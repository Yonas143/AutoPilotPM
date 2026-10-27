const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createGeminiAgentClient, createAgentClient, getAgentProvider, resolveAgentModel, validateAgentCredentials } = require('../../dist/agents/client.js');
const keys = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'AUTOPILOT_AI_PROVIDER', 'AUTOPILOT_GEMINI_MODEL'];
const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});
function clean() { for (const k of keys) delete process.env[k]; }
function reply(parts, finishReason = 'STOP') {
  return Response.json({ candidates: [{ content: { parts }, finishReason }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 } });
}
const request = { model: 'claude-sonnet-4-6', max_tokens: 1024, system: [{ type: 'text', text: 'Follow risk rules', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'hello' }] };

test('Gemini-only credentials pass; explicit selection and missing keys fail clearly', () => {
  clean();
  assert.throws(validateAgentCredentials, /GEMINI_API_KEY/);
  process.env.GEMINI_API_KEY = 'test-key';
  assert.doesNotThrow(validateAgentCredentials);
  assert.equal(getAgentProvider(), 'gemini');
  assert.equal(typeof createAgentClient().messages.create, 'function');
  process.env.ANTHROPIC_API_KEY = 'anthropic-test';
  assert.equal(getAgentProvider(), 'anthropic');
  assert.ok(createAgentClient().messages.stream);
  process.env.AUTOPILOT_AI_PROVIDER = 'gemini';
  assert.equal(getAgentProvider(), 'gemini');
  process.env.AUTOPILOT_GEMINI_MODEL = 'gemini-custom';
  assert.equal(resolveAgentModel('claude-haiku'), 'gemini-custom');
  assert.equal(resolveAgentModel('gemini-selected'), 'gemini-selected');
  delete process.env.GEMINI_API_KEY;
  assert.throws(validateAgentCredentials, /GEMINI_API_KEY/);
  process.env.AUTOPILOT_AI_PROVIDER = 'invalid';
  assert.throws(validateAgentCredentials, /must be/);
});

test('text/system requests use Gemini endpoint, header auth, model override and token accounting', async () => {
  clean();
  process.env.AUTOPILOT_GEMINI_MODEL = 'gemini-test';
  const client = createGeminiAgentClient('secret-test', async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    assert.equal(options.headers['x-goog-api-key'], 'secret-test');
    assert.ok(!url.includes('secret-test'));
    const body = JSON.parse(options.body);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Follow risk rules' }] });
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
    assert.equal(body.generationConfig.maxOutputTokens, 4096);
    return reply([{ text: 'Hello' }]);
  });
  const result = await client.messages.create(request);
  assert.equal(result.content[0].text, 'Hello');
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.usage.input_tokens, 12);
  assert.equal(result.usage.output_tokens, 4);
  assert.equal(client.messages.stream, undefined);
});

test('parallel tool calls preserve native signatures and map results back by ID', async () => {
  const parts = [
    { text: 'private reasoning', thought: true, thoughtSignature: 'thought-sig' },
    { functionCall: { id: 'native-a', name: 'get_balance', args: {} }, thoughtSignature: 'call-sig' },
    { functionCall: { name: 'get_price', args: { symbol: 'BTCUSDT' } } },
  ];
  let turn = 0;
  const client = createGeminiAgentClient('test', async (_, options) => {
    const body = JSON.parse(options.body);
    if (++turn === 1) {
      assert.deepEqual(body.tools[0].functionDeclarations[0], { name: 'get_balance', description: 'Balance', parametersJsonSchema: { type: 'object', properties: {} } });
      return reply(parts);
    }
    assert.deepEqual(body.contents[1], { role: 'model', parts });
    assert.deepEqual(body.contents[2].parts, [
      { functionResponse: { name: 'get_balance', id: 'native-a', response: { output: '100' } } },
      { functionResponse: { name: 'get_price', response: { error: 'unavailable' } } },
    ]);
    return reply([{ text: 'Balance: 100' }]);
  });
  const first = await client.messages.create({ ...request, tools: [{ name: 'get_balance', description: 'Balance', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } }] });
  assert.equal(first.stop_reason, 'tool_use');
  assert.equal(first.content.length, 2);
  const second = await client.messages.create({ ...request, messages: [
    ...request.messages,
    { role: 'assistant', content: first.content },
    { role: 'user', content: first.content.map((b, i) => ({ type: 'tool_result', tool_use_id: b.id, content: i ? 'unavailable' : '100', is_error: !!i })) },
  ] });
  assert.equal(second.content[0].text, 'Balance: 100');
});

