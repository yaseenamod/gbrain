/**
 * misconfigured_sources — the single surfacing point for a source row whose
 * `config.remote_url` is set while `local_path` is NOT a clone gbrain created
 * (the shape behind the #1881 class: a federated row pointing at a user's own
 * working tree). The core guard refuses to delete or re-clone such rows, and
 * the per-sync stderr warning was rejected in eng-review (it would spam every
 * healthy sync) — so doctor is where the operator learns about it, once, with
 * the same hint text sync's own error uses (`unownedHint`).
 *
 * Pure compute (`computeMisconfiguredSourcesCheck`) takes the rows plus a
 * repo-state probe so tests never touch git; the engine wrapper runs
 * `validateRepoState` on the local lane only (doctorReportRemote never walks
 * DB-supplied paths — trust boundary D4).
 */

import type { BrainEngine, SourceRow } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { isOwnedClone, unownedHint } from '../../../core/sources-ops.ts';
import { validateRepoState, type RepoState } from '../../../core/git-remote.ts';

export type SourceConfigRow = Pick<SourceRow, 'id' | 'local_path' | 'config'>;

const MAX_LISTED = 5;

export function remoteUrlOf(src: SourceConfigRow): string | null {
  const cfg = (src.config ?? {}) as Record<string, unknown>;
  const url = cfg.remote_url;
  return typeof url === 'string' && url.trim().length > 0 ? url : null;
}

export function computeMisconfiguredSourcesCheck(
  sources: SourceConfigRow[],
  probeState: (localPath: string, remoteUrl: string) => RepoState,
): Check {
  const withRemote = sources.filter((s) => remoteUrlOf(s) !== null);
  const bad: Array<{ id: string; state: RepoState; hint: string }> = [];
  for (const src of withRemote) {
    if (isOwnedClone(src)) continue;
    let state: RepoState = 'missing';
    if (src.local_path) {
      try {
        state = probeState(src.local_path, remoteUrlOf(src)!);
      } catch {
        state = 'corrupted';
      }
    }
    bad.push({ id: src.id, state, hint: unownedHint(src, state) });
  }

  if (bad.length === 0) {
    return {
      name: 'misconfigured_sources',
      status: 'ok',
      message:
        withRemote.length === 0
          ? 'No sources carry config.remote_url'
          : `${withRemote.length} source(s) with config.remote_url are all gbrain-owned clones`,
    };
  }

  const shown = bad.slice(0, MAX_LISTED).map((b) => `  - ${b.hint}`);
  const more = bad.length > MAX_LISTED ? `\n  … +${bad.length - MAX_LISTED} more (see details.misconfigured)` : '';
  return {
    name: 'misconfigured_sources',
    status: 'warn',
    message:
      `${bad.length} source(s) have config.remote_url set but local_path is not a clone gbrain owns — ` +
      `sync treats them read-only and will never re-clone or delete them:\n${shown.join('\n')}${more}`,
    details: { misconfigured: bad.map((b) => ({ id: b.id, state: b.state })) },
    remediation_status: 'human_only',
  };
}

export async function checkMisconfiguredSources(engine: BrainEngine): Promise<Check | null> {
  try {
    const sources = await engine.listAllSources();
    return computeMisconfiguredSourcesCheck(sources, (p, url) => validateRepoState(p, url));
  } catch {
    return null; // sources table unavailable — the connection/schema checks own that
  }
}
