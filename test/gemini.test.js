'use strict';

/**
 * The Gemini provider with a REAL Chrome and a local page shaped like gemini.google.com (test/fixtures/fake_gemini.js): the link flow (a plain Chrome to
 * sign in, then the driven one to check and read the model picker), the models, choosing a model and a thinking level on the page, streaming the answer
 * and the thinking, tool calls through the fenced bridge (with a snippet full of tags and quotes that the page's markdown would mangle), a sign-in that
 * lapses, a human check, and unlinking. No Google account is involved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { createConfig } = require('../src/config');
const { cleanupDir } = require('./fixtures/cleanup');
const { createRegistry } = require('../src/registry');
const { createServer } = require('../src/server');
const { chromeExecutable } = require('../src/providers/chrome');
const { createGeminiProvider } = require('../src/providers/gemini');
const { startFakeGemini } = require('./fixtures/fake_gemini');

const skip = chromeExecutable() ? false : 'Chrome is not installed';
const SNIPPET = '<h1 class="title">Hello & "welcome"</h1>\n<p>line two \\ backslash</p>';
const user = (text) => ({ role: 'user', content: text });
const SAVE = [{ type: 'function', function: { name: 'save_text', description: 'Save some text', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }];
const WEATHER = [{ type: 'function', function: { name: 'get_weather', description: 'Current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];

async function boot({ plan = 'pro', link = true } = {}) {
  const page = await startFakeGemini();
  page.control({ plan });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-gem-'));
  const bus = new EventEmitter();
  const config = createConfig({ dataDir: dir });
  const provider = createGeminiProvider({ dataDir: dir, config, bus, appUrl: page.url, plainChromeArgs: ['--headless=new'] });
  const srv = createServer({ config, registry: createRegistry({ providers: [provider], bus }), port: 0 });
  const { port } = await srv.start();
  const key = config.createApiKey('t').key;
  const t = {
    page, dir, provider, srv, key, config, base: `http://127.0.0.1:${port}`,
    chat: (body) => fetch(`${t.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) }),
    async close() { await srv.stop(); await page.close(); await cleanupDir(dir); }
  };
  if (link) {
    const started = await provider.startLink({ consentAcknowledged: true });
    assert.equal(started.ok, true, JSON.stringify(started));
    const done = await provider.finishLink({});
    assert.equal(done.ok, true, JSON.stringify(done));
  }
  return t;
}

test('linking needs consent; with it, a plain Chrome signs in and the models are read from the page\'s own picker', { skip, timeout: 90000 }, async () => {
  const t = await boot({ link: false });
  try {
    assert.equal((await t.provider.startLink({ consentAcknowledged: false })).ok, false);
    const t0 = Date.now();
    assert.equal((await t.provider.startLink({ consentAcknowledged: true })).ok, true);
    assert.ok(Date.now() - t0 < 6000, 'starting returns once Chrome is up, not when the person is done');
    assert.equal((await t.provider.status()).linking, true);
    const done = await t.provider.finishLink({});
    assert.deepEqual({ ok: done.ok, linked: done.linked }, { ok: true, linked: true });
    const status = await t.provider.status();
    assert.equal(status.linked, true);
    assert.equal(status.linking, false);
    assert.deepEqual(status.models.map((m) => m.id), ['gemini-3-5-flash-lite', 'gemini-3-8-flash', 'gemini-3-1-pro', 'gemini-4-argon']);
    const session = path.join(t.dir, 'gemini_session.json');
    assert.equal(fs.statSync(session).mode & 0o777, 0o600);
    assert.equal(fs.statSync(t.dir).mode & 0o777, 0o700);
    const listed = await (await fetch(`${t.base}/v1/models`, { headers: { authorization: `Bearer ${t.key}` } })).json();
    assert.ok(listed.data.some((m) => m.id === 'gemini-3-1-pro' && m.owned_by === 'gemini'));
  } finally { await t.provider.stop(); await t.close(); }
});

test('a free account is offered only what it can use: locked rows are never models', { skip, timeout: 90000 }, async () => {
  const t = await boot({ plan: 'free' });
  try {
    assert.deepEqual((await t.provider.status()).models.map((m) => m.id), ['gemini-auto']);
  } finally { await t.provider.stop(); await t.close(); }
});

test('pressing Done before signing in keeps the link open and says so; Cancel ends it', { skip, timeout: 90000 }, async () => {
  const t = await boot({ link: false });
  try {
    t.page.control({ signedOut: true });
    await t.provider.startLink({ consentAcknowledged: true });
    const early = await t.provider.finishLink({});
    assert.equal(early.ok, false);
    assert.equal(early.notSignedIn, true);
    assert.match(early.note, /Sign in|sign in/);
    assert.equal((await t.provider.status()).linked, false);
    assert.equal((await t.provider.status()).linking, true, 'the sign-in Chrome is back for the person to go on');
    const cancelled = await t.provider.finishLink({ cancel: true });
    assert.equal(cancelled.cancelled, true);
    assert.equal((await t.provider.status()).linking, false);
  } finally { await t.provider.stop(); await t.close(); }
});

test('chat: the page is put on the chosen model, the question goes as it is, and the answer comes back', { skip, timeout: 90000 }, async () => {
  const t = await boot();
  try {
    const res = await t.chat({ model: 'gemini-3-1-pro', messages: [user('What is 3 + 4?')] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, '7');
    const sent = t.page.state.sent.at(-1);
    assert.equal(sent.mode, '3.1 Pro', 'the page was put on the model the request named');
    assert.equal(sent.prompt, 'What is 3 + 4?', 'a plain question is not wrapped in anything');
    assert.ok(body.choices[0].message.reasoning_content, 'the page\'s thinking is returned apart from the answer');
    const other = await t.chat({ model: 'gemini-3-5-flash-lite', messages: [user('What is 3 + 4?')] });
    assert.equal(other.status, 200);
    assert.equal(t.page.state.sent.at(-1).mode, '3.5 Flash-Lite');
  } finally { await t.provider.stop(); await t.close(); }
});

test('chat: a caller that left while the page was loading has nothing typed and sent for it; one that leaves after the send is reported as sent', { skip, timeout: 90000 }, async () => {
  const t = await boot();
  try {
    const before = t.page.state.sent.length;
    const visits = t.page.state.visits;
    // gone as soon as the page has been opened: the last stop before the message is typed is the one that has to notice
    const leaving = { get aborted() { return t.page.state.visits > visits; } };
    const early = await t.provider.page.completeOnce({ prompt: 'never to be typed', signal: leaving, model: 'gemini-3-1-pro' });
    assert.equal(early.cancelled, true);
    assert.equal(early.sent, false, 'nothing went out, so nothing is counted');
    assert.equal(t.page.state.sent.length, before, 'the prompt was not typed into the page');

    // gone once the answer has started: the message went out, and the result says so
    const ac = new AbortController();
    const late = t.provider.page.completeOnce({ prompt: 'Give me a long answer', signal: ac.signal, model: 'gemini-3-1-pro', onDelta: () => ac.abort() });
    const r = await late;
    assert.equal(r.cancelled, true);
    assert.equal(r.sent, true, 'the account was spent');
    assert.equal(t.page.state.sent.length, before + 1);
  } finally { await t.provider.stop(); await t.close(); }
});

test('chat: a streamed answer arrives in pieces and adds up; the thinking streams as reasoning_content',{ skip, timeout: 90000 }, async () => {
  const t = await boot();
  try {
    const res = await t.chat({ model: 'gemini-3-1-pro', stream: true, messages: [user('Give me a long answer')] });
    const events = (await res.text()).split('\n\n').map((b) => (b.split('\n').find((l) => l.startsWith('data: ')) || '').slice(6)).filter(Boolean);
    assert.equal(events.at(-1), '[DONE]');
    const chunks = events.filter((e) => e !== '[DONE]').map((e) => JSON.parse(e));
    assert.equal(chunks.map((c) => c.choices[0].delta.content || '').join(''), 'word '.repeat(60).trim());
    assert.equal(chunks.map((c) => c.choices[0].delta.reasoning_content || '').join(''), 'Reading the request. Choosing the shape of the answer.');
    assert.ok(chunks.filter((c) => c.choices[0].delta.content).length > 3, 'the answer was not held until the end');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  } finally { await t.provider.stop(); await t.close(); }
});

test('reasoning_effort sets the page\'s Thinking level, once per change', { skip, timeout: 90000 }, async () => {
  const t = await boot();
  try {
    await t.chat({ model: 'gemini-3-1-pro', reasoning_effort: 'high', messages: [user('What is 3 + 4?')] });
    assert.equal(t.page.state.sent.at(-1).level, 'High');
    await t.chat({ model: 'gemini-3-1-pro', reasoning_effort: 'low', messages: [user('What is 3 + 4?')] });
    assert.equal(t.page.state.sent.at(-1).level, 'Low');
    await t.provider.setSettings({ thinkingLevel: 'medium' });
    await t.chat({ model: 'gemini-3-1-pro', messages: [user('What is 3 + 4?')] });
    assert.equal(t.page.state.sent.at(-1).level, 'Medium', 'with no reasoning_effort the saved level is used');
    assert.equal((await t.provider.status()).thinkingLevel, 'medium');
  } finally { await t.provider.stop(); await t.close(); }
});

test('tools: a fenced call comes back as tool_calls, and the result finishes the task', { skip, timeout: 90000 }, async () => {
  const t = await boot();
  try {
    const first = await (await t.chat({ model: 'gemini-3-1-pro', tools: WEATHER, messages: [user('Weather in Dar es Salaam?')] })).json();
    const call = first.choices[0].message.tool_calls[0];
    assert.equal(first.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual([call.function.name, JSON.parse(call.function.arguments)], ['get_weather', { city: 'Dar es Salaam' }]);
    assert.match(t.page.state.sent.at(-1).prompt, /Tool bridge/);
    const second = await (await t.chat({ model: 'gemini-3-1-pro', tools: WEATHER, messages: [user('Weather in Dar es Salaam?'), first.choices[0].message, { role: 'tool', tool_call_id: call.id, content: '31C, clear' }] })).json();
    assert.equal(second.choices[0].message.content, 'It is sunny. TOOL_DONE');
  } finally { await t.provider.stop(); await t.close(); }
});

test('tools: text full of tags, quotes and backslashes survives the page (the fence keeps it as written)', { skip, timeout: 90000 }, async () => {
  const t = await boot();
  try {
    const body = await (await t.chat({ model: 'gemini-3-1-pro', tools: SAVE, messages: [user('Please send the snippet')] })).json();
    const call = body.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'save_text');
    assert.equal(JSON.parse(call.function.arguments).text, SNIPPET);
  } finally { await t.provider.stop(); await t.close(); }
});

test('a lapsed sign-in is a 401 that says so, the account is marked expired and offers no models', { skip, timeout: 90000 }, async () => {
  const t = await boot();
  try {
    t.page.control({ signedOut: true });
    const res = await t.chat({ model: 'gemini-3-1-pro', messages: [user('What is 3 + 4?')] });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'gemini_session_expired');
    const status = await t.provider.status();
    assert.equal(status.expired, true);
    assert.deepEqual(status.models, []);
    const listed = await (await fetch(`${t.base}/v1/models`, { headers: { authorization: `Bearer ${t.key}` } })).json();
    assert.deepEqual(listed.data, []);
    assert.equal(t.srv.notices[0].kind, 'expired');
  } finally { await t.provider.stop(); await t.close(); }
});

test('a human check ends the request in one 429, pauses the lane, and later requests never reach the page', { skip, timeout: 90000 }, async () => {
  const t = await boot();
  try {
    t.page.control({ blocked: true });
    const first = await t.chat({ model: 'gemini-3-1-pro', messages: [user('What is 3 + 4?')] });
    assert.equal(first.status, 429);
    const err = (await first.json()).error;
    assert.equal(err.code, 'gemini_rate_limited');
    assert.match(err.message, /human check/);
    assert.ok(Number(first.headers.get('retry-after')) > 200);
    t.page.control({ blocked: false });
    const visits = t.page.state.visits;
    const second = await t.chat({ model: 'gemini-3-1-pro', messages: [user('What is 3 + 4?')] });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error.code, 'gemini_cooldown');
    assert.equal(t.page.state.visits, visits, 'the page was not visited while the lane is paused');
  } finally { await t.provider.stop(); await t.close(); }
});

test('unlinking deletes the session and the Chrome profile', { skip, timeout: 90000 }, async () => {
  const t = await boot();
  try {
    assert.ok(fs.existsSync(path.join(t.dir, 'gemini-chrome')));
    await t.provider.unlink();
    assert.equal(fs.existsSync(path.join(t.dir, 'gemini_session.json')), false);
    assert.equal(fs.existsSync(path.join(t.dir, 'gemini-chrome')), false);
    assert.equal((await t.provider.status()).linked, false);
    const res = await t.chat({ model: 'gemini-3-1-pro', messages: [user('hi')] });
    assert.equal(res.status, 404, 'no models once unlinked');
  } finally { await t.provider.stop(); await t.close(); }
});

test('stopping while a link waits leaves nothing behind: the program is free to exit at once, not after the 15 minute link window', { skip, timeout: 90000 }, async () => {
  const page = await startFakeGemini();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-gem-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'link_then_stop.js'), dir, page.url], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, 45000);
  try {
    const code = await exited;
    assert.ok(out.includes('stopped'), out);
    assert.equal(code, 0, `the process ended by itself (exit ${code}): ${out}`);
  } finally {
    clearTimeout(timer);
    try { child.kill('SIGKILL'); } catch (_) { /* gone */ }
    await page.close();
    await cleanupDir(dir);
  }
});
