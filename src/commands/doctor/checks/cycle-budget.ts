/**
 * cycle_budget_starvation — the doctor half of the #4168 honest-skip contract.
 *
 * A cycle phase that cannot start because earlier phases consumed the whole
 * job budget returns `status: 'skipped'` with
 * `details.reason === 'insufficient_cycle_budget'` instead of recording a
 * halt. The cycle still completes ('partial' is accepted), so
 * `cycle_freshness` stays green while the same phase silently never runs.
 * This check reads the most recent completed `autopilot-cycle` job results
 * and warns when a phase has been budget-skipped in N CONSECUTIVE cycles
 * (one skip is normal life; a streak is starvation).
 *
 * Pure compute (`computeCycleBudgetStarvationCheck`) over the rows the
 * engine wrapper fetches, so the streak math is unit-testable without a DB.
 * PGLite inline cycles never land in `minion_jobs`, so the wrapper returns
 * null (say nothing) when there is no job history to inspect.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { resolveEnvNumber } from '../../../core/env-number.ts';

export const CYCLE_BUDGET_SKIP_REASON = 'insufficient_cycle_budget';
/** Consecutive budget-skipped cycles before the warn fires. */
export const DEFAULT_CYCLE_BUDGET_STARVATION_THRESHOLD = 3;
/** How many recent completed full cycles are inspected. */
export const CYCLE_BUDGET_WINDOW = 10;

export interface CycleJobRow {
  finished_at: string | Date | null;
  result: unknown;
}

/** Phases in one cycle result that were skipped for lack of budget. */
export function budgetStarvedPhases(result: unknown): string[] {
  const report = (result as { report?: { phases?: unknown } } | null)?.report;
  const phases = Array.isArray(report?.phases) ? report!.phases : [];
  const out: string[] = [];
  for (const p of phases) {
    const phase = p as { phase?: unknown; status?: unknown; details?: { reason?: unknown } };
    if (phase.status === 'skipped' && phase.details?.reason === CYCLE_BUDGET_SKIP_REASON && typeof phase.phase === 'string') {
      out.push(phase.phase);
    }
  }
  return out;
}

/**
 * @param rows newest-first completed `autopilot-cycle` rows (at most CYCLE_BUDGET_WINDOW).
 */
export function computeCycleBudgetStarvationCheck(
  rows: CycleJobRow[],
  opts?: { threshold?: number },
): Check | null {
  if (rows.length === 0) return null;
  const threshold = Math.max(1, opts?.threshold ?? DEFAULT_CYCLE_BUDGET_STARVATION_THRESHOLD);

  // Per-phase consecutive streak measured from the NEWEST cycle backwards.
  // A phase that ran fine in the latest cycle has streak 0 even if it
  // starved for a week before — the operator already fixed it.
  const starvedPerRow = rows.map((row) => new Set(budgetStarvedPhases(row.result)));
  const cyclesWithAnySkip = starvedPerRow.filter((s) => s.size > 0).length;
  const allPhases = new Set<string>();
  for (const s of starvedPerRow) for (const p of s) allPhases.add(p);
  const streaks = new Map<string, number>();
  for (const phase of allPhases) {
    let n = 0;
    for (const s of starvedPerRow) {
      if (!s.has(phase)) break;
      n++;
    }
    streaks.set(phase, n);
  }

  const starving = [...streaks.entries()]
    .filter(([, n]) => n >= threshold)
    .sort((a, b) => b[1] - a[1]);

  const details = {
    window: rows.length,
    threshold,
    cycles_with_budget_skips: cyclesWithAnySkip,
    streaks: Object.fromEntries(streaks),
  };

  if (starving.length === 0) {
    return {
      name: 'cycle_budget_starvation',
      status: 'ok',
      message:
        cyclesWithAnySkip === 0
          ? `No budget-skipped phases in the last ${rows.length} full cycle(s)`
          : `${cyclesWithAnySkip} of the last ${rows.length} full cycle(s) budget-skipped a phase, but no phase is starved ${threshold}+ cycles in a row`,
      details,
    };
  }

  const list = starving.map(([phase, n]) => `${phase} (${n} consecutive)`).join(', ');
  return {
    name: 'cycle_budget_starvation',
    status: 'warn',
    message:
      `Cycle phase(s) skipped for insufficient budget in ${threshold}+ consecutive full cycles: ${list}. ` +
      `Earlier phases consume the whole autopilot-cycle job budget, so this work never runs while cycle_freshness stays green. ` +
      `Fix: raise the autopilot interval (gbrain autopilot --install --interval <seconds>) so each cycle has a bigger budget, ` +
      `or raise the autopilot-cycle handler timeout anchor (src/core/minions/handler-timeouts.ts). ` +
      `Override the streak threshold with GBRAIN_CYCLE_BUDGET_STARVATION_THRESHOLD.`,
    details,
    remediation_status: 'human_only',
  };
}

export async function checkCycleBudgetStarvation(engine: BrainEngine): Promise<Check | null> {
  try {
    const rows = await engine.executeRaw<CycleJobRow>(
      `SELECT finished_at, result
         FROM minion_jobs
        WHERE name = 'autopilot-cycle' AND status = 'completed'
        ORDER BY finished_at DESC NULLS LAST
        LIMIT ${CYCLE_BUDGET_WINDOW}`,
    );
    const threshold = resolveEnvNumber(
      'GBRAIN_CYCLE_BUDGET_STARVATION_THRESHOLD',
      DEFAULT_CYCLE_BUDGET_STARVATION_THRESHOLD,
    );
    return computeCycleBudgetStarvationCheck(rows, { threshold });
  } catch {
    return null; // no minion_jobs table (PGLite inline cycles) — nothing to inspect
  }
}
