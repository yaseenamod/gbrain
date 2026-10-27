/**
 * pooler_pacing — a transaction-mode pooler (Supabase/PgBouncer on port 6543)
 * running UNPACED bulk work. An unpaced `gbrain embed --stale` or large
 * `gbrain sync` saturates the pooler's slot budget and starves the minion
 * supervisor's lock renewals (`lock-renewal-failed` → dead jobs). Pacing
 * (`pace.mode`, see CLAUDE.md "Pace Mode") is the native fix and is OFF by
 * default, so the doctor has to say so on exactly the topology where it bites.
 *
 * Same URL-only port sniff as `pgbouncer_prepare` (one pooler signal, two
 * consequences: prepared statements AND slot pressure). Pure compute over the
 * resolved inputs; the wrapper reads env > DB config and, best-effort, counts
 * recent lock-renewal deaths so the message carries the evidence.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { PACE_MODE_KEY, readPaceEnv, resolvePaceMode } from '../../../core/pace-mode.ts';
import { loadConfig } from '../../../core/config.ts';

export const TRANSACTION_POOLER_PORT = '6543';

export function isTransactionPoolerUrl(url: string): boolean {
  try {
    const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
    return parsed.port === TRANSACTION_POOLER_PORT;
  } catch {
    return false;
  }
}

export interface PoolerPacingInput {
  engineKind: 'postgres' | 'pglite';
  databaseUrl: string | null | undefined;
  /** `GBRAIN_PACE_MODE` */
  envMode?: string;
  /** `pace.mode` from the config table */
  configMode?: string | null;
  /** Jobs that died on lock renewal in the last 7 days (null = unknown). */
  lockRenewalDeaths7d?: number | null;
}

export function computePoolerPacingCheck(input: PoolerPacingInput): Check | null {
  if (input.engineKind !== 'postgres') return null;
  if (!input.databaseUrl || !isTransactionPoolerUrl(input.databaseUrl)) return null;

  const knobs = resolvePaceMode({ envMode: input.envMode, mode: input.configMode ?? undefined });
  const deaths = input.lockRenewalDeaths7d ?? null;
  const details = {
    pooler_port: TRANSACTION_POOLER_PORT,
    pace_mode: knobs.resolved_mode,
    pace_enabled: knobs.enabled,
    lock_renewal_deaths_7d: deaths,
  };

  if (knobs.enabled) {
    return {
      name: 'pooler_pacing',
      status: 'ok',
      message:
        `Transaction-mode pooler (port ${TRANSACTION_POOLER_PORT}) with pace mode '${knobs.resolved_mode}' ` +
        `(max ${knobs.maxConcurrency} in-flight writes) — bulk backfills are slot-capped`,
      details,
    };
  }

  const evidence =
    deaths && deaths > 0
      ? ` ${deaths} job(s) died on lock renewal in the last 7 days — the signature of pooler starvation.`
      : '';
  return {
    name: 'pooler_pacing',
    status: 'warn',
    message:
      `Transaction-mode pooler (port ${TRANSACTION_POOLER_PORT}) detected and pace mode is off: an unpaced ` +
      `gbrain embed --stale or large gbrain sync can exhaust pooler slots and starve minion lock renewals.${evidence} ` +
      `Fix: gbrain config set ${PACE_MODE_KEY} balanced (paces every embed/sync caller and the embed-backfill job), ` +
      `or pass --pace on individual runs. GBRAIN_PACE_MODE=<mode> overrides config for an incident.`,
    details,
    remediation_status: 'human_only',
  };
}

export async function checkPoolerPacing(engine: BrainEngine): Promise<Check | null> {
  try {
    if (engine.kind !== 'postgres') return null;
    const databaseUrl = loadConfig()?.database_url ?? null;
    if (!databaseUrl || !isTransactionPoolerUrl(databaseUrl)) return null;

    let configMode: string | null = null;
    try { configMode = await engine.getConfig(PACE_MODE_KEY); } catch { /* no config table yet */ }

    let lockRenewalDeaths7d: number | null = null;
    try {
      const rows = await engine.executeRaw<{ n: number | string }>(
        `SELECT COUNT(*)::int AS n FROM minion_jobs
          WHERE status IN ('failed', 'dead')
            AND finished_at > now() - interval '7 days'
            AND (error_text ILIKE '%lock-renewal%' OR error_text ILIKE '%lock renewal%' OR error_text ILIKE '%lock-lost%')`,
      );
      lockRenewalDeaths7d = Number(rows[0]?.n ?? 0);
    } catch { /* no minion_jobs table — evidence stays unknown */ }

    return computePoolerPacingCheck({
      engineKind: 'postgres',
      databaseUrl,
      envMode: readPaceEnv().envMode,
      configMode,
      lockRenewalDeaths7d,
    });
  } catch {
    return null;
  }
}
