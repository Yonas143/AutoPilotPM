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
      DRY_RUN: 'true', DRIFT_DRY_RUN: 'true', PERCOLATOR_DRY_RUN: 'true', BYBIT_DEMO: 'true', BYBIT_TESTNET: 'false', WEBCHAT_TOKEN: 'test-webchat-token',
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
      let ready = false;
      try {
        const response = await fetch('http://127.0.0.1:18789/health', { signal: AbortSignal.timeout(1000) });
        ready = response.ok;
      } catch {}
      if (ready) {
          const base = 'http://127.0.0.1:18789';
          const metadata = await (await fetch(base + '/')).json();
          assert.equal(metadata.endpoints.webchat, '/webchat/');
          const alias = await fetch(base + '/chat', { redirect: 'manual' });
          assert.equal(alias.status, 302);
          assert.equal(alias.headers.get('location'), '/webchat/');
          for (const path of ['/webchat', '/webchat/', '/webchat/legacy', '/webchat/css/app.css', '/webchat/js/app.js', '/webchat/js/ws.js', '/webchat/js/chat.js', '/webchat/js/commands.js', '/webchat/js/sidebar.js', '/webchat/js/storage.js', '/webchat/logo.png']) {
            const page = await fetch(base + path);
            assert.equal(page.status, 200, path + ' must be available in the image');
            assert.ok((await page.arrayBuffer()).byteLength > 0, path + ' must not be empty');
          }
          const WebSocket = require('ws');
          await new Promise((resolve, reject) => {
            const ws = new WebSocket('ws://127.0.0.1:18789/chat');
            const timer = setTimeout(() => { ws.terminate(); reject(new Error('Chat authentication timed out')); }, 5000);
            ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'test-webchat-token', userId: 'interface-test' })));
            ws.on('error', error => { clearTimeout(timer); reject(error); });
            ws.on('message', payload => {
              const message = JSON.parse(payload.toString());
              if (message.type === 'authenticated') ws.send(JSON.stringify({ type: 'message', text: '/bybit-demo' }));
              if (message.type === 'message') {
                clearTimeout(timer); ws.close();
                if (message.text.includes('credentials missing')) resolve();
                else reject(new Error('Read-only Bybit Demo command returned an unexpected result'));
              }
              if (message.type === 'error') { clearTimeout(timer); ws.close(); reject(new Error(message.message)); }
            });
          });
          const performance = await fetch(base + '/api/performance');
          assert.equal(performance.status, 200, await performance.clone().text());
          const data = await performance.json();
          assert.equal(data.stats.totalTrades, 0);
          assert.deepEqual(data.recentTrades, []);
          const dashboard = await fetch(base + '/dashboard');
          assert.equal(dashboard.status, 200);
          const html = await dashboard.text();
          const { Script } = require('node:vm');
          for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script);
          assert.ok(!html.includes('Make sure trading is enabled'));
          console.log('PASS: Gemini-only startup, performance data, chat pages/assets and dashboard script; external network disabled by Docker.');
          return;
      }
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
