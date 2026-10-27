/**
 * skill_lane_duplicates — the same skill name loadable from two Claude Code
 * lanes at once: the user skills dir (harness-bridge install target), the
 * project `.claude/skills` dir, and every installed plugin snapshot under
 * `<claude config>/plugins/` (the marketplace lane, including two persona
 * variants of the gbrain plugin installed side by side). The bridge prints a
 * static "may coexist" callout at install time; #4167 built live coexistence
 * detection for the MCP server name only. This closes the skill-name half.
 *
 * Which copy wins a duplicate is host-defined, so the check names the lanes
 * and lets the operator keep one. Pure compute over `SkillLane[]`; the lane
 * resolver is separate so tests use temp dirs and never read the real home.
 */

import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import type { Check } from '../../doctor.ts';
import { claudeConfigDir, claudeProjectSkillsDir, claudeUserSkillsDir } from '../../../core/bootstrap/host-specs.ts';

export interface SkillLane {
  /** Human label, e.g. `user skills (~/.claude/skills)` or `plugin snapshot gbrain-coding`. */
  label: string;
  dir: string;
}

const PLUGIN_WALK_MAX_DEPTH = 5;
const MAX_LISTED = 8;

/** Names of `<dir>/<name>/SKILL.md` skills in one lane (empty when the lane is absent). */
export function listLaneSkills(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(dir, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Every `skills/` dir holding at least one SKILL.md under the plugins root (bounded walk). */
export function discoverPluginSkillDirs(pluginsRoot: string): SkillLane[] {
  const out: SkillLane[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > PLUGIN_WALK_MAX_DEPTH) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.name === 'skills' && listLaneSkills(full).length > 0) {
        out.push({ label: `plugin snapshot ${relative(pluginsRoot, dir) || e.name}`, dir: full });
        continue; // a skills dir never nests another lane
      }
      walk(full, depth + 1);
    }
  };
  walk(pluginsRoot, 0);
  return out;
}

/** Default Claude Code lanes on this host. Absent dirs are dropped; symlinked twins are deduped. */
export function defaultClaudeSkillLanes(workspaceDir: string = process.cwd()): SkillLane[] {
  const lanes: SkillLane[] = [
    { label: `user skills (${claudeUserSkillsDir()})`, dir: claudeUserSkillsDir() },
    { label: `project skills (${claudeProjectSkillsDir(workspaceDir)})`, dir: claudeProjectSkillsDir(workspaceDir) },
    ...discoverPluginSkillDirs(join(claudeConfigDir(), 'plugins')),
  ];
  return dedupeLanes(lanes);
}

export function dedupeLanes(lanes: SkillLane[]): SkillLane[] {
  const seen = new Set<string>();
  const out: SkillLane[] = [];
  for (const lane of lanes) {
    let key: string;
    try {
      if (!statSync(lane.dir).isDirectory()) continue;
      key = realpathSync(lane.dir);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lane);
  }
  return out;
}

export function computeSkillLaneDuplicatesCheck(lanes: SkillLane[]): Check | null {
  const live = dedupeLanes(lanes);
  if (live.length < 2) return null; // one lane can't collide with itself

  const byName = new Map<string, string[]>();
  let total = 0;
  for (const lane of live) {
    for (const name of listLaneSkills(lane.dir)) {
      total++;
      const list = byName.get(name) ?? [];
      list.push(lane.label);
      byName.set(name, list);
    }
  }
  const duplicates = [...byName.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([name, labels]) => ({ name, lanes: labels }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (duplicates.length === 0) {
    return {
      name: 'skill_lane_duplicates',
      status: 'ok',
      message: `${total} skill(s) across ${live.length} Claude Code lane(s), no duplicate names`,
      details: { lanes: live.map((l) => l.label), skill_count: total },
    };
  }

  const shown = duplicates.slice(0, MAX_LISTED).map((d) => `${d.name} [${d.lanes.join(' + ')}]`).join('; ');
  const more = duplicates.length > MAX_LISTED ? ` … +${duplicates.length - MAX_LISTED} more` : '';
  return {
    name: 'skill_lane_duplicates',
    status: 'warn',
    message:
      `${duplicates.length} skill name(s) load from more than one Claude Code lane — which copy wins is host-defined: ` +
      `${shown}${more}. Keep one lane per machine: remove the bridge copy with ` +
      `gbrain skillpack remove --harness claude-code --skill <slug>, or uninstall the plugin (claude plugin uninstall <plugin>).`,
    details: { lanes: live.map((l) => l.label), duplicates },
    remediation_status: 'human_only',
  };
}

export function checkSkillLaneDuplicates(workspaceDir?: string): Check | null {
  try {
    return computeSkillLaneDuplicatesCheck(defaultClaudeSkillLanes(workspaceDir));
  } catch {
    return null;
  }
}
