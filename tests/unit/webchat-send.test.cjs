const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const source = fs.readFileSync('public/webchat/js/app.js', 'utf8')
    .replace(/^import .*;\n/gm, '').split('// Boot')[0] + '\nglobalThis.TestApp = App;';
  const elements = { input: { value: 'Hello', style: {} }, 'send-btn': { classList: { remove() {} } } };
  const context = vm.createContext({
    WSClient: class {}, document: { getElementById: id => elements[id] },
    Storage: { set() {}, get() { return ''; } }, setTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ session: { id: 'session' } }) }),
  });
  vm.runInContext(source, context);
  const app = new context.TestApp();
  app.userId = 'test-user';
  app.sidebar = { sessions: [], addSession(session) { this.sessions.push(session); }, setActive() {}, updateSession() {}, feedMessages() {} };
  app.chat = { messages: [], addMessage(text) { this.messages.push(text); }, showTyping() {}, loadHistory() { this.messages = []; } };
  app.commands = { hide() {} };
  app._setGenerating = () => {};
  app.ws = { connected: true, authenticated: true, connect() {}, send() {} };
  return { app, context, elements };
}

test('first send skips the empty history refresh during authentication', async () => {
  const { app } = fixture();
  let skipAtConnect;
  app.ws.connect = () => { skipAtConnect = app._skipNextRefresh; };
  await app._send();
  assert.equal(skipAtConnect, true);
  assert.deepEqual(app.chat.messages, ['Hello']);
  assert.equal(app._sending, false);
});

test('a history request started before send cannot erase the new message', async () => {
  const { app, context } = fixture();
  app.activeSessionId = 'session';
  let resolveHistory;
  context.fetch = () => new Promise(resolve => { resolveHistory = resolve; });
  const refresh = app._refreshHistory('session');
  await app._send();
  resolveHistory({ ok: true, json: async () => ({ messages: [] }) });
  await refresh;
  assert.deepEqual(app.chat.messages, ['Hello']);
});

test('transport acknowledgements do not stop the thinking indicator', () => {
  const { app, context } = fixture();
  const source = fs.readFileSync('public/webchat/js/app.js', 'utf8');
  const start = source.indexOf("    this.ws.on('message', (msg) => {");
  const end = source.indexOf('    // Load sessions, then connect', start);
  let handler;
  let stopped = 0;
  app.ws.on = (_, fn) => { handler = fn; };
  app.chat.hideTyping = () => { stopped++; };
  app._setGenerating = () => { stopped++; };
  context.app = app;
  vm.runInContext(`(function() { ${source.slice(start, end)} }).call(app)`, context);
  handler({ type: 'ack' });
  assert.equal(stopped, 0);
  app.chat.addMessage = () => {};
  handler({ type: 'error', message: 'Gemini unavailable' });
  assert.equal(stopped, 2);
});
