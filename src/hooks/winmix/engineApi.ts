import type {
  AliasMap,
  CalibrationMap,
  DiagnosticEntry,
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
  WinmixSettings
} from '../../types/winmix';
import type { computeMarketFeedback, patternWeightsFromSlips } from '../../utils/ledger';
import type {
  ImportPreviewState,
  PipelineRunInfo,
  RecoveryNotice,
  UploadResult
} from './types';

/**
 * Public surface of `useWinmixEngine()`. Keys, types and callback semantics are
 * identical to the pre-refactor inferred return type; `WinmixEngine` aliases it.
 */
export interface UseWinmixEngineReturn {
  // state
  seasons: Season[];
  currentLeague: League;
  selectedSeasonId: string | null;
  /** The pending draft while weights are being edited, else the committed map. */
  teamWeights: WeightMap;
  manualWeightOverrides: WeightMap;
  teamAliasMap: AliasMap;
  seasonCounters: SeasonCounters;
  calibration: CalibrationMap;
  settings: WinmixSettings;
  round: FixtureRound;
  slips: Slip[];

  // derived
  leagueSeasons: Season[];
  leagueMatches: MatchRow[];
  selectedSeason: Season | null;
  patternWeights: ReturnType<typeof patternWeightsFromSlips>;
  marketFeedback: ReturnType<typeof computeMarketFeedback>;
  hasData: boolean;

  // status
  storageBackend: StorageBackend;
  storageWarning: string | null;
  diagnostics: DiagnosticEntry[];
  isComputing: boolean;
  isReady: boolean;
  uploadResult: UploadResult | null;
  importPreview: ImportPreviewState | null;
  recoveryNotice: RecoveryNotice | null;
  pipelineRuns: Partial<Record<League, PipelineRunInfo>>;

  // actions
  setLeague: (league: League) => void;
  selectSeason: (id: string) => void;
  deleteSeason: (id: string) => Promise<void>;
  pruneOldestSeason: () => Promise<void>;
  clearAll: () => Promise<void>;
  importFiles: (fileList: FileList | File[], mode: LeagueMode) => Promise<void>;
  dismissUploadResult: () => void;
  dismissRecoveryNotice: () => void;
  setWeight: (
    league: League,
    key: string,
    value: number,
    source?: 'manual' | 'automatic'
  ) => void;
  saveWeights: () => Promise<void>;
  updateSettings: (patch: Partial<WinmixSettings>) => Promise<void>;
  recomputeAll: (message?: string) => Promise<void>;
  recomputeLeague: (league: League, message?: string) => Promise<void>;
  rebuildFromScratch: () => Promise<void>;
  exportJson: () => Promise<void>;
  beginImport: (file: File) => Promise<void>;
  cancelImport: () => void;
  applyImport: (mode: 'merge' | 'replace') => Promise<void>;
  setFixtureTeam: (fixtureId: string, side: 'home' | 'away', key: string | null) => void;
  clearFixture: (fixtureId: string) => void;
  renameRound: (name: string) => void;
  resetRound: () => Promise<void>;
  saveSlip: (slip: Slip) => void;
  updateSlipLine: (slipId: string, lineId: string, patch: Partial<SlipLine>) => void;
  deleteSlip: (slipId: string) => Promise<void>;
  clearLedger: () => Promise<void>;
  clearDiagnostics: () => void;
  flushPersist: () => void;
}
