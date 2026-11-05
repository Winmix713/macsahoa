import { useCallback, useState, type MutableRefObject } from 'react';
import { toast } from 'sonner';
import type { LeagueMode } from '../../types/winmix';
import { syncSeasonsToCloud } from '../../utils/cloudSync';
import { READ_CONCURRENCY } from '../../utils/constants';
import { readFilesWithConcurrency } from '../../utils/csv';
import { isCloudTierConfigured } from '../../utils/supabaseTier';
import { applyRecommendedTeamWeights, errorMessage, pct } from './helpers';
import { ingestCsvFiles } from './ingest';
import type { DomainState, UploadResult } from './types';
import type { LogDiagnostic } from './useDiagnostics';
import type { PipelineRunner } from './usePipelineRunner';

interface IngestionDeps {
  stateRef: MutableRefObject<DomainState>;
  commit: (patch: Partial<DomainState>) => DomainState;
  persist: (snapshot: DomainState) => void;
  logDiagnostic: LogDiagnostic;
  resetWeightDraft: () => void;
  runner: Pick<PipelineRunner, 'report' | 'isStale' | 'withPipelineLock' | 'runPipelineForLeagues'>;
}

/**
 * CSV import: bounded-concurrency read → pure parse/validate/dedupe →
 * recommended weights → pipeline for the touched leagues → commit/persist →
 * optional silent cloud sync.
 */
export function useIngestion({
  stateRef,
  commit,
  persist,
  logDiagnostic,
  resetWeightDraft,
  runner
}: IngestionDeps) {
  const { report, isStale, withPipelineLock, runPipelineForLeagues } = runner;
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);

  const dismissUploadResult = useCallback(() => setUploadResult(null), []);

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
                pct: 60 + ((index + 1) / files.length) * 30
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

          resetWeightDraft();
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
              const synced = working;
              void (async () => {
                try {
                  const result = await syncSeasonsToCloud(
                    synced.seasons,
                    synced.teamWeights,
                    synced.teamAliasMap
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
                  logDiagnostic('warn', `Felhő szinkron hiba: ${errorMessage(e)}`);
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
          toast.error('Az import hibára futott — részletek a diagnosztikai naplóban.');
        }
      });
    },
    [
      commit,
      isStale,
      logDiagnostic,
      persist,
      report,
      resetWeightDraft,
      runPipelineForLeagues,
      stateRef,
      withPipelineLock
    ]
  );

  return { uploadResult, importFiles, dismissUploadResult };
}
