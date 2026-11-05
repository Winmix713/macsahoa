import { useCallback, type MutableRefObject } from 'react';
import { toast } from 'sonner';
import { useDialogs } from '../../contexts/DialogContext';
import type { Slip, SlipLine } from '../../types/winmix';
import { emptyRound } from '../../utils/fixtures';
import type { DomainState } from './types';
import type { LogDiagnostic } from './useDiagnostics';

interface RoundAndLedgerDeps {
  stateRef: MutableRefObject<DomainState>;
  commit: (patch: Partial<DomainState>) => DomainState;
  persist: (snapshot: DomainState) => void;
  persistSoon: () => void;
  logDiagnostic: LogDiagnostic;
}

/** Fixture-round editing and the slip ledger (Tipp Napló). */
export function useRoundAndLedger({
  stateRef,
  commit,
  persist,
  persistSoon,
  logDiagnostic
}: RoundAndLedgerDeps) {
  const dialogs = useDialogs();

  /* --------------------------- Round building -------------------------- */

  const setFixtureTeam = useCallback(
    (fixtureId: string, side: 'home' | 'away', key: string | null) => {
      const { round } = stateRef.current;
      const target = round.fixtures.find((f) => f.id === fixtureId);
      if (!target) return;

      const fixtures = round.fixtures.map((fixture) => {
        if (fixture.id === fixtureId) {
          return side === 'home' ? { ...fixture, homeKey: key } : { ...fixture, awayKey: key };
        }
        // A team may appear at most once per league column.
        if (key && fixture.league === target.league) {
          if (fixture.homeKey === key || fixture.awayKey === key) {
            return {
              ...fixture,
              homeKey: fixture.homeKey === key ? null : fixture.homeKey,
              awayKey: fixture.awayKey === key ? null : fixture.awayKey
            };
          }
        }
        return fixture;
      });

      commit({ round: { ...round, fixtures } });
      persistSoon();
    },
    [commit, persistSoon, stateRef]
  );

  const clearFixture = useCallback(
    (fixtureId: string) => {
      const { round } = stateRef.current;
      commit({
        round: {
          ...round,
          fixtures: round.fixtures.map((fixture) =>
            fixture.id === fixtureId ? { ...fixture, homeKey: null, awayKey: null } : fixture
          )
        }
      });
      persistSoon();
    },
    [commit, persistSoon, stateRef]
  );

  const renameRound = useCallback(
    (name: string) => {
      const { round } = stateRef.current;
      commit({ round: { ...round, name } });
      persistSoon();
    },
    [commit, persistSoon, stateRef]
  );

  const resetRound = useCallback(async () => {
    const ok = await dialogs.confirm(
      'Törlöd a forduló összes párosítását és új, üres fordulót kezdesz?'
    );
    if (!ok) return;
    persist(commit({ round: emptyRound() }));
    toast.success('Forduló kiürítve.');
  }, [commit, dialogs, persist]);

  /* ------------------------------- Ledger ------------------------------ */

  const saveSlip = useCallback(
    (slip: Slip) => {
      const committed = commit({ slips: [slip, ...stateRef.current.slips] });
      persist(committed);
      logDiagnostic('info', `Szelvény elmentve: ${slip.roundName} (${slip.lines.length} tipp).`);
      toast.success('Szelvény elmentve a Tipp Naplóba.');
    },
    [commit, logDiagnostic, persist, stateRef]
  );

  const updateSlipLine = useCallback(
    (slipId: string, lineId: string, patch: Partial<SlipLine>) => {
      commit({
        slips: stateRef.current.slips.map((slip) =>
          slip.id === slipId
            ? {
                ...slip,
                lines: slip.lines.map((line) => (line.id === lineId ? { ...line, ...patch } : line))
              }
            : slip
        )
      });
      persistSoon();
    },
    [commit, persistSoon, stateRef]
  );

  const deleteSlip = useCallback(
    async (slipId: string) => {
      const slip = stateRef.current.slips.find((s) => s.id === slipId);
      if (!slip) return;
      const ok = await dialogs.confirm(`Törlöd a következő szelvényt: ${slip.roundName}?`);
      if (!ok) return;
      persist(commit({ slips: stateRef.current.slips.filter((s) => s.id !== slipId) }));
      toast.success('Szelvény törölve.');
    },
    [commit, dialogs, persist, stateRef]
  );

  const clearLedger = useCallback(async () => {
    if (stateRef.current.slips.length === 0) return;
    const ok = await dialogs.confirm(
      'Törlöd a teljes Tipp Naplót? A mintateljesítmény-súlyok visszaállnak semlegesre.'
    );
    if (!ok) return;
    persist(commit({ slips: [] }));
    toast.success('Tipp Napló törölve.');
  }, [commit, dialogs, persist, stateRef]);

  return {
    setFixtureTeam,
    clearFixture,
    renameRound,
    resetRound,
    saveSlip,
    updateSlipLine,
    deleteSlip,
    clearLedger
  };
}
