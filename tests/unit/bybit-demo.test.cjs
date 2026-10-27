const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { RestClientV5 } = require('bybit-api');
const bybit = require('../../dist/exchanges/bybit/index.js');
const { checkBybitDemoConnection } = require('../../dist/exchanges/bybit/demo-status.js');
const keys = ['BYBIT_DEMO', 'BYBIT_TESTNET', 'DRY_RUN', 'BYBIT_API_KEY', 'BYBIT_API_SECRET'];
const originalEnv = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const methods = ['getWalletBalance', 'submitOrder', 'cancelOrder', 'setLeverage'];
const originalMethods = Object.fromEntries(methods.map(k => [k, RestClientV5.prototype[k]]));
function clean() { for (const k of keys) delete process.env[k]; }
afterEach(() => {
  for (const k of keys) originalEnv[k] === undefined ? delete process.env[k] : process.env[k] = originalEnv[k];
  for (const k of methods) RestClientV5.prototype[k] = originalMethods[k];
});
function wallet() { return { retCode: 0, result: { list: [{ coin: [{ coin: 'USDT', equity: '10000', walletBalance: '10000', availableToWithdraw: '10000', unrealisedPnl: '0' }] }] } }; }

test('demo, testnet and live resolve to distinct domains; conflicts and typos fail closed', () => {
  clean();
  assert.equal(bybit.resolveBybitEnvironment().baseUrl, 'https://api.bybit.com');
  assert.equal(bybit.resolveBybitEnvironment({ demo: true }).baseUrl, 'https://api-demo.bybit.com');
  assert.equal(bybit.resolveBybitEnvironment({ testnet: true }).baseUrl, 'https://api-testnet.bybit.com');
  process.env.BYBIT_DEMO = 'true';
  assert.equal(bybit.resolveBybitEnvironment({ demo: false }).environment, 'demo');
  assert.throws(() => bybit.resolveBybitEnvironment({ testnet: true }), /cannot be combined/);
  process.env.BYBIT_DEMO = 'typo';
  assert.throws(() => bybit.resolveBybitEnvironment(), /must be/);
});

test('SDK clients follow demo changes and secret rotation instead of reusing the live client', async () => {
  clean();
  const seen = [];
  RestClientV5.prototype.getWalletBalance = async function() {
    seen.push({ baseUrl: this.options.baseUrl, secret: this.options.secret, demo: this.options.demoTrading });
    return wallet();
  };
  const config = { apiKey: 'fake-key-cache', apiSecret: 'fake-secret-one' };
  await bybit.getBalance(config);
  process.env.BYBIT_DEMO = 'true';
  await bybit.getBalance(config);
  config.apiSecret = 'fake-secret-two';
  await bybit.getBalance(config);
  assert.deepEqual(seen.map(s => s.baseUrl), ['https://api.bybit.com', 'https://api-demo.bybit.com', 'https://api-demo.bybit.com']);
  assert.equal(seen[2].secret, 'fake-secret-two');
  assert.equal(seen[1].demo, true);
});

test('global dry-run cannot be bypassed by false caller defaults; no SDK mutations occur', async () => {
  clean(); process.env.DRY_RUN = 'true'; process.env.BYBIT_DEMO = 'true';
  let mutations = 0;
  for (const k of ['submitOrder', 'cancelOrder', 'setLeverage']) RestClientV5.prototype[k] = async () => { mutations++; throw new Error('Unexpected exchange mutation'); };
  const config = { apiKey: 'fake', apiSecret: 'fake', dryRun: false };
  assert.equal((await bybit.openLong(config, 'BTCUSDT', 0.001, 1)).orderStatus, 'DRY_RUN');
  assert.equal((await bybit.openShort(config, 'BTCUSDT', 0.001, 1)).orderStatus, 'DRY_RUN');
  assert.equal((await bybit.placeLimitOrder(config, 'BTCUSDT', 'Buy', 0.001, 100000)).orderStatus, 'DRY_RUN');
  assert.equal((await bybit.placeStopOrder(config, 'BTCUSDT', 'Sell', 0.001, 90000)).orderStatus, 'DRY_RUN');
  assert.equal(await bybit.cancelOrder(config, 'BTCUSDT', 'fake-id'), true);
  assert.equal(mutations, 0);
});

test('read-only connection command always uses demo and never leaks credentials or signed SDK errors', async () => {
  clean();
  assert.match(await checkBybitDemoConnection(), /credentials missing/);
  process.env.BYBIT_API_KEY = 'private-test-key'; process.env.BYBIT_API_SECRET = 'private-test-secret'; process.env.DRY_RUN = 'true';
  let endpoint;
  RestClientV5.prototype.getWalletBalance = async function() { endpoint = this.options.baseUrl; return wallet(); };
  const status = await checkBybitDemoConnection();
  assert.equal(endpoint, 'https://api-demo.bybit.com');
  assert.match(status, /verified/);
  assert.match(status, /App Bybit routing: live/);
  assert.match(status, /USDT: 10000/);
  assert.match(status, /simulation: enabled/);
  assert.ok(!status.includes('private-test'));
  RestClientV5.prototype.getWalletBalance = async () => { throw { code: 403, message: 'private-test-secret', requestOptions: { key: 'private-test-key' } }; };
  const failure = await checkBybitDemoConnection();
  assert.match(failure, /HTTP 403/);
  assert.ok(!failure.includes('private-test'));
});

test('wallet API errors are surfaced as safe codes, not mistaken for a zero balance', async () => {
  clean();
  process.env.BYBIT_API_KEY = 'fake-key'; process.env.BYBIT_API_SECRET = 'fake-secret';
  RestClientV5.prototype.getWalletBalance = async () => ({ retCode: 10003, retMsg: 'private-secret', result: {} });
  const status = await checkBybitDemoConnection();
  assert.match(status, /Bybit code 10003/);
  assert.ok(!status.includes('private-secret'));
});
