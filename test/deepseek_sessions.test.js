'use strict';

/**
 * Sessions on the DeepSeek lane, against the local copy of the site (test/fixtures/fake_deepseek.js, which keeps its chats like the real one: message ids that
 * follow each other, a parent that must be the chat's last message, a deleted chat that is gone). A conversation that grows request by request must stay in ONE
 * chat that is sent only what is new, and everything that is not a clean continuation must go back to what a request did before sessions: a new chat that is
 * told the whole conversation. No DeepSeek account is involved.
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
const { startFakeDeepSeek, TOKEN } = require('./fixtures/fake_deepseek');

const FAST = { perMinute: 1000, minGapMs: 1, cooldownMs: 60000, smooth: true };
const user = (text) => ({ role: 'user', content: text });
const WEATHER = [{ type: 'function', function: { name: 'get_weather', description: 'Current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
const CALL = '<tool_call>{"name":"get_weather","arguments":{"city":"Dar es Salaam"}}</tool_call>';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, ms = 2000) { for (let t = 0; t < ms && !test(); t += 10) await wait(10); }

async function boot({ sessions = true, sessionOptions = { closeGapMs: 2 }, preload } = {}) {
  const site = await startFakeDeepSeek();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-dss-'));
  fs.writeFileSync(path.join(dir, 'deepseek_session.json'), JSON.stringify({ token: TOKEN, cookies: [{ name: 'ds_standin', value: 'cookie-value-1234' }], linkedAt: new Date().toISOString(), expired: false }), { mode: 0o600 });
  if (preload) preload(dir);
  const bus = new EventEmitter();
  const logs = [];
  const config = createConfig({ dataDir: dir });
  const provider = createDeepSeekProvider({ dataDir: dir, config, bus, base: site.base, pace: FAST, log: (l) => logs.push(l), sessions, sessionOptions, closeRetryMs: 60 });
  const srv = createServer({ config, registry: createRegistry({ providers: [provider], bus }), port: 0 });
  const { port } = await srv.start();
  const key = config.createApiKey('t').key;
  const t = {
    site, dir, provider, srv, config, logs, state: site.state, key, base: `http://127.0.0.1:${port}`,
    chat: (body, headers = {}) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify(body) }),
    /** One more turn of a conversation the way a client does it: the whole history goes in, the answer is added to it. */
    async turn(history, text, body = {}, headers = {}) {
      history.push(user(text));
      const res = await t.chat({ model: 'deepseek-chat', messages: history, ...body }, headers);
      assert.equal(res.status, 200, `status ${res.status}`);
      const data = await res.json();
      history.push({ role: 'assistant', content: data.choices[0].message.content });
      return data;
    },
    async close() { await srv.stop(); await site.close(); await cleanupDir(dir); }
  };
  return t;
}

// ---- one conversation, one chat -------------------------------------------------------------------------------------------------------------

test('a conversation that grows stays in one chat, each request carries only what is new, and the chat is not deleted while it goes on', async () => {
  const t = await boot();
  try {
    t.state.reply = (prompt) => `Answer to: ${prompt.slice(0, 30)}`;
    const history = [];
    for (const q of ['What is a kernel?', 'And a process?', 'How do they differ?', 'Thanks.']) await t.turn(history, q);
    assert.equal(t.state.created.length, 1, 'one chat for four turns');
    assert.deepEqual(t.state.completions.map((c) => c.session), Array(4).fill('standin-1'));
    assert.deepEqual(t.state.completions.map((c) => c.parent), [null, 2, 4, 6], 'each message continues the one that answered before it');
    assert.deepEqual(t.state.completions.map((c) => c.prompt), ['What is a kernel?', 'And a process?', 'How do they differ?', 'Thanks.'], 'a plain chat is a plain chat: only the new question, as it is');
    assert.equal(t.state.deleted.length, 0, 'not deleted per request');
    const info = t.provider.engine.sessionInfo();
    assert.deepEqual([info.open, info.continued, info.started], [1, 3, 1]);
  } finally { await t.close(); }
});

