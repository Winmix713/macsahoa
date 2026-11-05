# WinMix Engine: Architecture and Operations Audit

This document describes how the WinMix engine is composed, how its modules depend on one another, how data flows through it, and what guarantees each part provides. It also records the current structural issues that must be resolved before the project compiles.

---

## 1. Executive summary

The engine is a headless React state layer. It owns the domain state (seasons, team weights, calibration, settings, the fixture round, and the betting slip ledger), persists it, runs the prediction pipeline, and exposes a single object to the user interface through `useWinmixEngine()`.

The design rests on four principles:

1. **One synchronous write point.** All state changes pass through `commit()`, so `stateRef` is always current, even within a single tick.
2. **One lock for long work.** Every operation that reads and rewrites predictions runs under `withPipelineLock()`. Concurrent jobs cannot interleave, and superseded jobs cannot commit.
3. **Pure cores, impure shells.** Parsing, deduplication, league detection and state shaping are pure functions. Side effects (storage, toasts, network) live in hooks.
4. **Derived data is recomputable.** Predictions are rebuilt from the stored matches. Checkpoints and the IndexedDB pipeline cache only save time; they are never required for correctness.

---

## 2. Module map

All engine modules live in `src/hooks/winmix/`, except the composer `useWinmixEngine`, which is the public entry point.

| Module | Kind | Responsibility |
|---|---|---|
| `useWinmixEngine` | Composer | Creates every sub-hook in dependency order, derives selectors, and returns the memoized public surface. |
| `engineApi` | Type contract | Declares `UseWinmixEngineReturn`, the full public surface consumed by the UI. |
| `engineStore` | State | Holds `DomainState` in React state and in `stateRef`; provides `commit()` and `mountedRef`. |
| `types` | Types | `DomainState`, `PersistedSlice`, `WeightDraft`, `PipelineRunInfo`, `RecoveryNotice`, `ImportPreviewState`, `UploadResult`, `ProgressState`. |
| `helpers` | Pure utilities | Initial state, persisted-slice conversion, selection resolution, record cloning, recommended weights, change detection, identifiers, error and progress formatting. |
| `ingest` | Pure | `ingestCsvFiles()`: CSV texts to seasons, with validation, dedupe, league detection and integrity warnings. |
| `useDiagnostics` | State | Newest-first diagnostics log capped at 200 entries. |
| `usePersistence` | Side effects | Snapshot writes to localStorage plus an IndexedDB pipeline-cache mirror, with debouncing, idle scheduling, and ordered writes. |
| `usePipelineRunner` | Core orchestration | Synchronous job lock, run identifiers, throttled progress, per-league pipeline execution, checkpoint I/O, and the audit record of each run. |
| `useBoot` | Lifecycle | Restores state on mount (snapshot, then cache, then backfill of missing predictions) and reports corruption. |
| `useIngestion` | Command | CSV import pipeline with read, parse, weight recommendation, recompute, commit, and optional background cloud sync. |
| `useJsonTransfer` | Command | JSON export, two-step import (validate and preview, then merge or replace). |
| `useWeights` | Command | Draft-based team-weight editing; a draft becomes real only after its recompute succeeds. |
| `useDataManagement` | Command | League and season navigation, deletion and pruning, clear-all, settings, manual recompute, full rebuild. |
| `useRoundAndLedger` | Command | Fixture-round editing and the slip ledger (saved betting slips). |

---

## 3. Dependency graph and initialization order

The composer creates hooks in a fixed order. The order is part of the contract, because effects are registered in the same sequence.

```
useEngineStore            (state, stateRef, mountedRef, commit)
  -> useDiagnostics       (logDiagnostic, mountedRef-gated)
  -> usePersistence       (persist, persistSoon, flushPersist, storageBackend)
  -> usePipelineRunner    (withPipelineLock, runPipelineForLeagues, recompute, report)
       -> useWeights
       -> useBoot          (needs runner + persist)
       -> useIngestion     (needs runner + persist + weights reset)
       -> useJsonTransfer  (needs runner + persist + weights reset)
       -> useDataManagement(needs runner + persist + ingestion.dismissUploadResult)
       -> useRoundAndLedger(needs persist + persistSoon)
  -> derived selectors    (useMemo: league seasons, matches, selected season, pattern weights, market feedback)
  -> public surface       (useMemo: UseWinmixEngineReturn)
```