test('base64 images map correctly and unsupported blocks fail instead of silently disappearing', async () => {
  const client = createGeminiAgentClient('test', async (_, options) => {
    assert.deepEqual(JSON.parse(options.body).contents[0].parts, [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }]);
    return reply([{ text: 'Image received' }]);
  });
  await client.messages.create({ ...request, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] });
  await assert.rejects(client.messages.create({ ...request, messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }] }), /does not support/);
  await assert.rejects(client.messages.create({ ...request, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }] }] }), /no matching/);
});

test('API errors are sanitized, blocked content fails, and truncated tool calls are not executed', async () => {
  const client = createGeminiAgentClient('secret', async () => new Response('secret echoed upstream', { status: 429 }));
  await assert.rejects(client.messages.create(request), error => error.status === 429 && !error.message.includes('secret'));
  const blocked = createGeminiAgentClient('test', async () => Response.json({ promptFeedback: { blockReason: 'SAFETY' } }));
  await assert.rejects(blocked.messages.create(request), /no content/);
  const unsafe = createGeminiAgentClient('test', async () => reply([{ functionCall: { name: 'trade', args: {} } }], 'SAFETY'));
  await assert.rejects(unsafe.messages.create(request), /without a usable completion/);
  const truncated = createGeminiAgentClient('test', async () => reply([{ functionCall: { name: 'trade', args: {} } }], 'MAX_TOKENS'));
  assert.equal((await truncated.messages.create(request)).stop_reason, 'max_tokens');
});

test('abort signals reach the request and model IDs cannot alter the endpoint', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = createGeminiAgentClient('test', async (_, options) => {
    assert.equal(options.signal.aborted, true);
    throw options.signal.reason;
  });
  await assert.rejects(client.messages.create(request, { signal: controller.signal }));
  process.env.AUTOPILOT_GEMINI_MODEL = 'gemini-bad/path?key=leak';
  await assert.rejects(client.messages.create(request), /Invalid Gemini model/);
});

test('temporary Gemini errors retry and Retry-After is bounded; permanent errors have safe user hints', async () => {
  const { GeminiApiError } = require('../../dist/agents/client.js');
  const { withRetry } = require('../../dist/infra/retry.js');
  let attempts = 0;
  const client = createGeminiAgentClient('secret', async () => ++attempts < 3
    ? new Response('secret provider text', { status: 503 }) : reply([{ text: 'Recovered' }]));
  const result = await withRetry(() => client.messages.create(request), { maxAttempts: 3, minDelay: 1, maxDelay: 2, jitter: 0 });
  assert.equal(attempts, 3);
  assert.equal(result.content[0].text, 'Recovered');
  const busy = createGeminiAgentClient('secret', async () => new Response('secret', { status: 503, headers: { 'retry-after': '999' } }));
  await assert.rejects(busy.messages.create(request), e => e instanceof GeminiApiError && e.retryAfter === 30000 && e.userMessage.includes('temporarily unavailable') && !e.message.includes('secret'));
  assert.match(new GeminiApiError(429).userMessage, /quota/);
  assert.match(new GeminiApiError(403).userMessage, /permissions/);
  assert.match(new GeminiApiError(404).userMessage, /AUTOPILOT_GEMINI_MODEL/);
});

test('model command accepts Gemini IDs and reports the effective Gemini model', async () => {
  clean();
  process.env.GEMINI_API_KEY = 'test';
  const { createDefaultCommands } = require('../../dist/commands/registry.js');
  const command = createDefaultCommands().find(c => c.name === 'model');
  const session = { context: {} };
  let saved = false;
  const ctx = { session, sessions: { updateSession() { saved = true; } } };
  assert.match(await command.handler('gemini-3.5-flash-lite', ctx), /Model set to gemini-3.5-flash-lite/);
  assert.equal(saved, true);
  assert.equal(session.context.modelOverride, 'gemini-3.5-flash-lite');
  assert.match(await command.handler('', ctx), /gemini-3.5-flash-lite/);
  assert.match(await command.handler('gemini-bad/path', ctx), /Unknown model/);
});
