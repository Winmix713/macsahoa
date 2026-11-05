import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { progressStore } from './progressStore';
import { toast } from 'sonner';
import { LEAGUES, LEAGUE_SEASON_PREFIX } from '../data/leagues';
import { useDialogs } from '../contexts/DialogContext';
import { computeAutoTeamWeights } from '../utils/autoWeights';
import {
  clearCheckpoints,
  readCheckpoint,
  writeCheckpoint } from
'../utils/checkpointStore';
import {
  DEFAULT_WEIGHT,
  EXPECTED_MATCH_COUNT,
  FEATURE_SCHEMA_VERSION,
  MATCH_COUNT_TOLERANCE,
  PIPELINE_CONTRACT_VERSION,
  READ_CONCURRENCY,
  SCHEMA_VERSION,
  STORAGE_SOFT_CAP_BYTES } from
'../utils/constants';
import {
  contentHashForMatches,
  dedupeMatches,
  detectLeagueFromMatches,
  finalizeMatchOrder,
  parseCsvText,
  readFilesWithConcurrency } from
'../utils/csv';
import { emptyRound } from '../utils/fixtures';
import {
  mergeWithPayload,
  parseImportFile,
  replaceWithPayload,
  summarize,
  type ImportPayload,
  type ImportSummary } from
'../utils/importJson';
import { computeMarketFeedback, patternWeightsFromSlips } from '../utils/ledger';
import { defaultSlipMarkets } from '../utils/marketCatalog';
import type { PipelineRunKind } from '../utils/pipeline';
import {
  clearPipelineCache,
  loadPipelineCache,
  savePipelineCache } from
'../utils/pipelineCache';
import { runLeaguePipeline, type PipelineRunMode } from '../utils/pipelineRunner';
import {
  DEFAULT_SETTINGS,
  detectStorageBackend,
  emptyAliases,
  emptyCalibration,
  emptyCounters,
  emptyWeights,
  loadPersistedState,
  savePersistedState } from
'../utils/storage';
import { canon } from '../utils/teams';
import { isCloudTierConfigured } from '../utils/supabaseTier';
import { syncSeasonsToCloud } from '../utils/cloudSync';
import type {
  AliasMap,
  CalibrationMap,
  DiagnosticEntry,
  DiagnosticLevel,
  FixtureRound,
  League,
  LeagueMode,
  MatchRow,
  Season,
  SeasonCounters,
  Slip,
  SlipLine,
  StorageBackend,
  WeightMap,
  WinmixSettings } from
'../types/winmix';

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Ring-buffer size for the in-memory diagnostics log. */
const DIAGNOSTICS_LIMIT = 200;
/** Idle window before a debounced snapshot write is flushed. */
const PERSIST_DEBOUNCE_MS = 400;
/** Minimum interval between progress re-renders during long jobs. */
const PROGRESS_THROTTLE_MS = 50;

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/**
 * The single source of truth for everything persisted to storage, plus the
 * two purely-navigational fields (`currentLeague`, `selectedSeasonId`) that
 * are cheap to recompute and therefore intentionally *not* persisted.
 */
interface DomainState {
  seasons: Season[];
  currentLeague: League;
  selectedSeasonId: string | null;
  teamWeights: WeightMap;
  teamAliasMap: AliasMap;
  seasonCounters: SeasonCounters;
  calibration: CalibrationMap;
  settings: WinmixSettings;
  manualWeightOverrides: WeightMap;
  round: FixtureRound;
  slips: Slip[];
}

/** The persisted subset of {@link DomainState}. */
type PersistedSlice = Omit<
  DomainState,
  'currentLeague' | 'selectedSeasonId'>;


export interface UploadResult {
  added: number;
  warnings: string[];
}

export interface ProgressState {
  label: string;
  pct: number;
}

/**
 * PHASE 8 — what the last pipeline run for a league actually did. Surfaced so
 * the Pipeline Audit can state plainly whether the numbers on screen came from
 * a resumed prefix or a full historical rebuild, and why.
 */
export interface PipelineRunInfo {
  league: League;
  kind: PipelineRunKind;
  mode: PipelineRunMode;
  /** Matches folded in by the end of the walk. */
  processedMatchCount: number;
  /** Reused verbatim from the checkpoint. */
  reusedMatches: number;
  /** Actually re-forecast in this run. */
  recomputedMatches: number;
  /** Why a resumable-looking checkpoint had to be discarded, if it was. */
  rebuildReason: string | null;
  at: string;
}

/**
 * Surfaced when a persisted snapshot could not be read. The raw value is kept
 * under `backupKey`, so a corrupted state is never a silent reset.
 */
export interface RecoveryNotice {
  message: string;
  backupKey: string | null;
}

/** A parsed, validated JSON export waiting for the user's replace/merge choice. */
export interface ImportPreviewState {
  fileName: string;
  payload: ImportPayload;
  warnings: string[];
  current: ImportSummary;
  incoming: ImportSummary;
}

/* ------------------------------------------------------------------ *
 * Pure helpers (no React, no side effects — unit-testable in isolation)
 * ------------------------------------------------------------------ */

function initialDomainState(): DomainState {
  return {
    seasons: [],
    currentLeague: LEAGUES[0],
    selectedSeasonId: null,
    teamWeights: emptyWeights(),
    teamAliasMap: emptyAliases(),
    seasonCounters: emptyCounters(),
    calibration: emptyCalibration(),
    settings: { ...DEFAULT_SETTINGS, slipMarkets: defaultSlipMarkets() },
    manualWeightOverrides: emptyWeights(),
    round: emptyRound(),
    slips: []
  };
}

/**
 * True when the IndexedDB pipeline cache was written at or after the
 * localStorage snapshot, i.e. it is the newer (or equal) source of truth.
 * `persist` writes localStorage first and the cache right after, so within one
 * save the cache timestamp is never earlier. A missing snapshot (never written,
 * or lost to a storage-quota failure) always yields to the cache.
 */
function cacheIsAtLeastAsFresh(
cacheSavedAt: string,
snapshotSavedAt: string | null | undefined)
: boolean {
  if (!snapshotSavedAt) return true;
  const cache = Date.parse(cacheSavedAt);
  const snapshot = Date.parse(snapshotSavedAt);
  if (!Number.isFinite(cache) || !Number.isFinite(snapshot)) return false;
  return cache >= snapshot;
}

function toPersistedSlice(state: DomainState): PersistedSlice {
  const {
    seasons,
    teamWeights,
    teamAliasMap,
    seasonCounters,
    calibration,
    settings,
    manualWeightOverrides,
    round,
    slips
  } = state;
  return {
    seasons,
    teamWeights,
    teamAliasMap,
    seasonCounters,
    calibration,
    settings,
    manualWeightOverrides,
    round,
    slips
  };
}

/**
 * Keeps `selectedSeasonId` pointing at a season that actually exists in the
 * currently active league; falls back to the first available one.
 */
function resolveSelection(
seasons: Season[],
league: League,
current: string | null)
: string | null {
  const available = seasons.filter((s) => s.league === league);
  if (available.length === 0) return null;
  return available.some((s) => s.id === current) ? current : available[0].id;
}

/**
 * Shallow-clones a per-league record. Driven by {@link LEAGUES} rather than
 * literal keys so a new league requires no edits in this module.
 */
function cloneLeagueRecord<V>(
source: Partial<Record<League, Record<string, V>>>)
: Record<League, Record<string, V>> {
  const out = {} as Record<League, Record<string, V>>;
  for (const league of LEAGUES) out[league] = { ...(source[league] ?? {}) };
  return out;
}

