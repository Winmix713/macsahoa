import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import { toast } from 'sonner';
import type { League } from '../../types/winmix';
import { changedWeightLeagues, cloneLeagueRecord, errorMessage } from './helpers';
import type { DomainState, WeightDraft } from './types';
import type { LogDiagnostic } from './useDiagnostics';
import type { PipelineRunner } from './usePipelineRunner';

interface WeightsDeps {
  stateRef: MutableRefObject<DomainState>;
  commit: (patch: Partial<DomainState>) => DomainState;
  persist: (snapshot: DomainState) => void;
  logDiagnostic: LogDiagnostic;
  runner: Pick<PipelineRunner, 'report' | 'isStale' | 'withPipelineLock' | 'runPipelineForLeagues'>;
}

/**
 * Team-weight editing. Edits live in a draft (React state, rendered from) until
 * the pipeline run that applies them succeeds. `draftRef` is only an
 * event-time mirror so async handlers read the newest draft synchronously.
 */
export function useWeights({ stateRef, commit, persist, logDiagnostic, runner }: WeightsDeps) {
  const { report, isStale, withPipelineLock, runPipelineForLeagues } = runner;
  const [draft, setDraft] = useState<WeightDraft | null>(null);
  const draftRef = useRef<WeightDraft | null>(null);

  const resetWeightDraft = useCallback(() => {
    draftRef.current = null;
    setDraft(null);
  }, []);

  const setWeight = useCallback(
    (league: League, key: string, value: number, source: 'manual' | 'automatic' = 'manual') => {
      const current: WeightDraft = draftRef.current ?? {
        weights: stateRef.current.teamWeights,
        manualOverrides: stateRef.current.manualWeightOverrides
      };
      const weights = cloneLeagueRecord<number>(current.weights);
      const manualOverrides = cloneLeagueRecord<number>(current.manualOverrides);
      weights[league][key] = value;
      if (source === 'manual') manualOverrides[league][key] = value;
      else delete manualOverrides[league][key];
      const next: WeightDraft = { weights, manualOverrides };
      draftRef.current = next;
      setDraft(next);
    },
    [stateRef]
  );

  /**
   * Applies the draft and recomputes exactly the leagues it changed (falling
   * back to the active league when the draft is value-identical to the state).
   */
  const saveWeights = useCallback(async () => {
    const pending = draftRef.current;
    if (!pending) return;
    await withPipelineLock(async (runId) => {
      const current = stateRef.current;
      const snapshot: DomainState = {
        ...current,
        teamWeights: pending.weights,
        manualWeightOverrides: pending.manualOverrides
      };
      const changed = changedWeightLeagues(pending, current);
      const leagues = changed.length > 0 ? changed : [snapshot.currentLeague];
      report({ label: 'Súlyok alkalmazása és újraszámolása…', pct: 0 }, true);
      try {
        const next = await runPipelineForLeagues(leagues, snapshot, 'Súlyok alkalmazása');
        if (isStale(runId)) return;
        resetWeightDraft();
        persist(commit(next));
        toast.success('Csapat súlyok rögzítve és predikciók újraszámolva!');
      } catch (e) {
        logDiagnostic('error', `Súlymentés hiba: ${errorMessage(e)}`);
        toast.error('A súlyok nem kerültek mentésre; a szerkesztett értékek megmaradtak.');
      }
    });
  }, [
    commit,
    isStale,
    logDiagnostic,
    persist,
    report,
    resetWeightDraft,
    runPipelineForLeagues,
    stateRef,
    withPipelineLock
  ]);

  return { weightDraft: draft, setWeight, saveWeights, resetWeightDraft };
}