test('with sessions off every request is a new chat that is told the whole conversation, and the chat is deleted afterwards: what a request did before', async () => {
  const t = await boot({ sessions: false });
  try {
    t.state.reply = () => 'ok';
    const history = [];
    for (const q of ['one', 'two', 'three']) await t.turn(history, q);
    assert.equal(t.state.created.length, 3);
    assert.match(t.state.completions[2].prompt, /USER:\nthree/);
    assert.match(t.state.completions[2].prompt, /USER:\none/, 'the whole conversation, again');
    await until(() => t.state.deleted.length === 3);
    assert.deepEqual(t.state.deleted.sort(), t.state.created.sort());
    assert.equal(t.provider.engine.sessionInfo().enabled, false);
  } finally { await t.close(); }
});

test('the usage counted for a request is the size of the whole conversation either way, as any other API would count it', async () => {
  const a = await boot();
  const b = await boot({ sessions: false });
  try {
    for (const t of [a, b]) t.state.reply = () => 'a short answer';
    const ha = [];
    const hb = [];
    let ua; let ub;
    for (const q of ['one', 'two is a bit longer', 'three is the longest of the questions asked here']) { ua = await a.turn(ha, q); ub = await b.turn(hb, q); }
    assert.equal(ua.usage.prompt_tokens, ub.usage.prompt_tokens);
    assert.ok(ua.usage.prompt_tokens > 20);
  } finally { await a.close(); await b.close(); }
});

test('streaming requests continue the chat the same way', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'streamed answer';
    const history = [user('first')];
    const read = async () => (await (await t.chat({ model: 'deepseek-chat', stream: true, messages: history })).text()).split('\n\n').map((b) => (b.split('\n').find((l) => l.startsWith('data: ')) || '').slice(6)).filter((e) => e && e !== '[DONE]').map((e) => JSON.parse(e)).map((e) => (e.choices[0] && e.choices[0].delta.content) || '').join('');
    history.push({ role: 'assistant', content: await read() });
    history.push(user('second'));
    assert.equal(await read(), 'streamed answer');
    assert.deepEqual(t.state.completions.map((c) => [c.session, c.prompt]), [['standin-1', 'first'], ['standin-1', 'second']]);
  } finally { await t.close(); }
});

// ---- a conversation with tools --------------------------------------------------------------------------------------------------------------

