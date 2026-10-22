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

// `sessions` is off here: these tests are about one request on one fresh conversation, the way every request ran before sessions (test/gemini_sessions.test.js is about sessions).
async function boot({ plan = 'pro', link = true, sessions = false, firstWordsMaxMs, waitTraceMs, modelsTtlMs } = {}) {
  const page = await startFakeGemini();
  page.control({ plan });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-gem-'));
  const bus = new EventEmitter();
  const config = createConfig({ dataDir: dir });
  const logs = [];
  const provider = createGeminiProvider({ dataDir: dir, config, bus, appUrl: page.url, plainChromeArgs: ['--headless=new'], sessions, log: (l) => logs.push(l), firstWordsMaxMs, waitTraceMs, modelsTtlMs });
  const srv = createServer({ config, registry: createRegistry({ providers: [provider], bus }), port: 0 });
  const { port } = await srv.start();
  const key = config.createApiKey('t').key;
  const t = {
    page, dir, provider, srv, key, config, logs, base: `http://127.0.0.1:${port}`,
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
    assert.deepEqual(status.models.map((m) => m.id), ['gemini', 'gemini-auto', 'gemini-3-5-flash-lite', 'gemini-3-8-flash', 'gemini-3-1-pro', 'gemini-4-argon'], 'the two stable names, then the account\'s own rows');
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
    assert.deepEqual((await t.provider.status()).models.map((m) => m.id), ['gemini', 'gemini-auto'], 'a free account\'s own row is its Auto; the locked rows are not offered');
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

test('tools: a quick-reply control drawn next to the code block of a tool call is not text around the call', { skip, timeout: 90000 }, async () => {
  const t = await boot();
  try {
    t.page.control({ chip: 'Sure thing' });
    const body = await (await t.chat({ model: 'gemini-3-1-pro', tools: SAVE, messages: [user('Please send the snippet')] })).json();
    const message = body.choices[0].message;
    assert.equal(JSON.parse(message.tool_calls[0].function.arguments).text, SNIPPET);
    assert.ok(!/Sure thing/.test(JSON.stringify(message)), 'nothing of the control goes back with the call: ' + JSON.stringify(message).slice(0, 200));
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

test('a page that keeps working but never shows a word is given up on after a limit, with the page described in the log (it used to wait for the 15 minute cap)', { skip, timeout: 120000 }, async () => {
  const t = await boot({ firstWordsMaxMs: 6000, waitTraceMs: 1500 });
  try {
    t.page.control({ stall: true });
    const started = Date.now();
    const res = await t.chat({ model: 'gemini-3-8-flash', messages: [{ role: 'user', content: 'Hello there stalled page' }] });
    assert.ok(res.status >= 400, `status ${res.status}`);
    assert.match((await res.json()).error.message, /showed no words/i);
    assert.ok(Date.now() - started < 60000, 'it did not wait for the cap');
    // while it waited, what the page showed was written down every so often, so a slow call can be read afterwards
    const traces = t.logs.filter((l) => /^gemini: still waiting \d+ s after sending: /.test(l));
    assert.ok(traces.length >= 2, 'waiting is traced: ' + t.logs.slice(-6).join(' | '));
    assert.match(traces[0], /"running":true/);
    assert.match(traces[0], /requests: .*POST [^ ]+\/sent /, 'which requests the page made, and how far they got: ' + traces[0]);
    assert.match(traces[0], /"users":1/);
    assert.ok(!traces.join('\n').includes('Hello there stalled page'), 'never what was said');
    const line = t.logs.find((l) => /^gemini: stalled/.test(l));
    assert.ok(line, 'what the page showed is in the log: ' + t.logs.slice(-5).join(' | '));
    assert.match(line, /"running":true/);
    assert.match(line, /"responses":1/);
    assert.ok(!line.includes('Hello there stalled page'), 'never what was said');
  } finally { await t.provider.stop(); await t.close(); }
});

test('a model picker the page draws a moment after its message box is waited for: the linked list is the account\'s models, not the one-model fallback', { skip, timeout: 120000 }, async () => {
  const t = await boot({ link: false });
  try {
    t.page.control({ pickerDelayMs: 3000 });
    assert.equal((await t.provider.startLink({ consentAcknowledged: true })).ok, true);
    assert.equal((await t.provider.finishLink({})).ok, true);
    assert.deepEqual((await t.provider.status()).models.map((m) => m.id), ['gemini', 'gemini-auto', 'gemini-3-5-flash-lite', 'gemini-3-8-flash', 'gemini-3-1-pro', 'gemini-4-argon']);
  } finally { await t.provider.stop(); await t.close(); }
});

test('a link that could not read the picker is not stuck with the one-model fallback: the first call reads it again, and the next call can choose a model', { skip, timeout: 180000 }, async () => {
  const t = await boot({ link: false });
  try {
    t.page.control({ pickerDelayMs: 600000 }); // the picker never comes while linking
    assert.equal((await t.provider.startLink({ consentAcknowledged: true })).ok, true);
    assert.equal((await t.provider.finishLink({})).ok, true);
    assert.deepEqual((await t.provider.status()).models.map((m) => m.id), ['gemini', 'gemini-auto'], 'only the stable names');
    t.page.control({ pickerDelayMs: 0 }); // the picker is there at the call
    const first = await t.chat({ model: 'gemini', messages: [{ role: 'user', content: 'First question' }] });
    assert.equal(first.status, 200);
    assert.deepEqual((await t.provider.status()).models.map((m) => m.name).slice(2), ['3.5 Flash-Lite', '3.8 Flash', '3.1 Pro', '4 Argon'], 'read again on the call');
    const second = await t.chat({ model: 'gemini-3-1-pro', messages: [{ role: 'user', content: 'Second question' }] });
    assert.equal(second.status, 200);
    assert.equal(t.page.state.sent.at(-1).mode, '3.1 Pro', 'the page was put on the model that was chosen');
  } finally { await t.provider.stop(); await t.close(); }
});

test('the line that says where a call\'s time went also says when the page showed the message and when it started working', { skip, timeout: 120000 }, async () => {
  const t = await boot();
  try {
    const res = await t.chat({ model: 'gemini-3-8-flash', messages: [{ role: 'user', content: 'Timing question' }] });
    assert.equal(res.status, 200);
    const line = t.logs.find((l) => /^gemini: call took/.test(l));
    assert.ok(line, t.logs.join(' | '));
    assert.match(line, /message shown \d+ ms after sending, page working \d+ ms after sending/);
    assert.match(line, /requests: .*POST [^ ]+\/sent \d{3} /, 'the requests of the call, with their status: ' + line);
    assert.ok(!/\?/.test(line.slice(line.indexOf('requests:'))), 'no query strings in the line');
  } finally { await t.provider.stop(); await t.close(); }
});

test('the page\'s own error message is a failed request, not an answer: the client is told so and can try again', { skip, timeout: 120000 }, async () => {
  const t = await boot();
  try {
    // the two wordings the page has been seen to use where an answer goes when its own request failed
    for (const wording of [true, 'I seem to be encountering an error. Can I try something else for you?']) {
      t.page.control({ errorAnswer: wording });
      const res = await t.chat({ model: 'gemini-3-8-flash', messages: [{ role: 'user', content: 'Anything at all' }] });
      assert.ok(res.status >= 400, `status ${res.status}: an error message is not an answer (${wording})`);
      assert.match((await res.json()).error.message, /Gemini answered with its own error message/i);
    }
    assert.ok(t.logs.some((l) => /gemini: the page answered with its own error message/.test(l)), t.logs.slice(-3).join(' | '));
    t.page.control({ errorAnswer: false });
    const again = await t.chat({ model: 'gemini-3-8-flash', messages: [{ role: 'user', content: 'Second try' }] });
    assert.equal(again.status, 200);
    assert.match((await again.json()).choices[0].message.content, /Second try/);
  } finally { await t.provider.stop(); await t.close(); }
});

test('a quick-reply control the page draws inside the answer (a "Yes" under a question) is not part of the answer, whatever element it is made of, and the log says where such a thing sits without saying its words', { skip, timeout: 120000 }, async () => {
  const t = await boot();
  try {
    for (const chipTag of ['button', 'div']) {
      t.page.control({ chip: 'Sure thing', chipTag });
      const res = await t.chat({ model: 'gemini-3-8-flash', messages: [{ role: 'user', content: `Offer me an example (${chipTag})` }] });
      assert.equal(res.status, 200);
      const content = (await res.json()).choices[0].message.content;
      assert.match(content, /Offer me an example/, 'the model\'s words are there');
      assert.ok(!/Sure thing/.test(content), `the page's control is not the model's answer (${chipTag}): ${JSON.stringify(content.slice(-60))}`);
    }
    const tail = t.logs.find((l) => /^gemini: shape of the last response/.test(l));
    assert.ok(tail, t.logs.join(' | '));
    assert.match(tail, /last elements with their own text: .*button\.suggestion-chip#10\{in answer\}/, 'where the control sits, by tag, class and text length: ' + tail);
    assert.ok(!/Sure thing/.test(t.logs.join('\n')), 'no words of the page or of the answer in the log');
  } finally { await t.provider.stop(); await t.close(); }
});

test('an answer that merely talks about something going wrong is still an answer', { skip, timeout: 120000 }, async () => {
  const t = await boot();
  try {
    const res = await t.chat({ model: 'gemini-3-8-flash', messages: [{ role: 'user', content: 'Explain why something went wrong in my build, in detail please' }] });
    assert.equal(res.status, 200);
  } finally { await t.provider.stop(); await t.close(); }
});

// ---- the model list: stable names, live, with a working context size ---------------------------------------------------------------------------

test('the model list always has gemini and gemini-auto first, then the account\'s own rows, each with a working context size', { skip, timeout: 120000 }, async () => {
  const t = await boot();
  try {
    const list = t.provider.models();
    assert.deepEqual(list.map((m) => m.id), ['gemini', 'gemini-auto', 'gemini-3-5-flash-lite', 'gemini-3-8-flash', 'gemini-3-1-pro', 'gemini-4-argon']);
    assert.ok(list.every((m) => m.context_length === 128000), 'one conservative working size, from one place');
  } finally { await t.provider.stop(); await t.close(); }
});

test('an old saved link that holds only the one-model fallback lists the two stable names and nothing doubled', { skip, timeout: 120000 }, async () => {
  const t = await boot({ link: false });
  try {
    fs.writeFileSync(path.join(t.dir, 'gemini_session.json'), JSON.stringify({ linked: true, expired: false, models: [{ id: 'gemini', name: 'Gemini', thinking: true }], linkedAt: new Date().toISOString() }));
    assert.deepEqual(t.provider.models().map((m) => m.id), ['gemini', 'gemini-auto']);
  } finally { await t.provider.stop(); await t.close(); }
});

test('gemini and gemini-auto mean the mode the page is on: no model is chosen for them', { skip, timeout: 120000 }, async () => {
  const t = await boot();
  try {
    for (const model of ['gemini', 'gemini-auto']) {
      const res = await t.chat({ model, messages: [{ role: 'user', content: `Which mode, ${model}?` }] });
      assert.equal(res.status, 200, `${model}: status ${res.status}`);
    }
    assert.deepEqual(t.page.state.sent.map((x) => x.mode), ['Argon', 'Argon'], 'the page\'s own mode, untouched');
    // and a named row still is chosen
    await t.chat({ model: 'gemini-3-1-pro', messages: [{ role: 'user', content: 'Pro please' }] });
    assert.equal(t.page.state.sent.at(-1).mode, '3.1 Pro');
  } finally { await t.provider.stop(); await t.close(); }
});

test('the list follows the account: a row the picker no longer offers goes away on the next call once the list is old enough, and a real Auto row takes the gemini-auto name', { skip, timeout: 180000 }, async () => {
  const t = await boot({ modelsTtlMs: 400 });
  try {
    assert.equal(t.provider.models().length, 6);
    t.page.control({ plan: 'free' }); // the account now has fewer rows: Auto, and two locked ones that are not offered
    await new Promise((r) => setTimeout(r, 900));
    const res = await t.chat({ model: 'gemini', messages: [{ role: 'user', content: 'Hello list' }] });
    assert.equal(res.status, 200);
    assert.deepEqual(t.provider.models().map((m) => [m.id, m.name]), [['gemini', 'Gemini (account default)'], ['gemini-auto', 'Auto']], 'the row is the account\'s own Auto, not the generic name');
    const auto = await t.chat({ model: 'gemini-auto', messages: [{ role: 'user', content: 'Auto please' }] });
    assert.equal(auto.status, 200);
    assert.ok(!t.logs.some((l) => /the linked list has no model/.test(l)), 'gemini-auto was found in the list, as the account\'s own row');
  } finally { await t.provider.stop(); await t.close(); }
});

test('the list can be read again without a call: refreshModels() when idle, and the same when a client lists the models', { skip, timeout: 180000 }, async () => {
  const t = await boot({ modelsTtlMs: 300 });
  try {
    assert.equal(typeof t.provider.refreshModels, 'function');
    t.page.control({ plan: 'free' });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(await t.provider.refreshModels({}), true, 'it was old, so it was read');
    assert.deepEqual(t.provider.models().map((m) => m.name), ['Gemini (account default)', 'Auto']);
    assert.equal(await t.provider.refreshModels({}), false, 'not again at once: the list is fresh');
    t.page.control({ plan: 'pro' });
    assert.equal(await t.provider.refreshModels({ force: true }), true, 'forced, whatever its age');
    assert.equal(t.provider.models().length, 6);
    // listing the models over HTTP starts a read in the background and answers at once with what there is
    t.page.control({ plan: 'free' });
    await new Promise((r) => setTimeout(r, 700));
    const res = await fetch(`${t.base}/v1/models`, { headers: { authorization: `Bearer ${t.key}` } });
    const body = await res.json();
    assert.ok(body.data.some((m) => m.id === 'gemini-auto') && body.data.every((m) => m.context_length === 128000), JSON.stringify(body.data.map((m) => m.id)));
    for (let i = 0; i < 60 && t.provider.models().length !== 2; i += 1) await new Promise((r) => setTimeout(r, 500));
    assert.equal(t.provider.models().length, 2, 'the background read followed the account');
  } finally { await t.provider.stop(); await t.close(); }
});