/** Refreshes only weights that have never been explicitly overridden. */
function applyRecommendedTeamWeights(
snapshot: DomainState,
leagues: readonly League[])
: DomainState {
  const teamWeights = cloneLeagueRecord<number>(snapshot.teamWeights);

  for (const league of leagues) {
    const matches = snapshot.seasons.
    filter((season) => season.league === league).
    flatMap((season) => season.matches);
    const recommendations = computeAutoTeamWeights(matches, league);

    for (const [key, recommendation] of Object.entries(recommendations)) {
      if (snapshot.manualWeightOverrides[league]?.[key] === undefined) {
        teamWeights[league][key] = recommendation.recommendedWeight;
      }
    }
  }

  return { ...snapshot, teamWeights };
}

function makeSeasonId(league: League): string {
  const uuid =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ?
  crypto.randomUUID() :
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `season_${league}_${uuid}`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatMb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(2);
}

function pct(done: number, total: number): number {
  return total > 0 ? done / total * 100 : 0;
}

/**
 * Stable per-file identity. Combined with the row index this gives every
 * undated row a unique dedupe identity, so genuine repeat fixtures survive.
 */
function makeSourceFileId(file: File): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function summarizeSkipped(rows: Array<{line: number;reason: string;}>, limit = 3): string {
  const head = rows.
  slice(0, limit).
  map((r) => `#${r.line} — ${r.reason}`).
  join('; ');
  return `${head}${rows.length > limit ? '; …' : ''}`;
}

interface IngestBase {
  seasons: Season[];
  teamWeights: WeightMap;
  teamAliasMap: AliasMap;
  seasonCounters: SeasonCounters;
  allowDuplicateImport: boolean;
}

interface IngestResult {
  seasons: Season[];
  teamWeights: WeightMap;
  teamAliasMap: AliasMap;
  seasonCounters: SeasonCounters;
  added: number;
  warnings: string[];
  leaguesTouched: League[];
}

/**
 * Turns raw CSV texts into new {@link Season} records, accumulating team
 * aliases, default weights and per-league season counters along the way.
 *
 * Deliberately pure: it neither reads nor writes React state, so the whole
 * ingestion contract (validation, dedupe, league detection, duplicate
 * rejection) can be tested without rendering anything.
 *
 * @param texts Aligned 1:1 with `files`; `null`/`undefined` marks a read failure.
 */
function ingestCsvFiles(
base: IngestBase,
files: File[],
texts: Array<string | null | undefined>,
mode: LeagueMode,
onFileStart: (file: File, index: number) => void)
: IngestResult {
  const seasons = base.seasons.slice();
  const teamWeights = cloneLeagueRecord<number>(base.teamWeights);
  const teamAliasMap = cloneLeagueRecord<string>(base.teamAliasMap);
  const seasonCounters: SeasonCounters = { ...base.seasonCounters };
  const warnings: string[] = [];
  const leaguesTouched = new Set<League>();
  let added = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onFileStart(file, i);

    const text = texts[i];
    if (text == null) {
      warnings.push(`⚠️ "${file.name}": nem sikerült beolvasni a fájlt.`);
      continue;
    }

    const parsed = parseCsvText(text, { sourceFileId: makeSourceFileId(file) });
    if (parsed.matches.length === 0) {
      const reason = parsed.skippedRows[0]?.reason ?? 'ismeretlen ok';
      warnings.push(
        `⚠️ "${file.name}": nem sikerült érvényes mérkőzéseket kinyerni (${reason}).`
      );
      continue;
    }

    const { unique, dupCount, ambiguousCount } = dedupeMatches(parsed.matches);
    const ordered = finalizeMatchOrder(unique);
    const actualCount = ordered.matches.length;

    if (Math.abs(actualCount - EXPECTED_MATCH_COUNT) > MATCH_COUNT_TOLERANCE) {
      const skipDetail = parsed.skippedRows.length ?
      ` Kihagyott sorok: ${parsed.skippedRows.length} (pl.: ${summarizeSkipped(parsed.skippedRows)}).` :
      '';
      warnings.push(
        `⚠️ "${file.name}": ${actualCount} érvényes mérkőzést tartalmaz ` +
        `(elvárt: ${EXPECTED_MATCH_COUNT} ±${MATCH_COUNT_TOLERANCE}). ` +
        `Kihagyva.${skipDetail}`
      );
      continue;
    }

    // ---- League resolution: forced by the UI, or inferred from the data ----
    let league: League;
    let detectNote = '';
    if (mode === 'auto') {
      const det = detectLeagueFromMatches(unique, file.name);
      if (det.league === 'unknown') {
        warnings.push(
          `⚠️ "${file.name}": a liga nem állapítható meg megbízhatóan ` +
          `(bizonyosság: ${(det.confidence * 100).toFixed(0)}%). ` +
          `Válaszd ki manuálisan a "Kényszerített Angol/Spanyol" módot, ` +
          `és töltsd fel újra ezt a fájlt.`
        );
        continue;
      }
      league = det.league;
      detectNote = ` (auto-detektálva, bizonyosság: ${(
      det.confidence * 100).
      toFixed(0)}%)`;
    } else {
      league = mode;
    }

    // ---- Content-addressed duplicate season guard ----
    const contentHash = contentHashForMatches(unique);
    const isDuplicate = seasons.some(
      (s) => s.league === league && s.contentHash === contentHash
    );
    if (isDuplicate && !base.allowDuplicateImport) {
      warnings.push(
        `⚠️ "${file.name}": tartalmilag megegyezik egy már betöltött ` +
        `${league} szezonnal — kihagyva (a beállításoknál engedélyezheted ` +
        `az ismétlődő importot).`
      );
      continue;
    }

    leaguesTouched.add(league);

    // TWO-TIER IDENTITY: the canonical key is the internal index, the uploaded
    // spelling (accents and casing intact) is the display name. Virtual team
    // names are registered exactly as they arrived — never normalised toward
    // any real-world club.
    for (const match of ordered.matches) {
      for (const name of [match.home_team, match.away_team]) {
        const key = canon(name);
        teamAliasMap[league][key] ??= name;
        teamWeights[league][key] ??= DEFAULT_WEIGHT;
      }
    }

    const seasonIndex = (seasonCounters[league] ?? 0) + 1;
    seasonCounters[league] = seasonIndex;

    const season: Season = {
      id: makeSeasonId(league),
      league,
      seasonIndex,
      name: `${LEAGUE_SEASON_PREFIX[league]} ${seasonIndex}`,
      fileName: file.name,
      createdAt: new Date().toISOString(),
      contentHash,
      countWarning: actualCount !== EXPECTED_MATCH_COUNT,
      actualMatchCount: actualCount,
      orderMode: ordered.mode,
      datedMatchCount: ordered.dated,
      matches: ordered.matches
    };
    seasons.push(season);
    added++;

    // ---- Integrity reporting: nothing is dropped or altered silently ----
    // The detection note rides along on the acceptance line: on a 19-file
    // upload a separate line per file was pure noise.
    warnings.push(
      `ℹ️ "${file.name}": ${parsed.stats.accepted} / ${parsed.stats.dataRows} sor átvéve` + (
      parsed.stats.rejected > 0 ? `, ${parsed.stats.rejected} elutasítva` : '') +
      `${detectNote}.`
    );
    if (parsed.stats.rejected > 0) {
      warnings.push(
        `⚠️ "${file.name}": ${parsed.stats.rejected} sor érvénytelen adat miatt kimaradt ` +
        `(${summarizeSkipped(parsed.skippedRows)}).`
      );
    }
    if (parsed.repairedRows.length > 0) {
      warnings.push(
        `⚠️ "${file.name}": ${parsed.repairedRows.length} sornál hibás kísérőadat javítva, ` +
        `a mérkőzés megtartva (${summarizeSkipped(parsed.repairedRows)}).`
      );
    }
    if (dupCount > 0) {
      warnings.push(
        `ℹ️ "${file.name}": ${dupCount} bizonyítottan azonos sor (egyező dátum, párosítás és ` +
        `eredmény) eltávolítva.`
      );
    }
    if (ambiguousCount > 0) {
      warnings.push(
        `ℹ️ "${file.name}": ${ambiguousCount} dátum nélküli sor ugyanazt a párosítást és ` +
        `eredményt mutatja — MEGTARTVA, mert ez lehet valós visszavágó is.`
      );
    }
    if (ordered.mode === 'chronological') {
      warnings.push(
        `ℹ️ "${file.name}": mind a ${ordered.dated} mérkőzés dátuma feldolgozva, ` +
        `a sorrend valós kronológia.`
      );
    } else if (!parsed.stats.hasDateColumn) {
      // A virtual-league export with no `date` column is a NORMAL input, not a
      // defect: the file's own row order IS the chronology. Reporting it as a
      // warning on every file trained the operator to ignore real warnings.
      warnings.push(
        `ℹ️ "${file.name}": a fájl nem tartalmaz "date" oszlopot — a kronológiát a sorok ` +
        `sorrendje adja (virtuális ligáknál ez a szokásos eset).`
      );
    } else {
      warnings.push(
        `⚠️ "${file.name}": ${ordered.dated} / ${actualCount} mérkőzésnek van értelmezhető ` +
        `dátuma a "date" oszlopból — a kronológiát a fájl sorrendje adja, ami befolyásolja ` +
        `a predikciókat.`
      );
    }
    if (season.countWarning) {
      warnings.push(
        `ℹ️ "${file.name}": ${actualCount} mérkőzéssel importálva ` +
        `(nem pontosan ${EXPECTED_MATCH_COUNT}, de tűréshatáron belül).`
      );
    }
  }

  return {
    seasons,
    teamWeights,
    teamAliasMap,
    seasonCounters,
    added,
    warnings,
    leaguesTouched: Array.from(leaguesTouched)
  };
}

