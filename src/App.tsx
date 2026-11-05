import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Toaster, toast } from 'sonner';

import { fetchRemoteSeasonFiles } from './utils/remoteSeasons';
import {
  fetchCloudSeasonList,
  fetchCloudSeasonsConcurrently,
  fetchCurrentSealedVersion,
  isCloudTierConfigured,
} from './utils/supabaseTier';
import { checkCloudFreshness, writeCloudMarker } from './utils/cloudFreshness';

import { CloudTierProvider } from './contexts/CloudTierContext';
import { DialogProvider } from './contexts/DialogContext';
import { WinmixProvider, useWinmix } from './contexts/WinmixContext';

import { ImportPreviewModal } from './components/winmix/ImportPreviewModal';
import { NavRail } from './components/winmix/NavRail';
import { StatusBar } from './components/winmix/StatusBar';
import { TopBar } from './components/winmix/TopBar';

import { useScreenInit } from './useScreenInit.js';

import type { ViewKey } from './types/winmix';

/* ==========================================================================
 * Lazy page imports
 * ========================================================================== */

const DataStudio = lazy(() =>
  import('./pages/DataStudio').then((m) => ({ default: m.DataStudio }))
);
const FixturePredictor = lazy(() =>
  import('./pages/FixturePredictor').then((m) => ({ default: m.FixturePredictor }))
);
const HeadToHead = lazy(() =>
  import('./pages/HeadToHead').then((m) => ({ default: m.HeadToHead }))
);
const LeagueAnalyzer = lazy(() =>
  import('./pages/LeagueAnalyzer').then((m) => ({ default: m.LeagueAnalyzer }))
);
const PipelineAudit = lazy(() =>
  import('./pages/PipelineAudit').then((m) => ({ default: m.PipelineAudit }))
);
const PipelineOperationsDashboard = lazy(() =>
  import('./pages/PipelineOperationsDashboard').then((m) => ({
    default: m.PipelineOperationsDashboard,
  }))
);
const PredictionLedger = lazy(() =>
  import('./pages/PredictionLedger').then((m) => ({ default: m.PredictionLedger }))
);

/* ==========================================================================
 * View validation
 * ========================================================================== */

const VALID_VIEWS = new Set<ViewKey>([
  'dashboard',
  'operations',
  'pipeline',
  'league',
  'h2h',
  'predictor',
  'ledger',
]);

function isViewKey(value: unknown): value is ViewKey {
  return typeof value === 'string' && VALID_VIEWS.has(value as ViewKey);
}

function toViewKey(value: unknown): ViewKey {
  return isViewKey(value) ? value : 'dashboard';
}

/* ==========================================================================
 * Lazy-page loading fallback
 * ========================================================================== */

function PageLoadingSpinner() {
  return (
    <div
      role="status"
      aria-label="Betöltés…"
      className="flex h-64 w-full items-center justify-center text-muted-foreground"
    >
      <span aria-hidden="true" className="animate-spin text-2xl">
        ⟳
      </span>

      <span className="sr-only">Az oldal betöltése folyamatban…</span>
    </div>
  );
}

/* ==========================================================================
 * Studio Shell
 * ========================================================================== */

type CloudLoadMode = 'auto' | 'manual';

