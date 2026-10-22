'use strict';

/**
 * The other APIs in front of the engine (src/adapters.js): Anthropic's Messages API and OpenAI's Responses API, and the checks and answers the chat completions
 * endpoint gained next to them (validation, request ids, what is ignored, one model by id). The provider is DeepSeek's local copy (test/fixtures/fake_deepseek.js):
 * the engine, the governor, the tool bridge and the sessions are the real ones.
 */

process.env.ULA_TEST_MODE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createConfig } = require('../src/config');
const { cleanupDir } = require('./fixtures/cleanup');
const { createRegistry } = require('../src/registry');
const { createServer } = require('../src/server');
const { createDeepSeekProvider } = require('../src/providers/deepseek');
const A = require('../src/adapters');
const { startFakeDeepSeek, TOKEN } = require('./fixtures/fake_deepseek');

const FAST = { perMinute: 1000, minGapMs: 1, cooldownMs: 60000, smooth: true };
const CALL = '<tool_call>{"name":"get_weather","arguments":{"city":"Dar es Salaam"}}</tool_call>';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot({ sessions = false } = {}) {
  const site = await startFakeDeepSeek();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-ad-'));
  fs.writeFileSync(path.join(dir, 'deepseek_session.json'), JSON.stringify({ token: TOKEN, cookies: [{ name: 'ds_standin', value: 'cookie-value-1234' }], linkedAt: new Date().toISOString(), expired: false }), { mode: 0o600 });
  const bus = new EventEmitter();
  const config = createConfig({ dataDir: dir });
  const provider = createDeepSeekProvider({ dataDir: dir, config, bus, base: site.base, pace: FAST, log: () => {}, sessions, sessionOptions: { closeGapMs: 2 } });
  const srv = createServer({ config, registry: createRegistry({ providers: [provider], bus }), port: 0 });
  const { port } = await srv.start();
  const key = config.createApiKey('t').key;
  const base = `http://127.0.0.1:${port}`;
  const post = (route, body, headers = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify(body) });
  return {
    site, state: site.state, provider, base, key, post, config,
    /** The events of a server-sent stream: [{ event, data }]. */
    async events(res) {
      const text = await res.text();
      return text.split('\n\n').filter((b) => b.trim()).map((b) => ({ event: (b.split('\n').find((l) => l.startsWith('event: ')) || '').slice(7), data: JSON.parse((b.split('\n').find((l) => l.startsWith('data: ')) || 'data: {}').slice(6)) }));
    },
    async close() { await srv.stop(); await site.close(); await cleanupDir(dir); }
  };
}

// ---- the chat completions endpoint ----------------------------------------------------------------------------------------------------------

test('every answer has a request id, and one model can be asked for by its id', async () => {
  const t = await boot();
  try {
    const one = await fetch(`${t.base}/v1/models/deepseek-chat`, { headers: { authorization: `Bearer ${t.key}` } });
    assert.equal(one.status, 200);
    assert.match(one.headers.get('x-request-id'), /^req_[0-9a-f]{20}$/);
    const body = await one.json();
    assert.deepEqual([body.id, body.object, body.owned_by], ['deepseek-chat', 'model', 'deepseek']);
    const prefixed = await (await fetch(`${t.base}/v1/models/deepseek%2Fdeepseek-reasoner`, { headers: { authorization: `Bearer ${t.key}` } })).json();
    assert.equal(prefixed.id, 'deepseek-reasoner');
    const missing = await fetch(`${t.base}/v1/models/gpt-4o`, { headers: { authorization: `Bearer ${t.key}` } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'model_not_found');
    t.state.reply = () => 'ok';
    const chat = await t.post('/v1/chat/completions', { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] });
    assert.match(chat.headers.get('x-request-id'), /^req_/);
  } finally { await t.close(); }
});

