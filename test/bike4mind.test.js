/**
 * Bike4Mind, end to end against its own API's documented shape: the key link, the catalog and credits, the native tools and pictures, the SSE stream's deltas
 * and cumulative text, and every refusal it documents. The stand-in is a loopback server (test/fixtures/fake_bike4mind.js); the provider only ever reaches
 * app.bike4mind.com unless ULA_TEST_MODE=1 and the base is 127.0.0.1.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createConfig } = require('../src/config');
const { createRegistry } = require('../src/registry');
const { createServer } = require('../src/server');
const { createBike4MindProvider } = require('../src/providers/bike4mind');
const { startFakeBike4Mind, MODELS } = require('./fixtures/fake_bike4mind');

process.env.ULA_TEST_MODE = '1';

const READ_TOOL = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file from the project.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function boot({ fake: fakeOptions = {}, link = true, token, provider: providerOptions = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-b4m-'));
  const fake = await startFakeBike4Mind(fakeOptions);
  const logs = [];
  const log = (line) => logs.push(line);
  const config = createConfig({ dataDir: dir });
  const provider = createBike4MindProvider({ dataDir: dir, config, base: fake.base, log, ...providerOptions });
  const linked = link ? await provider.linkToken({ token: token || fake.state.key, consentAcknowledged: true }) : null;
  const bus = new EventEmitter();
  const server = createServer({ config, registry: createRegistry({ providers: [provider], bus }), port: 0 });
  const info = await server.start();
  const apiKey = config.createApiKey('test key').key;
  const post = async (url, body, headers = {}) => {
    const res = await fetch(`${info.url}${url}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };
  return {
    dir, fake, provider, logs, config, server, base: info.url, apiKey, linked, post,
    send: (body) => post('/v1/chat/completions', body),
    async close() { await server.stop(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test('a Bike4Mind API key links the account: text models, credits, account, and a 0600 key file', async () => {
  const ui = await boot();
  try {
    assert.equal(ui.linked.ok, true);
    const state = await ui.provider.status();
    assert.equal(state.linked, true);
    assert.equal(state.expired, false);
    assert.equal(state.credits.balance, 5000);
    assert.equal(state.accountLabel, 'Ada Lovelace');
    assert.equal(state.tier, 'pro');
    assert.deepEqual(ui.provider.models().map((m) => m.id), ['claude-sonnet-test', 'gpt-plain-test', 'text-only-test']);
    const [claude, plain] = ui.provider.models();
    assert.equal(claude.context_length, 200000);
    assert.equal(claude.supportsTools, true);
    assert.equal(claude.supportsVision, true);
    assert.equal(plain.supportsVision, false);
    assert.equal(plain.context_length, 128000);
    const file = path.join(ui.dir, 'bike4mind_key.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).key, ui.fake.state.key);
    // The image model is not offered as a chat model, and the catalog was read in pages of 100.
    assert.equal(ui.fake.requests.some((r) => r.path === '/api/v1/models' && r.query.limit === '100'), true);
    assert.equal(ui.fake.requests.some((r) => r.path === '/api/v1/completions'), false);
  } finally { await ui.close(); }
});

test('the catalog follows next_cursor and stops on a repeated one', async () => {
  const pages = [[MODELS[0]], [MODELS[1], MODELS[2], MODELS[3]]];
  const ui = await boot({ fake: { pages } });
  try {
    assert.deepEqual(ui.provider.models().map((m) => m.id), ['claude-sonnet-test', 'gpt-plain-test', 'text-only-test']);
    const reads = ui.fake.requests.filter((r) => r.path === '/api/v1/models');
    assert.deepEqual(reads.map((r) => r.query.cursor || null), [null, '1']);
  } finally { await ui.close(); }
});

test('a plain question is one user message, and cumulative content events become one answer', async () => {
  const ui = await boot();
  try {
    ui.fake.state.script = () => ({
      events: [
        { type: 'meta', requestId: 'req_test' },
        { type: 'content', text: 'Hel' },
        { type: 'content', text: 'Hello' },
        { type: 'content', text: ' world', stopReason: 'end_turn', usage: { inputTokens: 4, outputTokens: 2 }, credits: { used: 2 } }
      ]
    });
    const { res, data } = await ui.send({ model: 'gpt-plain-test', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.equal(data.choices[0].message.content, 'Hello world');
    assert.equal(data.choices[0].finish_reason, 'stop');
    const sent = ui.fake.state.completions[0];
    assert.equal(sent.model, 'gpt-plain-test');
    assert.deepEqual(sent.messages, [{ role: 'user', content: 'hi' }]);
    assert.equal(sent.tools, undefined);
    assert.equal(sent.options, undefined);
    const state = await ui.provider.status();
    assert.equal(state.credits.balance, 4998);
  } finally { await ui.close(); }
});

test('temperature reaches Bike4Mind in its own options, and is not called ignored', async () => {
  const ui = await boot();
  try {
    const { res } = await ui.send({ model: 'gpt-plain-test', messages: [{ role: 'user', content: 'hi' }], temperature: 0.4 });
    assert.equal(res.status, 200);
    assert.equal(ui.fake.state.completions[0].options.temperature, 0.4);
    assert.equal(res.headers.get('x-ula-ignored'), null);
  } finally { await ui.close(); }
});

test('streaming sends the answer as OpenAI chunks and then a finish', async () => {
  const ui = await boot();
  try {
    ui.fake.state.script = () => ({
      events: [
        { type: 'content', text: 'one ' },
        { type: 'content', text: 'two', stopReason: 'end_turn' }
      ]
    });
    const res = await fetch(`${ui.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ui.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-plain-test', messages: [{ role: 'user', content: 'count' }], stream: true })
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"content":"one "/);
    assert.match(text, /"content":"two"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally { await ui.close(); }
});

test('native tools, reasoning effort and a picture reach the API; a tool_use event comes back as a tool call', async () => {
  const ui = await boot();
  try {
    ui.fake.state.script = () => ({
      events: [
        { type: 'content', text: 'I will read it.' },
        { type: 'tool_use', text: '', tools: [{ id: 'tool_1', name: 'read', arguments: '{"path":"a.txt"}' }], stopReason: 'tool_use', credits: { used: 4 } }
      ]
    });
    const { res, data } = await ui.send({
      model: 'claude-sonnet-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look at this and read the file' }, { type: 'image_url', image_url: { url: PNG } }] }],
      tools: [READ_TOOL],
      reasoning_effort: 'high'
    });
    assert.equal(res.status, 200);
    const message = data.choices[0].message;
    assert.equal(message.content, 'I will read it.');
    assert.equal(message.tool_calls.length, 1);
    assert.equal(message.tool_calls[0].function.name, 'read');
    // The bridge normalizes a `path` argument to `filePath` for every provider (src/bridge.js parseArgs).
    const args = JSON.parse(message.tool_calls[0].function.arguments);
    assert.equal(args.path, 'a.txt');
    assert.equal(args.filePath, 'a.txt');
    assert.equal(data.choices[0].finish_reason, 'tool_calls');

    const sent = ui.fake.state.completions[0];
    assert.equal(sent.tools.length, 1);
    assert.equal(sent.tools[0].toolSchema.name, 'read');
    assert.equal(sent.tools[0].toolSchema.parameters.type, 'object');
    assert.equal(sent.options.reasoningEffort, 'high');
    assert.equal(Array.isArray(sent.messages[0].content), true);
    const parts = sent.messages[0].content;
    assert.equal(parts[0].type, 'text');
    assert.match(parts[0].text, /look at this and read the file/);
    assert.match(parts[0].text, /\[attached image 1\]/);
    assert.equal(parts[1].type, 'image_url');
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
  } finally { await ui.close(); }
});

test('a model without tool support refuses a tool request before anything is spent', async () => {
  const ui = await boot();
  try {
    const { res, data } = await ui.send({ model: 'text-only-test', messages: [{ role: 'user', content: 'read it' }], tools: [READ_TOOL] });
    assert.equal(res.status, 400);
    assert.equal(data.error.code, 'bike4mind_error');
    assert.match(data.error.message, /does not call tools/);
    assert.equal(ui.fake.state.completions.length, 0);
  } finally { await ui.close(); }
});

test('a model without vision is told the picture was left out, and gets no image part', async () => {
  const ui = await boot();
  try {
    ui.fake.state.script = () => ({ events: [{ type: 'content', text: 'I cannot see it.', stopReason: 'end_turn' }] });
    const { res, data } = await ui.send({ model: 'gpt-plain-test', messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: PNG } }] }] });
    assert.equal(res.status, 200);
    assert.equal(data.choices[0].message.content, 'I cannot see it.');
    const sent = ui.fake.state.completions[0];
    assert.equal(typeof sent.messages[0].content, 'string');
    assert.match(sent.messages[0].content, /does not take pictures/);
  } finally { await ui.close(); }
});

test('thinking blocks are streamed apart and cumulative blocks are not repeated', async () => {
  const ui = await boot();
  try {
    ui.fake.state.script = () => ({
      events: [
        { type: 'content', text: 'The answer is 4.', thinking: [{ type: 'thinking', thinking: 'Add' }], stopReason: 'end_turn' },
        { type: 'content', text: '', thinking: [{ type: 'thinking', thinking: 'Adding two and two.' }] }
      ]
    });
    const { res, data } = await ui.send({ model: 'claude-sonnet-test', messages: [{ role: 'user', content: '2+2?' }], reasoning_effort: 'medium' });
    assert.equal(res.status, 200);
    assert.equal(data.choices[0].message.content, 'The answer is 4.');
    assert.equal(data.choices[0].message.reasoning_content, 'Adding two and two.');
  } finally { await ui.close(); }
});

test('a reply the API calls max_tokens is finish_reason length, not stop', async () => {
  const ui = await boot();
  try {
    ui.fake.state.script = () => ({ events: [{ type: 'content', text: 'The first half', stopReason: 'max_tokens' }] });
    const { res, data } = await ui.send({ model: 'gpt-plain-test', messages: [{ role: 'user', content: 'write a lot' }] });
    assert.equal(res.status, 200);
    assert.equal(data.choices[0].message.content, 'The first half');
    assert.equal(data.choices[0].finish_reason, 'length');
  } finally { await ui.close(); }
});

test('a refused key ends the account: 401, models gone, and the next request never reaches the API', async () => {
  const ui = await boot();
  try {
    ui.fake.state.script = () => ({ status: 401, json: { error: 'Missing or invalid credentials.' } });
    const first = await ui.send({ model: 'claude-sonnet-test', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(first.res.status, 401);
    assert.equal(first.data.error.code, 'bike4mind_session_expired');
    const state = await ui.provider.status();
    assert.equal(state.expired, true);
    assert.equal(state.models.length, 0);
    assert.match(state.expiredReason, /refused/);
    // With no models left, the caller is told the model is unknown rather than being sent to an account that already refused the key.
    const second = await ui.send({ model: 'claude-sonnet-test', messages: [{ role: 'user', content: 'again' }] });
    assert.equal(second.res.status, 404);
    assert.equal(second.data.error.code, 'model_not_found');
    assert.equal(ui.fake.state.completions.length, 1);
  } finally { await ui.close(); }
});

test('a 429 pauses the account, and the queued request is answered without another call', async () => {
  const ui = await boot();
  try {
    ui.fake.state.script = () => ({ status: 429, json: { error: 'Rate limit exceeded.' }, headers: { 'retry-after': '2' } });
    const first = await ui.send({ model: 'gpt-plain-test', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(first.res.status, 429);
    assert.equal(first.data.error.code, 'bike4mind_rate_limited');
    const state = await ui.provider.status();
    assert.equal(state.usage.isCooldown, true);
    assert.match(state.usage.cooldownReason, /refused requests/);
    const second = await ui.send({ model: 'gpt-plain-test', messages: [{ role: 'user', content: 'again' }] });
    assert.equal(second.res.status, 429);
    assert.equal(second.data.error.code, 'bike4mind_cooldown');
    assert.equal(ui.fake.state.completions.length, 1);
  } finally { await ui.close(); }
});

test('an in-band insufficient_credits error is a 400 with the credit message', async () => {
  const ui = await boot();
  try {
    ui.fake.state.script = () => ({ events: [{ type: 'content', text: 'Partial.' }, { type: 'error', code: 'insufficient_credits', message: 'The balance is empty.' }] });
    const { res, data } = await ui.send({ model: 'gpt-plain-test', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 400);
    assert.equal(data.error.code, 'bike4mind_error');
    assert.match(data.error.message, /credits are used up/);
    assert.match(data.error.message, /Top up/);
  } finally { await ui.close(); }
});

test('linking refuses a bad key shape, a 401, a missing scope and an unreachable host, in plain words', async () => {
  const ui = await boot({ link: false });
  try {
    const badShape = await ui.provider.linkToken({ token: 'b4m_no', consentAcknowledged: true });
    assert.equal(badShape.ok, false);
    assert.match(badShape.error, /begin with b4m_/);

    ui.fake.state.key = 'b4m_live_a_different_key_9999';
    const refused = await ui.provider.linkToken({ token: 'b4m_live_test_key_1234567890', consentAcknowledged: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /refused/);

    ui.fake.state.key = 'b4m_live_test_key_1234567890';
    ui.fake.state.modelsForbidden = true;
    const scope = await ui.provider.linkToken({ token: ui.fake.state.key, consentAcknowledged: true });
    assert.equal(scope.ok, false);
    assert.match(scope.error, /ai:chat/);

    ui.fake.state.modelsForbidden = false;
    const dead = await startFakeBike4Mind();
    await dead.close();
    const unreachable = createBike4MindProvider({ dataDir: ui.dir, config: ui.config, base: dead.base, log: () => {} });
    const gone = await unreachable.linkToken({ token: 'b4m_live_test_key_1234567890', consentAcknowledged: true });
    assert.equal(gone.ok, false);
    assert.match(gone.error, /could not be reached/);
    await unreachable.stop();
  } finally { await ui.close(); }
});

test('refreshing the catalog updates the models and the balance; the key never appears in a log or the state page', async () => {
  const ui = await boot();
  try {
    ui.fake.state.script = () => ({ events: [{ type: 'content', text: 'ok', stopReason: 'end_turn', credits: { used: 7 } }] });
    const { res } = await ui.send({ model: 'gpt-plain-test', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.equal((await ui.provider.status()).credits.balance, 4993);

    ui.fake.state.balance = 1234;
    ui.fake.state.pages = [[MODELS[0], MODELS[1], MODELS[2]]];
    assert.equal(await ui.provider.refreshModels(), true);
    const state = await ui.provider.status();
    assert.equal(state.credits.balance, 1234);
    assert.equal(state.models.length, 3);

    const key = ui.fake.state.key;
    assert.equal(ui.logs.some((line) => line.includes(key)), false);
    const page = await (await fetch(`${ui.base}/_/state`, { headers: { authorization: `Bearer ${ui.config.adminToken()}` } })).text();
    assert.equal(page.includes(key), false);
  } finally { await ui.close(); }
});