test('an agent with tools: the first request carries the system text and the tool protocol, the following ones only the new tool result, in the same chat', async () => {
  const t = await boot();
  try {
    t.state.reply = (prompt) => (/^TOOL RESULT \(get_weather\)/m.test(prompt) ? 'It is sunny in Dar es Salaam.' : `Looking.\n${CALL}`);
    const system = { role: 'system', content: 'You are a weather assistant.' };
    const history = [system, user('What is the weather in Dar es Salaam?')];
    const first = await (await t.chat({ model: 'deepseek-chat', tools: WEATHER, messages: history })).json();
    const requested = first.choices[0].message;
    assert.equal(requested.tool_calls.length, 1);
    history.push(requested, { role: 'tool', tool_call_id: requested.tool_calls[0].id, content: '31 C and sunny' });
    const second = await (await t.chat({ model: 'deepseek-chat', tools: WEATHER, messages: history })).json();
    assert.equal(second.choices[0].message.content, 'It is sunny in Dar es Salaam.');
    history.push(second.choices[0].message, user('And tomorrow?'));
    const third = await t.chat({ model: 'deepseek-chat', tools: WEATHER, messages: history });
    assert.equal(third.status, 200);
    const [c1, c2, c3] = t.state.completions;
    assert.deepEqual([c1.session, c2.session, c3.session], ['standin-1', 'standin-1', 'standin-1']);
    assert.match(c1.prompt, /You are a weather assistant\./);
    assert.match(c1.prompt, /# Tool bridge/);
    assert.ok(/^TOOL RESULT \(get_weather\):\n31 C and sunny/.test(c2.prompt), c2.prompt.slice(0, 80));
    assert.ok(!/weather assistant|# Tool bridge|What is the weather/.test(c2.prompt), 'the chat already holds the system text, the protocol and the question');
    assert.match(c3.prompt, /^USER:\nAnd tomorrow\?/);
    assert.deepEqual([c1.parent, c2.parent, c3.parent], [null, 2, 4]);
    assert.equal(t.state.created.length, 1);
  } finally { await t.close(); }
});

test('an agent task longer than the chat limit stays in one chat (a new chat would be told just as much), and each continued step reports what the chat held as cached input', async () => {
  // What a coding agent sends: a long system prompt and tool list, then one tool step after another. Before 0.9.0 such a chat was "full" from its first
  // request on, so every step opened a new chat that was told the whole conversation again (Lens through the bridge: 23 steps, cached 0).
  const t = await boot({ sessionOptions: { maxChars: 2000, closeGapMs: 2 } });
  try {
    let step = 0;
    const cities = ['Dar es Salaam', 'Arusha', 'Mwanza'];
    t.state.reply = () => (++step < 4 ? `Step ${step}.\n<tool_call>{"name":"get_weather","arguments":{"city":"${cities[step - 1]}"}}</tool_call>` : 'It is sunny everywhere.');
    const history = [{ role: 'system', content: `You are a weather assistant. ${'Follow the rules. '.repeat(200)}` }, user('Weather in four places?')];
    const usages = [];
    for (let i = 0; i < 4; i += 1) {
      const data = await (await t.chat({ model: 'deepseek-chat', tools: WEATHER, messages: history })).json();
      usages.push(data.usage);
      const m = data.choices[0].message;
      history.push(m);
      if (m.tool_calls) history.push({ role: 'tool', tool_call_id: m.tool_calls[0].id, content: `${20 + i} C` });
    }
    assert.equal(t.state.created.length, 1, 'one chat for the whole task');
    assert.deepEqual(t.state.completions.map((c) => c.parent), [null, 2, 4, 6]);
    assert.ok(t.state.completions[0].prompt.length > 2000, 'the first prompt alone is past the limit');
    assert.ok(t.state.completions.slice(1).every((c) => c.prompt.length < 200), 'later steps carry only the new tool result');
    assert.equal(usages[0].prompt_tokens_details.cached_tokens, 0, 'a new chat holds nothing yet');
    for (const u of usages.slice(1)) {
      assert.ok(u.prompt_tokens_details.cached_tokens > 500, `cached ${u.prompt_tokens_details.cached_tokens}`);
      assert.ok(u.prompt_tokens_details.cached_tokens < u.prompt_tokens, 'the new message is not cached');
    }
    assert.ok(usages[3].prompt_tokens_details.cached_tokens > usages[1].prompt_tokens_details.cached_tokens, 'the cached part grows with the chat');
  } finally { await t.close(); }
});

test('streamed usage carries the cached input too (what an agent that streams reads)', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'streamed answer';
    const history = [user('first question, long enough to count')];
    const usageOf = async () => {
      const text = await (await t.chat({ model: 'deepseek-chat', stream: true, stream_options: { include_usage: true }, messages: history })).text();
      const events = text.split('\n\n').map((b) => (b.split('\n').find((l) => l.startsWith('data: ')) || '').slice(6)).filter((e) => e && e !== '[DONE]').map((e) => JSON.parse(e));
      return events.find((e) => e.usage).usage;
    };
    assert.equal((await usageOf()).prompt_tokens_details.cached_tokens, 0);
    history.push({ role: 'assistant', content: 'streamed answer' }, user('second'));
    assert.ok((await usageOf()).prompt_tokens_details.cached_tokens > 0);
  } finally { await t.close(); }
});

