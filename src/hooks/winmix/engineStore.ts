import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { initialDomainState, resolveSelection } from './helpers';
import type { DomainState } from './types';

/** Handle returned by {@link useEngineStore}. */
export interface EngineStore {
  /** Render-time view of the domain state. */
  state: DomainState;
  /** Always-current state; updated synchronously by {@link EngineStore.commit}. */
  stateRef: MutableRefObject<DomainState>;
  /** False after unmount: gates every post-await state write. */
  mountedRef: MutableRefObject<boolean>;
  /**
   * Applies a patch to the domain state and returns the new snapshot.
   * `stateRef` is updated synchronously so callers can chain reads/writes
   * within a single tick without waiting for React to re-render.
   */
  commit: (patch: Partial<DomainState>) => DomainState;
}

/**
 * Owns the domain state and its single synchronous write point.
 * Side effects: registers the mounted-flag effect (must be the first effect
 * the engine registers, so later cleanups observe the flag consistently).
 */
export function useEngineStore(): EngineStore {
  const [state, setState] = useState<DomainState>(initialDomainState);
  const stateRef = useRef(state);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const commit = useCallback((patch: Partial<DomainState>): DomainState => {
    const next = { ...stateRef.current, ...patch };
    next.selectedSeasonId = resolveSelection(
      next.seasons,
      next.currentLeague,
      next.selectedSeasonId
    );
    stateRef.current = next;
    if (mountedRef.current) setState(next);
    return next;
  }, []);

  return { state, stateRef, mountedRef, commit };
}
