import type {
  AliasMap,
  CalibrationMap,
  FixtureRound,
  League,
  Season,
  SeasonCounters,
  Slip,
  WeightMap,
  WinmixSettings
} from '../../types/winmix';
import type { ImportPayload, ImportSummary } from '../../utils/importJson';
import type { PipelineRunKind } from '../../utils/pipeline';
import type { PipelineRunMode } from '../../utils/pipelineRunner';

/**
 * The single source of truth for everything persisted to storage, plus the
 * two purely-navigational fields (`currentLeague`, `selectedSeasonId`) that
 * are cheap to recompute and therefore intentionally *not* persisted.
 */
export interface DomainState {
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
export type PersistedSlice = Omit<DomainState, 'currentLeague' | 'selectedSeasonId'>;

/** Outcome of a CSV import batch, surfaced to the upload panel. */
export interface UploadResult {
  added: number;
  warnings: string[];
}

/** Progress bar payload consumed through `progressStore`. */
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

/** Weight edits are drafts until their pipeline run succeeds. */
export interface WeightDraft {
  weights: WeightMap;
  manualOverrides: WeightMap;
}