test('the Anthropic and Responses APIs report a continued chat as cached input too', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'an answer from the chat';
    const post = (route, body) => fetch(`${t.base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.key}` }, body: JSON.stringify(body) }).then((r) => r.json());
    const msgs = [{ role: 'user', content: 'first question, long enough to count for something' }];
    const a1 = await post('/v1/messages', { model: 'deepseek-chat', max_tokens: 100, messages: msgs });
    assert.equal(a1.usage.cache_read_input_tokens, 0);
    msgs.push({ role: 'assistant', content: 'an answer from the chat' }, { role: 'user', content: 'second' });
    const a2 = await post('/v1/messages', { model: 'deepseek-chat', max_tokens: 100, messages: msgs });
    assert.ok(a2.usage.cache_read_input_tokens > 0, JSON.stringify(a2.usage));
    assert.ok(a2.usage.input_tokens < a2.usage.input_tokens + a2.usage.cache_read_input_tokens);
    const input = [{ role: 'user', content: 'another question, long enough to count as well' }];
    const r1 = await post('/v1/responses', { model: 'deepseek-chat', input });
    assert.equal(r1.usage.input_tokens_details.cached_tokens, 0);
    const r2 = await post('/v1/responses', { model: 'deepseek-chat', input: input.concat([{ role: 'assistant', content: 'an answer from the chat' }, { role: 'user', content: 'and again' }]) });
    assert.ok(r2.usage.input_tokens_details.cached_tokens > 0, JSON.stringify(r2.usage));
    assert.ok(r2.usage.input_tokens_details.cached_tokens <= r2.usage.input_tokens);
  } finally { await t.close(); }
});

// ---- what is not a continuation -------------------------------------------------------------------------------------------------------------

test('an edited earlier message, other tools, another system prompt and another model each start a new chat that is told everything', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'ok';
    const h = [];
    await t.turn(h, 'original question');
    await t.turn(h, 'second');
    assert.equal(t.state.created.length, 1);
    // the person went back and changed the first message
    const edited = [user('EDITED question'), h[1], user('second')];
    assert.equal((await t.chat({ model: 'deepseek-chat', messages: edited })).status, 200);
    assert.equal(t.state.created.length, 2, 'a new chat');
    assert.match(t.state.completions.at(-1).prompt, /EDITED question/);
    assert.match(t.state.completions.at(-1).prompt, /USER:\nsecond/, 'it was told the whole conversation');
    // another system prompt, other tools, another model
    await t.chat({ model: 'deepseek-chat', messages: [{ role: 'system', content: 'Different.' }, ...h, user('third')] });
    assert.equal(t.state.created.length, 3);
    await t.chat({ model: 'deepseek-chat', tools: WEATHER, messages: [...h, user('fourth')] });
    assert.equal(t.state.created.length, 4);
    await t.chat({ model: 'deepseek-reasoner', messages: [...h, user('fifth')] });
    assert.equal(t.state.created.length, 5);
    // none of that closed the chats that could still be continued
    const again = [...h, user('sixth')];
    assert.equal((await t.chat({ model: 'deepseek-chat', messages: again })).status, 200);
    assert.equal(t.state.created.length, 5, 'the first conversation is still open and is continued');
    assert.equal(t.state.completions.at(-1).session, 'standin-1');
  } finally { await t.close(); }
});

test('the same request sent twice (a client that retried) is not mistaken for a continuation', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'ok';
    const history = [user('hello')];
    await t.chat({ model: 'deepseek-chat', messages: history });
    await t.chat({ model: 'deepseek-chat', messages: history });
    assert.equal(t.state.created.length, 2);
    assert.deepEqual(t.state.completions.map((c) => c.prompt), ['hello', 'hello']);
  } finally { await t.close(); }
});

