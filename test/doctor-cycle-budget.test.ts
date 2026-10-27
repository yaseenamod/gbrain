/**
 * cycle_budget_starvation (src/commands/doctor/checks/cycle-budget.ts).
 *
 * Pins:
 *   - no completed autopilot-cycle rows → null (PGLite inline cycles say nothing);
 *   - no budget skips → ok;
 *   - skips that are not consecutive from the newest cycle → ok (streak resets
 *     the moment the phase runs again);
 *   - threshold consecutive skips of one phase → warn naming phase + streak;
 *   - env/opts threshold override;
 *   - the engine wrapper tolerates a missing minion_jobs table.
 */
import { describe, expect, test } from 'bun:test';
import {
  budgetStarvedPhases,
  checkCycleBudgetStarvation,
  computeCycleBudgetStarvationCheck,
  CYCLE_BUDGET_SKIP_REASON,
  type CycleJobRow,
} from '../src/commands/doctor/checks/cycle-budget.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function cycle(skipped: string[], ran: string[] = ['sync']): CycleJobRow {
  return {
    finished_at: new Date().toISOString(),
    result: {
      status: 'partial',
      report: {
        phases: [
          ...ran.map((phase) => ({ phase, status: 'ok', details: {} })),
          ...skipped.map((phase) => ({ phase, status: 'skipped', details: { reason: CYCLE_BUDGET_SKIP_REASON } })),
          { phase: 'enrich', status: 'skipped', details: { reason: 'no_provider' } }, // other skip reasons never count
        ],
      },
    },
  };
}

describe('budgetStarvedPhases', () => {
  test('extracts only insufficient_cycle_budget skips; tolerates malformed results', () => {
    expect(budgetStarvedPhases(cycle(['propose_takes']).result)).toEqual(['propose_takes']);
    expect(budgetStarvedPhases(null)).toEqual([]);
    expect(budgetStarvedPhases({ report: { phases: 'nope' } })).toEqual([]);
    expect(budgetStarvedPhases({ report: { phases: [{ status: 'skipped', details: { reason: CYCLE_BUDGET_SKIP_REASON } }] } })).toEqual([]);
  });
});

describe('computeCycleBudgetStarvationCheck', () => {
  test('no rows → null', () => {
    expect(computeCycleBudgetStarvationCheck([])).toBeNull();
  });

  test('no skips → ok', () => {
    const c = computeCycleBudgetStarvationCheck([cycle([]), cycle([])])!;
    expect(c.name).toBe('cycle_budget_starvation');
    expect(c.status).toBe('ok');
    expect(c.message).toContain('No budget-skipped phases');
  });

  test('3 consecutive skips of one phase → warn naming phase and streak', () => {
    const rows = [cycle(['propose_takes']), cycle(['propose_takes']), cycle(['propose_takes']), cycle([])];
    const c = computeCycleBudgetStarvationCheck(rows)!;
    expect(c.status).toBe('warn');
    expect(c.message).toContain('propose_takes (3 consecutive)');
    expect(c.message).toContain('--interval');
    expect(c.remediation_status).toBe('human_only');
    expect(c.details).toMatchObject({ window: 4, threshold: 3, cycles_with_budget_skips: 3, streaks: { propose_takes: 3 } });
  });

  test('streak resets when the newest cycle ran the phase — old starvation is history', () => {
    const rows = [cycle([]), cycle(['propose_takes']), cycle(['propose_takes']), cycle(['propose_takes'])];
    const c = computeCycleBudgetStarvationCheck(rows)!;
    expect(c.status).toBe('ok');
    expect(c.message).toContain('3 of the last 4');
    expect((c.details as { streaks: Record<string, number> }).streaks.propose_takes).toBe(0);
  });

  test('interleaved skips never sum to a streak', () => {
    const rows = [cycle(['propose_takes']), cycle([]), cycle(['propose_takes']), cycle([]), cycle(['propose_takes'])];
    expect(computeCycleBudgetStarvationCheck(rows)!.status).toBe('ok');
  });

  test('threshold override and per-phase independence', () => {
    const rows = [cycle(['propose_takes', 'synthesize']), cycle(['propose_takes'])];
    const c = computeCycleBudgetStarvationCheck(rows, { threshold: 2 })!;
    expect(c.status).toBe('warn');
    expect(c.message).toContain('propose_takes (2 consecutive)');
    expect(c.message).not.toContain('synthesize (');
  });
});

describe('checkCycleBudgetStarvation (engine wrapper)', () => {
  test('missing minion_jobs → null', async () => {
    const engine = { executeRaw: async () => { throw new Error('relation "minion_jobs" does not exist'); } } as unknown as BrainEngine;
    expect(await checkCycleBudgetStarvation(engine)).toBeNull();
  });

  test('rows flow through the pure compute', async () => {
    const rows = [cycle(['propose_takes']), cycle(['propose_takes']), cycle(['propose_takes'])];
    const engine = { executeRaw: async () => rows } as unknown as BrainEngine;
    const c = await checkCycleBudgetStarvation(engine);
    expect(c?.status).toBe('warn');
  });
});