test('a request that cannot be answered is refused in words, not answered with something else', async () => {
  const t = await boot();
  try {
    const bad = async (body) => { const r = await t.post('/v1/chat/completions', { model: 'deepseek-chat', ...body }); return { status: r.status, error: (await r.json()).error }; };
    const role = await bad({ messages: [{ role: 'wizard', content: 'hi' }] });
    assert.deepEqual([role.status, role.error.code, role.error.param], [400, 'invalid_messages', 'messages[0].role']);
    const n = await bad({ n: 2, messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual([n.status, n.error.code, n.error.param], [400, 'unsupported_parameter', 'n']);
    assert.equal((await bad({ messages: [] })).error.code, 'invalid_messages');
    assert.equal(t.state.completions.length, 0, 'nothing reached DeepSeek');
    t.state.reply = () => 'ok';
    assert.equal((await t.post('/v1/chat/completions', { model: 'deepseek-chat', n: 1, messages: [{ role: 'user', content: 'hi' }] })).status, 200, 'n of 1 is fine');
  } finally { await t.close(); }
});

test('the fields a web chat cannot honour are named in a header, never dropped silently; the developer role is the system role', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'ok';
    const res = await t.post('/v1/chat/completions', { model: 'deepseek-chat', temperature: 0, top_p: 0.5, seed: 7, messages: [{ role: 'developer', content: 'Be terse.' }, { role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-ula-ignored'), 'temperature, top_p, seed');
    assert.match(t.state.completions[0].prompt, /Be terse\./);
    const plain = await t.post('/v1/chat/completions', { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(plain.headers.get('x-ula-ignored'), null);
  } finally { await t.close(); }
});

// ---- Anthropic Messages ---------------------------------------------------------------------------------------------------------------------

test('messages: a plain request with a system prompt is answered as an Anthropic message', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'Hello from the stand-in.';
    const res = await t.post('/v1/messages', { model: 'deepseek-chat', max_tokens: 100, system: [{ type: 'text', text: 'Be brief.' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }] }, { 'x-api-key': t.key, authorization: '', 'anthropic-version': '2023-06-01' });
    assert.equal(res.status, 200);
    const msg = await res.json();
    assert.deepEqual([msg.type, msg.role, msg.model, msg.stop_reason, msg.stop_sequence], ['message', 'assistant', 'deepseek-chat', 'end_turn', null]);
    assert.deepEqual(msg.content, [{ type: 'text', text: 'Hello from the stand-in.' }]);
    assert.ok(msg.usage.input_tokens > 0 && msg.usage.output_tokens > 0);
    assert.match(msg.id, /^msg_/);
    assert.match(t.state.completions[0].prompt, /Be brief\.\n\nSay hello/);
  } finally { await t.close(); }
});

test('messages: a stream is the events of Anthropic\'s stream in order, and the text adds up', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'A streamed answer that comes in several pieces.';
    const res = await t.post('/v1/messages', { model: 'deepseek-chat', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'go' }] }, { 'x-api-key': t.key });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const ev = await t.events(res);
    assert.deepEqual(ev.map((e) => e.event).filter((e, i, all) => e !== all[i - 1]), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    assert.equal(ev[0].data.message.content.length, 0);
    assert.equal(ev.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join(''), 'A streamed answer that comes in several pieces.');
    assert.equal(ev.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'end_turn');
    assert.ok(ev.filter((e) => e.event === 'content_block_delta').length > 1, 'in pieces');
  } finally { await t.close(); }
});

test('messages: a tool the model wants to call is a tool_use block, and the tool_result that follows is read as the answer to it', async () => {
  const t = await boot();
  try {
    t.state.reply = (prompt) => (/^TOOL RESULT \(get_weather\)/m.test(prompt) ? 'It is sunny.' : `Looking.\n${CALL}`);
    const tools = [{ name: 'get_weather', description: 'Weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
    const first = await (await t.post('/v1/messages', { model: 'deepseek-chat', max_tokens: 200, tools, messages: [{ role: 'user', content: 'Weather in Dar?' }] }, { 'x-api-key': t.key })).json();
    assert.equal(first.stop_reason, 'tool_use');
    assert.deepEqual(first.content.map((b) => b.type), ['text', 'tool_use']);
    const use = first.content[1];
    assert.deepEqual([use.name, use.input], ['get_weather', { city: 'Dar es Salaam' }]);
    const second = await (await t.post('/v1/messages', {
      model: 'deepseek-chat', max_tokens: 200, tools,
      messages: [{ role: 'user', content: 'Weather in Dar?' }, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: [{ type: 'text', text: '31 C and sunny' }] }] }]
    }, { 'x-api-key': t.key })).json();
    assert.deepEqual(second.content, [{ type: 'text', text: 'It is sunny.' }]);
    assert.match(t.state.completions.at(-1).prompt, /TOOL RESULT \(get_weather\):\n31 C and sunny/);
  } finally { await t.close(); }
});