function StudioShell() {
  const screenInit = useScreenInit();

  const [view, setView] = useState<ViewKey>(() => toViewKey(screenInit?.view));

  const {
    currentLeague,
    setLeague,
    recomputeAll,
    clearAll,
    exportJson,
    importPreview,
    beginImport,
    cancelImport,
    applyImport,
    importFiles,
    isComputing,
    isReady,
    hasData,
  } = useWinmix();

  const [loadingMatches, setLoadingMatches] = useState(false);

  /**
   * Synchronous mutex shared by the automatic bootstrap, the manual button
   * and the "new version" toast action. ref.current changes synchronously,
   * so two fast triggers can never run two downloads at once.
   */
  const loadingMatchesRef = useRef(false);
  const cloudBootstrapAttemptedRef = useRef(false);
  const freshnessCheckedRef = useRef(false);

  /* ------------------------------------------------------------------------
   * Single source of truth for loading data from Supabase.
   *
   * - 'auto'   : runs on an empty browser. Silent if the cloud has nothing
   *              yet; no success toast.
   * - 'manual' : runs from the button / toast action. Every problem is
   *              reported, and success is confirmed.
   *
   * Files go through the same importFiles() pipeline as everywhere else, so
   * parsing, league detection and recalculation stay identical.
   * The cloud marker is written only after a successful import.
   * ---------------------------------------------------------------------- */
  const loadFromCloud = useCallback(
    async (mode: CloudLoadMode) => {
      if (loadingMatchesRef.current) return;

      loadingMatchesRef.current = true;
      setLoadingMatches(true);

      const manual = mode === 'manual';
      const failurePrefix = manual
        ? 'A felhő-adatok betöltése nem sikerült'
        : 'A kezdeti felhő-adatbetöltés sikertelen';

      let toastId: string | number | undefined;

      try {
        if (!isCloudTierConfigured()) {
          if (manual) throw new Error('A Supabase-felhő nincs beállítva.');
          return;
        }

        if (manual) {
          toastId = toast.loading('Felhő-mérkőzések betöltése…');
        }

        const version = await fetchCurrentSealedVersion();
        if (!version) {
          if (manual) throw new Error('Nem található aktuális, lezárt adatverzió.');
          return;
        }

        const seasons = await fetchCloudSeasonList(undefined, version.id);
        if (seasons.length === 0) {
          if (manual) throw new Error('Az aktuális adatverzióhoz nem található szezon.');
          return;
        }

        toastId = toast.loading(`Felhő-adatok letöltése… 0 / ${seasons.length}`, {
          id: toastId,
        });

        // Bounded concurrency, season order preserved, all-or-nothing.
        const downloads = await fetchCloudSeasonsConcurrently(seasons, {
          onProgress: (done, total) => {
            toastId = toast.loading(`Felhő-adatok letöltése… ${done} / ${total}`, {
              id: toastId,
            });
          },
        });

        const files = downloads.map(
          (download) =>
            new File([download.csvText], download.meta.fileName, {
              type: 'text/csv',
            })
        );

        if (files.length === 0) {
          throw new Error('Nem töltődött le egyetlen szezonadat sem.');
        }

        await importFiles(files, 'auto');

        // Remember which server version this browser now holds.
        writeCloudMarker(version);

        toast.dismiss(toastId);
        toastId = undefined;

        if (manual) {
          toast.success(`${files.length} szezon betöltve a Supabase-ből.`);
        }
      } catch (error) {
        if (toastId !== undefined) toast.dismiss(toastId);
        toastId = undefined;

        const message = error instanceof Error ? error.message : 'ismeretlen hiba';
        toast.error(`${failurePrefix}: ${message}`);
      } finally {
        if (toastId !== undefined) toast.dismiss(toastId);
        loadingMatchesRef.current = false;
        setLoadingMatches(false);
      }
    },
    [importFiles]
  );

  /* ------------------------------------------------------------------------
   * Legacy fallback: only used when the Supabase cloud tier is NOT configured
   * (e.g. local development without env variables).
   * ---------------------------------------------------------------------- */
  const loadFromRemoteFiles = useCallback(async () => {
    if (loadingMatchesRef.current) return;

    loadingMatchesRef.current = true;
    setLoadingMatches(true);

    const toastId = toast.loading('Mérkőzés-CSV-k letöltése…');

    try {
      const { files, failures } = await fetchRemoteSeasonFiles((done, total) => {
        toast.loading(`Mérkőzés-CSV-k letöltése… ${done} / ${total}`, {
          id: toastId,
        });
      });

      toast.dismiss(toastId);

      if (files.length === 0) {
        toast.error(
          'Egyetlen mérkőzés-CSV sem töltődött le — ellenőrizd a hálózati kapcsolatot.'
        );
        return;
      }

      if (failures.length > 0) {
        const visibleFailures = failures.slice(0, 3).join(', ');
        const suffix = failures.length > 3 ? ' …' : '';
        toast.warning(`${failures.length} fájl kimaradt: ${visibleFailures}${suffix}`);
      }

      await importFiles(files, 'auto');
    } catch (error) {
      toast.dismiss(toastId);
      const message = error instanceof Error ? error.message : 'ismeretlen hiba';
      toast.error(`A mérkőzések betöltése nem sikerült: ${message}`);
    } finally {
      loadingMatchesRef.current = false;
      setLoadingMatches(false);
    }
  }, [importFiles]);

  /** The "load matches" button: cloud first, legacy files only as fallback. */
  const handleLoadMatches = useCallback(async () => {
    if (isCloudTierConfigured()) {
      await loadFromCloud('manual');
    } else {
      await loadFromRemoteFiles();
    }
  }, [loadFromCloud, loadFromRemoteFiles]);

  /**
   * Automatic bootstrap: a browser with an empty local store hydrates itself
   * from the authoritative Supabase version — no button, no manual step.
   * Runs at most once per session.
   */
  useEffect(() => {
    if (
      !isReady ||
      hasData ||
      cloudBootstrapAttemptedRef.current ||
      !isCloudTierConfigured()
    ) {
      return;
    }
    cloudBootstrapAttemptedRef.current = true;
    void loadFromCloud('auto');
  }, [hasData, isReady, loadFromCloud]);

  /**
   * Once per session, when the data came from the browser cache, check with
   * ONE small request whether the cloud has a newer version. Local data is
   * never replaced automatically; the user decides via the toast action.
   */
  useEffect(() => {
    if (
      !isReady ||
      !hasData ||
      freshnessCheckedRef.current ||
      cloudBootstrapAttemptedRef.current
    ) {
      return;
    }
    freshnessCheckedRef.current = true;

    void checkCloudFreshness().then((newer) => {
      if (!newer) return;

      toast('Új felhő-verzió érhető el.', {
        description: 'A helyi adataid nem változtak, amíg nem frissíted őket.',
        duration: 20000,
        action: {
          label: 'Frissítés',
          onClick: () => void loadFromCloud('manual'),
        },
      });
    });
  }, [hasData, isReady, loadFromCloud]);

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-background md:flex-row">
      <a
        href="#main-content"
        className="
          sr-only
          focus:not-sr-only
          focus:absolute
          focus:left-4
          focus:top-4
          focus:z-[100]
          focus:rounded-lg
          focus:bg-signal
          focus:px-4
          focus:py-2
          focus:text-sm
          focus:font-medium
          focus:text-signal-foreground
          focus:shadow-lg
          focus:outline-none
          focus:ring-2
          focus:ring-signal
          focus:ring-offset-2
          focus:ring-offset-background
        "
      >
        Ugrás a fő tartalomhoz
      </a>

      <NavRail
        view={view}
        onChange={setView}
        onExport={() => void exportJson()}
        onImport={(file) => void beginImport(file)}
      />

      <div className="order-1 flex min-w-0 flex-1 flex-col overflow-hidden md:order-2">
        <TopBar
          league={currentLeague}
          onLeagueChange={setLeague}
          onRunPipeline={() =>
            void recomputeAll(
              'Pipeline v2 walk-forward predikciók + prequenciális kalibráció lefutott!'
            )
          }
          onLoadMatches={() => void handleLoadMatches()}
          onClearAll={() => void clearAll()}
          busy={isComputing}
          loadingMatches={loadingMatches}
        />

        <StatusBar />

        <main
          id="main-content"
          tabIndex={-1}
          className="
            flex-1
            overflow-y-auto
            overflow-x-hidden
            focus:outline-none
          "
        >
          <div
            className="
              mx-auto
              w-full
              max-w-[1600px]
              px-3
              py-4
              sm:px-4
              sm:py-5
              md:px-6
              md:py-6
            "
          >
            <Suspense fallback={<PageLoadingSpinner />}>
              {view === 'dashboard' && <DataStudio />}
              {view === 'operations' && <PipelineOperationsDashboard />}
              {view === 'pipeline' && <PipelineAudit />}
              {view === 'league' && <LeagueAnalyzer />}
              {view === 'h2h' && <HeadToHead />}
              {view === 'predictor' && <FixturePredictor />}
              {view === 'ledger' && <PredictionLedger />}
            </Suspense>
          </div>
        </main>
      </div>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {isComputing
          ? 'Pipeline számítás folyamatban…'
          : loadingMatches
            ? 'Mérkőzés-adatok letöltése folyamatban…'
            : ''}
      </div>

      {importPreview ? (
        <ImportPreviewModal
          fileName={importPreview.fileName}
          current={importPreview.current}
          incoming={importPreview.incoming}
          warnings={importPreview.warnings}
          busy={isComputing}
          onCancel={cancelImport}
          onApply={(mode) => void applyImport(mode)}
        />
      ) : null}
    </div>
  );
}

/* ==========================================================================
 * Root application providers
 * ========================================================================== */

export function App() {
  return (
    <DialogProvider>
      <WinmixProvider>
        <CloudTierProvider>
          <StudioShell />
        </CloudTierProvider>
      </WinmixProvider>

      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: '0.75rem',
            boxShadow: 'var(--shadow-panel-lg)',
            color: 'var(--foreground)',
            fontSize: '12px',
          },
        }}
      />
    </DialogProvider>
  );
}