/* ------------------------------------------------------------------ *
 * Hook
 * ------------------------------------------------------------------ */

export function useWinmixEngine() {
  const dialogs = useDialogs();

  const [state, setState] = useState<DomainState>(initialDomainState);
  const stateRef = useRef(state);

  const storageBackendRef = useRef<StorageBackend>(detectStorageBackend());
  const [storageBackend] = useState<StorageBackend>(storageBackendRef.current);
  /** Weight edits are drafts until their pipeline succeeds. */
  const weightDraftRef = useRef<{weights: WeightMap;manualOverrides: WeightMap;} | null>(null);
  const [weightDraftVersion, setWeightDraftVersion] = useState(0);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);
  const [isComputing, setIsComputing] = useState(false);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [importPreview, setImportPreview] =
  useState<ImportPreviewState | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<RecoveryNotice | null>(null);
  const [pipelineRuns, setPipelineRuns] = useState<
    Partial<Record<League, PipelineRunInfo>>>(
    {});

  /** False after unmount: gates every post-await state write. */
  const mountedRef = useRef(true);
  /**
   * Synchronous mutual-exclusion flag for pipeline work. `isComputing` is
   * React state and therefore always one render behind, so it must never be
   * used as a guard — only for rendering.
   */
  const busyRef = useRef(false);
  /**
   * Monotonic run id. A job whose id no longer matches is stale (superseded or
   * unmounted) and must not commit its result.
   */
  const runIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ------------------------------- Logging ------------------------------ */

  const logDiagnostic = useCallback(
    (level: DiagnosticLevel, message: string) => {
      if (!mountedRef.current) return;
      setDiagnostics((prev) =>
      [{ ts: new Date().toISOString(), level, message }, ...prev].slice(
        0,
        DIAGNOSTICS_LIMIT
      )
      );
    },
    []
  );

  const clearDiagnostics = useCallback(() => setDiagnostics([]), []);

  /* ------------------------------ Commit ------------------------------- */

  /**
   * Applies a patch to the domain state. `stateRef` is updated synchronously
   * so callers can chain reads/writes within a single tick without waiting
   * for React to re-render.
   */
  const commit = useCallback((patch: Partial<DomainState>): DomainState => {
    const next = { ...stateRef.current, ...patch };
    next.selectedSeasonId = resolveSelection(
      next.seasons,
      next.currentLeague,
      next.selectedSeasonId
    );
    stateRef.current = next;
    if (mountedRef.current) setState(next);
    return next;
  }, []);

  /* ---------------------------- Persistence ---------------------------- */

  const persist = useCallback(
    (snapshot: DomainState) => {
      const slice = toPersistedSlice(snapshot);
      const doSave = () => {
        const result = savePersistedState(storageBackendRef.current, slice);
        void savePipelineCache({
          schemaVersion: SCHEMA_VERSION,
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          pipelineContractVersion: PIPELINE_CONTRACT_VERSION,
          savedAt: new Date().toISOString(),
          ...slice
        });
        if (result.error) {
          logDiagnostic('error', `Állapot mentési hiba: ${result.error}`);
          return;
        }
        if (!mountedRef.current) return;
        setStorageWarning(
          result.sizeBytes > STORAGE_SOFT_CAP_BYTES ?
          `A mentett állapot mérete (${formatMb(result.sizeBytes)} MB) ` +
          `közelít a tárolási korláthoz. Fontold meg a legrégebbi ` +
          `szezon(ok) törlését.` :
          null
        );
      };

      const matchCount = slice.seasons.reduce((sum, s) => sum + s.matches.length, 0);
      if (matchCount > 5000 && typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => doSave(), { timeout: 2000 });
      } else {
        doSave();
      }
    },
    [logDiagnostic]
  );

  /**
   * Round editing and score entry fire on every keystroke, so the (potentially
   * multi-megabyte) snapshot is written at most once per idle burst.
   */
  const persistTimer = useRef<number | null>(null);

  const flushPersist = useCallback(() => {
    if (persistTimer.current === null) return;
    window.clearTimeout(persistTimer.current);
    persistTimer.current = null;
    persist(stateRef.current);
  }, [persist]);

  const persistSoon = useCallback(() => {
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
    }
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null;
      persist(stateRef.current);
    }, PERSIST_DEBOUNCE_MS);
  }, [persist]);

  // Never lose a debounced write to unmount or tab teardown. `pagehide` is
  // used instead of `beforeunload` because it also fires on mobile Safari.
  const flushRef = useRef(flushPersist);
  flushRef.current = flushPersist;

  useEffect(() => {
    const onHide = () => flushRef.current();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      onHide();
    };
  }, []);

  /* ------------------------------ Progress ----------------------------- */

  const lastProgressAt = useRef(0);

  /**
   * Throttled progress reporter. Terminal updates (`force`) always land so the
   * bar never freezes just short of completion.
   */
  const report = useCallback(
    (next: ProgressState | null, force = false) => {
      if (!mountedRef.current) return;
      const now = Date.now();
      if (!force && next && now - lastProgressAt.current < PROGRESS_THROTTLE_MS) {
        return;
      }
      lastProgressAt.current = now;
      progressStore.set(next);
    },
    []
  );

  /* ------------------------------ Pipeline ----------------------------- */

  /**
   * Recomputes the as-of feature/prediction pipeline for `leagues` against
   * `snapshot`, returning a *new* snapshot. Never mutates and never touches
   * domain state, so callers decide when (and whether) to commit.
   *
   * PHASE 8 — the session checkpoint is handed to the pipeline here and the
   * fresh one is stored on the way out. The pipeline itself decides whether
   * that checkpoint is trustworthy: an edited history, a weight change, a
   * schema bump or an active experiment branch all degrade silently to a full
   * rebuild, so a missing or stale checkpoint can only ever cost time, never
   * correctness. `forceFullRebuild` is the operator's manual override.
   */
  const runPipelineForLeagues = useCallback(
    async (
    leagues: readonly League[],
    snapshot: DomainState,
    labelPrefix = 'Pipeline számítás',
    options?: {forceFullRebuild?: boolean;})
    : Promise<DomainState> => {
      const forceFullRebuild = options?.forceFullRebuild === true;
      const calibration: CalibrationMap = { ...snapshot.calibration };
      const runs: Partial<Record<League, PipelineRunInfo>> = {};
      const span = 100 / Math.max(leagues.length, 1);

      const results = await Promise.all(
        leagues.map((league, index) => {
          const base = index * span;
          return runLeaguePipeline({
            seasons: snapshot.seasons,
            league,
            weights: snapshot.teamWeights[league] ?? {},
            historyScope: snapshot.settings.historyScope,
            experiments: snapshot.settings.experiments,
            checkpoint: forceFullRebuild ? null : readCheckpoint(league),
            forceFullRebuild,
            onProgress: (done, total) => {
              report({
                label: `${labelPrefix} (${league})… ${done}/${total}`,
                pct: base + pct(done, total) * span / 100
              });
            }
          }).then((result) => ({ league, result, base }));
        })
      );

      let working = snapshot;
      const computedSeasonIds = new Set<string>();
      for (const { league, result, base: _base } of results) {
        const leagueSeasonIds = new Set(
          result.seasons.filter((s) => s.league === league).map((s) => s.id)
        );
        const otherSeasons = working.seasons.filter(
          (s) => !leagueSeasonIds.has(s.id)
        );
        const leagueSeasons = result.seasons.filter((s) => s.league === league);
        working = { ...working, seasons: [...otherSeasons, ...leagueSeasons] };
        for (const id of leagueSeasonIds) computedSeasonIds.add(id);
        calibration[league] = result.calibration;

        writeCheckpoint(result.checkpoint);

        const processed = result.checkpoint.processedMatchCount;
        const recomputed = Math.max(0, processed - result.reusedMatches);
        runs[league] = {
          league,
          kind: result.kind,
          mode: result.mode,
          processedMatchCount: processed,
          reusedMatches: result.reusedMatches,
          recomputedMatches: recomputed,
          rebuildReason: result.rebuildReason,
          at: new Date().toISOString()
        };

        logDiagnostic(
          'info',
          result.kind === 'incremental' ?
          `${league}: inkrementális futás — ${result.reusedMatches} meccs a ` +
          `checkpointból újrahasznosítva, ${recomputed} újraszámolva (${result.mode}).` :
          `${league}: teljes újraépítés — ${processed} meccs újraszámolva (${result.mode})` +
          `${result.rebuildReason ? `. Ok: ${result.rebuildReason}` : '.'}`
        );
      }

      if (mountedRef.current) {
        setPipelineRuns((prev) => ({ ...prev, ...runs }));
      }

      return { ...working, calibration };
    },
    [logDiagnostic, report]
  );

  /**
   * Serialises every long-running operation behind a synchronous lock and
   * guarantees the busy/progress UI is always torn down, even on throw.
   *
   * @returns The job's result, or `undefined` if the lock was already held.
   */
  const withPipelineLock = useCallback(
    async <T,>(
    job: (runId: number) => Promise<T>,
    options?: {notifyIfBusy?: boolean;})
    : Promise<T | undefined> => {
      if (busyRef.current) {
        if (options?.notifyIfBusy !== false) {
          await dialogs.alert(
            'Egy másik pipeline-művelet még fut, kérlek várj, amíg befejeződik.'
          );
        }
        return undefined;
      }

      busyRef.current = true;
      const runId = ++runIdRef.current;
      setIsComputing(true);
      try {
        return await job(runId);
      } finally {
        busyRef.current = false;
        if (mountedRef.current) {
          setIsComputing(false);
          progressStore.set(null);
        }
      }
    },
    [dialogs]
  );

  /** True when the given run has been superseded or the hook unmounted. */
  const isStale = useCallback(
    (runId: number) => !mountedRef.current || runIdRef.current !== runId,
    []
  );

  /**
   * Public recompute entry point: runs the pipeline for `leagues`, commits and
   * persists the result, and surfaces failures both as a toast and a
   * diagnostics entry.
   */
  const recompute = useCallback(
    async (
    leagues: readonly League[],
    toastMessage?: string,
    options?: {forceFullRebuild?: boolean;}) =>
    {
      await withPipelineLock(async (runId) => {
        report(
          {
            label: options?.forceFullRebuild ?
            'Teljes újraépítés…' :
            'Pipeline számítás…',
            pct: 0
          },
          true
        );
        try {
          const next = await runPipelineForLeagues(
            leagues,
            stateRef.current,
            options?.forceFullRebuild ? 'Teljes újraépítés' : 'Pipeline számítás',
            options
          );
          if (isStale(runId)) return;
          persist(commit(next));
          if (toastMessage) toast.success(toastMessage);
        } catch (e) {
          logDiagnostic('error', `Pipeline hiba: ${errorMessage(e)}`);
          toast.error(
            'A pipeline számítás hibára futott — részletek a diagnosztikai naplóban.'
          );
        }
      });
    },
    [
    commit,
    isStale,
    logDiagnostic,
    persist,
    report,
    runPipelineForLeagues,
    withPipelineLock]

  );

  /* --------- Boot: restore state, then backfill missing pipeline -------- */

  useEffect(() => {
      const backend = storageBackendRef.current;

    let cancelled = false;

    const boot = async () => {
      let restored = initialDomainState();
      /**
       * PHASE 8 — a snapshot written under a different `FeatureVector` shape
       * gets exactly ONE forced full rebuild, then resumes incrementally. A
       * fit is never migrated across a dimensionality change.
       */
      let schemaRebuild = false;
      /** When the localStorage snapshot was written; null when there was none. */
      let snapshotSavedAt: string | null = null;
      /** A quarantined snapshot is reported to the user; the cache must not paper over it. */
      let snapshotCorrupted = false;

      try {
        const outcome = loadPersistedState(backend);
        if (outcome.state) {
          snapshotSavedAt = outcome.state.savedAt ?? null;
          restored = { ...restored, ...toPersistedSlice(outcome.state as unknown as DomainState) };
          if (outcome.state.migrated) {
            logDiagnostic('info', 'v1 → v2 állapot migráció lefutott.');
          }
          if (outcome.state.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) {
            schemaRebuild = true;
            clearCheckpoints();
            logDiagnostic(
              'warn',
              `A mentett állapot feature séma-verziója ` +
              `(${outcome.state.featureSchemaVersion ?? 'nincs jelölve'}) nem egyezik a ` +
              `jelenlegivel (v${FEATURE_SCHEMA_VERSION}) — a checkpointok eldobva, ` +
              `pontosan egy teljes újraépítés következik.`
            );
          }
        } else if (outcome.corrupted) {
          snapshotCorrupted = true;
          // Never look like a fresh install after a corrupted snapshot: the raw
          // value is quarantined and the user is told explicitly.
          logDiagnostic(
            'error',
            `A mentett állapot nem olvasható (${outcome.error ?? 'ismeretlen hiba'}). ` + (
            outcome.backupKey ?
            `A sérült tartalom megőrizve: ${outcome.backupKey}` :
            'A sérült tartalmat nem sikerült félretenni.')
          );
          if (mountedRef.current) {
            setRecoveryNotice({
              message:
              'A böngészőben mentett WinMix állapot sérült, ezért üres adatbázissal indultunk. ' +
              'A sérült mentés NEM lett törölve — félretettük, így egy JSON export vagy a ' +
              'CSV-k újratöltése után is visszakereshető.',
              backupKey: outcome.backupKey
            });
          }
        } else if (outcome.error) {
          logDiagnostic('error', `Állapot betöltési hiba: ${outcome.error}`);
        }
      } catch (e) {
        logDiagnostic(
          'error',
          `Állapot betöltési hiba, üres állapotból indulunk: ${errorMessage(e)}`
        );
      }

      /**
       * IndexedDB pipeline cache. The localStorage snapshot strips pipeline
       * output (forcing a full recompute) and, with tens of thousands of
       * matches, may not fit the storage quota at all (forcing a full cloud
       * re-download). When the cache is valid for the current schema/feature/
       * pipeline versions and at least as fresh as that snapshot, it is the
       * authoritative state: seasons come back with their predictions, so the
       * recompute below is skipped and no network access is needed.
       */
      if (!snapshotCorrupted) {
        try {
          const cached = await loadPipelineCache();
          if (cached && cacheIsAtLeastAsFresh(cached.savedAt, snapshotSavedAt)) {
            restored = { ...restored, ...toPersistedSlice(cached as unknown as DomainState) };
            // The cache only holds state written under the current feature shape.
            schemaRebuild = false;
            const cachedMatches = cached.seasons.reduce((sum, s) => sum + s.matches.length, 0);
            logDiagnostic(
              'info',
              `Gyorsítótárból visszaállítva: ${cached.seasons.length} szezon, ${cachedMatches} mérkőzés, ` +
              `újraszámítás nélkül (mentve: ${cached.savedAt}).`
            );
          }
        } catch (e) {
          logDiagnostic('warn', `A pipeline-gyorsítótár nem olvasható, kihagyva: ${errorMessage(e)}`);
        }
      }

      if (cancelled) return;
      let committed = commit(restored);
      logDiagnostic('info', 'WinMix Studio v2 betöltve.');

      // Predictions are derived data and intentionally not exported/persisted
      // for every match; backfill anything missing before the UI goes live.
      const needsCompute =
      schemaRebuild && committed.seasons.length > 0 ||
      committed.seasons.some((s) => s.matches.some((m) => !m.pipeline));

      if (needsCompute) {
        busyRef.current = true;
        const runId = ++runIdRef.current;
        setIsComputing(true);
        report(
          {
            label: schemaRebuild ?
            'Feature séma változás — teljes újraépítés…' :
            'Predikciók újraszámítása a mentett adatokból…',
            pct: 0
          },
          true
        );
        try {
          const next = await runPipelineForLeagues(
            LEAGUES,
            committed,
            schemaRebuild ? 'Teljes újraépítés' : 'Pipeline számítás',
            { forceFullRebuild: schemaRebuild }
          );
          if (!cancelled && !isStale(runId)) {
            committed = commit(next);
            persist(committed);
          }
        } catch (e) {
          logDiagnostic(
            'error',
            `Induló pipeline számítás hibája: ${errorMessage(e)}`
          );
        } finally {
          busyRef.current = false;
          if (!cancelled && mountedRef.current) {
            setIsComputing(false);
            progressStore.set(null);
          }
        }
      }

      if (!cancelled && mountedRef.current) setIsReady(true);
    };

    void boot();
    return () => {
      cancelled = true;
    };
    // Boot must run exactly once; every dependency is a stable ref/callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----------------------------- Ingestion ----------------------------- */

  const importFiles = useCallback(
    async (fileList: FileList | File[], mode: LeagueMode) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      await withPipelineLock(async (runId) => {
        setUploadResult(null);
        report({ label: `Fájlok beolvasása… 0/${files.length}`, pct: 0 }, true);

        try {
          // Phase 1 (0–60%): bounded-concurrency disk reads.
          const texts = await readFilesWithConcurrency(
            files,
            READ_CONCURRENCY,
            (done, total) => {
              report({
                label: `Fájlok beolvasása… ${done}/${total}`,
                pct: pct(done, total) * 0.6
              });
            },
            (message) => logDiagnostic('error', message)
          );
          if (isStale(runId)) return;

          // Phase 2 (60–90%): pure parse/validate/dedupe.
          const snapshot = stateRef.current;
          const ingest = ingestCsvFiles(
            {
              seasons: snapshot.seasons,
              teamWeights: snapshot.teamWeights,
              teamAliasMap: snapshot.teamAliasMap,
              seasonCounters: snapshot.seasonCounters,
              allowDuplicateImport: snapshot.settings.allowDuplicateImport
            },
            files,
            texts,
            mode,
            (file, index) => {
              report({
                label: `Feldolgozás: ${file.name} (${index + 1}/${files.length})`,
                pct: 60 + (index + 1) / files.length * 30
              });
            }
          );
          if (isStale(runId)) return;

          let working: DomainState = {
            ...snapshot,
            seasons: ingest.seasons,
            teamWeights: ingest.teamWeights,
            teamAliasMap: ingest.teamAliasMap,
            seasonCounters: ingest.seasonCounters
          };

          // Every accepted English/Spanish import activates the system's
          // recommendation before forecasts are rebuilt. Both supported leagues
          // share this path, whether they were selected or auto-detected.
          if (ingest.leaguesTouched.length > 0) {
            working = applyRecommendedTeamWeights(working, ingest.leaguesTouched);
            ingest.warnings.push(
              `ℹ️ A rendszer „Javasolt” csapatsúlyai automatikusan alkalmazva: ${ingest.leaguesTouched.join(', ')}.`
            );
          }

          // Phase 3 (90–100%): recompute only the leagues we actually touched.
          if (ingest.leaguesTouched.length > 0) {
            report({ label: 'Pipeline (as-of) számítás…', pct: 90 }, true);
            working = await runPipelineForLeagues(
              ingest.leaguesTouched,
              working,
              'Pipeline (as-of) számítás'
            );
            if (isStale(runId)) return;
          }

          weightDraftRef.current = null;
          setWeightDraftVersion((version) => version + 1);
          persist(commit(working));
          setUploadResult({ added: ingest.added, warnings: ingest.warnings });
          for (const w of ingest.warnings) {
            logDiagnostic(w.startsWith('⚠️') ? 'warn' : 'info', w);
          }

          if (ingest.added > 0) {
            toast.success(`${ingest.added} új bajnokság rögzítve!`);
            // Auto-sync to Supabase if the cloud tier is configured — silent,
            // non-blocking, failure only logs a diagnostic entry.
            if (isCloudTierConfigured()) {
              void (async () => {
                try {
                  const result = await syncSeasonsToCloud(
                    working.seasons, working.teamWeights, working.teamAliasMap
                  );
                  if (result.success) {
                    logDiagnostic(
                      'info',
                      `Felhő szinkron: ${result.seasons} szezon, ${result.teams} csapat, ${result.matches} mérkőzés feltöltve.`
                    );
                  } else {
                    logDiagnostic(
                      'warn',
                      `Felhő szinkron sikertelen: ${result.errors.join('; ')}`
                    );
                  }
                } catch (e) {
                  logDiagnostic(
                    'warn',
                    `Felhő szinkron hiba: ${e instanceof Error ? e.message : String(e)}`
                  );
                }
              })();
            }
          } else {
            toast.error(
              'Egyetlen fájl sem került rögzítésre — nézd meg a figyelmeztetéseket.'
            );
          }
        } catch (e) {
          logDiagnostic('error', `Import hiba: ${errorMessage(e)}`);
          toast.error(
            'Az import hibára futott — részletek a diagnosztikai naplóban.'
          );
        }
      });
    },
    [
    commit,
    isStale,
    logDiagnostic,
    persist,
    report,
    runPipelineForLeagues,
    withPipelineLock]

  );

  const dismissUploadResult = useCallback(() => setUploadResult(null), []);

  const dismissRecoveryNotice = useCallback(() => setRecoveryNotice(null), []);

  /* ----------------------------- Mutations ----------------------------- */

  const setLeague = useCallback(
    (league: League) => {
      commit({ currentLeague: league });
    },
    [commit]
  );

  const selectSeason = useCallback(
    (id: string) => {
      commit({ selectedSeasonId: id });
    },
    [commit]
  );

  const deleteSeason = useCallback(
    async (id: string) => {
      const season = stateRef.current.seasons.find((s) => s.id === id);
      if (!season) return;
      const ok = await dialogs.confirm(
        `Törölni szeretnéd a következőt: ${season.name}? ` +
        `(a többi szezon neve NEM változik)`
      );
      if (!ok) return;
      commit({
        seasons: stateRef.current.seasons.filter((s) => s.id !== id)
      });
      await recompute([season.league], `${season.name} törölve.`);
    },
    [commit, dialogs, recompute]
  );

  const pruneOldestSeason = useCallback(async () => {
    const oldest = stateRef.current.seasons.reduce<Season | null>(
      (min, s) =>
      !min || (s.createdAt ?? '').localeCompare(min.createdAt ?? '') < 0 ?
      s :
      min,
      null
    );
    if (!oldest) return;
    const ok = await dialogs.confirm(
      `Törlöd a legrégebbi szezont (${oldest.name}) a tárhely felszabadításához?`
    );
    if (!ok) return;
    commit({
      seasons: stateRef.current.seasons.filter((s) => s.id !== oldest.id)
    });
    await recompute(
      [oldest.league],
      `${oldest.name} törölve a tárhely felszabadításához.`
    );
  }, [commit, dialogs, recompute]);

  const clearAll = useCallback(async () => {
    const ok = await dialogs.confirm(
      'Biztosan törölni szeretnéd az összes rögzített adatot? Ez nem vonható vissza.'
    );
    if (!ok) return;
    const committed = commit({
      seasons: [],
      selectedSeasonId: null,
      teamWeights: emptyWeights(),
      manualWeightOverrides: emptyWeights(),
      teamAliasMap: emptyAliases(),
      seasonCounters: emptyCounters(),
      calibration: emptyCalibration(),
      round: emptyRound(),
      slips: []
    });
    weightDraftRef.current = null;
    setWeightDraftVersion((version) => version + 1);
    flushPersist();
    persist(committed);
    clearCheckpoints();
    // Queued after the (empty) mirror write inside persist(), so it wins.
    void clearPipelineCache();
    setPipelineRuns({});
    setUploadResult(null);
    toast.success('Összes adat törölve.');
  }, [commit, dialogs, flushPersist, persist]);

  const setWeight = useCallback(
    (league: League, key: string, value: number, source: 'manual' | 'automatic' = 'manual') => {
      const current = weightDraftRef.current ?? {
        weights: stateRef.current.teamWeights,
        manualOverrides: stateRef.current.manualWeightOverrides
      };
      const weights = cloneLeagueRecord<number>(current.weights);
      const manualOverrides = cloneLeagueRecord<number>(current.manualOverrides);
      weights[league][key] = value;
      if (source === 'manual') manualOverrides[league][key] = value;
      else delete manualOverrides[league][key];
      weightDraftRef.current = { weights, manualOverrides };
      setWeightDraftVersion((version) => version + 1);
    },
    []
  );

  const saveWeights = useCallback(async () => {
    const draft = weightDraftRef.current;
    if (!draft) return;
    await withPipelineLock(async (runId) => {
      const snapshot = { ...stateRef.current, teamWeights: draft.weights, manualWeightOverrides: draft.manualOverrides };
      report({ label: 'Súlyok alkalmazása és újraszámítása…', pct: 0 }, true);
      try {
        const next = await runPipelineForLeagues([snapshot.currentLeague], snapshot, 'Súlyok alkalmazása');
        if (isStale(runId)) return;
        weightDraftRef.current = null;
        setWeightDraftVersion((version) => version + 1);
        persist(commit(next));
        toast.success('Csapat súlyok rögzítve és predikciók újraszámolva!');
      } catch (e) {
        logDiagnostic('error', `Súlymentés hiba: ${errorMessage(e)}`);
        toast.error('A súlyok nem kerültek mentésre; a szerkesztett értékek megmaradtak.');
      }
    });
  }, [commit, isStale, logDiagnostic, persist, report, runPipelineForLeagues, withPipelineLock]);

  const updateSettings = useCallback(
    async (patch: Partial<WinmixSettings>) => {
      const current = stateRef.current.settings;
      const scopeChanged =
      patch.historyScope !== undefined &&
      patch.historyScope !== current.historyScope;

      if (scopeChanged) {
        const ok = await dialogs.confirm(
          'Az előzmény-hatókör módosítása megváltoztatja az as-of jellemzőket ' +
          'és a predikciókat minden ligában — újra kell számolni a teljes ' +
          'pipeline-t. Folytatod?'
        );
        if (!ok) return;
        await withPipelineLock(async (runId) => {
          const snapshot = { ...stateRef.current, settings: { ...current, ...patch } };
          report({ label: 'Előzmény-hatókör alkalmazása és teljes újraépítés…', pct: 0 }, true);
          try {
            const next = await runPipelineForLeagues(
              LEAGUES, snapshot, 'Előzmény-hatókör újraépítés', { forceFullRebuild: true }
            );
            if (isStale(runId)) return;
            persist(commit(next));
            toast.success(`Előzmény-hatókör: ${patch.historyScope === 'season-only' ? 'csak szezonon belüli' : 'liga-szintű kumulatív'}.`);
          } catch (e) {
            logDiagnostic('error', `Előzmény-hatókör mentési hiba: ${errorMessage(e)}`);
            toast.error('A beállítás nem került mentésre, mert az újraszámítás sikertelen volt.');
          }
        });
        return;
      }

      persist(commit({ settings: { ...current, ...patch } }));
    },
    [commit, dialogs, isStale, logDiagnostic, persist, report, runPipelineForLeagues, withPipelineLock]
  );

  /* -------------------------- Export / Import -------------------------- */

  const exportJson = useCallback(async () => {
    flushPersist();
    const snapshot = stateRef.current;
    if (snapshot.seasons.length === 0) {
      await dialogs.alert('Nincs mentett bajnokság.');
      return;
    }

    const payload = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      settings: snapshot.settings,
      calibration: snapshot.calibration,
      teamWeights: snapshot.teamWeights,
      manualWeightOverrides: snapshot.manualWeightOverrides,
      teamAliasMap: snapshot.teamAliasMap,
      seasonCounters: snapshot.seasonCounters,
      seasons: snapshot.seasons
    };

    let url: string | null = null;
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json'
      });
      url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `winmix_pipeline_db_v2_${new Date().
      toISOString().
      slice(0, 10)}.json`;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      toast.success('JSON adatbázis exportálva.');
    } catch (e) {
      logDiagnostic('error', `Export hiba: ${errorMessage(e)}`);
      toast.error('Az exportálás nem sikerült.');
    } finally {
      // Revoked on the next frame so the download has a chance to start.
      if (url) {
        const revoked = url;
        window.setTimeout(() => URL.revokeObjectURL(revoked), 0);
      }
    }
  }, [dialogs, flushPersist, logDiagnostic]);

  /**
   * Import is the mirror of {@link exportJson}: it validates the file, then
   * shows a summary so the user can choose between a full replace and a merge.
   * Nothing changes until {@link applyImport} runs.
   */
  const beginImport = useCallback(
    async (file: File) => {
      if (busyRef.current) {
        await dialogs.alert(
          'Egy másik pipeline-művelet még fut, kérlek várj, amíg befejeződik.'
        );
        return;
      }

      let text: string;
      try {
        text = await file.text();
      } catch (e) {
        logDiagnostic('error', `Import fájl olvasási hiba: ${errorMessage(e)}`);
        await dialogs.alert('A fájl nem olvasható be.');
        return;
      }

      const { payload, error, warnings } = parseImportFile(text);
      if (!payload) {
        const message = error ?? 'Az állomány nem importálható.';
        logDiagnostic(
          'error',
          `JSON import elutasítva (${file.name}): ${message}`
        );
        await dialogs.alert(message);
        return;
      }

      if (!mountedRef.current) return;
      setImportPreview({
        fileName: file.name,
        payload,
        warnings,
        current: summarize(stateRef.current, {
          schemaVersion: SCHEMA_VERSION,
          exportedAt: null
        }),
        incoming: summarize(payload, {
          schemaVersion: payload.schemaVersion,
          exportedAt: payload.exportedAt
        })
      });
    },
    [dialogs, logDiagnostic]
  );

  const cancelImport = useCallback(() => setImportPreview(null), []);

  const applyImport = useCallback(
    async (mode: 'merge' | 'replace') => {
      const preview = importPreview;
      if (!preview) return;
      if (busyRef.current) {
        await dialogs.alert(
          'Egy másik pipeline-művelet még fut, kérlek várj, amíg befejeződik.'
        );
        return;
      }

      // A replace is destructive; make sure it is intentional.
      if (mode === 'replace') {
        const ok = await dialogs.confirm(
          'A felülírás törli a jelenlegi adatbázist ' +
          `(${preview.current.seasons} szezon) és a betöltött fájl ` +
          `tartalmával helyettesíti (${preview.incoming.seasons} szezon). ` +
          'Folytatod?'
        );
        if (!ok) return;
      }

      flushPersist();

      await withPipelineLock(async (runId) => {
        report({ label: 'JSON adatbázis betöltése…', pct: 0 }, true);
        try {
          const snapshot = stateRef.current;
          let added = preview.payload.seasons.length;
          let skipped = 0;

          let slices;
          if (mode === 'replace') {
            slices = replaceWithPayload(preview.payload);
          } else {
            const merged = mergeWithPayload(
              {
                seasons: snapshot.seasons,
                teamWeights: snapshot.teamWeights,
                manualWeightOverrides: snapshot.manualWeightOverrides,
                teamAliasMap: snapshot.teamAliasMap,
                seasonCounters: snapshot.seasonCounters,
                calibration: snapshot.calibration,
                settings: snapshot.settings
              },
              preview.payload
            );
            added = merged.addedSeasons;
            skipped = merged.skippedSeasons;
            slices = merged;
          }

          let working: DomainState = {
            ...snapshot,
            seasons: slices.seasons,
            teamWeights: slices.teamWeights,
            manualWeightOverrides: slices.manualWeightOverrides,
            teamAliasMap: slices.teamAliasMap,
            seasonCounters: slices.seasonCounters,
            calibration: slices.calibration,
            settings: slices.settings,
            selectedSeasonId:
            mode === 'replace' ? null : snapshot.selectedSeasonId
          };

          report({ label: 'Import utáni pipeline számítás…', pct: 10 }, true);
          working = await runPipelineForLeagues(
            LEAGUES,
            working,
            'Import utáni pipeline'
          );
          if (isStale(runId)) return;

          weightDraftRef.current = null;
          setWeightDraftVersion((version) => version + 1);
          persist(commit(working));
          if (mountedRef.current) setImportPreview(null);

          for (const w of preview.warnings) logDiagnostic('warn', w);
          logDiagnostic(
            'info',
            `JSON import (${mode === 'replace' ? 'felülírás' : 'összefűzés'}) ` +
            `kész: ${added} szezon betöltve` + (
            skipped > 0 ? `, ${skipped} kihagyva (duplikátum)` : '') +
            ` — ${preview.fileName}`
          );
          toast.success(
            mode === 'replace' ?
            `Adatbázis felülírva: ${added} szezon.` :
            `${added} szezon összefűzve${
            skipped > 0 ? ` (${skipped} duplikátum kihagyva)` : ''}.`

          );
        } catch (e) {
          logDiagnostic('error', `JSON import hiba: ${errorMessage(e)}`);
          toast.error(
            'Az adatbázis betöltése hibára futott — részletek a diagnosztikai naplóban.'
          );
        }
      });
    },
    [
    commit,
    dialogs,
    flushPersist,
    importPreview,
    isStale,
    logDiagnostic,
    persist,
    report,
    runPipelineForLeagues,
    withPipelineLock]

  );

  /* --------------------------- Round building -------------------------- */

  const setFixtureTeam = useCallback(
    (fixtureId: string, side: 'home' | 'away', key: string | null) => {
      const { round } = stateRef.current;
      const target = round.fixtures.find((f) => f.id === fixtureId);
      if (!target) return;

      const fixtures = round.fixtures.map((fixture) => {
        if (fixture.id === fixtureId) {
          return side === 'home' ?
          { ...fixture, homeKey: key } :
          { ...fixture, awayKey: key };
        }
        // A team may appear at most once per league column.
        if (key && fixture.league === target.league) {
          if (fixture.homeKey === key || fixture.awayKey === key) {
            return {
              ...fixture,
              homeKey: fixture.homeKey === key ? null : fixture.homeKey,
              awayKey: fixture.awayKey === key ? null : fixture.awayKey
            };
          }
        }
        return fixture;
      });

      commit({ round: { ...round, fixtures } });
      persistSoon();
    },
    [commit, persistSoon]
  );

  const clearFixture = useCallback(
    (fixtureId: string) => {
      const { round } = stateRef.current;
      commit({
        round: {
          ...round,
          fixtures: round.fixtures.map((fixture) =>
          fixture.id === fixtureId ?
          { ...fixture, homeKey: null, awayKey: null } :
          fixture
          )
        }
      });
      persistSoon();
    },
    [commit, persistSoon]
  );

  const renameRound = useCallback(
    (name: string) => {
      const { round } = stateRef.current;
      commit({ round: { ...round, name } });
      persistSoon();
    },
    [commit, persistSoon]
  );

  const resetRound = useCallback(async () => {
    const ok = await dialogs.confirm(
      'Törlöd a forduló összes párosítását és új, üres fordulót kezdesz?'
    );
    if (!ok) return;
    persist(commit({ round: emptyRound() }));
    toast.success('Forduló kiürítve.');
  }, [commit, dialogs, persist]);

  /* ------------------------------- Ledger ------------------------------ */

  const saveSlip = useCallback(
    (slip: Slip) => {
      const committed = commit({ slips: [slip, ...stateRef.current.slips] });
      persist(committed);
      logDiagnostic(
        'info',
        `Szelvény elmentve: ${slip.roundName} (${slip.lines.length} tipp).`
      );
      toast.success('Szelvény elmentve a Tipp Naplóba.');
    },
    [commit, logDiagnostic, persist]
  );

  const updateSlipLine = useCallback(
    (slipId: string, lineId: string, patch: Partial<SlipLine>) => {
      commit({
        slips: stateRef.current.slips.map((slip) =>
        slip.id === slipId ?
        {
          ...slip,
          lines: slip.lines.map((line) =>
          line.id === lineId ? { ...line, ...patch } : line
          )
        } :
        slip
        )
      });
      persistSoon();
    },
    [commit, persistSoon]
  );

  const deleteSlip = useCallback(
    async (slipId: string) => {
      const slip = stateRef.current.slips.find((s) => s.id === slipId);
      if (!slip) return;
      const ok = await dialogs.confirm(
        `Törlöd a következő szelvényt: ${slip.roundName}?`
      );
      if (!ok) return;
      persist(
        commit({
          slips: stateRef.current.slips.filter((s) => s.id !== slipId)
        })
      );
      toast.success('Szelvény törölve.');
    },
    [commit, dialogs, persist]
  );

  const clearLedger = useCallback(async () => {
    if (stateRef.current.slips.length === 0) return;
    const ok = await dialogs.confirm(
      'Törlöd a teljes Tipp Naplót? A mintateljesítmény-súlyok visszaállnak semlegesre.'
    );
    if (!ok) return;
    persist(commit({ slips: [] }));
    toast.success('Tipp Napló törölve.');
  }, [commit, dialogs, persist]);

  /* ----------------------------- Recompute ----------------------------- */

  const recomputeAll = useCallback(
    (message?: string) => recompute(LEAGUES, message),
    [recompute]
  );

  const recomputeLeague = useCallback(
    (league: League, message?: string) => recompute([league], message),
    [recompute]
  );

  /**
   * PHASE 8 — the operator escape hatch, available regardless of schema
   * version. Drops every checkpoint and walks both leagues' full history from
   * scratch. The result is mathematically identical to a resumed run; this
   * exists for the case where the operator does not want to have to trust that.
   */
  const rebuildFromScratch = useCallback(async () => {
    const ok = await dialogs.confirm(
      'Teljes újraépítés: minden checkpoint eldobásra kerül, és a teljes előzmény ' +
      'újraszámolódik mindkét ligára. Az eredmény matematikailag azonos egy ' +
      'inkrementális futással, csak lassabb — elavult vagy gyanús állapot esetén ' +
      'ez a biztos visszaút. Folytatod?'
    );
    if (!ok) return;
    clearCheckpoints();
    setPipelineRuns({});
    logDiagnostic('info', 'Kézi teljes újraépítés: minden checkpoint eldobva.');
    await recompute(
      LEAGUES,
      'Teljes újraépítés lefutott — a checkpointok újraírva.',
      { forceFullRebuild: true }
    );
  }, [dialogs, logDiagnostic, recompute]);

  /* ------------------------- Derived selectors ------------------------- */

  const leagueSeasons = useMemo(
    () =>
    state.seasons.
    filter((s) => s.league === state.currentLeague).
    slice().
    sort(
      (a, b) =>
      (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
      a.seasonIndex - b.seasonIndex
    ),
    [state.seasons, state.currentLeague]
  );

  const leagueMatches = useMemo<MatchRow[]>(
    () => leagueSeasons.flatMap((s) => s.matches),
    [leagueSeasons]
  );

  const selectedSeason = useMemo(
    () => state.seasons.find((s) => s.id === state.selectedSeasonId) ?? null,
    [state.seasons, state.selectedSeasonId]
  );

  const patternWeights = useMemo(
    () => patternWeightsFromSlips(state.slips),
    [state.slips]
  );

  /**
   * PHASE 6 — signalled vs. observed, per market. Diagnostic only: it feeds
   * the Pipeline Audit panel and nothing else. No lambda, baseline or weight
   * is derived from it.
   */
  const marketFeedback = useMemo(
    () => computeMarketFeedback(state.slips),
    [state.slips]
  );

  /* ------------------------------ Surface ------------------------------ */

  return useMemo(
    () => ({
      // state
      seasons: state.seasons,
      currentLeague: state.currentLeague,
      selectedSeasonId: state.selectedSeasonId,
       teamWeights: weightDraftRef.current?.weights ?? state.teamWeights,
       manualWeightOverrides: weightDraftRef.current?.manualOverrides ?? state.manualWeightOverrides,
      teamAliasMap: state.teamAliasMap,
      seasonCounters: state.seasonCounters,
      calibration: state.calibration,
      settings: state.settings,
      round: state.round,
      slips: state.slips,

      // derived
      leagueSeasons,
      leagueMatches,
      selectedSeason,
      patternWeights,
      marketFeedback,
      hasData: state.seasons.length > 0,

      // status
      storageBackend,
      storageWarning,
      diagnostics,
      isComputing,
      isReady,
      uploadResult,
      importPreview,
      recoveryNotice,
      pipelineRuns,

      // actions
      setLeague,
      selectSeason,
      deleteSeason,
      pruneOldestSeason,
      clearAll,
      importFiles,
      dismissUploadResult,
      dismissRecoveryNotice,
      setWeight,
      saveWeights,
      updateSettings,
      recomputeAll,
      recomputeLeague,
      rebuildFromScratch,
      exportJson,
      beginImport,
      cancelImport,
      applyImport,
      setFixtureTeam,
      clearFixture,
      renameRound,
      resetRound,
      saveSlip,
      updateSlipLine,
      deleteSlip,
      clearLedger,
      clearDiagnostics,
      flushPersist
    }),
    [
    state,
    weightDraftVersion,
    leagueSeasons,
    leagueMatches,
    selectedSeason,
    patternWeights,
    marketFeedback,
    storageBackend,
    storageWarning,
    diagnostics,
    isComputing,
    isReady,
    uploadResult,
    importPreview,
    recoveryNotice,
    pipelineRuns,
    setLeague,
    selectSeason,
    deleteSeason,
    pruneOldestSeason,
    clearAll,
    importFiles,
    dismissUploadResult,
    dismissRecoveryNotice,
    setWeight,
    saveWeights,
    updateSettings,
    recomputeAll,
    recomputeLeague,
    rebuildFromScratch,
    exportJson,
    beginImport,
    cancelImport,
    applyImport,
    setFixtureTeam,
    clearFixture,
    renameRound,
    resetRound,
    saveSlip,
    updateSlipLine,
    deleteSlip,
    clearLedger,
    clearDiagnostics,
    flushPersist]

  );
}

export type WinmixEngine = ReturnType<typeof useWinmixEngine>;