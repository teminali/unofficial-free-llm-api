'use strict';

/**
 * Sessions on the Gemini lane, with a REAL Chrome and the local page shaped like gemini.google.com (test/fixtures/fake_gemini.js, which keeps conversations at
 * /app/<id> like the real page). A conversation that grows request by request must stay in ONE Gemini conversation: each request opens it again and adds
 * only the new message, and the answer read back is the new one, not the one the page already showed. No Google account is involved.
 */

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
const { chromeExecutable } = require('../src/providers/chrome');
const { createGeminiProvider } = require('../src/providers/gemini');
const { startFakeGemini } = require('./fixtures/fake_gemini');

const skip = chromeExecutable() ? false : 'Chrome is not installed';
const user = (text) => ({ role: 'user', content: text });

async function boot({ sessions = true, tabIdleMs, maxTabs } = {}) {
  const page = await startFakeGemini();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-gs-'));
  const bus = new EventEmitter();
  const config = createConfig({ dataDir: dir });
  const provider = createGeminiProvider({ dataDir: dir, config, bus, appUrl: page.url, plainChromeArgs: ['--headless=new'], sessions, tabIdleMs, maxTabs });
  const srv = createServer({ config, registry: createRegistry({ providers: [provider], bus }), port: 0 });
  const { port } = await srv.start();
  const key = config.createApiKey('t').key;
  const t = {
    page, dir, provider, srv, config, state: page.state,
    chat: (body) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) }),
    async turn(history, text, body = {}) {
      history.push(user(text));
      const res = await t.chat({ model: 'gemini-3-8-flash', messages: history, ...body });
      assert.equal(res.status, 200, `status ${res.status}`);
      const data = await res.json();
      history.push({ role: 'assistant', content: data.choices[0].message.content });
      return data.choices[0].message.content;
    },
    async close() { await provider.stop(); await srv.stop(); await page.close(); await cleanupDir(dir); }
  };
  assert.equal((await provider.startLink({ consentAcknowledged: true })).ok, true);
  assert.equal((await provider.finishLink({})).ok, true);
  return t;
}

test('a conversation that grows stays in one Gemini conversation: each request adds only the new message, and the answer read is the new one', { skip, timeout: 120000 }, async () => {
  const t = await boot();
  try {
    const visitsAfterLink = t.state.visits; // the link itself loaded the page twice
    const h = [];
    assert.equal(await t.turn(h, 'First question here'), 'The page answers: First question here');
    assert.equal(await t.turn(h, 'Second question here'), 'The page answers: Second question here', 'not the answer the page was already showing');
    assert.equal(await t.turn(h, 'Third question here'), 'The page answers: Third question here');
    assert.deepEqual(t.state.sent.map((s) => s.prompt), ['First question here', 'Second question here', 'Third question here'], 'only what is new, as it is');
    assert.equal(new Set(t.state.sent.map((s) => s.conv)).size, 1, 'one conversation');
    const [id] = [...Object.keys(Object.fromEntries(t.state.convs))];
    assert.equal(t.state.convs.get(id).length, 3);
    assert.deepEqual(t.state.conversationAddresses, [], 'the tab of the conversation stays open: the second and third request did not load the page again');
    assert.equal(t.state.visits - visitsAfterLink, 1, 'one page load for three requests');
    const info = t.provider.engine.sessionInfo();
    assert.deepEqual([info.open, info.continued, info.started], [1, 2, 1]);
  } finally { await t.close(); }
});

test('with sessions off every request opens a fresh conversation and is told the whole conversation, as before', { skip, timeout: 120000 }, async () => {
  const t = await boot({ sessions: false });
  try {
    const h = [];
    await t.turn(h, 'One');
    await t.turn(h, 'Two');
    assert.equal(new Set(t.state.sent.map((s) => s.conv)).size, 2);
    assert.match(t.state.sent[1].prompt, /USER:\nOne/);
    assert.equal(t.state.conversationAddresses.length, 0);
  } finally { await t.close(); }
});

test('a conversation Gemini no longer has is given up: the request is asked again once, in a new conversation with everything', { skip, timeout: 120000 }, async () => {
  // (a tab that is still open cannot know its conversation was deleted; this is the case where the tab is gone and the conversation is opened by its address)
  const t = await boot({ tabIdleMs: 300 });
  try {
    const h = [];
    await t.turn(h, 'Remember the number seven');
    await new Promise((r) => setTimeout(r, 1200));
    t.state.convs.clear(); // deleted by the person, on the page
    assert.match(await t.turn(h, 'What number?'), /^The page answers: USER: Remember the number seven/, 'told the whole conversation again');
    assert.equal(new Set(t.state.sent.map((s) => s.conv)).size, 2);
    assert.match(t.state.sent.at(-1).prompt, /USER:\nRemember the number seven/);
    assert.equal(t.provider.engine.sessionInfo().failed, 1);
  } finally { await t.close(); }
});

