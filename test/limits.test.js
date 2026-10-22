'use strict';

/**
 * max_tokens and stop for a plain chat (src/limits.js and the engine): the answer is cut where the caller asked, a stop string that arrives split over two pieces
 * of a stream is still found, the provider is told to stop sending once a limit is reached, and a request with tools is never cut.
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
const { createLimiter, cutText, stopList, maxChars } = require('../src/limits');
const { startFakeDeepSeek, TOKEN } = require('./fixtures/fake_deepseek');

const FAST = { perMinute: 1000, minGapMs: 1, cooldownMs: 60000, smooth: true };
const user = (text) => ({ role: 'user', content: text });
const WEATHER = [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];

// ---- the limiter ----------------------------------------------------------------------------------------------------------------------------

test('what a request asks for: tokens are four characters, the empty stops are not stops, at most four count', () => {
  assert.equal(maxChars({ max_tokens: 10 }), 40);
  assert.equal(maxChars({ max_completion_tokens: 5, max_tokens: 10 }), 20, 'the newer name wins');
  assert.equal(maxChars({ max_tokens: 0 }), 0);
  assert.equal(maxChars({ max_tokens: 'many' }), 0);
  assert.equal(maxChars({}), 0);
  assert.deepEqual(stopList('END'), ['END']);
  assert.deepEqual(stopList(['a', '', 5, 'b', 'c', 'd', 'e']), ['a', 'b', 'c', 'd']);
  assert.deepEqual(stopList(undefined), []);
});

test('a whole answer is cut at the first stop string, or at the size, whichever comes first; with neither it is left alone', () => {
  assert.deepEqual(cutText('one two END three', { stops: ['END'] }), { text: 'one two ', finish: 'stop' });
  assert.deepEqual(cutText('abcdefghij', { maxChars: 4 }), { text: 'abcd', finish: 'length' });
  assert.deepEqual(cutText('abc END def', { maxChars: 100, stops: ['END', 'def'] }), { text: 'abc ', finish: 'stop' });
  assert.deepEqual(cutText('abcdef END', { maxChars: 3, stops: ['END'] }), { text: 'abc', finish: 'length' }, 'the size was reached first');
  assert.deepEqual(cutText('abcd', { maxChars: 4 }), { text: 'abcd', finish: null }, 'an answer that ends at the size is not cut');
  assert.deepEqual(cutText('plain', {}), { text: 'plain', finish: null });
});

test('in pieces: a stop string split over pieces is found and never partly sent; text that only looked like the start of one is sent in the end', () => {
  const lim = createLimiter({ stops: ['<END>'] });
  const sent = [];
  for (const piece of ['Hello <', 'EN', 'D> and more']) { const r = lim.push(piece); sent.push(r.out); if (r.done) break; }
  assert.equal(sent.join(''), 'Hello ');
  assert.equal(lim.done(), 'stop');
  const other = createLimiter({ stops: ['<END>'] });
  const out = ['a <', 'EN', 'x'].map((p) => other.push(p).out);
  out.push(other.flush());
  assert.equal(out.join(''), 'a <ENx');
  assert.equal(other.done(), null);
});

test('in pieces: the size is reached in the middle of a piece, and nothing is accepted after it', () => {
  const lim = createLimiter({ maxChars: 5 });
  assert.deepEqual(lim.push('abc'), { out: 'abc', done: null });
  assert.deepEqual(lim.push('defgh'), { out: 'de', done: 'length' });
  assert.deepEqual(lim.push('more'), { out: '', done: 'length' });
  assert.equal(lim.seen(), 'abcdefgh', 'what the provider sent is kept for the record');
});

// ---- in the engine --------------------------------------------------------------------------------------------------------------------------

async function boot() {
  const site = await startFakeDeepSeek();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-lim-'));
  fs.writeFileSync(path.join(dir, 'deepseek_session.json'), JSON.stringify({ token: TOKEN, cookies: [{ name: 'ds_standin', value: 'cookie-value-1234' }], linkedAt: new Date().toISOString(), expired: false }), { mode: 0o600 });
  const bus = new EventEmitter();
  const config = createConfig({ dataDir: dir });
  const provider = createDeepSeekProvider({ dataDir: dir, config, bus, base: site.base, pace: FAST, log: () => {}, sessions: false });
  const srv = createServer({ config, registry: createRegistry({ providers: [provider], bus }), port: 0 });
  const { port } = await srv.start();
  const key = config.createApiKey('t').key;
  return {
    site, state: site.state,
    chat: (body) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: 'deepseek-chat', ...body }) }),
    async chunks(res) { return (await res.text()).split('\n\n').map((b) => (b.split('\n').find((l) => l.startsWith('data: ')) || '').slice(6)).filter((e) => e && e !== '[DONE]').map((e) => JSON.parse(e)); },
    async close() { await srv.stop(); await site.close(); await cleanupDir(dir); }
  };
}

test('max_tokens and stop cut a plain answer, and say why in finish_reason; the usage counts what was delivered', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'The quick brown fox jumps over the lazy dog. STOP here and then some more words.';
    const length = await (await t.chat({ max_tokens: 5, messages: [user('go')] })).json();
    assert.equal(length.choices[0].message.content, 'The quick brown fox ');
    assert.equal(length.choices[0].finish_reason, 'length');
    assert.equal(length.usage.completion_tokens, 5);
    const stop = await (await t.chat({ stop: ['STOP'], messages: [user('go')] })).json();
    assert.equal(stop.choices[0].message.content, 'The quick brown fox jumps over the lazy dog. ');
    assert.equal(stop.choices[0].finish_reason, 'stop');
    const none = await (await t.chat({ messages: [user('go')] })).json();
    assert.match(none.choices[0].message.content, /some more words\.$/);
  } finally { await t.close(); }
});

test('streaming: the stop string split over the stand-in\'s 9-character pieces is found, and what was held back is sent when nothing is found', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'Alpha beta gamma <<<END>>> delta epsilon';
    const events = await t.chunks(await t.chat({ stream: true, stop: ['<<<END>>>'], messages: [user('go')] }));
    assert.equal(events.map((e) => (e.choices[0] && e.choices[0].delta.content) || '').join(''), 'Alpha beta gamma ');
    assert.equal(events.filter((e) => e.choices[0] && e.choices[0].finish_reason).map((e) => e.choices[0].finish_reason).join(), 'stop');
    t.state.reply = () => 'Nothing to stop at but <<<EN looks like it.';
    const plain = await t.chunks(await t.chat({ stream: true, stop: ['<<<END>>>'], messages: [user('go')] }));
    assert.equal(plain.map((e) => (e.choices[0] && e.choices[0].delta.content) || '').join(''), 'Nothing to stop at but <<<EN looks like it.');
  } finally { await t.close(); }
});

test('streaming: once max_tokens is reached the provider is told to stop, the stream ends with length at once, and the next request is not kept waiting', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'word '.repeat(10000); // about ten seconds of streaming, if it were let run
    const started = Date.now();
    const events = await t.chunks(await t.chat({ stream: true, max_tokens: 10, messages: [user('go')] }));
    assert.equal(events.map((e) => (e.choices[0] && e.choices[0].delta.content) || '').join(''), 'word '.repeat(8), '10 tokens are 40 characters');
    assert.equal(events.filter((e) => e.choices[0] && e.choices[0].finish_reason).map((e) => e.choices[0].finish_reason).join(), 'length');
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
    t.state.reply = () => 'ok';
    const next = Date.now();
    assert.equal((await t.chat({ messages: [user('again')] })).status, 200);
    assert.ok(Date.now() - next < 3000);
  } finally { await t.close(); }
});

test('a request with tools is never cut, and the header says its max_tokens and stop were ignored', async () => {
  const t = await boot();
  try {
    t.state.reply = () => 'A long answer that would be cut at three tokens if cuts were made. END more.';
    const res = await t.chat({ tools: WEATHER, max_tokens: 3, stop: ['END'], messages: [user('go')] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-ula-ignored'), 'max_tokens, stop');
    assert.match((await res.json()).choices[0].message.content, /END more\.$/);
    const plain = await t.chat({ max_tokens: 3, messages: [user('go')] });
    assert.equal(plain.headers.get('x-ula-ignored'), null, 'honoured for a plain chat: nothing to say');
    const none = await t.chat({ tools: WEATHER, tool_choice: 'none', max_tokens: 3, messages: [user('go')] });
    assert.equal((await none.json()).choices[0].finish_reason, 'length', 'tool_choice none is a plain chat');
  } finally { await t.close(); }
});