Dependencies flow in one direction only. The lower layers never import the hooks above them. Shared contracts use narrow `Pick<>` types on the runner, so each consumer sees only the operations it needs.

---

## 4. Domain state

`DomainState` is the single source of truth:

- `seasons`: imported seasons, each with its matches, predictions, content hash and count warning.
- `currentLeague`, `selectedSeasonId`: navigation only. These are not persisted.
- `teamWeights`, `manualWeightOverrides`: effective weights per league, and the subset that a user set by hand. Automatic recommendations never overwrite a manual override.
- `teamAliasMap`: canonical team key to the spelling used in the uploaded file.
- `seasonCounters`: per-league counter used to name seasons.
- `calibration`: per-league calibration produced by the pipeline.
- `settings`: including `historyScope`, `allowDuplicateImport`, and `experiments`.
- `round`, `slips`: the fixture round being built and the saved slip ledger.

`PersistedSlice` is the same data minus navigation. `toPersistedSlice()` and `persistedToDomain()` convert between the two. A missing field in a stored payload falls back to the current base value, never to `undefined`.

`resolveSelection()` runs on every `commit()`. It guarantees that `selectedSeasonId` always points to a season in the active league, or is `null`.

---

## 5. Write path and consistency

### 5.1 `commit()`

`commit(patch)` merges the patch into `stateRef.current` synchronously, re-resolves the selected season, updates `stateRef`, and schedules a React re-render only if the component is still mounted. Callers can read the result immediately, which lets multi-step operations chain without waiting for a render.

### 5.2 Persistence ordering

`usePersistence` assigns every `persist()` call an increasing sequence number. A write is dropped if a newer sequence number exists by the time it runs. This prevents a deferred idle save from overwriting a newer synchronous save.

| Situation | Behavior |
|---|---|
| Ordinary edit | Written immediately. |
| Round or score entry (per keystroke) | Debounced by 400 ms through `persistSoon()`. |
| More than 5,000 matches | Written in an idle callback (timeout 2 s). A newer save cancels it. |
| Tab hidden or closing | `pagehide` flushes any debounced or queued write synchronously. |
| Unmount | Flushes pending writes. |
| Snapshot above soft cap | A storage warning is shown, suggesting the user prune the oldest season. |

Every snapshot write also updates the IndexedDB pipeline cache. Write failures are logged as diagnostics; they never throw into the UI.

### 5.3 Atomic operations

Operations that change data and predictions together use the `mutate` option of `recompute()`. The mutation is applied inside the lock, and its result is committed together with the pipeline output, or not at all. Deleting a season is the main example: if the recompute fails, the season remains.

---

## 6. Pipeline execution and locking

### 6.1 The lock

`withPipelineLock(job, options)` is the only way to run long work.

- `busyRef` is a synchronous flag. `isComputing` is React state and lags one render behind, so it is never used as a guard.
- A new run increments `runIdRef`. Any job whose id no longer matches is stale. Stale jobs must not commit results and must not release the lock.
- If the lock is held, the caller is told to wait (unless `notifyIfBusy` is false). The `preempt` option lets the boot job take over from a running job, which then becomes stale.
- The `finally` block clears the busy state and the progress bar only for the current owner.

### 6.2 Running the pipeline

`runPipelineForLeagues(leagues, snapshot, label, options)`:

1. Reads each league's checkpoint, unless `forceFullRebuild` is set.
2. Runs all requested leagues concurrently (`Promise.all`). Progress is reported as a share of the total, so each league occupies its own band of the progress bar.
3. Merges each league's results back into the snapshot, replacing only that league's seasons.
4. Stores calibration and writes the fresh checkpoint.
5. Records a `PipelineRunInfo` per league: whether the run was incremental or a full rebuild, how many matches were reused or recomputed, and the reason for any rebuild.
6. Returns a new snapshot. It never mutates state and never commits. The caller decides.