test('a name from the caller (the user field, or the X-ULA-Session header) keeps two conversations that begin alike in their own chats', async () => {
  const t = await boot();
  try {
    t.state.reply = (p) => `got ${p.slice(0, 20)}`;
    const a = [];
    const b = [];
    await t.turn(a, 'hello', { user: 'agent-a' });
    await t.turn(b, 'hello', {}, { 'x-ula-session': 'agent-b' });
    await t.turn(a, 'more from a', { user: 'agent-a' });
    await t.turn(b, 'more from b', {}, { 'x-ula-session': 'agent-b' });
    assert.equal(t.state.created.length, 2);
    assert.deepEqual(t.state.completions.map((c) => [c.session, c.prompt]), [['standin-1', 'hello'], ['standin-2', 'hello'], ['standin-1', 'more from a'], ['standin-2', 'more from b']]);
    // a name has one chat: a different conversation under the name replaces it, and the replaced chat is removed at once (without a name it would wait to expire)
    await t.turn([], 'something else entirely', { user: 'agent-a' });
    await until(() => t.state.deleted.includes('standin-1'));
    assert.deepEqual(t.state.deleted, ['standin-1']);
    assert.equal(t.provider.engine.sessionList().length, 2);
    await t.turn([], 'another topic with no name');
    await wait(60);
    assert.deepEqual(t.state.deleted, ['standin-1'], 'a request with no name replaces nothing');
  } finally { await t.close(); }
});

// ---- when the chat cannot be continued ------------------------------------------------------------------------------------------------------

test('a chat DeepSeek refuses to continue is given up: the request is asked again once on a new chat with the whole conversation, and the old chat is removed', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'ok';
    const h = [];
    await t.turn(h, 'one');
    t.state.refuseParent = true;
    const data = await t.turn(h, 'two');
    assert.equal(data.choices[0].message.content, 'ok', 'the caller got its answer');
    assert.equal(t.state.created.length, 2);
    assert.match(t.state.completions.at(-1).prompt, /USER:\none/, 'told everything again');
    await until(() => t.state.deleted.includes('standin-1'));
    assert.ok(t.state.deleted.includes('standin-1'), 'the chat that could not be continued is removed');
    assert.equal(t.provider.engine.sessionInfo().failed, 1);
  } finally { await t.close(); }
});

test('if continuing fails twice in a row it is switched off, said in the status, and every request goes back to a chat of its own', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'ok';
    const h = [];
    await t.turn(h, 'one');
    t.state.refuseParent = true;
    await t.turn(h, 'two');
    await t.turn(h, 'three');
    const status = await t.provider.status();
    assert.equal(status.sessions.enabled, false);
    assert.match(status.sessions.reason, /twice in a row/);
    t.state.refuseParent = false;
    const before = t.state.created.length;
    await t.turn(h, 'four');
    assert.equal(t.state.created.length, before + 1, 'a chat of its own');
    await until(() => t.state.deleted.length >= t.state.created.length);
    assert.equal(t.state.deleted.length, t.state.created.length, 'and deleted as before');
  } finally { await t.close(); }
});

test('after it switched itself off, turning it on again from the settings makes the next request continue a chat once more', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'ok';
    const h = [];
    await t.turn(h, 'one');
    t.state.refuseParent = true;
    await t.turn(h, 'two');
    await t.turn(h, 'three');
    assert.equal((await t.provider.status()).sessions.enabled, false);
    t.state.refuseParent = false;
    await t.provider.setSettings({ sessions: true });
    const status = await t.provider.status();
    assert.equal(status.sessions.enabled, true);
    assert.equal(status.sessions.reason, null);
    await t.turn(h, 'four');
    const created = t.state.created.length;
    await t.turn(h, 'five');
    assert.equal(t.state.created.length, created, 'the fifth message went into the chat the fourth opened');
  } finally { await t.close(); }
});

test('a refusal on a continued chat is not retried and does not switch the continuing off', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'ok';
    const h = [];
    await t.turn(h, 'one');
    t.state.notice = 'limit';
    h.push(user('two'));
    const res = await t.chat({ model: 'deepseek-chat', messages: h });
    assert.equal(res.status, 429);
    assert.equal(t.state.completions.length, 2, 'the refused request was sent once and not asked again');
    assert.equal(t.state.created.length, 1, 'and no new chat was opened for it');
    assert.equal(t.provider.engine.sessionInfo().enabled, true);
  } finally { await t.close(); }
});

