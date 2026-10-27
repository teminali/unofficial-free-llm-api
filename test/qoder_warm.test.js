/**
 * Qoder chats that stay open: one CLI process carries a conversation, a follow-up goes in as one new message, a caller who leaves ends the turn without leaving
 * the CLI running, a dead process is replaced, an old CLI falls back to one process per request, and at most three chats are held. The stand-in is
 * test/fixtures/fake_qoder_cli.js, which speaks `--input-format stream-json` and logs every run, turn, stdin body and interrupt.
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
const { createQoderProvider } = require('../src/providers/qoder');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake_qoder_cli.js');
const PAT = 'qdr_pat_test_1234567890abcdef';
const MODELS = [
  { name: 'Qwen3.7-Max', key: 'qmodel_preview' },
  { name: 'GLM-5.2', key: 'gm51model' }
];
const MODEL = 'qoder-qwen3-7-max';
const OTHER_MODEL = 'qoder-glm-5-2';

async function boot(state = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-qdw-'));
  const statePath = path.join(dir, 'fake-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ pat: PAT, models: MODELS, ...state }, null, 2));
  const wrapper = path.join(dir, 'qoder');
  fs.writeFileSync(wrapper, `#!/usr/bin/env node\nprocess.env.FAKE_QODER_STATE = ${JSON.stringify(statePath)};\nrequire(${JSON.stringify(FIXTURE)});\n`, { mode: 0o755 });
  const logs = [];
  const config = createConfig({ dataDir: dir });
  const provider = createQoderProvider({ dataDir: dir, config, log: (line) => logs.push(line), cliPath: wrapper });
  await provider.linkToken({ token: PAT, consentAcknowledged: true });
  const server = createServer({ config, registry: createRegistry({ providers: [provider], bus: new EventEmitter() }), port: 0 });
  const info = await server.start();
  const apiKey = config.createApiKey('test key').key;

  const send = async (messages, extra = {}) => {
    const res = await fetch(`${info.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, ...extra })
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };
  const reply = (sent) => sent.data.choices[0].message.content;
  const events = () => {
    try {
      return fs.readFileSync(`${statePath}.events`, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (_) { return []; }
  };
  const runs = () => events().filter((entry) => entry.event === 'run');
  const chats = () => runs().filter((entry) => entry.args.includes('--print'));
  const oneShot = () => chats().filter((entry) => !entry.args.includes('--input-format'));
  const turns = () => events().filter((entry) => entry.event === 'turn');
  const interrupts = () => events().filter((entry) => entry.event === 'interrupt');

  return {
    dir, provider, config, base: info.url, apiKey, logs, send, reply, events, runs, chats, oneShot, turns, interrupts,
    async close() { await server.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

const picture = (label) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(label).toString('base64')}` } });
const pictureBlock = (label) => `i:image/png:${Buffer.byteLength(label)}`;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const waitFor = async (check, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};
const argAfter = (run, flag) => {
  const at = run.args.indexOf(flag);
  return at >= 0 ? run.args[at + 1] : undefined;
};

test('a follow-up reuses the same process and sends only the messages the chat does not hold', async () => {
  const ui = await boot({ answers: ['first answer', 'second answer'] });
  try {
    const first = await ui.send([{ role: 'user', content: 'first question' }]);
    assert.equal(first.res.status, 200);
    assert.equal(ui.reply(first), 'first answer');

    const second = await ui.send([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: ui.reply(first) },
      { role: 'user', content: 'second question' }
    ]);
    assert.equal(second.res.status, 200);
    assert.equal(ui.reply(second), 'second answer');

    // One process for both turns, and it was opened for a chat that stays:
    const chats = ui.chats();
    assert.equal(chats.length, 1);
    assert.equal(argAfter(chats[0], '--input-format'), 'stream-json');
    assert.equal(argAfter(chats[0], '--output-format'), 'stream-json');
    assert.equal(chats[0].args.includes('--no-session-persistence'), true);
    assert.equal(chats[0].args.includes('--tools'), true);

    // The second turn carried the new question only: not the system text, not the first question, not the first answer.
    const turns = ui.turns();
    assert.equal(turns.length, 2);
    assert.equal(turns[0].text, 'first question');
    assert.equal(turns[1].text, 'second question');

    const info = ui.provider.engine.sessionInfo();
    assert.equal(info.open, 1);
    assert.equal(info.continued, 1);
    assert.equal(info.enabled, true);
  } finally { await ui.close(); }
});

test('a conversation whose earlier messages changed starts a new process with the whole transcript', async () => {
  const ui = await boot({ answers: ['first answer', 'second answer'] });
  try {
    const first = await ui.send([{ role: 'user', content: 'first question' }]);
    // The caller's copy of the answer is not the one the chat gave: the chat cannot be carried on from there.
    const second = await ui.send([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'a different first answer' },
      { role: 'user', content: 'second question' }
    ]);
    assert.equal(second.res.status, 200);
    const chats = ui.chats();
    assert.equal(chats.length, 2);
    // The second process starts a chat, so its first prompt is the whole conversation.
    const turns = ui.turns().filter((entry) => entry.pid === chats[1].pid);
    assert.equal(turns.length, 1);
    assert.match(turns[0].text, /first question/);
    assert.match(turns[0].text, /a different first answer/);
    assert.match(turns[0].text, /second question/);
    assert.equal(ui.provider.engine.sessionInfo().diverged, 1);
    assert.equal(ui.reply(first), 'first answer');
  } finally { await ui.close(); }
});

test('another model or another effort never continues the chat', async () => {
  const ui = await boot({ answers: ['one', 'two', 'three'] });
  try {
    const first = await ui.send([{ role: 'user', content: 'hi' }], { reasoning_effort: 'none' });
    assert.equal(first.res.status, 200);
    assert.equal(argAfter(ui.chats()[0], '--thinking'), 'disabled');

    const history = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: ui.reply(first) },
      { role: 'user', content: 'again' }
    ];
    const effort = await ui.send(history, { reasoning_effort: 'high' });
    assert.equal(effort.res.status, 200);
    assert.equal(argAfter(ui.chats()[1], '--reasoning-effort'), 'high');

    const model = await ui.send(history, { model: OTHER_MODEL, reasoning_effort: 'none' });
    assert.equal(model.res.status, 200);
    assert.equal(argAfter(ui.chats()[2], '--model'), 'gm51model');
    assert.equal(ui.chats().length, 3);
    assert.equal(ui.provider.engine.sessionInfo().open, 3);
  } finally { await ui.close(); }
});

test('sessions switched off mean one process per request, with the whole conversation on stdin', async () => {
  const ui = await boot({ answers: ['first answer', 'second answer'] });
  try {
    await ui.provider.setSettings({ sessions: false });
    const first = await ui.send([{ role: 'user', content: 'first question' }]);
    const second = await ui.send([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: ui.reply(first) },
      { role: 'user', content: 'second question' }
    ]);
    assert.equal(second.res.status, 200);
    const shots = ui.oneShot();
    assert.equal(shots.length, 2);
    assert.equal(ui.chats().length, 2);
    assert.equal(ui.turns().length, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(ui.dir, 'fake-state.json'), 'utf8'));
    const stdin = saved.runs.filter((run) => run.args.includes('--print')).map((run) => run.stdin);
    assert.equal(stdin[0], 'first question');
    assert.match(stdin[1], /first question/);
    assert.match(stdin[1], /second question/);
    assert.equal(ui.provider.engine.sessionInfo().enabled, false);
  } finally { await ui.close(); }
});

test('a caller who leaves ends the turn with an interrupt and the process does not linger', async () => {
  const parts = Array.from({ length: 80 }, (_, i) => ({ text: `${i} ` }));
  const ui = await boot({ streams: [parts], partDelayMs: 30 });
  try {
    const controller = new AbortController();
    const res = await fetch(`${ui.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ui.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'count' }], stream: true }),
      signal: controller.signal
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    await reader.read(); // the role chunk
    const chunk = await reader.read();
    assert.ok(chunk.value && chunk.value.length > 0, 'no content arrived before the caller left');
    controller.abort();

    assert.equal(await waitFor(() => ui.interrupts().length === 1), true, 'the CLI was never told to interrupt');
    const pid = ui.chats()[0].pid;
    assert.equal(await waitFor(() => !alive(pid), 8000), true, 'the interrupted process was left running');

    const next = await ui.send([{ role: 'user', content: 'hello again' }]);
    assert.equal(next.res.status, 200);
    assert.equal(ui.chats().length, 2);
  } finally { await ui.close(); }
});

test('a CLI that does not know --input-format falls back to one prompt per request', async () => {
  const ui = await boot({ refuseInputStream: true });
  try {
    const first = await ui.send([{ role: 'user', content: 'first question' }]);
    assert.equal(first.res.status, 200);
    assert.equal(ui.reply(first), 'Hello from Qoder.');
    const second = await ui.send([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: ui.reply(first) },
      { role: 'user', content: 'second question' }
    ]);
    assert.equal(second.res.status, 200);
    assert.equal(ui.reply(second), 'Hello from Qoder.');

    // The warm flags were tried once, refused, and are not tried again.
    assert.equal(ui.chats().filter((run) => run.args.includes('--input-format')).length, 1);
    assert.equal(ui.oneShot().length, 2);
    const saved = JSON.parse(fs.readFileSync(path.join(ui.dir, 'fake-state.json'), 'utf8'));
    const stdin = saved.runs.filter((run) => run.args.includes('--print') && !run.args.includes('--input-format')).map((run) => run.stdin);
    assert.equal(stdin[0], 'first question');
    assert.match(stdin[1], /second question/);
  } finally { await ui.close(); }
});

test('a process that dies mid-answer is replaced and the conversation survives', async () => {
  const ui = await boot({
    answer: 'Hello from Qoder.',
    streams: [{ text: 'Hello from Qoder.' }],
    dieAfterParts: 1,
    dieAfterPartsOnTurn: 2
  });
  try {
    const first = await ui.send([{ role: 'user', content: 'first question' }]);
    assert.equal(first.res.status, 200);
    const second = await ui.send([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: ui.reply(first) },
      { role: 'user', content: 'second question' }
    ]);
    assert.equal(second.res.status, 200);
    assert.equal(ui.reply(second), 'Hello from Qoder.');
    const chats = ui.chats();
    assert.equal(chats.length, 2);
    const died = chats[0].pid;
    assert.equal(await waitFor(() => !alive(died)), true);
    // The replacement was given the whole conversation, not the one new message.
    const turns = ui.turns().filter((entry) => entry.pid === chats[1].pid);
    assert.equal(turns.length, 1);
    assert.match(turns[0].text, /first question/);
    assert.match(turns[0].text, /second question/);
  } finally { await ui.close(); }
});

test('ending a chat ends its process', async () => {
  const ui = await boot();
  try {
    await ui.send([{ role: 'user', content: 'hi' }]);
    const [session] = ui.provider.engine.sessionList();
    assert.ok(session, 'no chat was kept');
    const pid = ui.chats()[0].pid;
    assert.equal(alive(pid), true);
    assert.equal(ui.provider.engine.endSession(session.id), true);
    assert.equal(await waitFor(() => !alive(pid)), true, 'the process of a closed chat was left running');
  } finally { await ui.close(); }
});

test('at most three chats stay open, and the one used longest ago goes', async () => {
  const ui = await boot();
  try {
    for (const question of ['one', 'two', 'three', 'four']) {
      const sent = await ui.send([{ role: 'user', content: question }]);
      assert.equal(sent.res.status, 200);
    }
    assert.equal(ui.chats().length, 4);
    assert.equal(ui.provider.engine.sessionInfo().open, 3);
    const pids = ui.chats().map((run) => run.pid);
    assert.equal(await waitFor(() => pids.filter(alive).length === 3), true, 'the closed chat kept its process running');
  } finally { await ui.close(); }
});

test('a warm answer streams thinking and text as the CLI sends them', async () => {
  const ui = await boot({ streams: [[{ think: 'Add' }, { think: ' two.' }, { text: 'Four.' }]] });
  try {
    const res = await fetch(`${ui.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ui.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: '2+2?' }], stream: true })
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"reasoning_content":"Add"/);
    assert.match(text, /"reasoning_content":" two\."/);
    assert.match(text, /"content":"Four\."/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally { await ui.close(); }
});

test('a follow-up in a kept chat sends only its own new picture, as a block where it was put', async () => {
  const ui = await boot({ answers: ['a login page', 'the second one is darker'] });
  try {
    const firstAsk = { role: 'user', content: [{ type: 'text', text: 'what is this' }, picture('first shot')] };
    const first = await ui.send([firstAsk]);
    assert.equal(first.res.status, 200);
    const second = await ui.send([
      firstAsk,
      { role: 'assistant', content: ui.reply(first) },
      { role: 'user', content: [{ type: 'text', text: 'and this one' }, picture('second shot')] }
    ]);
    assert.equal(second.res.status, 200);
    assert.equal(ui.chats().length, 1, 'one process for both turns');
    const turns = ui.turns();
    assert.deepEqual(turns[0].blocks, ['t', pictureBlock('first shot')]);
    assert.deepEqual(turns[1].blocks, ['t', pictureBlock('second shot')], 'the chat already holds the first picture');
    assert.match(turns[1].text, /and this one\n\[attached image 2\]/, 'the numbers mean the same pictures as in the first turn');
  } finally { await ui.close(); }
});

test('with sessions off a picture still goes as a block, in a one-message stream-json run', async () => {
  const ui = await boot();
  try {
    await ui.provider.setSettings({ sessions: false });
    const sent = await ui.send([{ role: 'user', content: [{ type: 'text', text: 'what is this' }, picture('a shot')] }]);
    assert.equal(sent.res.status, 200);
    assert.equal(ui.reply(sent), 'Hello from Qoder.');
    const runs = ui.chats();
    assert.equal(runs.length, 1);
    assert.equal(argAfter(runs[0], '--input-format'), 'stream-json');
    assert.deepEqual(ui.turns().find((entry) => entry.pid === runs[0].pid).blocks, ['t', pictureBlock('a shot')]);
    assert.equal(ui.provider.engine.sessionInfo().open, 0, 'nothing was kept');
  } finally { await ui.close(); }
});

test('a CLI that does not know --input-format is sent the words, and the prompt says the picture did not go', async () => {
  const ui = await boot({ refuseInputStream: true });
  try {
    const sent = await ui.send([{ role: 'user', content: [{ type: 'text', text: 'what is this' }, picture('a shot')] }]);
    assert.equal(sent.res.status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(ui.dir, 'fake-state.json'), 'utf8'));
    const plain = saved.runs.filter((run) => run.args.includes('--print') && !run.args.includes('--input-format'));
    assert.equal(plain.length, 1);
    assert.match(plain[0].stdin, /what is this\n\[attached image 1\]/);
    assert.match(plain[0].stdin, /this Qoder CLI cannot take pictures\. Those pictures are NOT visible to you/);
  } finally { await ui.close(); }
});
