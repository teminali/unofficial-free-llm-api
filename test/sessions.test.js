'use strict';

/**
 * The parts of sessions that need no provider: how a message is recognised again (bridge.js fingerprints), what a continuation prompt holds, and the store that
 * decides which chat a request continues (src/sessions.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/bridge');
const { createSessionStore, commonPrefix } = require('../src/sessions');

const user = (content) => ({ role: 'user', content });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];

// ---- recognising a message ------------------------------------------------------------------------------------------------------------------

// waits for a condition up to a ceiling, so a busy machine slows a test down but cannot fail it
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 5)); return fn(); };
const settle = () => new Promise((r) => setTimeout(r, 15)); // for "nothing more happened": a short pause after what was waited for

test('a message is the same message whatever the call ids, the order of the keys in its arguments and the spaces around its words', () => {
  const a = { role: 'assistant', content: '  Looking. ', tool_calls: [call('call_1', 'read', '{"b":1,"a":{"y":2,"x":1}}')] };
  const b = { role: 'assistant', content: 'Looking.', tool_calls: [call('call_9', 'read', { a: { x: 1, y: 2 }, b: 1 })] };
  assert.equal(B.fingerprint(a), B.fingerprint(b));
  assert.equal(B.fingerprint({ role: 'function', content: 'ok' }), B.fingerprint({ role: 'tool', content: 'ok' }), 'the old name of the tool role is the same role');
});

test('a message is another message when its role, its words or the meaning of its call differ', () => {
  const base = { role: 'assistant', content: 'Looking.', tool_calls: [call('c', 'read', { path: 'a.txt' })] };
  const seen = new Set([B.fingerprint(base)]);
  for (const other of [
    { ...base, role: 'user' },
    { ...base, content: 'Looking!' },
    { ...base, tool_calls: [call('c', 'read', { path: 'b.txt' })] },
    { ...base, tool_calls: [call('c', 'write', { path: 'a.txt' })] },
    { ...base, tool_calls: [] }
  ]) assert.ok(!seen.has(B.fingerprint(other)), JSON.stringify(other));
});

test('the conversation of a request: one hash for all the system text and one for each other message, in order', () => {
  const a = B.conversationFingerprints([{ role: 'system', content: 'S1' }, user('q'), { role: 'assistant', content: 'a' }]);
  assert.equal(a.talk.length, 2);
  assert.notEqual(a.system, B.conversationFingerprints([{ role: 'system', content: 'S2' }, user('q')]).system);
  const sameSystemTwoMessages = B.conversationFingerprints([{ role: 'system', content: 'S' }, { role: 'system', content: 'T' }, user('q')]);
  assert.equal(sameSystemTwoMessages.system, B.conversationFingerprints([{ role: 'system', content: 'S\n\nT' }, user('q')]).system);
  assert.equal(B.conversationFingerprints([user('q')]).talk[0], a.talk[0]);
});

test('the tools of a request are the same tools in any order and with their keys in any order, and other tools otherwise', () => {
  const t1 = { type: 'function', function: { name: 'a', description: 'd', parameters: { type: 'object', properties: { x: {}, y: {} } } } };
  const t2 = { type: 'function', function: { name: 'b', description: 'd', parameters: { type: 'object' } } };
  assert.equal(B.toolsKey([t1, t2]), B.toolsKey([t2, { type: 'function', function: { parameters: { properties: { y: {}, x: {} }, type: 'object' }, description: 'd', name: 'a' } }]));
  assert.notEqual(B.toolsKey([t1]), B.toolsKey([t1, t2]));
  assert.notEqual(B.toolsKey([t1]), B.toolsKey([{ ...t1, function: { ...t1.function, description: 'changed' } }]));
  assert.equal(B.toolsKey([]), B.toolsKey(undefined));
});

// ---- what a continued chat is told --------------------------------------------------------------------------------------------------------

test('a continuation of a plain chat sends the new question as it is, and nothing the chat already holds', () => {
  const messages = [{ role: 'system', content: 'Be brief.' }, user('first'), { role: 'assistant', content: 'one' }, user('second')];
  assert.equal(B.buildPrompt(messages, [], { continuation: { from: 2 } }), 'second');
  assert.match(B.buildPrompt(messages, [], {}), /Be brief\./, 'the first message of a chat still carries the system text');
});

test('a continuation with tools writes the new tool results by the name of the call they answer, with no bridge unless asked, and always the closing line', () => {
  const messages = [user('weather?'), { role: 'assistant', content: '', tool_calls: [call('c1', 'get_weather', { city: 'Dar' })] }, { role: 'tool', tool_call_id: 'c1', content: '31 C, sunny' }];
  const plain = B.buildPrompt(messages, TOOLS, { continuation: { from: 2 } });
  assert.match(plain, /^TOOL RESULT \(get_weather\):\n31 C, sunny/);
  assert.ok(!/USER:|# Tool bridge/.test(plain), 'nothing from before, and no protocol the chat has been given');
  assert.match(plain, /The tool result above is real/, 'the closing line says what to do now');
  assert.match(B.buildPrompt(messages, TOOLS, { continuation: { from: 2, refreshBridge: true } }), /# Tool bridge/, 'the protocol can be said again');
});

// ---- the store ------------------------------------------------------------------------------------------------------------------------------

function store(extra = {}) {
  let t = 1000;
  const closed = [];
  const persisted = [];
  const s = createSessionStore({ close: async (r) => { closed.push(r.id); }, persist: (ids) => persisted.push(ids), now: () => t, options: { closeGapMs: 1, ...extra } });
  return { s, closed, persisted, advance: (ms) => { t += ms; } };
}
const KEY = 'deepseek-chat||';

test('commonPrefix counts the first entries two lists share', () => {
  assert.equal(commonPrefix(['a', 'b', 'c'], ['a', 'b', 'x']), 2);
  assert.equal(commonPrefix([], ['a']), 0);
  assert.equal(commonPrefix(['a'], ['a']), 1);
});

test('a request that adds messages to a conversation the chat holds continues it; the first request of a conversation does not', () => {
  const { s } = store();
  assert.equal(s.match({ key: KEY, hashes: ['sys', 'u1'] }).reason, 'new');
  const first = s.commit({ key: KEY, hashes: ['sys', 'u1', 'a1'], remote: { id: 'chat-1' } });
  const hit = s.match({ key: KEY, hashes: ['sys', 'u1', 'a1', 'u2'] });
  assert.equal(hit.session, first);
  assert.equal(hit.from, 2, 'the chat holds two messages of the request already');
  s.commit({ session: hit.session, key: KEY, hashes: ['sys', 'u1', 'a1', 'u2', 'a2'], remote: { id: 'chat-1', lastId: 4 }, chars: 50 });
  assert.equal(s.size(), 1, 'a continued chat is one session, not two');
  assert.equal(s.list()[0].turns, 2);
});

test('nothing that is not a clean continuation is continued: a changed, dropped or repeated message, other tools or another system prompt', () => {
  const { s } = store();
  s.commit({ key: KEY, hashes: ['sys', 'u1', 'a1', 'u2', 'a2'], remote: { id: 'chat-1' } });
  const no = (hashes, key = KEY) => assert.equal(s.match({ key, hashes }).session, null, JSON.stringify([hashes, key]));
  no(['sys', 'u1', 'EDITED', 'u2', 'a2', 'u3']);       // an earlier message was changed
  no(['sys', 'a1', 'u2', 'a2', 'u3']);                 // the first message was dropped
  no(['sys', 'u1', 'a1', 'u2']);                       // the request is shorter: the person went back (a regeneration)
  no(['sys', 'u1', 'a1', 'u2', 'a2']);                 // the same request again: nothing new to say
  no(['OTHER', 'u1', 'a1', 'u2', 'a2', 'u3']);         // another system prompt
  no(['sys', 'u1', 'a1', 'u2', 'a2', 'u3'], 'deepseek-reasoner||'); // another model
  no(['sys', 'u1', 'a1', 'u2', 'a2', 'u3'], 'deepseek-chat||tools'); // other tools
  assert.equal(s.stats.diverged >= 3, true, 'the changed ones are counted as changed, not as new');
});

test('of two open chats the one that holds the longest part of the conversation is continued', () => {
  const { s } = store();
  s.commit({ key: KEY, hashes: ['sys', 'u1', 'a1'], remote: { id: 'short' } });
  s.commit({ key: KEY, hashes: ['sys', 'u1', 'a1', 'u2', 'a2'], remote: { id: 'long' } });
  assert.equal(s.match({ key: KEY, hashes: ['sys', 'u1', 'a1', 'u2', 'a2', 'u3'] }).session.remote.id, 'long');
});

test('a name given by the caller keeps its conversations apart, and a new chat under a name replaces the one that was there', () => {
  const { s, closed } = store();
  s.commit({ key: KEY, tag: 'a', hashes: ['sys', 'u1', 'a1'], remote: { id: 'chat-a' } });
  s.commit({ key: KEY, tag: 'b', hashes: ['sys', 'u1', 'a1'], remote: { id: 'chat-b' } });
  assert.equal(s.match({ key: KEY, tag: 'a', hashes: ['sys', 'u1', 'a1', 'u2'] }).session.remote.id, 'chat-a');
  assert.equal(s.match({ key: KEY, tag: 'b', hashes: ['sys', 'u1', 'a1', 'u2'] }).session.remote.id, 'chat-b');
  assert.equal(s.match({ key: KEY, hashes: ['sys', 'u1', 'a1', 'u2'] }).session, null, 'a request with no name does not borrow a named chat');
  const { s: t, closed: closedT } = store();
  t.commit({ key: KEY, tag: 'a', hashes: ['sys', 'u1', 'a1'], remote: { id: 'old' } });
  t.commit({ key: KEY, tag: 'a', hashes: ['sys', 'x1', 'y1'], remote: { id: 'new' } });
  assert.equal(t.size(), 1);
  return new Promise((resolve) => setTimeout(() => { assert.deepEqual(closedT, ['old']); assert.deepEqual(closed, []); resolve(); }, 20));
});

test('a chat that is being used is not continued twice, and not closed under the request that is using it', () => {
  const { s, advance } = store({ ttlMs: 100 });
  s.commit({ key: KEY, hashes: ['sys', 'u1', 'a1'], remote: { id: 'chat-1' } });
  const hit = s.match({ key: KEY, hashes: ['sys', 'u1', 'a1', 'u2'] });
  assert.ok(hit.session);
  assert.equal(s.match({ key: KEY, hashes: ['sys', 'u1', 'a1', 'u2'] }).session, null, 'busy');
  advance(150);
  s.sweep();
  assert.equal(s.size(), 1, 'a session in use is not idle');
  advance(100);
  s.sweep();
  assert.equal(s.size(), 0, 'one that never came back is ended in the end');
});

test('an idle session is closed after its time, a long one is not continued, and the oldest makes room for a new one', async () => {
  const { s, closed, advance } = store({ ttlMs: 1000, maxSessions: 2, maxChars: 100, maxTurns: 3 });
  s.commit({ key: KEY, hashes: ['sys', 'a', 'x'], remote: { id: 'c1' } });
  advance(10);
  s.commit({ key: KEY, hashes: ['sys', 'b', 'x'], remote: { id: 'c2' } });
  advance(10);
  s.commit({ key: KEY, hashes: ['sys', 'c', 'x'], remote: { id: 'c3' } });
  await until(() => closed.length >= 1);
  await settle();
  assert.deepEqual(closed, ['c1'], 'the one used longest ago made room');
  advance(2000);
  s.sweep();
  await until(() => closed.length >= 3);
  await settle();
  assert.deepEqual(closed.sort(), ['c1', 'c2', 'c3']);
  const full = store({ maxChars: 100 });
  full.s.commit({ key: KEY, hashes: ['sys', 'u1', 'a1'], remote: { id: 'big' }, chars: 500 });
  assert.equal(full.s.match({ key: KEY, hashes: ['sys', 'u1', 'a1', 'u2'] }).reason, 'full');
});

test('turning the continuing on again by hand clears the switch-off and the count of failures', () => {
  const { s } = store();
  const open = () => { s.commit({ key: KEY, hashes: ['sys', 'u'], remote: { id: 'c' } }); return s.match({ key: KEY, hashes: ['sys', 'u', 'v'] }).session; };
  s.drop(open(), { general: true });
  s.drop(open(), { general: true });
  assert.match(s.disabledReason(), /twice in a row/);
  s.reset();
  assert.equal(s.disabledReason(), null);
  assert.equal(s.match({ key: KEY, hashes: ['sys', 'u'] }).reason, 'new', 'matching works again');
  s.drop(open(), { general: true });
  assert.equal(s.disabledReason(), null, 'one failure after the reset is the first, not the second');
});

test('two failures to continue in a row switch the continuing off; a success in between starts the count again', () => {
  const { s } = store();
  const open = () => { s.commit({ key: KEY, hashes: ['sys', 'u'], remote: { id: 'c' } }); return s.match({ key: KEY, hashes: ['sys', 'u', 'v'] }).session; };
  s.drop(open(), { general: true });
  s.worked();
  s.drop(open(), { general: true });
  assert.equal(s.disabledReason(), null, 'a success between the two');
  s.drop(open(), { general: true });
  assert.match(s.disabledReason(), /twice in a row/);
  assert.equal(s.match({ key: KEY, hashes: ['sys', 'u', 'v'] }).reason, 'off');
});

test('a refusal or a sign-in problem is not a failure to continue: it ends the session but never switches the continuing off', () => {
  const { s } = store();
  for (let i = 0; i < 4; i += 1) {
    s.commit({ key: KEY, hashes: ['sys', 'u'], remote: { id: `c${i}` } });
    s.drop(s.match({ key: KEY, hashes: ['sys', 'u', 'v'] }).session, { general: false });
  }
  assert.equal(s.disabledReason(), null);
});

test('the ids of the open chats are written down on every change, and a chat the provider would not remove now is written down again', async () => {
  const { s, persisted } = store();
  s.commit({ key: KEY, hashes: ['sys', 'u1', 'a1'], remote: { id: 'c1' } });
  assert.deepEqual(persisted.at(-1), ['c1']);
  const resting = createSessionStore({ close: async () => ({ retryAfterMs: 60000 }), persist: (ids) => persisted.push(ids), options: { closeGapMs: 1 } });
  resting.commit({ key: KEY, hashes: ['sys', 'u1', 'a1'], remote: { id: 'rest-1' } });
  await resting.closeAll(200);
  assert.deepEqual(persisted.at(-1), ['rest-1'], 'left for the next start');
  const done = createSessionStore({ close: async () => {}, persist: (ids) => persisted.push(ids) });
  done.commit({ key: KEY, hashes: ['sys', 'u1', 'a1'], remote: { id: 'gone' } });
  await done.closeAll(200);
  assert.deepEqual(persisted.at(-1), []);
});

test('chats a killed run left behind are removed, one after the other, and a closing that is told "later" is asked again later', async () => {
  const asked = [];
  let ready = false;
  const s = createSessionStore({ close: async (r) => { asked.push(r.id); return ready ? undefined : { retryAfterMs: 5 }; }, options: { closeGapMs: 1 } });
  s.adopt(['old-1', 'old-2']);
  assert.ok(await until(() => asked.filter((id) => id === 'old-1').length > 1), 'asked again');
  assert.ok(!asked.includes('old-2'), 'the second waits behind the first');
  ready = true;
  assert.ok(await until(() => asked.includes('old-2')), 'the second is asked once the first is done');
});
