/**
 * autopilot_wrapper_stale — the daemon wrapper `<gbrain home>/autopilot-run.sh`
 * predates the env-file lane (#2608). Self-upgrade swaps the gbrain binary but
 * never regenerates the wrapper, so an install made before the env-file lane
 * keeps a wrapper that never sources `<gbrain home>/env`: keys placed there
 * (the documented fix for "autopilot runs green but nothing gets extracted")
 * silently never reach the daemon. The boot warning covers the no-key case;
 * this check covers wrapper drift.
 *
 * Detection is a marker scan on the file `writeWrapperScript` wrote —
 * `WRAPPER_ENV_LANE_MARKER` is pinned against the generator's output by
 * test/doctor-autopilot-wrapper.test.ts so the two can't drift apart.
 * Engine-free: runs in the filesystem lane, including with the DB down.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { Check } from '../../doctor.ts';
import { gbrainPath } from '../../../core/config.ts';

/** The env-file sourcing line's load-bearing fragment (set -a exports dotenv-style lines). */
export const WRAPPER_ENV_LANE_MARKER = 'set -a; source';
export const WRAPPER_FILENAME = 'autopilot-run.sh';
export const ENV_FILENAME = 'env';

export function computeAutopilotWrapperCheck(
  wrapperPath: string,
  content: string | null,
  expectedEnvFile: string,
): Check | null {
  if (content === null) return null; // no wrapper → no daemon install on this host

  if (!content.includes(WRAPPER_ENV_LANE_MARKER)) {
    return {
      name: 'autopilot_wrapper_stale',
      status: 'warn',
      message:
        `Autopilot wrapper ${wrapperPath} predates the env-file lane: it never sources ${expectedEnvFile}, ` +
        `so API keys and process-level env placed there never reach the daemon (self-upgrade swaps the binary, not the wrapper). ` +
        `Fix: gbrain autopilot --install (rewrites the wrapper in place; the schedule entry keeps pointing at the same path).`,
      details: { wrapper_path: wrapperPath, expected_env_file: expectedEnvFile, reason: 'missing_env_lane' },
      remediation_status: 'human_only',
    };
  }

  if (!content.includes(expectedEnvFile)) {
    return {
      name: 'autopilot_wrapper_stale',
      status: 'warn',
      message:
        `Autopilot wrapper ${wrapperPath} sources an env file other than ${expectedEnvFile} — ` +
        `the wrapper was generated under a different gbrain home (GBRAIN_HOME changed since install?). ` +
        `Fix: gbrain autopilot --install from the shell that has the intended GBRAIN_HOME.`,
      details: { wrapper_path: wrapperPath, expected_env_file: expectedEnvFile, reason: 'env_file_path_drift' },
      remediation_status: 'human_only',
    };
  }

  return {
    name: 'autopilot_wrapper_stale',
    status: 'ok',
    message: `Autopilot wrapper sources ${expectedEnvFile}`,
    details: { wrapper_path: wrapperPath, expected_env_file: expectedEnvFile },
  };
}

export function checkAutopilotWrapper(): Check | null {
  try {
    const wrapperPath = gbrainPath(WRAPPER_FILENAME);
    const expectedEnvFile = gbrainPath(ENV_FILENAME);
    if (!existsSync(wrapperPath)) return null;
    return computeAutopilotWrapperCheck(wrapperPath, readFileSync(wrapperPath, 'utf8'), expectedEnvFile);
  } catch {
    return null; // unreadable wrapper — never block doctor on a hygiene probe
  }
}