### 6.3 Progress reporting

`report()` throttles updates to one every 50 ms. Terminal updates use `force`, so the bar always reaches completion.

---

## 7. Lifecycle: boot

`useBoot` runs once per mount. Every dependency is a stable callback, and the effect is cancellable, so React StrictMode double-mounting is safe.

1. **Snapshot.** Load the localStorage snapshot. Remember when it was saved. If the schema or feature version differs, mark a forced full rebuild and clear checkpoints. If the snapshot is corrupted, quarantine it, show a recovery notice, and skip the cache.
2. **Cache.** Load the IndexedDB pipeline cache. Use it only if its versions match and it is at least as fresh as the snapshot. A cache restore clears the forced-rebuild flag, because the cache already reflects the current feature shape.
3. **Backfill.** If any match lacks predictions, or a forced rebuild is pending, run the pipeline under the lock with `preempt`. Then persist the result.
4. Set `isReady`. The UI waits on this flag.

---

## 8. Workflows

### 8.1 CSV import (`useIngestion`)

1. Read the files with bounded concurrency (`READ_CONCURRENCY`). Progress covers 0 to 60 percent.
2. Run `ingestCsvFiles` (pure). Progress covers 60 to 90 percent. For each file it:
   - Parses rows and records skipped and repaired rows.
   - Deduplicates exact duplicates and keeps ambiguous undated repeats, because they may be real rematches.
   - Requires the match count to be within `EXPECTED_MATCH_COUNT` plus or minus `MATCH_COUNT_TOLERANCE`.
   - Detects the league from the data in automatic mode, or uses the forced league.
   - Rejects a file whose content hash matches an existing season in the same league, unless duplicate import is allowed.
   - Registers team aliases and default weights.
   - Adds the season and emits integrity warnings. Nothing is dropped silently.
3. If any league was touched, apply recommended team weights to that league. Manual overrides are preserved.
4. Recompute only the touched leagues (90 to 100 percent).
5. Commit, persist, clear any weight draft, and show the upload result.
6. If the cloud tier is configured and at least one season was added, start a background cloud sync. Its failure only logs a diagnostic.

### 8.2 JSON export and import (`useJsonTransfer`)

- **Export** serializes settings, calibration, weights, overrides, aliases, counters and seasons. The fixture round and slip ledger are intentionally excluded.
- **Import** is two-step. `beginImport` parses and validates the file, then shows a preview with current and incoming summaries. Nothing changes yet.
- **Apply** runs under the lock. `replace` asks for confirmation first. `merge` skips duplicate seasons. The full pipeline then runs for both leagues before the commit.

### 8.3 Weight editing (`useWeights`)

- `setWeight` writes to a draft, not to state. A manual edit sets an override. An automatic edit removes the override.
- `saveWeights` recomputes only the leagues whose weights or overrides actually changed. If the pipeline fails, the draft is kept so the user can fix the values.

### 8.4 Settings (`useDataManagement`)

- Changing `historyScope` affects every league's as-of features, so the user must confirm and a full rebuild of both leagues runs under the lock. Other settings are persisted directly.

### 8.5 Deletion and pruning

- `deleteSeason` and `pruneOldestSeason` confirm, then remove the season and recompute its league atomically.
- `clearAll` confirms, resets all domain data, clears checkpoints and the pipeline cache (after the empty snapshot is written), resets run information, and runs under the lock.

### 8.6 Round and ledger (`useRoundAndLedger`)

- Assigning a team to a fixture removes that team from any other fixture in the same league column. A team can appear at most once per column.
- Round edits use debounced persistence. Saving, deleting and clearing slips persist immediately.

---

## 9. Public surface

`useWinmixEngine()` returns `UseWinmixEngineReturn`, grouped as:

