import { useCallback, useEffect, useState, type MutableRefObject } from 'react';
import { LEAGUES } from '../../data/leagues';
import type { StorageBackend } from '../../types/winmix';
import { clearCheckpoints } from '../../utils/checkpointStore';
import { FEATURE_SCHEMA_VERSION } from '../../utils/constants';
import { loadPipelineCache } from '../../utils/pipelineCache';
import { loadPersistedState } from '../../utils/storage';
import { cacheIsAtLeastAsFresh, errorMessage, initialDomainState, persistedToDomain } from './helpers';
import type { DomainState, RecoveryNotice } from './types';
import type { LogDiagnostic } from './useDiagnostics';
import type { PipelineRunner } from './usePipelineRunner';

interface BootDeps {
  mountedRef: MutableRefObject<boolean>;
  storageBackend: StorageBackend;
  commit: (patch: Partial<DomainState>) => DomainState;
  persist: (snapshot: DomainState) => void;
  logDiagnostic: LogDiagnostic;
  runner: Pick<PipelineRunner, 'report' | 'isStale' | 'withPipelineLock' | 'runPipelineForLeagues'>;
}

/**
 * Restores state on mount: localStorage snapshot → IndexedDB cache → backfill
 * of missing pipeline output. Runs exactly once because every dependency is a
 * stable callback; the effect is cancellable and StrictMode-safe (the boot
 * pipeline job takes over the lock by run id instead of blindly releasing it).
 */
export function useBoot({
  mountedRef,
  storageBackend,
  commit,
  persist,
  logDiagnostic,
  runner
}: BootDeps) {
  const [isReady, setIsReady] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState<RecoveryNotice | null>(null);
  const dismissRecoveryNotice = useCallback(() => setRecoveryNotice(null), []);
  const { report, isStale, withPipelineLock, runPipelineForLeagues } = runner;

  useEffect(() => {
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
      /** A quarantined snapshot is reported; the cache must not paper over it. */
      let snapshotCorrupted = false;

      try {
        const outcome = loadPersistedState(storageBackend);
        if (outcome.state) {
          snapshotSavedAt = outcome.state.savedAt ?? null;
          restored = persistedToDomain(outcome.state, restored);
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
            `A mentett állapot nem olvasható (${outcome.error ?? 'ismeretlen hiba'}). ` +
              (outcome.backupKey
                ? `A sérült tartalom megőrizve: ${outcome.backupKey}`
                : 'A sérült tartalmat nem sikerült félretenni.')
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
       * matches, may not fit the storage quota at all. When the cache is valid
       * for the current schema/feature/pipeline versions and at least as fresh
       * as that snapshot, it is authoritative: seasons come back with their
       * predictions, so the recompute below is skipped.
       */
      if (!snapshotCorrupted) {
        try {
          const cached = await loadPipelineCache();
          if (cached && cacheIsAtLeastAsFresh(cached.savedAt, snapshotSavedAt)) {
            restored = persistedToDomain(cached, restored);
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
          logDiagnostic(
            'warn',
            `A pipeline-gyorsítótár nem olvasható, kihagyva: ${errorMessage(e)}`
          );
        }
      }

      if (cancelled) return;
      const committed = commit(restored);
      logDiagnostic('info', 'WinMix Studio v2 betöltve.');

      // Predictions are derived data and intentionally not exported/persisted
      // for every match; backfill anything missing before the UI goes live.
      const needsCompute =
        (schemaRebuild && committed.seasons.length > 0) ||
        committed.seasons.some((s) => s.matches.some((m) => !m.pipeline));

      if (needsCompute) {
        await withPipelineLock(
          async (runId) => {
            report(
              {
                label: schemaRebuild
                  ? 'Feature séma változás — teljes újraépítés…'
                  : 'Predikciók újraszámítása a mentett adatokból…',
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
              if (!cancelled && !isStale(runId)) persist(commit(next));
            } catch (e) {
              logDiagnostic('error', `Induló pipeline számítás hibája: ${errorMessage(e)}`);
            }
          },
          { notifyIfBusy: false, preempt: true }
        );
      }

      if (!cancelled && mountedRef.current) setIsReady(true);
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, [
    commit,
    isStale,
    logDiagnostic,
    mountedRef,
    persist,
    report,
    runPipelineForLeagues,
    storageBackend,
    withPipelineLock
  ]);

  return { isReady, recoveryNotice, dismissRecoveryNotice };
}
