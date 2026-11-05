import { useCallback, useState, type MutableRefObject } from 'react';
import type { DiagnosticEntry, DiagnosticLevel } from '../../types/winmix';

/** Ring-buffer size for the in-memory diagnostics log. */
const DIAGNOSTICS_LIMIT = 200;

export type LogDiagnostic = (level: DiagnosticLevel, message: string) => void;

/**
 * In-memory diagnostics log (newest first, capped). `logDiagnostic` is a
 * no-op after unmount and has a stable identity.
 */
export function useDiagnostics(mountedRef: MutableRefObject<boolean>) {
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);

  const logDiagnostic = useCallback<LogDiagnostic>(
    (level, message) => {
      if (!mountedRef.current) return;
      setDiagnostics((prev) =>
        [{ ts: new Date().toISOString(), level, message }, ...prev].slice(0, DIAGNOSTICS_LIMIT)
      );
    },
    [mountedRef]
  );

  const clearDiagnostics = useCallback(() => setDiagnostics([]), []);

  return { diagnostics, logDiagnostic, clearDiagnostics };
}
