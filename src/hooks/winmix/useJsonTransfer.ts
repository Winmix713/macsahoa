import { useCallback, useState, type MutableRefObject } from 'react';
import { toast } from 'sonner';
import { useDialogs } from '../../contexts/DialogContext';
import { LEAGUES } from '../../data/leagues';
import { SCHEMA_VERSION } from '../../utils/constants';
import {
  mergeWithPayload,
  parseImportFile,
  replaceWithPayload,
  summarize
} from '../../utils/importJson';
import { errorMessage } from './helpers';
import type { DomainState, ImportPreviewState } from './types';
import type { LogDiagnostic } from './useDiagnostics';
import type { PipelineRunner } from './usePipelineRunner';

/** Delay before the export object URL is revoked, so the download can start. */
const REVOKE_URL_DELAY_MS = 1000;

const BUSY_MESSAGE = 'Egy másik pipeline-művelet még fut, kérlek várj, amíg befejeződik.';

interface JsonTransferDeps {
  stateRef: MutableRefObject<DomainState>;
  commit: (patch: Partial<DomainState>) => DomainState;
  persist: (snapshot: DomainState) => void;
  flushPersist: () => void;
  mountedRef: MutableRefObject<boolean>;
  logDiagnostic: LogDiagnostic;
  resetWeightDraft: () => void;
  runner: Pick<
    PipelineRunner,
    'report' | 'isStale' | 'isPipelineBusy' | 'withPipelineLock' | 'runPipelineForLeagues'
  >;
}

/**
 * JSON database export and the two-step import (validate + preview, then the
 * user's replace/merge choice). Nothing changes until `applyImport` runs.
 */
export function useJsonTransfer({
  stateRef,
  commit,
  persist,
  flushPersist,
  mountedRef,
  logDiagnostic,
  resetWeightDraft,
  runner
}: JsonTransferDeps) {
  const dialogs = useDialogs();
  const { report, isStale, isPipelineBusy, withPipelineLock, runPipelineForLeagues } = runner;
  const [importPreview, setImportPreview] = useState<ImportPreviewState | null>(null);

  /**
   * Exports the database as JSON. NOTE: `slips` and `round` are deliberately
   * not part of the export format (unchanged; see the refactor report).
   */
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
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `winmix_pipeline_db_v2_${new Date().toISOString().slice(0, 10)}.json`;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      toast.success('JSON adatbázis exportálva.');
    } catch (e) {
      logDiagnostic('error', `Export hiba: ${errorMessage(e)}`);
      toast.error('Az exportálás nem sikerült.');
    } finally {
      // Revoked after a short delay so the browser can start the download first.
      if (url) {
        const revoked = url;
        window.setTimeout(() => URL.revokeObjectURL(revoked), REVOKE_URL_DELAY_MS);
      }
    }
  }, [dialogs, flushPersist, logDiagnostic, stateRef]);

  const beginImport = useCallback(
    async (file: File) => {
      if (isPipelineBusy()) {
        await dialogs.alert(BUSY_MESSAGE);
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
        logDiagnostic('error', `JSON import elutasítva (${file.name}): ${message}`);
        await dialogs.alert(message);
        return;
      }

      if (!mountedRef.current) return;
      setImportPreview({
        fileName: file.name,
        payload,
        warnings,
        current: summarize(stateRef.current, { schemaVersion: SCHEMA_VERSION, exportedAt: null }),
        incoming: summarize(payload, {
          schemaVersion: payload.schemaVersion,
          exportedAt: payload.exportedAt
        })
      });
    },
    [dialogs, isPipelineBusy, logDiagnostic, mountedRef, stateRef]
  );

  const cancelImport = useCallback(() => setImportPreview(null), []);

  const applyImport = useCallback(
    async (mode: 'merge' | 'replace') => {
      const preview = importPreview;
      if (!preview) return;
      if (isPipelineBusy()) {
        await dialogs.alert(BUSY_MESSAGE);
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

          let slices: ReturnType<typeof replaceWithPayload> | ReturnType<typeof mergeWithPayload>;
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
            selectedSeasonId: mode === 'replace' ? null : snapshot.selectedSeasonId
          };

          report({ label: 'Import utáni pipeline számítás…', pct: 10 }, true);
          working = await runPipelineForLeagues(LEAGUES, working, 'Import utáni pipeline');
          if (isStale(runId)) return;

          resetWeightDraft();
          persist(commit(working));
          if (mountedRef.current) setImportPreview(null);

          for (const w of preview.warnings) logDiagnostic('warn', w);
          logDiagnostic(
            'info',
            `JSON import (${mode === 'replace' ? 'felülírás' : 'összefűzés'}) ` +
              `kész: ${added} szezon betöltve` +
              (skipped > 0 ? `, ${skipped} kihagyva (duplikátum)` : '') +
              ` — ${preview.fileName}`
          );
          toast.success(
            mode === 'replace'
              ? `Adatbázis felülírva: ${added} szezon.`
              : `${added} szezon összefűzve${
                  skipped > 0 ? ` (${skipped} duplikátum kihagyva)` : ''
                }.`
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
      isPipelineBusy,
      isStale,
      logDiagnostic,
      mountedRef,
      persist,
      report,
      resetWeightDraft,
      runPipelineForLeagues,
      stateRef,
      withPipelineLock
    ]
  );

  return { importPreview, exportJson, beginImport, cancelImport, applyImport };
}