test('refusals on continued chats, however many, never switch the continuing off: only a failure that says nothing about the account counts', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'ok';
    for (let round = 0; round < 3; round += 1) {
      const h = [];
      await t.turn(h, `round ${round}`);
      t.state.notice = 'limit';
      h.push(user('and more'));
      assert.equal((await t.chat({ model: 'deepseek-chat', messages: h })).status, 429);
      t.state.notice = null;
      t.provider.governor.clearCooldown();
    }
    assert.equal(t.provider.engine.sessionInfo().enabled, true, 'three refusals, each on a continued chat');
    assert.equal(t.provider.engine.sessionInfo().failed, 0);
  } finally { await t.close(); }
});

test('while the account is resting after a refusal nothing is sent to it to remove a chat; the chat is written down for the next start', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'ok';
    const h = [];
    await t.turn(h, 'one');
    t.provider.governor.setCooldown(60000, 'a test');
    const [open] = t.provider.engine.sessionList();
    assert.ok(t.provider.engine.endSession(open.id));
    await wait(120);
    assert.equal(t.state.requests['/api/v0/chat_session/delete'] || 0, 0, 'not even a delete');
    const written = JSON.parse(fs.readFileSync(path.join(t.dir, 'sessions-deepseek.json'), 'utf8'));
    assert.deepEqual(written.chats, ['standin-1']);
  } finally { await t.close(); }
});

// ---- the life of a chat ---------------------------------------------------------------------------------------------------------------------

test('a chat nobody continued is removed after its time, and the next request of that conversation starts a new one', async () => {
  const t = await boot({ sessionOptions: { ttlMs: 60, sweepMs: 20, closeGapMs: 2 } });
  try {
    t.state.reply = () => 'ok';
    const h = [];
    await t.turn(h, 'one');
    await until(() => t.state.deleted.length === 1);
    assert.deepEqual(t.state.deleted, ['standin-1']);
    await t.turn(h, 'two');
    assert.equal(t.state.created.length, 2);
    assert.match(t.state.completions.at(-1).prompt, /USER:\none/);
  } finally { await t.close(); }
});

test('only so many chats are kept open: a newer conversation pushes the one used longest ago out, and that chat is removed', async () => {
  const t = await boot({ sessionOptions: { maxSessions: 2, closeGapMs: 2 } });
  try {
    t.state.reply = () => 'ok';
    for (const q of ['first topic', 'second topic', 'third topic']) await t.turn([], q);
    assert.equal(t.state.created.length, 3);
    await until(() => t.state.deleted.length === 1);
    assert.deepEqual(t.state.deleted, ['standin-1']);
    assert.equal(t.provider.engine.sessionList().length, 2);
  } finally { await t.close(); }
});

test('a chat that holds much more than a new chat would be told is not continued: the conversation goes on in a new chat, and the long one is removed', async () => {
  const t = await boot({ sessionOptions: { maxChars: 200, maxOverhead: 0.5, closeGapMs: 2 } });
  try {
    t.state.reply = () => 'x'.repeat(300);
    const h = [];
    await t.turn(h, 'one');
    await t.turn(h, 'two');
    assert.equal(t.state.created.length, 2);
    assert.match(t.state.completions.at(-1).prompt, /USER:\none/);
    await until(() => t.state.deleted.length === 1);
    assert.deepEqual(t.state.deleted, ['standin-1']);
  } finally { await t.close(); }
});

test('the open chats are removed when the program stops, and the list of what is open is empty afterwards', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'ok';
    await t.turn([], 'a');
    await t.turn([], 'b');
    assert.equal(t.provider.engine.sessionList().length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.dir, 'sessions-deepseek.json'), 'utf8')).chats.sort(), ['standin-1', 'standin-2']);
    await t.provider.stop();
    assert.deepEqual(t.state.deleted.sort(), ['standin-1', 'standin-2']);
    assert.equal(fs.existsSync(path.join(t.dir, 'sessions-deepseek.json')), false, 'nothing left to remove next time');
  } finally { await t.close(); }
});

