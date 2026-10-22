'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createConfig } = require('../src/config');
const { createRegistry } = require('../src/registry');
const { createServer } = require('../src/server');
const { createFakeProvider } = require('./fixtures/fake_provider');

const WEATHER = [{ type: 'function', function: { name: 'get_weather', description: 'Current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];

async function boot({ fake: fakeOpts = {}, server: serverOpts = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-test-'));
  const bus = new EventEmitter();
  const fake = createFakeProvider({ dir, bus, ...fakeOpts });
  const registry = createRegistry({ providers: [fake], bus });
  const config = createConfig({ dataDir: dir });
  const logs = [];
  const srv = createServer({ config, registry, port: 0, log: (l) => logs.push(l), ...serverOpts });
  const { port } = await srv.start();
  const { key } = config.createApiKey('test');
  return {
    dir, fake, config, srv, key, port, logs, base: `http://127.0.0.1:${port}`,
    async close() { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

/** A request with full control of the headers (fetch will not let a test set Host or Origin). */
function raw(t, { method = 'GET', pathname = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: t.port, method, path: pathname, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

const chat = (t, body, headers = {}) => fetch(`${t.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.key}`, ...headers }, body: JSON.stringify(body) });
const user = (text) => ({ role: 'user', content: text });

async function sse(res) {
  const text = await res.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const data = line.slice(6);
    events.push(data === '[DONE]' ? '[DONE]' : JSON.parse(data));
  }
  return events;
}

// ---- keys and models -------------------------------------------------------------------------------------------------------------------------

test('the API needs a key: none, a wrong one and a revoked one are refused', async () => {
  const t = await boot();
  try {
    const none = await fetch(`${t.base}/v1/models`);
    assert.equal(none.status, 401);
    assert.equal((await none.json()).error.code, 'invalid_api_key');
    assert.equal((await fetch(`${t.base}/v1/models`, { headers: { authorization: 'Bearer sk-ula-wrong' } })).status, 401);
    assert.equal((await fetch(`${t.base}/v1/models`, { headers: { authorization: `Bearer ${t.key}` } })).status, 200);
    assert.equal((await fetch(`${t.base}/v1/models`, { headers: { 'x-api-key': t.key } })).status, 200);
    const id = t.config.listApiKeys()[0].id;
    assert.ok(t.config.revokeApiKey(id));
    assert.equal((await fetch(`${t.base}/v1/models`, { headers: { authorization: `Bearer ${t.key}` } })).status, 401);
  } finally { await t.close(); }
});

test('a key is kept in config.json (so it can be shown again) next to its hash, the file is owner-only, and the key is nowhere else in the data folder', async () => {
  const t = await boot();
  try {
    const file = path.join(t.dir, 'config.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.apiKeys.length, 1);
    assert.equal(saved.apiKeys[0].secret, t.key, 'the key is kept, so the interface can show it again');
    assert.ok(saved.apiKeys[0].hash && !saved.apiKeys[0].hash.includes(t.key), 'and the hash is what a call is checked against');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    for (const name of fs.readdirSync(t.dir)) {
      if (name === 'config.json') continue;
      const p = path.join(t.dir, name);
      if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, 'utf8').includes(t.key), `${name} must not hold the key`);
    }
  } finally { await t.close(); }
});

test('/v1/models lists the linked models and nothing from an expired account', async () => {
  const t = await boot();
  try {
    const list = await (await fetch(`${t.base}/v1/models`, { headers: { authorization: `Bearer ${t.key}` } })).json();
    assert.equal(list.object, 'list');
    assert.deepEqual(list.data.map((m) => m.id), ['fake-chat', 'fake-reasoner', 'fake-auto']);
    assert.equal(list.data[0].owned_by, 'fake');
    t.fake.script.expired = true;
    const after = await (await fetch(`${t.base}/v1/models`, { headers: { authorization: `Bearer ${t.key}` } })).json();
    assert.deepEqual(after.data, []);
  } finally { await t.close(); }
});

test('an unknown model is a 404 that names what is available; the provider prefix and a missing model both work', async () => {
  const t = await boot();
  try {
    const miss = await chat(t, { model: 'gpt-4o', messages: [user('hi')] });
    assert.equal(miss.status, 404);
    const err = (await miss.json()).error;
    assert.equal(err.code, 'model_not_found');
    assert.match(err.message, /fake-chat/);
    assert.equal((await chat(t, { model: 'fake/fake-chat', messages: [user('hi')] })).status, 200);
    assert.equal((await chat(t, { messages: [user('hi')] })).status, 200);
    assert.equal((await chat(t, { model: 'fake-chat', messages: [] })).status, 400);
  } finally { await t.close(); }
});

// ---- completions -----------------------------------------------------------------------------------------------------------------------------

test('a plain completion has the OpenAI shape, an estimated usage and the model that was asked for', async () => {
  const t = await boot();
  try {
    t.fake.script.reply = () => ({ ok: true, text: 'The sky is blue because of Rayleigh scattering.' });
    const res = await chat(t, { model: 'fake-chat', messages: [user('Why is the sky blue?')] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.model, 'fake-chat');
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(body.choices[0].message.content, 'The sky is blue because of Rayleigh scattering.');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.ok(body.usage.prompt_tokens > 0 && body.usage.completion_tokens > 0);
    assert.equal(body.usage.total_tokens, body.usage.prompt_tokens + body.usage.completion_tokens);
    assert.equal(t.fake.calls[0].prompt, 'Why is the sky blue?', 'a plain question goes upstream as it is');
    assert.equal(t.fake.calls[0].thinking, false);
  } finally { await t.close(); }
});

test('streaming sends chunks, a role first, a stop last and [DONE]; the text adds up', async () => {
  const t = await boot();
  try {
    t.fake.script.reply = () => ({ ok: true, text: 'one two three four five six seven' });
    const events = await sse(await chat(t, { model: 'fake-chat', stream: true, messages: [user('count')] }));
    assert.equal(events[events.length - 1], '[DONE]');
    const chunks = events.filter((e) => e !== '[DONE]');
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
    assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop');
    assert.equal(chunks.map((c) => c.choices[0].delta.content || '').join(''), 'one two three four five six seven');
    assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk' && c.id === chunks[0].id));
    assert.ok(chunks.length > 4, 'the answer arrived in pieces');
  } finally { await t.close(); }
});

test('stream_options.include_usage adds a final usage chunk', async () => {
  const t = await boot();
  try {
    const events = await sse(await chat(t, { model: 'fake-chat', stream: true, stream_options: { include_usage: true }, messages: [user('hi')] }));
    const last = events[events.length - 2];
    assert.deepEqual(last.choices, []);
    assert.ok(last.usage.total_tokens > 0);
    const plain = await sse(await chat(t, { model: 'fake-chat', stream: true, messages: [user('hi')] }));
    assert.ok(plain.filter((e) => e !== '[DONE]').every((e) => !e.usage));
  } finally { await t.close(); }
});

test('a thinking model streams reasoning_content apart from the answer, and returns it whole when not streaming', async () => {
  const t = await boot();
  try {
    t.fake.script.reply = (_prompt, { thinking }) => ({ ok: true, text: 'Forty-two.', thinking: thinking ? 'Let me work it out.' : '' });
    const events = (await sse(await chat(t, { model: 'fake-reasoner', stream: true, messages: [user('meaning of life?')] }))).filter((e) => e !== '[DONE]');
    assert.equal(events.map((e) => e.choices[0].delta.reasoning_content || '').join(''), 'Let me work it out.');
    assert.equal(events.map((e) => e.choices[0].delta.content || '').join(''), 'Forty-two.');
    assert.equal(t.fake.calls[0].thinking, true, 'the reasoner asks the provider for its thinking mode');
    const whole = await (await chat(t, { model: 'fake-reasoner', messages: [user('again')] })).json();
    assert.equal(whole.choices[0].message.reasoning_content, 'Let me work it out.');
    assert.ok(whole.usage.completion_tokens_details.reasoning_tokens > 0);
  } finally { await t.close(); }
});

test('reasoning_effort is passed on, and response_format asks for JSON in words', async () => {
  const t = await boot();
  try {
    await chat(t, { model: 'fake-chat', reasoning_effort: 'high', response_format: { type: 'json_object' }, messages: [user('two colours')] });
    assert.equal(t.fake.calls[0].thinkingLevel, 'high');
    assert.match(t.fake.calls[0].prompt, /valid JSON value only/);
    await chat(t, { model: 'fake-chat', reasoning_effort: 'minimal', messages: [user('x')] });
    assert.equal(t.fake.calls[1].thinkingLevel, 'low');
  } finally { await t.close(); }
});

// ---- tools -----------------------------------------------------------------------------------------------------------------------------------

function weatherChat(prompt) {
  if (/TOOL RESULT \(get_weather\)/.test(prompt)) return { ok: true, text: 'It is sunny in Dar es Salaam.' };
  return { ok: true, text: 'Let me look.\n<tool_call>{"name":"get_weather","arguments":{"city":"Dar es Salaam"}}</tool_call>' };
}

test('a tool call comes back as tool_calls, and the result in the next request finishes the task', async () => {
  const t = await boot();
  try {
    t.fake.script.reply = weatherChat;
    const first = await (await chat(t, { model: 'fake-chat', tools: WEATHER, messages: [user('Weather in Dar es Salaam?')] })).json();
    const call = first.choices[0].message.tool_calls[0];
    assert.equal(first.choices[0].finish_reason, 'tool_calls');
    assert.equal(call.function.name, 'get_weather');
    assert.deepEqual(JSON.parse(call.function.arguments), { city: 'Dar es Salaam' });
    assert.equal(first.choices[0].message.content, 'Let me look.');
    const second = await (await chat(t, {
      model: 'fake-chat', tools: WEATHER,
      messages: [user('Weather in Dar es Salaam?'), first.choices[0].message, { role: 'tool', tool_call_id: call.id, content: '31C, clear' }]
    })).json();
    assert.equal(second.choices[0].finish_reason, 'stop');
    assert.equal(second.choices[0].message.content, 'It is sunny in Dar es Salaam.');
    assert.match(t.fake.calls[1].prompt, /TOOL RESULT \(get_weather\):\n31C, clear/);
  } finally { await t.close(); }
});

test('a streamed tool call never shows its markup as text', async () => {
  const t = await boot();
  try {
    t.fake.script.reply = weatherChat;
    const events = (await sse(await chat(t, { model: 'fake-chat', stream: true, tools: WEATHER, messages: [user('Weather?')] }))).filter((e) => e !== '[DONE]');
    const text = events.map((e) => e.choices[0].delta.content || '').join('');
    assert.ok(!text.includes('<tool') && !text.includes('get_weather'), `markup leaked: ${text}`);
    const calls = events.flatMap((e) => e.choices[0].delta.tool_calls || []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'get_weather');
    assert.equal(events[events.length - 1].choices[0].finish_reason, 'tool_calls');
  } finally { await t.close(); }
});

test('a plain chat is never read for tool calls, even when the answer talks about them', async () => {
  const t = await boot();
  try {
    const answers = ['Wrap a call in <tool_call> tags and close it with </tool_call>.', '{"name":"Ada","arguments":{"age":36}}', '```json\n{"name":"Ada","arguments":{}}\n```'];
    for (const text of answers) {
      t.fake.script.reply = () => ({ ok: true, text });
      const whole = await (await chat(t, { model: 'fake-chat', messages: [user('explain')] })).json();
      assert.equal(whole.choices[0].message.content, text);
      assert.equal(whole.choices[0].message.tool_calls, undefined);
      const events = (await sse(await chat(t, { model: 'fake-chat', stream: true, messages: [user('explain')] }))).filter((e) => e !== '[DONE]');
      assert.equal(events.map((e) => e.choices[0].delta.content || '').join(''), text, 'streamed text must be the whole answer');
    }
    assert.equal(t.fake.calls.length, answers.length * 2, 'no retry was spent on a "damaged call" that was only text');
  } finally { await t.close(); }
});

test('a tool call cut off in its content is asked for once more, then used', async () => {
  const t = await boot();
  try {
    t.fake.script.reply = (_p, { call }) => (call === 1
      ? { ok: true, text: '<tool_call>{"name":"get_weather","arguments":{"city":"Da' }
      : { ok: true, text: '<tool_call>{"name":"get_weather","arguments":{"city":"Dar"}}</tool_call>' });
    const body = await (await chat(t, { model: 'fake-chat', tools: WEATHER, messages: [user('Weather?')] })).json();
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.equal(t.fake.calls.length, 2);
    assert.match(t.fake.calls[1].prompt, /NOTE: your last reply/);
  } finally { await t.close(); }
});

test('a tool call that stays unreadable is an error, not text', async () => {
  const t = await boot();
  try {
    t.fake.script.reply = () => ({ ok: true, text: '<tool_call>{"name":"get_weather","arguments":{"city":"Da' });
    const res = await chat(t, { model: 'fake-chat', tools: WEATHER, messages: [user('Weather?')] });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'fake_unreadable_tool_call');
  } finally { await t.close(); }
});

test('an empty answer is asked for once more, then reported', async () => {
  const t = await boot();
  try {
    t.fake.script.reply = () => ({ ok: true, text: '' });
    const res = await chat(t, { model: 'fake-chat', messages: [user('hi')] });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'fake_empty_answer');
    assert.equal(t.fake.calls.length, 2);
  } finally { await t.close(); }
});

test('an escalating model hands one hard question to the thinking mode and builds from the answer', async () => {
  const t = await boot();
  try {
    t.fake.script.reply = (prompt, { thinking }) => {
      if (thinking) return { ok: true, text: 'PLAN-FROM-REASONER: use a grid.', thinking: 'weighing options' };
      if (/TOOL RESULT \(think\)/.test(prompt)) return { ok: true, text: 'Built from: PLAN-FROM-REASONER' };
      return { ok: true, text: '<tool_call>{"name":"think","arguments":{"question":"How should it be laid out?"}}</tool_call>' };
    };
    const events = (await sse(await chat(t, { model: 'fake-auto', stream: true, tools: WEATHER, messages: [user('Design me a page')] }))).filter((e) => e !== '[DONE]');
    assert.equal(events.map((e) => e.choices[0].delta.content || '').join(''), 'Built from: PLAN-FROM-REASONER');
    assert.equal(events.map((e) => e.choices[0].delta.reasoning_content || '').join(''), 'weighing options', 'the thought is shown as reasoning');
    assert.equal(events.flatMap((e) => e.choices[0].delta.tool_calls || []).length, 0, 'the client never sees the think step');
    assert.deepEqual(t.fake.calls.map((c) => c.thinking), [false, true, false]);
    assert.match(t.fake.calls[1].prompt, /QUESTION:\nHow should it be laid out\?/);
    assert.ok(!/# Tool bridge/.test(t.fake.calls[1].prompt), 'the thinking mode answers a question, it does not get the tool protocol');
  } finally { await t.close(); }
});

test('an escalating model with no tools is just the plain chat', async () => {
  const t = await boot();
  try {
    await chat(t, { model: 'fake-auto', messages: [user('hi')] });
    assert.equal(t.fake.calls.length, 1);
    assert.ok(!/think/i.test(t.fake.calls[0].prompt));
  } finally { await t.close(); }
});

// ---- the governor in front of the account -----------------------------------------------------------------------------------------------------

test('the daily cap answers 429 with Retry-After and sends nothing upstream', async () => {
  const t = await boot({ fake: { dailyCap: 2 } });
  try {
    assert.equal((await chat(t, { model: 'fake-chat', messages: [user('1')] })).status, 200);
    assert.equal((await chat(t, { model: 'fake-chat', messages: [user('2')] })).status, 200);
    const third = await chat(t, { model: 'fake-chat', messages: [user('3')] });
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) > 0);
    assert.equal((await third.json()).error.code, 'fake_daily_cap');
    assert.equal(t.fake.calls.length, 2);
  } finally { await t.close(); }
});

test('when the provider refuses, the request ends in one plain 429 and the next requests are answered locally', async () => {
  const t = await boot();
  try {
    t.fake.script.reply = () => { t.fake.governor.setCooldown(600000, 'DeepSeek said messages are too frequent'); return { ok: false, rateLimited: true, error: 'Fake has reached its own limit for this account.' }; };
    const first = await chat(t, { model: 'fake-chat', messages: [user('1')] });
    assert.equal(first.status, 429);
    assert.equal((await first.json()).error.code, 'fake_rate_limited');
    assert.ok(Number(first.headers.get('retry-after')) > 500);
    const second = await chat(t, { model: 'fake-chat', messages: [user('2')] });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error.code, 'fake_cooldown');
    assert.equal(t.fake.calls.length, 1, 'nothing more was sent to the account while it is cooling down');
    t.fake.governor.clearCooldown();
    t.fake.script.reply = () => ({ ok: true, text: 'back' });
    assert.equal((await chat(t, { model: 'fake-chat', messages: [user('3')] })).status, 200);
  } finally { await t.close(); }
});

test('a muted account is a 429 with the provider\'s own words', async () => {
  const t = await boot();
  try {
    t.fake.script.reply = () => { t.fake.governor.setCooldown(3600000, 'muted'); return { ok: false, rateLimited: true, noticeKind: 'muted', noticeShort: 'Fake muted this account', error: 'Fake has muted this account until Saturday.' }; };
    const res = await chat(t, { model: 'fake-chat', messages: [user('1')] });
    assert.equal(res.status, 429);
    const err = (await res.json()).error;
    assert.equal(err.code, 'fake_muted');
    assert.match(err.message, /muted this account until Saturday/);
    assert.equal(t.srv.notices[0].kind, 'muted');
  } finally { await t.close(); }
});

test('an expired sign-in is a 401 that says so, before and during a request', async () => {
  const t = await boot();
  try {
    t.fake.script.reply = () => ({ ok: false, authExpired: true, error: 'Your Fake session has expired. Sign in again on the Accounts page.' });
    const during = await chat(t, { model: 'fake-chat', messages: [user('1')] });
    assert.equal(during.status, 401);
    assert.equal((await during.json()).error.code, 'fake_session_expired');
    t.fake.script.expired = true;
    const before = await chat(t, { model: 'fake-chat', messages: [user('2')] });
    assert.equal(before.status, 404, 'an expired account offers no models');
  } finally { await t.close(); }
});

test('a full queue is refused instead of piling up', async () => {
  const t = await boot();
  try {
    t.fake.script.delayMs = 120;
    const all = await Promise.all(Array.from({ length: 9 }, (_, i) => chat(t, { model: 'fake-chat', messages: [user(`q${i}`)] })));
    const statuses = all.map((r) => r.status);
    assert.ok(statuses.includes(429), `statuses: ${statuses}`);
    assert.ok(statuses.filter((s) => s === 200).length >= 7);
    const refused = all.find((r) => r.status === 429);
    assert.equal((await refused.json()).error.code, 'fake_queue_full');
  } finally { await t.close(); }
});

test('a client that goes away stops the work and costs nothing more', async () => {
  const t = await boot();
  try {
    t.fake.script.delayMs = 400;
    const controller = new AbortController();
    const pending = chat(t, { model: 'fake-chat', stream: true, messages: [user('slow')] }, {}).catch(() => null);
    const aborted = fetch(`${t.base}/v1/chat/completions`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${t.key}` }, body: JSON.stringify({ model: 'fake-chat', stream: true, messages: [user('abandoned')] }) }).catch(() => null);
    setTimeout(() => controller.abort(), 100);
    await aborted;
    await pending;
    for (let i = 0; i < 100 && !(t.srv.requests.some((r) => r.status === 499) && t.srv.requests.some((r) => r.status === 200)); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.ok(t.srv.requests.some((r) => r.status === 499), 'the abandoned request was ended as client-closed');
    assert.ok(t.srv.requests.some((r) => r.status === 200), 'the other request was answered');
    assert.equal(t.fake.governor.getStats().todayCalls, 1, 'only the call that was answered counts against the account');
    assert.equal(t.fake.calls.length, 1, 'the abandoned request was still waiting for its turn, so it was never sent to the account');
  } finally { await t.close(); }
});

test('a client that leaves after its message went out still spent the account, and the count says so', async () => {
  const t = await boot();
  try {
    t.fake.script.delayMs = 300;
    const controller = new AbortController();
    const going = fetch(`${t.base}/v1/chat/completions`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${t.key}` }, body: JSON.stringify({ model: 'fake-chat', stream: true, messages: [user('sent then abandoned')] }) }).catch(() => null);
    for (let i = 0; i < 60 && !t.fake.calls.length; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.fake.calls.length, 1, 'the message reached the account');
    controller.abort();
    await going;
    for (let i = 0; i < 60 && !t.srv.requests.some((r) => r.status === 499); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.ok(t.srv.requests.some((r) => r.status === 499));
    assert.equal(t.fake.governor.getStats().todayCalls, 1, 'a message that was sent counts toward the daily and per-minute limits even if nobody read the answer');
  } finally { await t.close(); }
});

// ---- the server's own safety -------------------------------------------------------------------------------------------------------------------

test('a Host header that is not this server\'s own is refused on loopback', async () => {
  const t = await boot();
  try {
    const bad = await raw(t, { pathname: '/v1/models', headers: { host: 'evil.example', authorization: `Bearer ${t.key}` } });
    assert.equal(bad.status, 403);
    assert.equal(bad.json().error.code, 'forbidden_host');
    const good = await raw(t, { pathname: '/v1/models', headers: { host: `localhost:${t.port}`, authorization: `Bearer ${t.key}` } });
    assert.equal(good.status, 200);
  } finally { await t.close(); }
});

test('a key can be shown again from the interface: only with the sign-in, never from another site, and an older hash-only key says so', async () => {
  const t = await boot();
  try {
    const login = await raw(t, { pathname: `/_/login?token=${encodeURIComponent(t.config.adminToken())}` });
    const jar = String(login.headers['set-cookie'][0]).split(';')[0];
    const own = { cookie: jar, origin: `http://127.0.0.1:${t.port}` };
    const id = t.config.listApiKeys()[0].id;
    assert.equal((await raw(t, { method: 'POST', pathname: `/_/keys/${id}/reveal`, headers: { authorization: `Bearer ${t.key}`, origin: own.origin } })).status, 401, 'an API key cannot read keys');
    assert.equal((await raw(t, { method: 'POST', pathname: `/_/keys/${id}/reveal`, headers: { cookie: jar, origin: 'http://evil.example' } })).status, 403, 'another site cannot');
    assert.equal((await raw(t, { pathname: `/_/keys/${id}/reveal`, headers: own })).status === 200, false, 'a plain GET does not hand it over');
    const shown = await raw(t, { method: 'POST', pathname: `/_/keys/${id}/reveal`, headers: own });
    assert.equal(shown.status, 200);
    assert.equal(shown.json().key, t.key);
    assert.match(String(shown.headers['cache-control']), /no-store/);
    assert.equal((await raw(t, { method: 'POST', pathname: '/_/keys/ffffffffffff/reveal', headers: own })).status, 404);
    // a key from version 0.1.0 (hash only)
    const file = path.join(t.dir, 'config.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.apiKeys.push({ id: 'aaaaaaaaaaaa', name: 'old', hash: 'x'.repeat(64), hint: 'sk-ula-old...old', createdAt: new Date().toISOString(), lastUsedAt: null });
    fs.writeFileSync(file, JSON.stringify(data));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const old = await raw(t, { method: 'POST', pathname: '/_/keys/aaaaaaaaaaaa/reveal', headers: own });
    assert.equal(old.status, 409);
    assert.match(old.json().error.message, /make a new one/i);
    const state = await raw(t, { pathname: '/_/state', headers: { cookie: jar } });
    assert.ok(!state.text.includes(t.key), 'the state still never carries a key');
  } finally { await t.close(); }
});

test('the admin API needs the sign-in; the link signs in with a cookie; the cookie cannot act for another site', async () => {
  const t = await boot();
  try {
    assert.equal((await raw(t, { pathname: '/_/state' })).status, 401);
    assert.equal((await raw(t, { pathname: '/_/state', headers: { authorization: `Bearer ${t.key}` } })).status, 401, 'an API key is not the admin sign-in');
    assert.equal((await raw(t, { pathname: '/_/login?token=wrong' })).status, 401);
    const login = await raw(t, { pathname: `/_/login?token=${encodeURIComponent(t.config.adminToken())}` });
    assert.equal(login.status, 302);
    const cookie = String(login.headers['set-cookie'][0]);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const jar = cookie.split(';')[0];
    const state = await raw(t, { pathname: '/_/state', headers: { cookie: jar } });
    assert.equal(state.status, 200);
    const body = state.json();
    assert.equal(body.providers[0].id, 'fake');
    assert.equal(body.keys.length, 1);
    assert.ok(!JSON.stringify(body).includes(t.key), 'the state never carries a key');

    const jsonHeaders = { cookie: jar, 'content-type': 'application/json' };
    const foreign = await raw(t, { method: 'POST', pathname: '/_/keys', headers: { ...jsonHeaders, origin: 'http://evil.example' }, body: '{"name":"x"}' });
    assert.equal(foreign.status, 403, 'a page on another site must not be able to make a key');
    const crossSite = await raw(t, { method: 'POST', pathname: '/_/keys', headers: { ...jsonHeaders, 'sec-fetch-site': 'cross-site' }, body: '{"name":"x"}' });
    assert.equal(crossSite.status, 403);
    const own = await raw(t, { method: 'POST', pathname: '/_/keys', headers: { ...jsonHeaders, origin: `http://127.0.0.1:${t.port}` }, body: '{"name":"laptop"}' });
    assert.equal(own.status, 200);
    const made = own.json();
    assert.match(made.key, /^sk-ula-/);
    assert.equal((await fetch(`${t.base}/v1/models`, { headers: { authorization: `Bearer ${made.key}` } })).status, 200);
    const gone = await raw(t, { method: 'DELETE', pathname: `/_/keys/${made.entry.id}`, headers: { cookie: jar, origin: `http://127.0.0.1:${t.port}` } });
    assert.equal(gone.status, 200);
    assert.equal((await fetch(`${t.base}/v1/models`, { headers: { authorization: `Bearer ${made.key}` } })).status, 401);

    // the interface uses the same endpoint as everyone, signed in with the cookie
    assert.equal((await raw(t, { method: 'POST', pathname: '/v1/chat/completions', headers: { ...jsonHeaders, origin: 'http://evil.example' }, body: JSON.stringify({ model: 'fake-chat', messages: [user('x')] }) })).status, 403);
    assert.equal((await raw(t, { method: 'POST', pathname: '/v1/chat/completions', headers: { ...jsonHeaders, origin: `http://127.0.0.1:${t.port}` }, body: JSON.stringify({ model: 'fake-chat', messages: [user('x')] }) })).status, 200);
  } finally { await t.close(); }
});

test('the admin token also works as a bearer for scripts, and logout clears the cookie', async () => {
  const t = await boot();
  try {
    assert.equal((await raw(t, { pathname: '/_/state', headers: { authorization: `Bearer ${t.config.adminToken()}` } })).status, 200);
    const out = await raw(t, { method: 'POST', pathname: '/_/logout', headers: { authorization: `Bearer ${t.config.adminToken()}`, 'content-type': 'application/json' }, body: '{}' });
    assert.match(String(out.headers['set-cookie'][0]), /Max-Age=0/);
  } finally { await t.close(); }
});

test('an oversized body is a 413, and a body that is not JSON is a 400', async () => {
  const t = await boot();
  try {
    const big = await raw(t, { method: 'POST', pathname: '/v1/chat/completions', headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-chat', messages: [user('x'.repeat(17 * 1024 * 1024))] }) });
    assert.equal(big.status, 413);
    const bad = await raw(t, { method: 'POST', pathname: '/v1/chat/completions', headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
  } finally { await t.close(); }
});

test('a body that is valid JSON but not an object is a 400 at once, never a request left hanging', async () => {
  const t = await boot();
  try {
    for (const body of ['null', '0', 'false', '""', '[]', '[1]']) {
      const res = await fetch(`${t.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.key}` }, body, signal: AbortSignal.timeout(4000) });
      assert.equal(res.status, 400, `body ${body}`);
      assert.equal((await res.json()).error.code, 'bad_body');
    }
    const admin = await fetch(`${t.base}/_/keys`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.config.adminToken()}` }, body: 'null', signal: AbortSignal.timeout(4000) });
    assert.equal(admin.status, 400);
  } finally { await t.close(); }
});

test('without keys, a page on another site cannot spend the account: the origin is checked and the body must be JSON', async () => {
  const t = await boot({ server: { requireKey: false } });
  try {
    const body = JSON.stringify({ model: 'fake-chat', messages: [user('hi')] });
    const post = (headers) => raw(t, { method: 'POST', pathname: '/v1/chat/completions', headers, body });
    // the "simple request" a foreign page can send with no preflight: text/plain, no custom header
    const simple = await post({ 'content-type': 'text/plain', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.equal(simple.status, 403);
    assert.equal(simple.json().error.code, 'forbidden_origin');
    assert.equal((await post({ 'content-type': 'application/json', origin: 'http://evil.example' })).status, 403, 'a foreign Origin, even with a JSON body');
    assert.equal((await post({ 'content-type': 'application/json', 'sec-fetch-site': 'same-site' })).status, 403, 'a sibling site on this machine is another site');
    assert.equal((await post({ 'content-type': 'application/json', origin: 'null' })).status, 403, 'a sandboxed page sends Origin: null');
    assert.equal(t.fake.calls.length, 0, 'nothing reached the account');
    // a script with no browser headers is the intended use
    const wrongType = await post({ 'content-type': 'text/plain' });
    assert.equal(wrongType.status, 415, 'a plain-text body is not accepted without a key');
    assert.equal((await post({ 'content-type': 'application/json' })).status, 200);
    assert.equal((await fetch(`${t.base}/v1/models`)).status, 200);
  } finally { await t.close(); }
});

test('open CORS cannot be combined with no keys', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-test-'));
  try {
    assert.throws(() => createServer({ config: createConfig({ dataDir: scratch }), registry: createRegistry({ providers: [] }), requireKey: false, cors: ['*'] }), /Refusing/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('the sign-in cookie is a session of its own, not the admin token, and logout ends it', async () => {
  const t = await boot();
  try {
    const login = await raw(t, { pathname: `/_/login?token=${encodeURIComponent(t.config.adminToken())}` });
    const cookie = String(login.headers['set-cookie'][0]);
    assert.ok(!cookie.includes(t.config.adminToken()), 'the cookie must not carry the token');
    const jar = cookie.split(';')[0];
    assert.equal((await raw(t, { pathname: '/_/state', headers: { cookie: jar } })).status, 200);
    const out = await raw(t, { method: 'POST', pathname: '/_/logout', headers: { cookie: jar, 'content-type': 'application/json', origin: `http://127.0.0.1:${t.port}` }, body: '{}' });
    assert.equal(out.status, 200);
    assert.equal((await raw(t, { pathname: '/_/state', headers: { cookie: jar } })).status, 401, 'the old cookie is dead after logout');
    // a cookie that is not valid percent-encoding is just "not signed in", for the interface and for the API
    const name = jar.split('=')[0];
    assert.equal((await raw(t, { pathname: '/_/state', headers: { cookie: `${name}=%E0%A4%A` } })).status, 401);
    assert.equal((await raw(t, { pathname: '/v1/models', headers: { cookie: `${name}=%E0%A4%A` } })).status, 401);
    // another server on this machine has its own cookie name, so two copies do not sign each other out
    const other = await boot();
    try {
      const otherLogin = await raw(other, { pathname: `/_/login?token=${encodeURIComponent(other.config.adminToken())}` });
      assert.notEqual(String(otherLogin.headers['set-cookie'][0]).split('=')[0], name);
    } finally { await other.close(); }
  } finally { await t.close(); }
});

test('the web files: a malformed address is a 400, and a file that cannot be read is an error, not a crash', async () => {
  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-web-'));
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(web, 'locked.txt'), 'nope', { mode: 0o000 });
  const t = await boot({ server: { webDir: web } });
  try {
    assert.equal((await raw(t, { pathname: '/%E0%A4%A' })).status, 400);
    assert.equal((await raw(t, { pathname: '/index.html' })).status, 200);
    if (process.getuid && process.getuid() !== 0) {
      const locked = await raw(t, { pathname: '/locked.txt' });
      assert.ok(locked.status === 403 || locked.status === 404 || locked.status === 500, `locked file: ${locked.status}`);
    }
    assert.equal((await raw(t, { pathname: '/health' })).status, 200, 'the server is still up');
  } finally { await t.close(); fs.rmSync(web, { recursive: true, force: true }); }
});

test('the server keeps and logs metadata only, never a prompt or an answer', async () => {
  const t = await boot();
  try {
    t.fake.script.reply = () => ({ ok: true, text: 'ANSWER-SECRET-9f3' });
    await chat(t, { model: 'fake-chat', messages: [user('PROMPT-SECRET-77a please')] });
    await chat(t, { model: 'fake-chat', stream: true, messages: [user('PROMPT-SECRET-77a again')] });
    const seen = JSON.stringify({ logs: t.logs, requests: t.srv.requests, notices: t.srv.notices });
    assert.ok(!seen.includes('PROMPT-SECRET') && !seen.includes('ANSWER-SECRET'), seen.slice(0, 300));
    assert.equal(t.srv.requests.length, 2);
    assert.equal(t.srv.requests[0].by, 'test');
    assert.equal(t.srv.requests[0].model, 'fake-chat');
  } finally { await t.close(); }
});

test('serving the API without keys is refused unless the server is on loopback', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-test-'));
  try {
    assert.throws(() => createServer({ config: createConfig({ dataDir: scratch }), registry: createRegistry({ providers: [] }), host: '0.0.0.0', requireKey: false }), /Refusing/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  const t = await boot({ server: { requireKey: false } });
  try { assert.equal((await fetch(`${t.base}/v1/models`)).status, 200); } finally { await t.close(); }
});

test('cross-origin calls are off unless asked for, and then only for keys', async () => {
  const off = await boot();
  try {
    const pre = await raw(off, { method: 'OPTIONS', pathname: '/v1/chat/completions', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 403);
  } finally { await off.close(); }
  const on = await boot({ server: { cors: ['https://app.example'] } });
  try {
    const pre = await raw(on, { method: 'OPTIONS', pathname: '/v1/chat/completions', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'https://app.example');
    const other = await raw(on, { method: 'OPTIONS', pathname: '/v1/chat/completions', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(other.status, 403);
    const real = await raw(on, { pathname: '/v1/models', headers: { origin: 'https://app.example', authorization: `Bearer ${on.key}` } });
    assert.equal(real.headers['access-control-allow-origin'], 'https://app.example');
  } finally { await on.close(); }
});
