/**
 * skill_lane_duplicates (src/commands/doctor/checks/skill-lanes.ts).
 *
 * Pins:
 *   - fewer than two lanes on disk → null;
 *   - disjoint skill sets across lanes → ok with the skill count;
 *   - the same `<name>/SKILL.md` in two lanes → warn naming the name + both lanes;
 *   - a directory without SKILL.md is not a skill;
 *   - symlinked twin lanes dedupe to one (no self-collision);
 *   - discoverPluginSkillDirs finds nested `skills/` dirs under a plugins root
 *     (marketplace cache layout is host-defined, so the walk is bounded, not
 *     layout-specific) and labels them by their relative path;
 *   - >8 duplicates → sample truncation.
 *
 * All fixtures live in mkdtemp dirs; the real ~/.claude is never read.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeSkillLaneDuplicatesCheck,
  dedupeLanes,
  discoverPluginSkillDirs,
  listLaneSkills,
} from '../src/commands/doctor/checks/skill-lanes.ts';

const cleanups: string[] = [];
afterEach(() => { for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'gbrain-skill-lanes-'));
  cleanups.push(d);
  return d;
}

function lane(root: string, name: string, skills: string[], extras: string[] = []): { label: string; dir: string } {
  const dir = join(root, name);
  for (const s of skills) {
    mkdirSync(join(dir, s), { recursive: true });
    writeFileSync(join(dir, s, 'SKILL.md'), `---\nname: ${s}\n---\n`);
  }
  for (const e of extras) mkdirSync(join(dir, e), { recursive: true });
  return { label: name, dir };
}

describe('listLaneSkills', () => {
  test('only dirs holding SKILL.md count; missing lane → []', () => {
    const root = tmp();
    const l = lane(root, 'user', ['b', 'a'], ['notaskill']);
    expect(listLaneSkills(l.dir)).toEqual(['a', 'b']);
    expect(listLaneSkills(join(root, 'nope'))).toEqual([]);
  });
});

describe('computeSkillLaneDuplicatesCheck', () => {
  test('<2 live lanes → null', () => {
    const root = tmp();
    const only = lane(root, 'user', ['a']);
    expect(computeSkillLaneDuplicatesCheck([only, { label: 'ghost', dir: join(root, 'ghost') }])).toBeNull();
  });

  test('disjoint lanes → ok', () => {
    const root = tmp();
    const c = computeSkillLaneDuplicatesCheck([lane(root, 'user', ['a']), lane(root, 'plugin', ['b', 'c'])])!;
    expect(c.name).toBe('skill_lane_duplicates');
    expect(c.status).toBe('ok');
    expect(c.message).toContain('3 skill(s) across 2');
  });

  test('same name in two lanes → warn naming the name and both lanes', () => {
    const root = tmp();
    const c = computeSkillLaneDuplicatesCheck([lane(root, 'user', ['ingest', 'x']), lane(root, 'plugin', ['ingest'])])!;
    expect(c.status).toBe('warn');
    expect(c.message).toContain('ingest [user + plugin]');
    expect(c.message).toContain('gbrain skillpack remove --harness claude-code');
    expect(c.details).toMatchObject({ duplicates: [{ name: 'ingest', lanes: ['user', 'plugin'] }] });
    expect(c.remediation_status).toBe('human_only');
  });

  test('symlinked twin lanes dedupe — a lane never collides with itself', () => {
    const root = tmp();
    const real = lane(root, 'user', ['a']);
    symlinkSync(real.dir, join(root, 'alias'));
    const lanes = dedupeLanes([real, { label: 'alias', dir: join(root, 'alias') }]);
    expect(lanes).toHaveLength(1);
    expect(computeSkillLaneDuplicatesCheck([real, { label: 'alias', dir: join(root, 'alias') }])).toBeNull();
  });

  test('>8 duplicates → truncated sample', () => {
    const root = tmp();
    const names = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const c = computeSkillLaneDuplicatesCheck([lane(root, 'user', names), lane(root, 'plugin', names)])!;
    expect(c.message).toContain('+2 more');
  });
});

describe('discoverPluginSkillDirs', () => {
  test('finds nested skills dirs under a plugins root and labels them relatively', () => {
    const root = tmp();
    lane(join(root, 'cache', 'mkt', 'gbrain-coding', '1.0.0'), 'skills', ['ingest']);
    lane(join(root, 'cache', 'mkt', 'gbrain-daily', '1.0.0'), 'skills', ['ingest']);
    mkdirSync(join(root, 'cache', 'mkt', 'empty', 'skills'), { recursive: true }); // no SKILL.md → not a lane
    const lanes = discoverPluginSkillDirs(root).sort((a, b) => a.label.localeCompare(b.label));
    expect(lanes.map((l) => l.label)).toEqual([
      `plugin snapshot ${join('cache', 'mkt', 'gbrain-coding', '1.0.0')}`,
      `plugin snapshot ${join('cache', 'mkt', 'gbrain-daily', '1.0.0')}`,
    ]);
    const c = computeSkillLaneDuplicatesCheck(lanes)!;
    expect(c.status).toBe('warn');
    expect(c.message).toContain('ingest [');
    expect(discoverPluginSkillDirs(join(root, 'missing'))).toEqual([]);
  });
});
