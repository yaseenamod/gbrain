/**
 * misconfigured_sources (src/commands/doctor/checks/source-config.ts).
 *
 * Pins:
 *   - no remote_url anywhere → ok;
 *   - remote_url on a gbrain-owned clone (managed_clone marker) → ok;
 *   - remote_url on an unowned path → warn carrying sources-ops' unownedHint
 *     verbatim (healthy vs degraded wording follows the probed repo state);
 *   - >5 rows → sample truncation + details.misconfigured carries all ids;
 *   - the repo-state probe is injected (tests never shell out to git);
 *   - the engine wrapper tolerates a missing sources table.
 */
import { describe, expect, test } from 'bun:test';
import { checkMisconfiguredSources, computeMisconfiguredSourcesCheck, remoteUrlOf } from '../src/commands/doctor/checks/source-config.ts';
import { unownedHint } from '../src/core/sources-ops.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { RepoState } from '../src/core/git-remote.ts';

const healthy = (): RepoState => 'healthy';

function src(id: string, config: Record<string, unknown>, local_path: string | null = `/home/u/work/${id}`) {
  return { id, local_path, config };
}

describe('computeMisconfiguredSourcesCheck', () => {
  test('no remote_url → ok', () => {
    const c = computeMisconfiguredSourcesCheck([src('default', {})], healthy);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('No sources carry config.remote_url');
    expect(remoteUrlOf(src('x', { remote_url: '  ' }))).toBeNull();
  });

  test('owned clone (managed_clone marker) → ok', () => {
    const c = computeMisconfiguredSourcesCheck(
      [src('wiki', { remote_url: 'https://example.com/a.git', managed_clone: true })],
      healthy,
    );
    expect(c.status).toBe('ok');
    expect(c.message).toContain('1 source(s) with config.remote_url are all gbrain-owned');
  });

  test('unowned healthy working tree → warn with the shared unownedHint', () => {
    const row = src('wiki', { remote_url: 'https://example.com/a.git' });
    const c = computeMisconfiguredSourcesCheck([row], healthy);
    expect(c.status).toBe('warn');
    expect(c.message).toContain(unownedHint(row, 'healthy'));
    expect(c.message).toContain('read-only');
    expect(c.details).toEqual({ misconfigured: [{ id: 'wiki', state: 'healthy' }] });
    expect(c.remediation_status).toBe('human_only');
  });

  test('degraded path wording follows the probed state; probe throw → corrupted; null path → missing', () => {
    const rows = [
      src('a', { remote_url: 'https://example.com/a.git' }),
      src('b', { remote_url: 'https://example.com/b.git' }),
      src('c', { remote_url: 'https://example.com/c.git' }, null),
    ];
    const probe = (p: string): RepoState => {
      if (p.endsWith('/a')) return 'no-git';
      throw new Error('boom');
    };
    const c = computeMisconfiguredSourcesCheck(rows, probe);
    expect(c.details).toEqual({
      misconfigured: [
        { id: 'a', state: 'no-git' },
        { id: 'b', state: 'corrupted' },
        { id: 'c', state: 'missing' },
      ],
    });
    expect(c.message).toContain('state: no-git');
  });

  test('>5 misconfigured rows → truncated sample, full list in details', () => {
    const rows = Array.from({ length: 7 }, (_, i) => src(`s${i}`, { remote_url: `https://example.com/${i}.git` }));
    const c = computeMisconfiguredSourcesCheck(rows, healthy);
    expect(c.message).toContain('+2 more');
    expect((c.details as { misconfigured: unknown[] }).misconfigured).toHaveLength(7);
  });
});

describe('checkMisconfiguredSources (engine wrapper)', () => {
  test('listAllSources failure → null', async () => {
    const engine = { listAllSources: async () => { throw new Error('no sources table'); } } as unknown as BrainEngine;
    expect(await checkMisconfiguredSources(engine)).toBeNull();
  });

  test('rows without remote_url never probe git', async () => {
    const engine = { listAllSources: async () => [src('default', {}, '/nonexistent')] } as unknown as BrainEngine;
    const c = await checkMisconfiguredSources(engine);
    expect(c?.status).toBe('ok');
  });
});