test('another model is another conversation; the first one is still continued afterwards', { skip, timeout: 120000 }, async () => {
  const t = await boot();
  try {
    const h = [];
    await t.turn(h, 'Alpha question');
    await t.turn([], 'Other model question', { model: 'gemini-3-1-pro' });
    await t.turn(h, 'Alpha again');
    const convs = t.state.sent.map((s) => s.conv);
    assert.equal(convs[0], convs[2]);
    assert.notEqual(convs[0], convs[1]);
    assert.equal(t.state.sent[2].prompt, 'Alpha again');
  } finally { await t.close(); }
});

test('tools: the call and its result go through one conversation, the result alone in the second request', { skip, timeout: 120000 }, async () => {
  const t = await boot();
  try {
    const WEATHER = [{ type: 'function', function: { name: 'get_weather', description: 'Current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
    const h = [user('What is the weather in Dar es Salaam?')];
    const first = (await (await t.chat({ model: 'gemini-3-8-flash', tools: WEATHER, messages: h })).json()).choices[0].message;
    assert.equal(first.tool_calls.length, 1);
    h.push(first, { role: 'tool', tool_call_id: first.tool_calls[0].id, content: '31 C and sunny' });
    const second = await (await t.chat({ model: 'gemini-3-8-flash', tools: WEATHER, messages: h })).json();
    assert.equal(second.choices[0].message.content.length > 0, true);
    assert.equal(new Set(t.state.sent.map((s) => s.conv)).size, 1);
    assert.match(t.state.sent[0].prompt, /# Tool bridge/);
    assert.ok(/^TOOL RESULT \(get_weather\):/.test(t.state.sent[1].prompt), t.state.sent[1].prompt.slice(0, 60));
  } finally { await t.close(); }
});

test('the tab of a conversation is kept open between requests, and closed when the session ends', { skip, timeout: 120000 }, async () => {
  const t = await boot();
  try {
    const h = [];
    await t.turn(h, 'First');
    assert.equal(t.provider.page.tabCount(), 1, 'kept after the answer');
    await t.turn(h, 'Second');
    assert.equal(t.provider.page.tabCount(), 1, 'the same tab, not a second one');
    const [one] = t.provider.engine.sessionList();
    assert.ok(one);
    await t.provider.engine.endSession(one.id);
    assert.equal(t.provider.page.tabCount(), 0, 'its tab went with the session');
  } finally { await t.close(); }
});

test('a tab that has been idle for too long is closed, and the conversation is opened again by its address when it goes on', { skip, timeout: 120000 }, async () => {
  const t = await boot({ tabIdleMs: 600 });
  try {
    const h = [];
    await t.turn(h, 'Before the pause');
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(t.provider.page.tabCount(), 0, 'closed after the idle time');
    assert.equal(await t.turn(h, 'After the pause'), 'The page answers: After the pause');
    assert.equal(t.state.conversationAddresses.length, 1, 'opened again by its address');
    assert.equal(new Set(t.state.sent.map((x) => x.conv)).size, 1, 'still one conversation');
  } finally { await t.close(); }
});

test('only a few tabs stay open: another conversation takes the place of the oldest, which is opened again by its address when it goes on', { skip, timeout: 180000 }, async () => {
  const t = await boot({ maxTabs: 1 });
  try {
    const a = [];
    const b = [];
    await t.turn(a, 'Alpha one', { model: 'gemini-3-8-flash' });
    await t.turn(b, 'Beta one', { model: 'gemini-3-1-pro' });
    assert.equal(t.provider.page.tabCount(), 1, 'one tab at most');
    assert.equal(await t.turn(a, 'Alpha two', { model: 'gemini-3-8-flash' }), 'The page answers: Alpha two');
    assert.equal(t.state.conversationAddresses.length, 1, 'Alpha was opened again by its address');
    assert.equal(t.provider.page.tabCount(), 1);
    const convs = t.state.sent.map((x) => x.conv);
    assert.equal(convs[0], convs[2], 'Alpha stayed in its own conversation');
    assert.notEqual(convs[0], convs[1]);
  } finally { await t.close(); }
});

test('a request that fails does not leave its tab behind', { skip, timeout: 120000 }, async () => {
  const t = await boot();
  try {
    const h = [];
    await t.turn(h, 'One');
    t.state.convs.clear(); // the conversation is gone on the page
    t.page.control({});
    // the kept tab still shows the old page; the next request must not trust it blindly
    const res = await t.chat({ model: 'gemini-3-8-flash', messages: [...h, user('Two')] });
    assert.equal(res.status, 200, 'a conversation that is gone is started again, as before');
    assert.ok(t.provider.page.tabCount() <= 1);
  } finally { await t.close(); }
});
