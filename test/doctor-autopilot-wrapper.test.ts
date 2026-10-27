/**
 * autopilot_wrapper_stale (src/commands/doctor/checks/autopilot-wrapper.ts).
 *
 * Pins:
 *   - no wrapper on disk → null (no daemon install, nothing to say);
 *   - wrapper without the env-file sourcing line → warn (missing_env_lane)
 *     naming `gbrain autopilot --install`;
 *   - wrapper sourcing a different env file → warn (env_file_path_drift);
 *   - current wrapper → ok;
 *   - DRIFT GUARD: the generator in src/commands/autopilot.ts must emit
 *     WRAPPER_ENV_LANE_MARKER inside its heredoc, so detector and generator
 *     can never disagree on what "current" looks like.
 *
 * GBRAIN_HOME points at a temp dir (via withEnv) so the real wrapper is never read.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkAutopilotWrapper,
  computeAutopilotWrapperCheck,
  ENV_FILENAME,
  WRAPPER_ENV_LANE_MARKER,
  WRAPPER_FILENAME,
} from '../src/commands/doctor/checks/autopilot-wrapper.ts';
import { gbrainPath } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

const ENV = '/home/u/.gbrain/env';
const WRAPPER = '/home/u/.gbrain/autopilot-run.sh';
const CURRENT = `#!/bin/bash\n[ -f '${ENV}' ] && { ${WRAPPER_ENV_LANE_MARKER} '${ENV}' 2>/dev/null; set +a; }\nexec gbrain autopilot\n`;
const LEGACY = `#!/bin/bash\n[ -f ~/.zshrc ] && source ~/.zshrc\nexec gbrain autopilot\n`;

describe('computeAutopilotWrapperCheck', () => {
  test('no wrapper → null', () => {
    expect(computeAutopilotWrapperCheck(WRAPPER, null, ENV)).toBeNull();
  });

  test('legacy wrapper → warn missing_env_lane with the reinstall fix', () => {
    const c = computeAutopilotWrapperCheck(WRAPPER, LEGACY, ENV)!;
    expect(c.name).toBe('autopilot_wrapper_stale');
    expect(c.status).toBe('warn');
    expect(c.message).toContain('gbrain autopilot --install');
    expect(c.message).toContain(ENV);
    expect(c.details).toMatchObject({ reason: 'missing_env_lane' });
    expect(c.remediation_status).toBe('human_only');
  });

  test('wrapper sourcing another home\'s env file → warn env_file_path_drift', () => {
    const c = computeAutopilotWrapperCheck(WRAPPER, CURRENT, '/srv/brain/.gbrain/env')!;
    expect(c.status).toBe('warn');
    expect(c.details).toMatchObject({ reason: 'env_file_path_drift' });
    expect(c.message).toContain('GBRAIN_HOME');
  });

  test('current wrapper → ok', () => {
    const c = computeAutopilotWrapperCheck(WRAPPER, CURRENT, ENV)!;
    expect(c.status).toBe('ok');
    expect(c.message).toContain(ENV);
  });
});

describe('checkAutopilotWrapper (filesystem)', () => {
  test('absent wrapper → null; legacy wrapper → warn; current → ok', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-wrapper-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, () => {
        expect(checkAutopilotWrapper()).toBeNull();
        const wrapperPath = gbrainPath(WRAPPER_FILENAME);
        const envPath = gbrainPath(ENV_FILENAME);
        mkdirSync(dirname(wrapperPath), { recursive: true });
        writeFileSync(wrapperPath, LEGACY);
        expect(checkAutopilotWrapper()?.status).toBe('warn');
        writeFileSync(wrapperPath, `#!/bin/bash\n[ -f '${envPath}' ] && { ${WRAPPER_ENV_LANE_MARKER} '${envPath}' 2>/dev/null; set +a; }\n`);
        expect(checkAutopilotWrapper()?.status).toBe('ok');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('generator/detector drift guard', () => {
  test('writeWrapperScript emits the marker the detector scans for', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'), 'utf8');
    const start = src.indexOf('export function writeWrapperScript');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 12_000);
    expect(body).toContain(WRAPPER_ENV_LANE_MARKER);
    // The sourced path is the gbrain-home env file, baked absolute.
    expect(body).toContain("join(gbrainDir, 'env')");
  });
});
