/**
 * pooler_pacing (src/commands/doctor/checks/pooler-pacing.ts).
 *
 * Pins:
 *   - PGLite / no URL / direct port 5432 → null (not a pooler topology);
 *   - port 6543 + pace mode off → warn naming `pace.mode balanced` + `--pace`;
 *   - lock-renewal deaths in the window → evidence sentence in the warn;
 *   - env GBRAIN_PACE_MODE or config pace.mode enabling pacing → ok naming the mode;
 *   - env wins over config (incident escape hatch precedence);
 *   - the engine wrapper reads the URL through loadConfig (GBRAIN_DATABASE_URL)
 *     and degrades to unknown evidence when minion_jobs is absent.
 */
import { describe, expect, test } from 'bun:test';
import { checkPoolerPacing, computePoolerPacingCheck, isTransactionPoolerUrl } from '../src/commands/doctor/checks/pooler-pacing.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const POOLER = 'postgresql://user:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const DIRECT = 'postgresql://user:pw@db.example.supabase.co:5432/postgres';

describe('isTransactionPoolerUrl', () => {
  test('port sniff', () => {
    expect(isTransactionPoolerUrl(POOLER)).toBe(true);
    expect(isTransactionPoolerUrl('postgres://u@h:6543/d')).toBe(true);
    expect(isTransactionPoolerUrl(DIRECT)).toBe(false);
    expect(isTransactionPoolerUrl('not a url')).toBe(false);
  });
});

describe('computePoolerPacingCheck', () => {
  test('null when not a pooler topology', () => {
    expect(computePoolerPacingCheck({ engineKind: 'pglite', databaseUrl: POOLER })).toBeNull();
    expect(computePoolerPacingCheck({ engineKind: 'postgres', databaseUrl: null })).toBeNull();
    expect(computePoolerPacingCheck({ engineKind: 'postgres', databaseUrl: DIRECT })).toBeNull();
  });

  test('pooler + pace off → warn with the config-set and --pace fixes', () => {
    const c = computePoolerPacingCheck({ engineKind: 'postgres', databaseUrl: POOLER })!;
    expect(c.name).toBe('pooler_pacing');
    expect(c.status).toBe('warn');
    expect(c.message).toContain('gbrain config set pace.mode balanced');
    expect(c.message).toContain('--pace');
    expect(c.message).not.toContain('died on lock renewal');
    expect(c.details).toMatchObject({ pace_mode: 'off', pace_enabled: false, lock_renewal_deaths_7d: null });
    expect(c.remediation_status).toBe('human_only');
  });

  test('lock-renewal deaths become evidence in the warn', () => {
    const c = computePoolerPacingCheck({ engineKind: 'postgres', databaseUrl: POOLER, lockRenewalDeaths7d: 4 })!;
    expect(c.status).toBe('warn');
    expect(c.message).toContain('4 job(s) died on lock renewal');
  });

  test('config pace.mode enabling pacing → ok naming the mode and cap', () => {
    const c = computePoolerPacingCheck({ engineKind: 'postgres', databaseUrl: POOLER, configMode: 'gentle' })!;
    expect(c.status).toBe('ok');
    expect(c.message).toContain("pace mode 'gentle'");
    expect(c.message).toContain('max 4 in-flight');
  });

  test('env mode wins over config; an unknown mode falls back to off', () => {
    expect(computePoolerPacingCheck({ engineKind: 'postgres', databaseUrl: POOLER, configMode: 'off', envMode: 'aggressive' })!.status).toBe('ok');
    expect(computePoolerPacingCheck({ engineKind: 'postgres', databaseUrl: POOLER, configMode: 'bogus' })!.status).toBe('warn');
  });
});

describe('checkPoolerPacing (engine wrapper)', () => {
  test('pglite engine → null without touching config', async () => {
    const engine = { kind: 'pglite' } as unknown as BrainEngine;
    expect(await checkPoolerPacing(engine)).toBeNull();
  });

  test('pooler URL from env + absent minion_jobs → warn with unknown evidence', async () => {
    await withEnv({ GBRAIN_DATABASE_URL: POOLER, GBRAIN_PACE_MODE: undefined }, async () => {
      const engine = {
        kind: 'postgres',
        getConfig: async () => null,
        executeRaw: async () => { throw new Error('relation "minion_jobs" does not exist'); },
      } as unknown as BrainEngine;
      const c = await checkPoolerPacing(engine);
      expect(c?.status).toBe('warn');
      expect(c?.details).toMatchObject({ lock_renewal_deaths_7d: null });
    });
  });

  test('config pace.mode read through engine.getConfig → ok', async () => {
    await withEnv({ GBRAIN_DATABASE_URL: POOLER, GBRAIN_PACE_MODE: undefined }, async () => {
      const engine = {
        kind: 'postgres',
        getConfig: async (k: string) => (k === 'pace.mode' ? 'balanced' : null),
        executeRaw: async () => [{ n: 2 }],
      } as unknown as BrainEngine;
      const c = await checkPoolerPacing(engine);
      expect(c?.status).toBe('ok');
      expect(c?.details).toMatchObject({ pace_mode: 'balanced', lock_renewal_deaths_7d: 2 });
    });
  });
});
