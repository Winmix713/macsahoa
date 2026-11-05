import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { StorageBackend } from '../../types/winmix';
import {
  FEATURE_SCHEMA_VERSION,
  PIPELINE_CONTRACT_VERSION,
  SCHEMA_VERSION,
  STORAGE_SOFT_CAP_BYTES
} from '../../utils/constants';
import { savePipelineCache } from '../../utils/pipelineCache';
import { detectStorageBackend, savePersistedState } from '../../utils/storage';
import { errorMessage, formatMb, runDetached, toPersistedSlice } from './helpers';
import type { DomainState, PersistedSlice } from './types';
import type { LogDiagnostic } from './useDiagnostics';

/** Idle window before a debounced snapshot write is flushed. */
const PERSIST_DEBOUNCE_MS = 400;
/** Above this many matches a save is deferred to an idle callback. */
const IDLE_PERSIST_MATCH_THRESHOLD = 5000;

interface PendingIdleWrite {
  handle: number;
  seq: number;
  slice: PersistedSlice;
}

interface PersistenceDeps {
  stateRef: MutableRefObject<DomainState>;
  mountedRef: MutableRefObject<boolean>;
  logDiagnostic: LogDiagnostic;
}

/**
 * Snapshot persistence (localStorage + IndexedDB mirror).
 *
 * Write ordering is monotonic: every `persist` call takes a sequence number
 * and a write whose number is no longer the newest is dropped, so a deferred
 * idle save can never overwrite a newer synchronous one. A queued idle save is
 * also written synchronously on `pagehide` / unmount instead of being lost.
 */
export function usePersistence({ stateRef, mountedRef, logDiagnostic }: PersistenceDeps) {
  const [storageBackend] = useState<StorageBackend>(detectStorageBackend);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  const latestSeq = useRef(0);
  const pendingIdle = useRef<PendingIdleWrite | null>(null);
  const persistTimer = useRef<number | null>(null);

  const writeSlice = useCallback(
    (slice: PersistedSlice, seq: number) => {
      if (seq !== latestSeq.current) return; // superseded by a newer persist()
      const result = savePersistedState(storageBackend, slice);
      runDetached(
        () =>
          savePipelineCache({
            schemaVersion: SCHEMA_VERSION,
            featureSchemaVersion: FEATURE_SCHEMA_VERSION,
            pipelineContractVersion: PIPELINE_CONTRACT_VERSION,
            savedAt: new Date().toISOString(),
            ...slice
          }),
        (e) => logDiagnostic('warn', `Pipeline-gyorsítótár mentési hiba: ${errorMessage(e)}`)
      );
      if (result.error) {
        logDiagnostic('error', `Állapot mentési hiba: ${result.error}`);
        return;
      }
      if (!mountedRef.current) return;
      setStorageWarning(
        result.sizeBytes > STORAGE_SOFT_CAP_BYTES
          ? `A mentett állapot mérete (${formatMb(result.sizeBytes)} MB) ` +
              `közelít a tárolási korláthoz. Fontold meg a legrégebbi ` +
              `szezon(ok) törlését.`
          : null
      );
    },
    [logDiagnostic, mountedRef, storageBackend]
  );

  const cancelPendingIdle = useCallback(() => {
    const pending = pendingIdle.current;
    if (!pending) return;
    pendingIdle.current = null;
    if (typeof cancelIdleCallback !== 'undefined') cancelIdleCallback(pending.handle);
  }, []);

  /** Writes a queued idle save right now (it is still the newest, or it is dropped). */
  const flushPendingIdle = useCallback(() => {
    const pending = pendingIdle.current;
    if (!pending) return;
    cancelPendingIdle();
    writeSlice(pending.slice, pending.seq);
  }, [cancelPendingIdle, writeSlice]);

  const persist = useCallback(
    (snapshot: DomainState) => {
      const slice = toPersistedSlice(snapshot);
      const seq = ++latestSeq.current;
      cancelPendingIdle(); // a newer snapshot supersedes any queued idle write

      const matchCount = slice.seasons.reduce((sum, s) => sum + s.matches.length, 0);
      if (matchCount > IDLE_PERSIST_MATCH_THRESHOLD && typeof requestIdleCallback !== 'undefined') {
        const handle = requestIdleCallback(
          () => {
            pendingIdle.current = null;
            writeSlice(slice, seq);
          },
          { timeout: 2000 }
        );
        pendingIdle.current = { handle, seq, slice };
      } else {
        writeSlice(slice, seq);
      }
    },
    [cancelPendingIdle, writeSlice]
  );

  /** Writes any debounced or idle-queued snapshot immediately. */
  const flushPersist = useCallback(() => {
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
      persist(stateRef.current);
    }
    flushPendingIdle();
  }, [flushPendingIdle, persist, stateRef]);

  /**
   * Round editing and score entry fire on every keystroke, so the (potentially
   * multi-megabyte) snapshot is written at most once per idle burst.
   */
  const persistSoon = useCallback(() => {
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
    }
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null;
      persist(stateRef.current);
    }, PERSIST_DEBOUNCE_MS);
  }, [persist, stateRef]);

  // Never lose a debounced write to unmount or tab teardown. `pagehide` is
  // used instead of `beforeunload` because it also fires on mobile Safari.
  useEffect(() => {
    window.addEventListener('pagehide', flushPersist);
    return () => {
      window.removeEventListener('pagehide', flushPersist);
      flushPersist();
    };
  }, [flushPersist]);

  return { storageBackend, storageWarning, persist, persistSoon, flushPersist };
}
