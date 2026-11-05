import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { toast } from 'sonner';
import { useDialogs } from '../../contexts/DialogContext';
import type { CalibrationMap, League } from '../../types/winmix';
import { readCheckpoint, writeCheckpoint } from '../../utils/checkpointStore';
import { runLeaguePipeline } from '../../utils/pipelineRunner';
import { progressStore } from '../progressStore';
import { errorMessage, pct } from './helpers';
import type { DomainState, PipelineRunInfo, ProgressState } from './types';
import type { LogDiagnostic } from './useDiagnostics';

/** Minimum interval between progress re-renders during long jobs. */
const PROGRESS_THROTTLE_MS = 50;

const BUSY_MESSAGE = 'Egy másik pipeline-művelet még fut, kérlek várj, amíg befejeződik.';

export interface LockOptions {
  /** Alert the user when the lock is held (default true). */
  notifyIfBusy?: boolean;
  /** Take the lock over from a running job, which then becomes stale (boot only). */
  preempt?: boolean;
}

export interface RecomputeOptions {
  forceFullRebuild?: boolean;
  /**
   * Applied to the committed state *inside* the lock; its result is the pipeline
   * input and is committed together with the pipeline output, or not at all.
   */
  mutate?: (state: DomainState) => DomainState;
}

interface RunnerDeps {
  stateRef: MutableRefObject<DomainState>;
  mountedRef: MutableRefObject<boolean>;
  commit: (patch: Partial<DomainState>) => DomainState;
  persist: (snapshot: DomainState) => void;
  logDiagnostic: LogDiagnostic;
}

/**
 * Serialises every long-running operation behind a synchronous lock, owns the
 * progress reporter and the "what did the last run do" audit info.
 */
export function usePipelineRunner({
  stateRef,
  mountedRef,
  commit,
  persist,
  logDiagnostic
}: RunnerDeps) {
  const dialogs = useDialogs();
  const dialogsRef = useRef(dialogs);
  useEffect(() => {
    dialogsRef.current = dialogs;
  }, [dialogs]);

  const [isComputing, setIsComputing] = useState(false);
  const [pipelineRuns, setPipelineRuns] = useState<Partial<Record<League, PipelineRunInfo>>>({});

  /**
   * Synchronous mutual-exclusion flag. `isComputing` is React state and
   * therefore always one render behind, so it must never be used as a guard.
   */
  const busyRef = useRef(false);
  /**
   * Monotonic run id. A job whose id no longer matches is stale (superseded or
   * unmounted) and must not commit its result nor release the lock.
   */
  const runIdRef = useRef(0);
  const lastProgressAt = useRef(0);

  const isPipelineBusy = useCallback(() => busyRef.current, []);
  const resetPipelineRuns = useCallback(() => setPipelineRuns({}), []);

  /**
   * Throttled progress reporter. Terminal updates (`force`) always land so the
   * bar never freezes just short of completion.
   */
  const report = useCallback(
    (next: ProgressState | null, force = false) => {
      if (!mountedRef.current) return;
      const now = Date.now();
      if (!force && next && now - lastProgressAt.current < PROGRESS_THROTTLE_MS) return;
      lastProgressAt.current = now;
      progressStore.set(next);
    },
    [mountedRef]
  );

  /** True when the given run has been superseded or the hook unmounted. */
  const isStale = useCallback(
    (runId: number) => !mountedRef.current || runIdRef.current !== runId,
    [mountedRef]
  );

  /**
   * Runs `job` under the lock and always tears the busy/progress UI down —
   * but only if this run still owns the lock.
   *
   * @returns The job's result, or `undefined` if the lock was already held.
   */
  const withPipelineLock = useCallback(
    async <T>(
      job: (runId: number) => Promise<T>,
      options?: LockOptions
    ): Promise<T | undefined> => {
      if (busyRef.current && options?.preempt !== true) {
        if (options?.notifyIfBusy !== false) await dialogsRef.current.alert(BUSY_MESSAGE);
        return undefined;
      }

      busyRef.current = true;
      const runId = ++runIdRef.current;
      setIsComputing(true);
      try {
        return await job(runId);
      } finally {
        if (runIdRef.current === runId) {
          busyRef.current = false;
          if (mountedRef.current) {
            setIsComputing(false);
            progressStore.set(null);
          }
        }
      }
    },
    [mountedRef]
  );

  /**
   * Recomputes the as-of feature/prediction pipeline for `leagues` against
   * `snapshot`, returning a *new* snapshot. Never mutates and never touches
   * domain state, so callers decide when (and whether) to commit.
   *
   * PHASE 8 — the session checkpoint is handed to the pipeline and the fresh
   * one is stored on the way out. The pipeline itself decides whether that
   * checkpoint is trustworthy; a missing or stale one can only cost time,
   * never correctness. `forceFullRebuild` is the operator's manual override.
   */
  const runPipelineForLeagues = useCallback(
    async (
      leagues: readonly League[],
      snapshot: DomainState,
      labelPrefix = 'Pipeline számítás',
      options?: { forceFullRebuild?: boolean }
    ): Promise<DomainState> => {
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
                pct: base + (pct(done, total) * span) / 100
              });
            }
          }).then((result) => ({ league, result }));
        })
      );

      let working = snapshot;
      for (const { league, result } of results) {
        const leagueSeasons = result.seasons.filter((s) => s.league === league);
        const leagueSeasonIds = new Set(leagueSeasons.map((s) => s.id));
        const otherSeasons = working.seasons.filter((s) => !leagueSeasonIds.has(s.id));
        working = { ...working, seasons: [...otherSeasons, ...leagueSeasons] };
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
          result.kind === 'incremental'
            ? `${league}: inkrementális futás — ${result.reusedMatches} meccs a ` +
                `checkpointból újrahasznosítva, ${recomputed} újraszámolva (${result.mode}).`
            : `${league}: teljes újraépítés — ${processed} meccs újraszámolva (${result.mode})` +
                `${result.rebuildReason ? `. Ok: ${result.rebuildReason}` : '.'}`
        );
      }

      if (mountedRef.current) {
        setPipelineRuns((prev) => ({ ...prev, ...runs }));
      }

      return { ...working, calibration };
    },
    [logDiagnostic, mountedRef, report]
  );

  /**
   * Public recompute entry point: runs the pipeline for `leagues`, commits and
   * persists the result, and surfaces failures both as a toast and a
   * diagnostics entry. With `options.mutate` the state change and the
   * recompute are atomic: if the pipeline fails nothing is committed.
   */
  const recompute = useCallback(
    async (leagues: readonly League[], toastMessage?: string, options?: RecomputeOptions) => {
      await withPipelineLock(async (runId) => {
        const forceFullRebuild = options?.forceFullRebuild === true;
        report(
          { label: forceFullRebuild ? 'Teljes újraépítés…' : 'Pipeline számítás…', pct: 0 },
          true
        );
        try {
          const input = options?.mutate ? options.mutate(stateRef.current) : stateRef.current;
          const next = await runPipelineForLeagues(
            leagues,
            input,
            forceFullRebuild ? 'Teljes újraépítés' : 'Pipeline számítás',
            options?.forceFullRebuild === undefined ? undefined : { forceFullRebuild }
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
    [commit, isStale, logDiagnostic, persist, report, runPipelineForLeagues, stateRef, withPipelineLock]
  );

  return {
    isComputing,
    pipelineRuns,
    resetPipelineRuns,
    isPipelineBusy,
    report,
    isStale,
    withPipelineLock,
    runPipelineForLeagues,
    recompute
  };
}

export type PipelineRunner = ReturnType<typeof usePipelineRunner>;