test('messages: a streamed tool call is a tool_use block with its input as JSON, and DeepThink\'s thinking is a thinking block before the text', async () => {
  const t = await boot();
  try {
    t.state.reply = (prompt, { thinking }) => (thinking ? { text: 'The answer is 7.', thinking: 'Adding three and four.' } : `Looking.\n${CALL}`);
    const tools = [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }];
    const calls = await t.events(await t.post('/v1/messages', { model: 'deepseek-chat', max_tokens: 100, stream: true, tools, messages: [{ role: 'user', content: 'weather?' }] }, { 'x-api-key': t.key }));
    const start = calls.find((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
    assert.equal(start.data.content_block.name, 'get_weather');
    const json = calls.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
    assert.deepEqual(JSON.parse(json), { city: 'Dar es Salaam' });
    assert.equal(calls.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'tool_use');
    const thinking = await (await t.post('/v1/messages', { model: 'deepseek-reasoner', max_tokens: 100, thinking: { type: 'enabled', budget_tokens: 4000 }, messages: [{ role: 'user', content: '3 + 4?' }] }, { 'x-api-key': t.key })).json();
    assert.deepEqual(thinking.content.map((b) => b.type), ['thinking', 'text']);
    assert.equal(thinking.content[0].thinking, 'Adding three and four.');
    assert.equal(thinking.content[1].text, 'The answer is 7.');
  } finally { await t.close(); }
});

test('messages: tokens can be counted without sending anything to the provider', async () => {
  const t = await boot();
  try {
    const res = await t.post('/v1/messages/count_tokens', { model: 'deepseek-chat', messages: [{ role: 'user', content: 'x'.repeat(400) }] }, { 'x-api-key': t.key });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.input_tokens >= 100 && body.input_tokens < 120, String(body.input_tokens));
    assert.equal(t.state.completions.length, 0);
    assert.equal(t.state.created.length, 0);
  } finally { await t.close(); }
});