- **State:** seasons, current league, selected season id, effective weights and overrides, alias map, counters, calibration, settings, round, slips.
- **Derived:** league seasons (sorted by creation time), league matches, selected season, pattern weights, market feedback, `hasData`.
- **Status:** storage backend and warning, diagnostics, computing flag, ready flag, upload result, import preview, recovery notice, per-league run information.
- **Actions:** navigation, data management, import and export, weights, settings, recompute, round and ledger operations, diagnostics and flush.

The `teamWeights` and `manualWeightOverrides` fields return the draft while one exists, so the UI always shows what the user is editing.

The composer's result is memoized over every value it exposes, so consumers re-render only when something they read has changed.

---

## 10. Error handling

| Area | Strategy |
|---|---|
| File read | Failed reads become warnings, and the other files continue. |
| Parsing and validation | Invalid rows are counted and listed, never silently dropped. |
| Pipeline failure | Logged as an error diagnostic and shown as a toast. Uncommitted state stays unchanged. |
| Persistence failure | Logged as an error. The app keeps running with in-memory state. |
| Cache failure | Logged as a warning. The pipeline recomputes instead. |
| Corrupted snapshot | Quarantined under a backup key, with a visible notice. Never a silent reset. |
| Background cloud sync | Failures logged only. |
| Fire-and-forget work | Wrapped by `runDetached()`, so neither a synchronous throw nor a rejected promise escapes. |

---

## 11. Current state and open issues

These findings come from the current project files. They must be resolved before the build can pass.

1. **Entry point location is inconsistent.** The composed engine now sits at `src/hooks/winmix/useWinmixEngine.ts`, while the previous public entry point `src/hooks/useWinmixEngine.ts` no longer exists. A 1,896-line file named `src/hooks/2useWinmixEngine.ts` is present; it appears to be the original monolith. Any consumer importing the public entry point from its previous location will fail.
2. **Import paths in the composer are not adjusted for its new location.** Inside `winmix/`, the composer imports `./winmix/...` (which no longer resolves) and `../types/winmix` and `../utils/ledger` (which should be `../../`). The sibling modules are already correct for the `winmix/` folder.
3. **Missing modules in this workspace.** Shared types, utilities, data, contexts, components, pages and the progress store are referenced but not present here. The project owner reports they exist in the main repository. `usePipelineRunner` expects the progress store at `src/hooks/progressStore`.
4. **Missing dependency.** `App.tsx` imports `sonner`, which is not listed in `package.json`.
5. **Build and tests.** The production build fails on the unresolved `sonner` import. No test files exist, so the test runner reports no tests.
6. **Monolith duplication.** Keeping the 1,896-line original alongside the refactored modules risks divergence. Once the refactor is verified, it should be removed (with a Version History backup kept).

---

## 12. Recommendations

1. Decide the canonical entry point. Either move the composer back to `src/hooks/useWinmixEngine.ts` and keep the `winmix/` imports, or keep it inside `winmix/` and update its imports to the local paths.
2. Use the `@/` alias (mapped to `src/`) for cross-folder imports to avoid fragile relative paths such as `../../`.
3. Add the `sonner` dependency if it is not already declared in the main repository.
4. Add unit tests for the pure modules first: `ingestCsvFiles`, `cacheIsAtLeastAsFresh`, `persistedToDomain`, `resolveSelection`, `changedWeightLeagues`, and `applyRecommendedTeamWeights`. These carry the most logic and need no UI.
5. Add a test for the pipeline lock: a superseded run must not commit, and a preempted run must not release the lock.
6. Delete the monolith once the refactor passes the build and tests.

---

## Glossary

- **Season:** one imported CSV file for one league, with its matches and predictions.
- **Checkpoint:** saved pipeline progress that lets the next run reuse finished matches.
- **As-of:** a feature or prediction computed using only the data available before a given match.
- **Calibration:** league-level statistics produced by the pipeline and used to adjust predictions.
- **Draft:** unsaved edits to team weights, applied only after a successful recompute.
- **Slip:** a saved set of betting picks in the ledger.
