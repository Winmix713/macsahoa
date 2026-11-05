import { LEAGUES } from '../../data/leagues';
import type { League, Season, WeightMap } from '../../types/winmix';
import { computeAutoTeamWeights } from '../../utils/autoWeights';
import { emptyRound } from '../../utils/fixtures';
import { defaultSlipMarkets } from '../../utils/marketCatalog';
import {
  DEFAULT_SETTINGS,
  emptyAliases,
  emptyCalibration,
  emptyCounters,
  emptyWeights
} from '../../utils/storage';
import type { DomainState, PersistedSlice, WeightDraft } from './types';

/** Fresh, empty domain state (first launch / "clear all"). Pure. */
export function initialDomainState(): DomainState {
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
export function cacheIsAtLeastAsFresh(
  cacheSavedAt: string,
  snapshotSavedAt: string | null | undefined
): boolean {
  if (!snapshotSavedAt) return true;
  const cache = Date.parse(cacheSavedAt);
  const snapshot = Date.parse(snapshotSavedAt);
  if (!Number.isFinite(cache) || !Number.isFinite(snapshot)) return false;
  return cache >= snapshot;
}

/** Picks exactly the persisted fields out of a full domain state. Pure. */
export function toPersistedSlice(state: DomainState): PersistedSlice {
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
 * Typed replacement for the former `as unknown as DomainState` casts: lays a
 * (possibly partial) persisted payload over `base`. A field missing from the
 * payload keeps the base value instead of becoming `undefined`.
 */
export function persistedToDomain(
  source: Partial<PersistedSlice>,
  base: DomainState = initialDomainState()
): DomainState {
  return {
    ...base,
    seasons: source.seasons ?? base.seasons,
    teamWeights: source.teamWeights ?? base.teamWeights,
    teamAliasMap: source.teamAliasMap ?? base.teamAliasMap,
    seasonCounters: source.seasonCounters ?? base.seasonCounters,
    calibration: source.calibration ?? base.calibration,
    settings: source.settings ?? base.settings,
    manualWeightOverrides: source.manualWeightOverrides ?? base.manualWeightOverrides,
    round: source.round ?? base.round,
    slips: source.slips ?? base.slips
  };
}

/**
 * Keeps `selectedSeasonId` pointing at a season that actually exists in the
 * currently active league; falls back to the first available one.
 */
export function resolveSelection(
  seasons: Season[],
  league: League,
  current: string | null
): string | null {
  const available = seasons.filter((s) => s.league === league);
  if (available.length === 0) return null;
  return available.some((s) => s.id === current) ? current : available[0].id;
}

/**
 * Shallow-clones a per-league record. Driven by {@link LEAGUES} rather than
 * literal keys so a new league requires no edits in this module.
 */
export function cloneLeagueRecord<V>(
  source: Partial<Record<League, Record<string, V>>>
): Record<League, Record<string, V>> {
  const out = {} as Record<League, Record<string, V>>;
  for (const league of LEAGUES) out[league] = { ...(source[league] ?? {}) };
  return out;
}

/** Refreshes only weights that have never been explicitly overridden. */
export function applyRecommendedTeamWeights(
  snapshot: DomainState,
  leagues: readonly League[]
): DomainState {
  const teamWeights = cloneLeagueRecord<number>(snapshot.teamWeights);

  for (const league of leagues) {
    const matches = snapshot.seasons
      .filter((season) => season.league === league)
      .flatMap((season) => season.matches);
    const recommendations = computeAutoTeamWeights(matches, league);

    for (const [key, recommendation] of Object.entries(recommendations)) {
      if (snapshot.manualWeightOverrides[league]?.[key] === undefined) {
        teamWeights[league][key] = recommendation.recommendedWeight;
      }
    }
  }

  return { ...snapshot, teamWeights };
}

function sameRecord(
  a: Readonly<Record<string, number>> | undefined,
  b: Readonly<Record<string, number>> | undefined
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && Object.is(left[key], right[key]));
}

/**
 * Leagues whose weights or manual overrides differ between a draft and the
 * committed state — exactly the leagues whose predictions go stale on save.
 */
export function changedWeightLeagues(
  draft: WeightDraft,
  current: { teamWeights: WeightMap; manualWeightOverrides: WeightMap }
): League[] {
  return LEAGUES.filter(
    (league) =>
      !sameRecord(draft.weights[league], current.teamWeights[league]) ||
      !sameRecord(draft.manualOverrides[league], current.manualWeightOverrides[league])
  );
}

export function makeSeasonId(league: League): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `season_${league}_${uuid}`;
}

/**
 * Stable per-file identity. Combined with the row index this gives every
 * undated row a unique dedupe identity, so genuine repeat fixtures survive.
 */
export function makeSourceFileId(file: File): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

export function summarizeSkipped(
  rows: Array<{ line: number; reason: string }>,
  limit = 3
): string {
  const head = rows
    .slice(0, limit)
    .map((r) => `#${r.line} — ${r.reason}`)
    .join('; ');
  return `${head}${rows.length > limit ? '; …' : ''}`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function formatMb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(2);
}

export function pct(done: number, total: number): number {
  return total > 0 ? (done / total) * 100 : 0;
}

/**
 * Starts fire-and-forget work without ever leaking a rejected promise: both a
 * synchronous throw and an async rejection end up in `onError`. The task
 * itself still starts synchronously, so call ordering is preserved.
 */
export function runDetached(
  task: () => Promise<unknown> | void,
  onError: (error: unknown) => void
): void {
  try {
    void Promise.resolve(task()).catch(onError);
  } catch (error) {
    onError(error);
  }
}