test('messages: errors are written the way Anthropic writes them, and a refusal keeps its Retry-After', async () => {
  const t = await boot();
  try {
    const noModel = await t.post('/v1/messages', { model: 'gpt-4o', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': t.key });
    assert.equal(noModel.status, 404);
    const body = await noModel.json();
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'not_found_error');
    assert.match(body.error.message, /No linked model/);
    const badRole = await t.post('/v1/messages', { model: 'deepseek-chat', max_tokens: 10, messages: [{ role: 'system', content: 'x' }] }, { 'x-api-key': t.key });
    assert.deepEqual([badRole.status, (await badRole.json()).error.type], [400, 'invalid_request_error']);
    const noKey = await fetch(`${t.base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noKey.status, 401);
    t.state.notice = 'limit';
    const limited = await t.post('/v1/messages', { model: 'deepseek-chat', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': t.key });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.type, 'rate_limit_error');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const resting = await t.post('/v1/messages', { model: 'deepseek-chat', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': t.key });
    assert.equal(resting.status, 429, 'answered locally while the account rests');
    assert.equal(t.state.completions.length, 1);
  } finally { await t.close(); }
});

// ---- OpenAI Responses -----------------------------------------------------------------------------------------------------------------------

test('responses: instructions and a string input are answered as a response with one message item', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'Forty-two.';
    const res = await t.post('/v1/responses', { model: 'deepseek-chat', instructions: 'Answer in one word.', input: 'What is six times seven?' });
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.deepEqual([r.object, r.status, r.model], ['response', 'completed', 'deepseek-chat']);
    assert.equal(r.output.length, 1);
    assert.deepEqual(r.output[0].content, [{ type: 'output_text', text: 'Forty-two.', annotations: [] }]);
    assert.ok(r.usage.input_tokens > 0 && r.usage.total_tokens === r.usage.input_tokens + r.usage.output_tokens);
    assert.match(t.state.completions[0].prompt, /Answer in one word\.\n\nWhat is six times seven\?/);
  } finally { await t.close(); }
});

test('responses: a function call is a function_call item, and a function_call_output item in the next input answers it', async () => {
  const t = await boot();
  try {
    t.state.reply = (prompt) => (/^TOOL RESULT \(get_weather\)/m.test(prompt) ? 'Sunny, 31 C.' : CALL);
    const tools = [{ type: 'function', name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }];
    const first = await (await t.post('/v1/responses', { model: 'deepseek-chat', tools, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Weather in Dar?' }] }] })).json();
    const call = first.output.find((o) => o.type === 'function_call');
    assert.deepEqual([call.name, JSON.parse(call.arguments)], ['get_weather', { city: 'Dar es Salaam' }]);
    const second = await (await t.post('/v1/responses', {
      model: 'deepseek-chat', tools,
      input: [{ role: 'user', content: 'Weather in Dar?' }, call, { type: 'function_call_output', call_id: call.call_id, output: '31 C, sunny' }]
    })).json();
    assert.equal(second.output[0].content[0].text, 'Sunny, 31 C.');
    assert.match(t.state.completions.at(-1).prompt, /TOOL RESULT \(get_weather\):\n31 C, sunny/);
  } finally { await t.close(); }
});

test('responses: a stream is the events of OpenAI\'s stream in order, ending with the whole response', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'Streaming text in pieces here.';
    const ev = await t.events(await t.post('/v1/responses', { model: 'deepseek-chat', stream: true, input: 'go' }));
    const order = ev.map((e) => e.event).filter((e, i, all) => e !== all[i - 1]);
    assert.deepEqual(order, ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed']);
    assert.equal(ev.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta).join(''), 'Streaming text in pieces here.');
    assert.deepEqual(ev.map((e) => e.data.sequence_number), ev.map((_, i) => i), 'numbered in order');
    const done = ev.at(-1).data.response;
    assert.equal(done.status, 'completed');
    assert.equal(done.output[0].content[0].text, 'Streaming text in pieces here.');
  } finally { await t.close(); }
});

test('responses: previous_response_id continues a conversation with only the new input, in the same provider chat; an unknown one is a 404', async () => {
  const t = await boot({ sessions: true });
  try {
    t.state.reply = (p) => `got: ${p.slice(0, 40)}`;
    const first = await (await t.post('/v1/responses', { model: 'deepseek-chat', input: 'first question' })).json();
    const second = await (await t.post('/v1/responses', { model: 'deepseek-chat', previous_response_id: first.id, input: 'second question' })).json();
    assert.equal(second.output[0].content[0].text, 'got: second question');
    assert.deepEqual(t.state.completions.map((c) => [c.session, c.prompt]), [['standin-1', 'first question'], ['standin-1', 'second question']], 'one chat, only what is new');
    const lost = await t.post('/v1/responses', { model: 'deepseek-chat', previous_response_id: 'resp_unknown', input: 'x' });
    assert.equal(lost.status, 404);
    assert.equal((await lost.json()).error.code, 'previous_response_not_found');
    const notStored = await (await t.post('/v1/responses', { model: 'deepseek-chat', store: false, input: 'private' })).json();
    assert.equal((await t.post('/v1/responses', { model: 'deepseek-chat', previous_response_id: notStored.id, input: 'again' })).status, 404, 'store: false keeps nothing');
  } finally { await t.close(); }
});

test('responses: an error before the stream opens is an OpenAI error with its status, and one inside a stream is an error event', async () => {
  const t = await boot();
  try {
    const none = await t.post('/v1/responses', { model: 'nope', input: 'hi' });
    assert.deepEqual([none.status, (await none.json()).error.code], [404, 'model_not_found']);
    assert.equal((await t.post('/v1/responses', { model: 'deepseek-chat', input: 42 })).status, 400);
    t.state.notice = 'limit';
    const limited = await t.post('/v1/responses', { model: 'deepseek-chat', input: 'hi' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally { await t.close(); }
});

test('a caller that leaves in the middle of a stream frees the provider for the next request', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'long '.repeat(10000); // about ten seconds of streaming
    const controller = new AbortController();
    const res = await fetch(`${t.base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': t.key }, body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'go' }] }), signal: controller.signal });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await wait(100);
    t.state.reply = () => 'ok';
    const asked = Date.now();
    const next = await t.post('/v1/messages', { model: 'deepseek-chat', max_tokens: 10, messages: [{ role: 'user', content: 'again' }] }, { 'x-api-key': t.key });
    assert.equal(next.status, 200);
    assert.equal((await next.json()).content[0].text, 'ok');
    assert.ok(Date.now() - asked < 4000, `the next request waited ${Date.now() - asked} ms: the first was still being answered for nobody`);
  } finally { await t.close(); }
});

// ---- the translations themselves ------------------------------------------------------------------------------------------------------------

test('Anthropic blocks become chat messages: tool results first, then the words; calls keep their ids; thinking blocks are dropped', () => {
  const { chat } = A.anthropicToChat({
    model: 'm', system: 'S', max_tokens: 5, stop_sequences: ['END'],
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'x' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'text', text: 'and then?' }, { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body', is_error: true }] }
    ]
  });
  assert.deepEqual(chat.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.deepEqual(chat.messages[2].tool_calls[0], { id: 'toolu_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } });
  assert.equal(chat.messages[2].content, 'ok');
  assert.deepEqual([chat.messages[3].tool_call_id, chat.messages[3].content], ['toolu_1', 'Error: file body']);
  assert.deepEqual([chat.max_tokens, chat.stop], [5, ['END']]);
});

test('Responses items become chat messages: consecutive function calls are one assistant message; unknown items are skipped', () => {
  const store = A.createResponseStore();
  const { chat } = A.responsesToChat({ model: 'm', input: [
    { role: 'developer', content: 'D' }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'U' }] },
    { type: 'reasoning', summary: [] }, { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' }, { type: 'function_call', call_id: 'c2', name: 'b', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'r1' }, { type: 'function_call_output', call_id: 'c2', output: 'r2' }
  ] }, store);
  assert.deepEqual(chat.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'tool']);
  assert.equal(chat.messages[2].tool_calls.length, 2);
});

test('the activity list says how long a request waited for its turn and how long the first word took, for every API', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'ok';
    await t.post('/v1/chat/completions', { model: 'deepseek-chat', messages: [{ role: 'user', content: 'a' }] });
    await t.post('/v1/messages', { model: 'deepseek-chat', max_tokens: 5, messages: [{ role: 'user', content: 'b' }] }, { 'x-api-key': t.key });
    await t.post('/v1/responses', { model: 'deepseek-chat', input: 'c' });
    const state = await (await fetch(`${t.base}/_/state`, { headers: { authorization: `Bearer ${t.config.adminToken()}` } })).json();
    assert.deepEqual(state.requests.map((r) => r.api).sort(), ['chat', 'messages', 'responses']);
    for (const r of state.requests) {
      assert.equal(typeof r.queueMs, 'number');
      assert.equal(typeof r.firstMs, 'number');
      assert.ok(r.firstMs > 0, `${r.api}: the first word took time`);
      assert.ok(r.queueMs + r.firstMs <= r.ms, `${r.api}: the parts are inside the whole`);
    }
  } finally { await t.close(); }
});
