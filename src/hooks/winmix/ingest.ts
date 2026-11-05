import { LEAGUE_SEASON_PREFIX } from '../../data/leagues';
import type {
  AliasMap,
  League,
  LeagueMode,
  Season,
  SeasonCounters,
  WeightMap
} from '../../types/winmix';
import { DEFAULT_WEIGHT, EXPECTED_MATCH_COUNT, MATCH_COUNT_TOLERANCE } from '../../utils/constants';
import {
  contentHashForMatches,
  dedupeMatches,
  detectLeagueFromMatches,
  finalizeMatchOrder,
  parseCsvText
} from '../../utils/csv';
import { canon } from '../../utils/teams';
import {
  cloneLeagueRecord,
  makeSeasonId,
  makeSourceFileId,
  summarizeSkipped
} from './helpers';

export interface IngestBase {
  seasons: Season[];
  teamWeights: WeightMap;
  teamAliasMap: AliasMap;
  seasonCounters: SeasonCounters;
  allowDuplicateImport: boolean;
}

export interface IngestResult {
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
export function ingestCsvFiles(
  base: IngestBase,
  files: File[],
  texts: Array<string | null | undefined>,
  mode: LeagueMode,
  onFileStart: (file: File, index: number) => void
): IngestResult {
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
      const skipDetail = parsed.skippedRows.length
        ? ` Kihagyott sorok: ${parsed.skippedRows.length} (pl.: ${summarizeSkipped(parsed.skippedRows)}).`
        : '';
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
      detectNote = ` (auto-detektálva, bizonyosság: ${(det.confidence * 100).toFixed(0)}%)`;
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
      `ℹ️ "${file.name}": ${parsed.stats.accepted} / ${parsed.stats.dataRows} sor átvéve` +
        (parsed.stats.rejected > 0 ? `, ${parsed.stats.rejected} elutasítva` : '') +
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
