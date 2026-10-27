const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

test('Gemini-only image reaches HTTP health without Anthropic or exchange credentials', { timeout: 110000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'autopilot-gemini-'));
  // Allowlist environment: never inherit real user or exchange credentials.
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      PATH: process.env.PATH, NODE_ENV: 'production', HOME: state,
      AUTOPILOT_STATE_DIR: state, AUTOPILOT_WORKSPACE: join(state, 'workspace'),
      AUTOPILOT_CONFIG_PATH: join(state, 'config.json'),
      GEMINI_API_KEY: 'mock-key-not-used-for-requests', AUTOPILOT_AI_PROVIDER: 'gemini',
      DRY_RUN: 'true', DRIFT_DRY_RUN: 'true', PERCOLATOR_DRY_RUN: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.stdout.on('data', b => { logs = (logs + b).slice(-20000); });
  child.stderr.on('data', b => { logs = (logs + b).slice(-20000); });
  try {
    const deadline = Date.now() + 95000;
    while (Date.now() < deadline && !exited) {
      try {
        const response = await fetch('http://127.0.0.1:18789/health', { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          console.log('PASS: Gemini-only startup reached /health; external network disabled by Docker.');
          return;
        }
      } catch {}
      await delay(1000);
    }
    assert.fail(`Gemini-only startup failed (exit=${child.exitCode}):\n${logs}`);
  } finally {
    if (!exited) {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
    }
    rmSync(state, { recursive: true, force: true });
  }
});
