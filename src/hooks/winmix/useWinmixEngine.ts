import { useMemo } from 'react';
import type { MatchRow } from '../types/winmix';
import { computeMarketFeedback, patternWeightsFromSlips } from '../utils/ledger';
import type { UseWinmixEngineReturn } from './winmix/engineApi';
import { useEngineStore } from './winmix/engineStore';
import { useBoot } from './winmix/useBoot';
import { useDataManagement } from './winmix/useDataManagement';
import { useDiagnostics } from './winmix/useDiagnostics';
import { useIngestion } from './winmix/useIngestion';
import { useJsonTransfer } from './winmix/useJsonTransfer';
import { usePersistence } from './winmix/usePersistence';
import { usePipelineRunner } from './winmix/usePipelineRunner';
import { useRoundAndLedger } from './winmix/useRoundAndLedger';
import { useWeights } from './winmix/useWeights';

export type {
  ImportPreviewState,
  PipelineRunInfo,
  ProgressState,
  RecoveryNotice,
  UploadResult
} from './winmix/types';
export type { UseWinmixEngineReturn } from './winmix/engineApi';

/**
 * Application engine: composes the store, persistence, pipeline runner, boot,
 * ingestion, JSON transfer, weight, data-management and ledger hooks into the
 * one object the UI consumes. Headless — it returns data and callbacks only.
 *
 * Hook order matters: the store (mounted flag) registers its effect first, the
 * persistence flush second, and boot after both, exactly as before the split.
 */
export function useWinmixEngine(): UseWinmixEngineReturn {
  const { state, stateRef, mountedRef, commit } = useEngineStore();
  const { diagnostics, logDiagnostic, clearDiagnostics } = useDiagnostics(mountedRef);
  const persistence = usePersistence({ stateRef, mountedRef, logDiagnostic });
  const { persist, persistSoon, flushPersist, storageBackend, storageWarning } = persistence;
  const runner = usePipelineRunner({ stateRef, mountedRef, commit, persist, logDiagnostic });
  const weights = useWeights({ stateRef, commit, persist, logDiagnostic, runner });
  const { resetWeightDraft } = weights;
  const boot = useBoot({ mountedRef, storageBackend, commit, persist, logDiagnostic, runner });
  const ingestion = useIngestion({ stateRef, commit, persist, logDiagnostic, resetWeightDraft, runner });
  const transfer = useJsonTransfer({
    stateRef,
    commit,
    persist,
    flushPersist,
    mountedRef,
    logDiagnostic,
    resetWeightDraft,
    runner
  });
  const data = useDataManagement({
    stateRef,
    commit,
    persist,
    flushPersist,
    logDiagnostic,
    resetWeightDraft,
    dismissUploadResult: ingestion.dismissUploadResult,
    runner
  });
  const roundLedger = useRoundAndLedger({ stateRef, commit, persist, persistSoon, logDiagnostic });

  /* ------------------------- Derived selectors ------------------------- */

  const leagueSeasons = useMemo(
    () =>
      state.seasons
        .filter((s) => s.league === state.currentLeague)
        .slice()
        .sort(
          (a, b) =>
            (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.seasonIndex - b.seasonIndex
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
  const patternWeights = useMemo(() => patternWeightsFromSlips(state.slips), [state.slips]);
  /** PHASE 6 — signalled vs. observed per market; diagnostic only (Pipeline Audit). */
  const marketFeedback = useMemo(() => computeMarketFeedback(state.slips), [state.slips]);

  /* ------------------------------ Surface ------------------------------ */

  const { weightDraft } = weights;

  return useMemo<UseWinmixEngineReturn>(
    () => ({
      // state
      seasons: state.seasons,
      currentLeague: state.currentLeague,
      selectedSeasonId: state.selectedSeasonId,
      teamWeights: weightDraft?.weights ?? state.teamWeights,
      manualWeightOverrides: weightDraft?.manualOverrides ?? state.manualWeightOverrides,
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
      isComputing: runner.isComputing,
      isReady: boot.isReady,
      uploadResult: ingestion.uploadResult,
      importPreview: transfer.importPreview,
      recoveryNotice: boot.recoveryNotice,
      pipelineRuns: runner.pipelineRuns,

      // actions
      setLeague: data.setLeague,
      selectSeason: data.selectSeason,
      deleteSeason: data.deleteSeason,
      pruneOldestSeason: data.pruneOldestSeason,
      clearAll: data.clearAll,
      importFiles: ingestion.importFiles,
      dismissUploadResult: ingestion.dismissUploadResult,
      dismissRecoveryNotice: boot.dismissRecoveryNotice,
      setWeight: weights.setWeight,
      saveWeights: weights.saveWeights,
      updateSettings: data.updateSettings,
      recomputeAll: data.recomputeAll,
      recomputeLeague: data.recomputeLeague,
      rebuildFromScratch: data.rebuildFromScratch,
      exportJson: transfer.exportJson,
      beginImport: transfer.beginImport,
      cancelImport: transfer.cancelImport,
      applyImport: transfer.applyImport,
      setFixtureTeam: roundLedger.setFixtureTeam,
      clearFixture: roundLedger.clearFixture,
      renameRound: roundLedger.renameRound,
      resetRound: roundLedger.resetRound,
      saveSlip: roundLedger.saveSlip,
      updateSlipLine: roundLedger.updateSlipLine,
      deleteSlip: roundLedger.deleteSlip,
      clearLedger: roundLedger.clearLedger,
      clearDiagnostics,
      flushPersist
    }),
    [
      state, weightDraft, leagueSeasons, leagueMatches, selectedSeason, patternWeights,
      marketFeedback, storageBackend, storageWarning, diagnostics, runner.isComputing,
      runner.pipelineRuns, boot.isReady, boot.recoveryNotice, boot.dismissRecoveryNotice,
      ingestion.uploadResult, ingestion.importFiles, ingestion.dismissUploadResult,
      transfer.importPreview, transfer.exportJson, transfer.beginImport, transfer.cancelImport,
      transfer.applyImport, data.setLeague, data.selectSeason, data.deleteSeason,
      data.pruneOldestSeason, data.clearAll, data.updateSettings, data.recomputeAll,
      data.recomputeLeague, data.rebuildFromScratch, weights.setWeight, weights.saveWeights,
      roundLedger.setFixtureTeam, roundLedger.clearFixture, roundLedger.renameRound,
      roundLedger.resetRound, roundLedger.saveSlip, roundLedger.updateSlipLine,
      roundLedger.deleteSlip, roundLedger.clearLedger, clearDiagnostics, flushPersist
    ]
  );
}

/** Backwards-compatible alias: existing consumers keep importing `WinmixEngine`. */
export type WinmixEngine = UseWinmixEngineReturn;
