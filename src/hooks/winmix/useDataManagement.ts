import { useCallback, type MutableRefObject } from 'react';
import { toast } from 'sonner';
import { useDialogs } from '../../contexts/DialogContext';
import { LEAGUES } from '../../data/leagues';
import type { League, Season, WinmixSettings } from '../../types/winmix';
import { clearCheckpoints } from '../../utils/checkpointStore';
import { clearPipelineCache } from '../../utils/pipelineCache';
import {
  emptyAliases,
  emptyCalibration,
  emptyCounters,
  emptyWeights
} from '../../utils/storage';
import { emptyRound } from '../../utils/fixtures';
import { errorMessage, runDetached } from './helpers';
import type { DomainState } from './types';
import type { LogDiagnostic } from './useDiagnostics';
import type { PipelineRunner } from './usePipelineRunner';

interface DataManagementDeps {
  stateRef: MutableRefObject<DomainState>;
  commit: (patch: Partial<DomainState>) => DomainState;
  persist: (snapshot: DomainState) => void;
  flushPersist: () => void;
  logDiagnostic: LogDiagnostic;
  resetWeightDraft: () => void;
  dismissUploadResult: () => void;
  runner: Pick<
    PipelineRunner,
    | 'report'
    | 'isStale'
    | 'withPipelineLock'
    | 'runPipelineForLeagues'
    | 'recompute'
    | 'resetPipelineRuns'
  >;
}

/**
 * League/season navigation, destructive operations, settings and the manual
 * recompute entry points.
 *
 * Every state change that invalidates predictions (delete / prune / clear)
 * runs under the pipeline lock: a concurrent job can neither resurrect deleted
 * data nor be left with stale predictions after a half-applied delete.
 */
export function useDataManagement({
  stateRef,
  commit,
  persist,
  flushPersist,
  logDiagnostic,
  resetWeightDraft,
  dismissUploadResult,
  runner
}: DataManagementDeps) {
  const dialogs = useDialogs();
  const { report, isStale, withPipelineLock, runPipelineForLeagues, recompute, resetPipelineRuns } =
    runner;

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

  /** Delete + recompute as one atomic step (nothing changes if either fails). */
  const removeSeasonAtomically = useCallback(
    (season: Season, toastMessage: string) =>
      recompute([season.league], toastMessage, {
        mutate: (state) => ({
          ...state,
          seasons: state.seasons.filter((s) => s.id !== season.id)
        })
      }),
    [recompute]
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
      await removeSeasonAtomically(season, `${season.name} törölve.`);
    },
    [dialogs, removeSeasonAtomically, stateRef]
  );

  const pruneOldestSeason = useCallback(async () => {
    const oldest = stateRef.current.seasons.reduce<Season | null>(
      (min, s) =>
        !min || (s.createdAt ?? '').localeCompare(min.createdAt ?? '') < 0 ? s : min,
      null
    );
    if (!oldest) return;
    const ok = await dialogs.confirm(
      `Törlöd a legrégebbi szezont (${oldest.name}) a tárhely felszabadításához?`
    );
    if (!ok) return;
    await removeSeasonAtomically(oldest, `${oldest.name} törölve a tárhely felszabadításához.`);
  }, [dialogs, removeSeasonAtomically, stateRef]);

  const clearAll = useCallback(async () => {
    const ok = await dialogs.confirm(
      'Biztosan törölni szeretnéd az összes rögzített adatot? Ez nem vonható vissza.'
    );
    if (!ok) return;
    await withPipelineLock(async () => {
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
      resetWeightDraft();
      flushPersist();
      persist(committed);
      clearCheckpoints();
      // Started after the (empty) mirror write inside persist(), so it wins.
      runDetached(
        () => clearPipelineCache(),
        (e) => logDiagnostic('warn', `Pipeline-gyorsítótár törlési hiba: ${errorMessage(e)}`)
      );
      resetPipelineRuns();
      dismissUploadResult();
      toast.success('Összes adat törölve.');
    });
  }, [
    commit,
    dialogs,
    dismissUploadResult,
    flushPersist,
    logDiagnostic,
    persist,
    resetPipelineRuns,
    resetWeightDraft,
    withPipelineLock
  ]);

  const updateSettings = useCallback(
    async (patch: Partial<WinmixSettings>) => {
      const current = stateRef.current.settings;
      const scopeChanged =
        patch.historyScope !== undefined && patch.historyScope !== current.historyScope;

      if (scopeChanged) {
        const ok = await dialogs.confirm(
          'Az előzmény-hatókör módosítása megváltoztatja az as-of jellemzőket ' +
            'és a predikciókat minden ligában — újra kell számolni a teljes ' +
            'pipeline-t. Folytatod?'
        );
        if (!ok) return;
        await withPipelineLock(async (runId) => {
          const snapshot = { ...stateRef.current, settings: { ...current, ...patch } };
          report(
            { label: 'Előzmény-hatókör alkalmazása és teljes újraépítés…', pct: 0 },
            true
          );
          try {
            const next = await runPipelineForLeagues(
              LEAGUES,
              snapshot,
              'Előzmény-hatókör újraépítés',
              { forceFullRebuild: true }
            );
            if (isStale(runId)) return;
            persist(commit(next));
            toast.success(
              `Előzmény-hatókör: ${
                patch.historyScope === 'season-only'
                  ? 'csak szezonon belüli'
                  : 'liga-szintű kumulatív'
              }.`
            );
          } catch (e) {
            logDiagnostic('error', `Előzmény-hatókör mentési hiba: ${errorMessage(e)}`);
            toast.error(
              'A beállítás nem került mentésre, mert az újraszámítás sikertelen volt.'
            );
          }
        });
        return;
      }

      persist(commit({ settings: { ...current, ...patch } }));
    },
    [commit, dialogs, isStale, logDiagnostic, persist, report, runPipelineForLeagues, stateRef, withPipelineLock]
  );

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
   * scratch. The result is mathematically identical to a resumed run.
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
    resetPipelineRuns();
    logDiagnostic('info', 'Kézi teljes újraépítés: minden checkpoint eldobva.');
    await recompute(LEAGUES, 'Teljes újraépítés lefutott — a checkpointok újraírva.', {
      forceFullRebuild: true
    });
  }, [dialogs, logDiagnostic, recompute, resetPipelineRuns]);

  return {
    setLeague,
    selectSeason,
    deleteSeason,
    pruneOldestSeason,
    clearAll,
    updateSettings,
    recomputeAll,
    recomputeLeague,
    rebuildFromScratch
  };
}