test('chats an earlier run left behind (a killed program) are removed when the program starts again', async () => {
  const t = await boot({ preload: (dir) => fs.writeFileSync(path.join(dir, 'sessions-deepseek.json'), JSON.stringify({ chats: ['left-1', 'left-2'] })) });
  try {
    await until(() => t.state.deleted.length === 2);
    assert.deepEqual(t.state.deleted.sort(), ['left-1', 'left-2']);
    await until(() => !fs.existsSync(path.join(t.dir, 'sessions-deepseek.json')));
    assert.equal(fs.existsSync(path.join(t.dir, 'sessions-deepseek.json')), false);
  } finally { await t.close(); }
});

test('the person can switch sessions off (the open chats are removed and the choice is kept) and on again', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'ok';
    const h = [];
    await t.turn(h, 'one');
    await t.provider.setSettings({ sessions: false });
    assert.deepEqual(t.state.deleted, ['standin-1']);
    assert.equal(t.config.providerSettings('deepseek').sessions, false);
    await t.turn(h, 'two');
    await until(() => t.state.deleted.length === 2);
    assert.equal(t.provider.engine.sessionList().length, 0);
    await t.provider.setSettings({ sessions: true });
    await t.turn(h, 'three');
    await t.turn(h, 'four');
    const last = t.state.completions.slice(-2);
    assert.equal(last[0].session, last[1].session, 'continuing again');
    assert.equal(last[1].prompt, 'four');
  } finally { await t.close(); }
});

test('the web interface lists the open chats (counts and times, never a prompt) and can end one', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'SECRET-ANSWER';
    await t.turn([], 'SECRET-PROMPT');
    const base = `http://127.0.0.1:${new URL(t.srv.url()).port}`;
    const auth = { authorization: `Bearer ${t.config.adminToken()}` };
    const state = await (await fetch(`${base}/_/state`, { headers: auth })).json();
    assert.equal(state.sessions.length, 1);
    assert.deepEqual(Object.keys(state.sessions[0]).sort(), ['busy', 'chars', 'createdAt', 'id', 'lastUsed', 'model', 'provider', 'tag', 'turns']);
    assert.ok(!JSON.stringify(state).includes('SECRET-PROMPT') && !JSON.stringify(state).includes('SECRET-ANSWER'));
    const gone = await fetch(`${base}/_/sessions/deepseek/${state.sessions[0].id}`, { method: 'DELETE', headers: auth });
    assert.equal(gone.status, 200);
    await until(() => t.state.deleted.length === 1);
    assert.deepEqual(t.state.deleted, ['standin-1']);
    assert.equal((await fetch(`${base}/_/sessions/deepseek/${state.sessions[0].id}`, { method: 'DELETE', headers: auth })).status, 404);
  } finally { await t.close(); }
});

// ---- deepseek-auto: a question put to DeepThink ---------------------------------------------------------------------------------------------

test('deepseek-auto: after a question was put to DeepThink the answer comes from a fresh chat that was told everything, and that chat is the one continued next', async () => {
  const t = await boot();
  try {
    t.state.reply = (prompt, { thinking }) => {
      if (thinking) return { text: 'PLAN: use a grid.', thinking: 'weighing layouts' };
      if (/TOOL RESULT \(think\)/.test(prompt)) return 'Built from the plan.';
      if (/Design me a page/.test(prompt)) return '<tool_call>{"name":"think","arguments":{"question":"How should the page be laid out?"}}</tool_call>';
      return 'Done.';
    };
    const h = [user('Design me a page')];
    const first = await (await t.chat({ model: 'deepseek-auto', tools: WEATHER, messages: h })).json();
    assert.equal(first.choices[0].message.content, 'Built from the plan.');
    h.push(first.choices[0].message, user('Thanks, and one more thing.'));
    const second = await t.chat({ model: 'deepseek-auto', tools: WEATHER, messages: h });
    assert.equal(second.status, 200);
    const c = t.state.completions;
    assert.deepEqual(c.map((x) => x.thinking), [false, true, false, false]);
    const answeredIn = c[2].session;
    assert.equal(c[3].session, answeredIn, 'the chat that gave the answer is continued');
    assert.match(c[3].prompt, /Thanks, and one more thing\./);
    assert.ok(!/Design me a page/.test(c[3].prompt));
    assert.notEqual(c[0].session, answeredIn, 'the chat that only asked to think was not kept');
    await until(() => t.state.deleted.includes(c[0].session));
    assert.ok(t.state.deleted.includes(c[0].session));
  } finally { await t.close(); }
});

test('a chat that could not be removed because the network failed is kept on the list (and on disk) and removed when it can be, never forgotten', async () => {
  const t = await boot();
  try {
    const h = [];
    await t.turn(h, 'one');
    const [open] = t.provider.engine.sessionList();
    t.site.state.drop = { '/api/v0/chat_session/delete': 1000 };
    assert.ok(t.provider.engine.endSession(open.id));
    await wait(300);
    assert.deepEqual(t.state.deleted, [], 'it could not be removed yet');
    const file = path.join(t.dir, 'sessions-deepseek.json');
    assert.ok(fs.existsSync(file), 'the chat is still written down, so a restart would remove it');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).chats, ['standin-1']);
    t.site.state.drop = {};
    await until(() => t.state.deleted.includes('standin-1'), 3000);
    assert.deepEqual(t.state.deleted, ['standin-1'], 'removed once the network was back');
    await until(() => !fs.existsSync(file), 1000);
    assert.ok(!fs.existsSync(file), 'and no longer written down');
  } finally { await t.close(); }
});

test('a chat that DeepSeek says is already gone is not asked about again and again', async () => {
  const t = await boot();
  try {
    const h = [];
    await t.turn(h, 'one');
    const [open] = t.provider.engine.sessionList();
    t.site.state.deleteStatus = 404;
    assert.ok(t.provider.engine.endSession(open.id));
    await wait(400);
    assert.equal(t.state.requests['/api/v0/chat_session/delete'], 1, 'asked once: a 404 is an answer, not a reason to try again');
  } finally { await t.close(); }
});

test('after a mixed run (good turns, a caller who leaves mid-answer, connections that drop before and during) every chat that was opened is gone from DeepSeek', async () => {
  const t = await boot();
  try {
    t.site.state.reply = () => 'An answer long enough to be sent in several pieces by the stand-in site.';
    const a = [];
    await t.turn(a, 'first conversation, first message');
    await t.turn(a, 'first conversation, second message');
    // a caller who reads one piece of a streamed answer and leaves
    const controller = new AbortController();
    const streamed = await fetch(`${t.base}/v1/chat/completions`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${t.key}` }, body: JSON.stringify({ model: 'deepseek-chat', stream: true, messages: [user('a streamed one, left halfway')] }) });
    await streamed.body.getReader().read();
    controller.abort();
    await wait(150);
    // the network goes away before a message, and in the middle of an answer
    t.site.state.drop = { '/api/v0/chat_session/create': 1 };
    await t.turn([], 'second conversation after a blip');
    t.site.state.dropMidStream = 2;
    const broken = await t.chat({ model: 'deepseek-chat', messages: [user('a third conversation that breaks off')] });
    assert.equal(broken.status, 502);
    t.site.state.dropMidStream = 0;
    await t.turn([], 'a fourth conversation, whole');
    await t.provider.stop();
    await until(() => t.state.created.every((id) => t.state.deleted.includes(id)), 3000);
    const left = t.state.created.filter((id) => !t.state.deleted.includes(id));
    assert.deepEqual(left, [], `chats left in the person's history: ${left.join(', ')} (opened ${t.state.created.length})`);
    assert.ok(!fs.existsSync(path.join(t.dir, 'sessions-deepseek.json')), 'nothing is left written down either');
  } finally { await t.close(); }
});
