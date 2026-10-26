/**
 * Qoder through the official CLI: linking with a personal access token, the flags a completion carries, the text tool bridge, the stream, and every refusal
 * the CLI can give. The stand-in is test/fixtures/fake_qoder_cli.js, a script that behaves like the real CLI and records each run in a JSON file.
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
const { parseModelList, cleanKey, effortArgs, childEnv } = require('../src/providers/qoder/cli');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake_qoder_cli.js');
const PAT = 'qdr_pat_test_1234567890abcdef';
const OTHER_PAT = 'qdr_pat_a_different_one_999999';
const MODELS = [
  { name: 'Qwen3.7-Max', key: 'qmodel_preview' },
  { name: 'Kimi K3', key: 'kmodel_latest' },
  { name: 'GLM-5.2', key: 'gm51model' },
  { name: 'Qoder Auto', system: true }
];
const READ_TOOL = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file from the project.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The wrapper sets the state file the fixture reads, so each boot has its own CLI state without touching the test's own environment. */
function writeWrapper(dir, statePath) {
  const wrapper = path.join(dir, 'qoder');
  fs.writeFileSync(wrapper, `#!/usr/bin/env node\nprocess.env.FAKE_QODER_STATE = ${JSON.stringify(statePath)};\nrequire(${JSON.stringify(FIXTURE)});\n`, { mode: 0o755 });
  return wrapper;
}

async function boot({ link = true, token = PAT, state = {}, cli = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-qd-'));
  const statePath = path.join(dir, 'fake-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ pat: PAT, models: MODELS, ...state }, null, 2));
  const wrapper = writeWrapper(dir, statePath);
  const cliPath = cli ? wrapper : path.join(dir, 'missing-qoder');
  const logs = [];
  const log = (line) => logs.push(line);
  const config = createConfig({ dataDir: dir });
  const provider = createQoderProvider({ dataDir: dir, config, log, cliPath });
  const linked = link ? await provider.linkToken({ token, consentAcknowledged: true }) : null;
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

  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const setState = (patch) => {
    const now = readState();
    fs.writeFileSync(statePath, JSON.stringify({ ...now, ...patch }, null, 2));
  };
  const runs = () => readState().runs || [];
  const chatRuns = () => runs().filter((run) => run.args.includes('--print'));
  const listRuns = () => runs().filter((run) => run.args.includes('--list-models'));

  return {
    dir, wrapper, statePath, logs, config, provider, server, base: info.url, apiKey, linked,
    post, send: (body) => post('/v1/chat/completions', body),
    readState, setState, runs, chatRuns, listRuns,
    async close() { await server.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

const argAfter = (run, flag) => {
  const at = run.args.indexOf(flag);
  return at >= 0 ? run.args[at + 1] : undefined;
};

test('a personal access token links the account through the CLI: models, refs, a 0600 token file, and no desktop variables', async () => {
  const hadEntrypoint = process.env.QODER_AGENT_SDK_ENTRYPOINT;
  process.env.QODER_AGENT_SDK_ENTRYPOINT = '/a/desktop/sdk/entry.js';
  const ui = await boot();
  try {
    assert.equal(ui.linked.ok, true);
    const ids = ['qoder-qwen3-7-max', 'qoder-kimi-k3', 'qoder-glm-5-2', 'qoder-qoder-auto'];
    assert.deepEqual(ui.provider.models().map((m) => m.id), ids);
    assert.deepEqual(ui.provider.models().map((m) => m.ref), ['qmodel_preview', 'kmodel_latest', 'gm51model', 'Qoder Auto']);
    for (const model of ui.provider.models()) {
      assert.equal(model.reasoning, true);
      assert.equal(model.thinking, false);
      assert.equal(model.escalate, false);
      assert.equal(model.supportsVision, false);
      assert.equal(model.context_length, 128000);
      assert.deepEqual(model.efforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    }

    // The list call was the CLI's own: one run, the token only in the environment, a private config folder inside the data folder.
    const lists = ui.listRuns();
    assert.equal(lists.length, 1);
    assert.deepEqual(lists[0].args, ['--list-models', '--config-dir', path.join(ui.dir, 'qoder-cli')]);
    // macOS reports /var as /private/var from the child's working folder.
    assert.equal(lists[0].cwd, fs.realpathSync(path.join(ui.dir, 'qoder-cli')));
    assert.equal(lists[0].pat, PAT);
    assert.equal(lists[0].sdkEntrypoint, null);
    assert.equal(lists[0].args.join(' ').includes(PAT), false);
    assert.equal(fs.statSync(path.join(ui.dir, 'qoder-cli')).mode & 0o777, 0o700);

    // The saved login is the token and the models: nothing from an exchange is stored, because the CLI does that itself.
    const file = path.join(ui.dir, 'qoder_key.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.pat, PAT);
    assert.equal(saved.token, undefined);
    assert.equal(saved.accessToken, undefined);
    assert.equal(saved.refreshToken, undefined);
    assert.equal(saved.models.length, 4);
    assert.equal(saved.expired, false);

    const status = await ui.provider.status();
    assert.equal(status.linked, true);
    assert.equal(status.expired, false);
    assert.equal(status.cli.found, true);
    assert.equal(status.cli.path, ui.wrapper);
    assert.match(status.keyPlaceholder, /personal access token/);
    assert.match(status.keyHint, /qoder\.com\/account\/integrations/);

    // What an OpenAI client sees: the prefixed id, reasoning, and the working context size.
    const listed = await (await fetch(`${ui.base}/v1/models`, { headers: { authorization: `Bearer ${ui.apiKey}` } })).json();
    const model = listed.data.find((m) => m.id === 'qoder-qwen3-7-max');
    assert.equal(model.owned_by, 'qoder');
    assert.equal(model.reasoning, true);
    assert.equal(model.context_length, 128000);
  } finally {
    await ui.close();
    if (hadEntrypoint === undefined) delete process.env.QODER_AGENT_SDK_ENTRYPOINT;
    else process.env.QODER_AGENT_SDK_ENTRYPOINT = hadEntrypoint;
  }
});

test('a plain question is one message on stdin, answered as one string', async () => {
  const ui = await boot();
  try {
    const { res, data } = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.equal(data.choices[0].message.content, 'Hello from Qoder.');
    assert.equal(data.choices[0].finish_reason, 'stop');
    assert.equal(typeof data.usage.total_tokens, 'number');

    const chats = ui.chatRuns();
    assert.equal(chats.length, 1);
    assert.equal(chats[0].stdin, 'hi');
    assert.equal(argAfter(chats[0], '--model'), 'qmodel_preview');
    assert.equal(argAfter(chats[0], '--tools'), '');
    assert.equal(argAfter(chats[0], '--output-format'), 'stream-json');
    assert.equal(chats[0].args.includes('--include-partial-messages'), true);
    assert.equal(chats[0].args.includes('--no-session-persistence'), true);
    assert.equal(argAfter(chats[0], '--max-model-request-retries'), '0');
    assert.equal(chats[0].args.includes('--reasoning-effort'), false);
    assert.equal(chats[0].args.includes('--thinking'), false);
  } finally { await ui.close(); }
});

test('reasoning effort is the CLI\'s own flag: high, minimal, none, and none at all', async () => {
  const ui = await boot();
  try {
    const high = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' });
    assert.equal(high.res.status, 200);
    assert.equal(argAfter(ui.chatRuns()[0], '--reasoning-effort'), 'high');
    assert.equal(ui.chatRuns()[0].args.includes('--thinking'), false);
    assert.equal(high.res.headers.get('x-ula-ignored'), null);

    const minimal = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'minimal' });
    assert.equal(minimal.res.status, 200);
    assert.equal(argAfter(ui.chatRuns()[1], '--reasoning-effort'), 'low');

    const none = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'none' });
    assert.equal(none.res.status, 200);
    assert.equal(argAfter(ui.chatRuns()[2], '--thinking'), 'disabled');

    const plain = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(plain.res.status, 200);
    assert.equal(ui.chatRuns()[3].args.includes('--reasoning-effort'), false);
    assert.equal(ui.chatRuns()[3].args.includes('--thinking'), false);
  } finally { await ui.close(); }
});

test('a streaming answer sends reasoning_content and content as chunks', async () => {
  const ui = await boot({ state: { stream: [{ think: 'Add' }, { think: ' two.' }, { text: 'Four.' }] } });
  try {
    const res = await fetch(`${ui.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ui.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: '2+2?' }], stream: true })
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"reasoning_content":"Add"/);
    assert.match(text, /"reasoning_content":" two\."/);
    assert.match(text, /"content":"Four\."/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally { await ui.close(); }
});

test('tools are a text bridge: the call goes in the prompt and comes back as a tool call', async () => {
  const call = '<tool_call>{"name":"read","arguments":{"path":"a.txt"}}</tool_call>';
  const ui = await boot({ state: { answer: call, stream: [{ text: call }] } });
  try {
    const { res, data } = await ui.send({
      model: 'qoder-qwen3-7-max',
      messages: [{ role: 'user', content: 'read a.txt' }],
      tools: [READ_TOOL]
    });
    assert.equal(res.status, 200);
    const message = data.choices[0].message;
    assert.equal(message.content, null);
    assert.equal(message.tool_calls.length, 1);
    assert.equal(message.tool_calls[0].function.name, 'read');
    // The bridge normalizes a `path` argument to `filePath` for every provider (src/bridge.js parseArgs).
    const args = JSON.parse(message.tool_calls[0].function.arguments);
    assert.equal(args.path, 'a.txt');
    assert.equal(args.filePath, 'a.txt');
    assert.equal(data.choices[0].finish_reason, 'tool_calls');

    const prompt = ui.chatRuns()[0].stdin;
    assert.match(prompt, /# Tool bridge/);
    assert.match(prompt, /### read/);
    assert.match(prompt, /read a\.txt/);
    assert.match(prompt, /<tool_call>\{"name":"TOOL_NAME"/);
  } finally { await ui.close(); }
});

test('a picture is left out in words because the CLI lane cannot carry one', async () => {
  const ui = await boot();
  try {
    const { res } = await ui.send({
      model: 'qoder-qwen3-7-max',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: PNG } }] }]
    });
    assert.equal(res.status, 200);
    const prompt = ui.chatRuns()[0].stdin;
    assert.match(prompt, /what is this/);
    assert.match(prompt, /\[image omitted by the bridge\]/);
    assert.equal(prompt.includes('data:image'), false);
  } finally { await ui.close(); }
});

test('temperature is reported as ignored and never becomes a flag', async () => {
  const ui = await boot();
  try {
    const { res } = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'hi' }], temperature: 0.4, top_p: 0.9 });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-ula-ignored'), 'temperature, top_p');
    assert.equal(ui.chatRuns()[0].args.includes('0.4'), false);
  } finally { await ui.close(); }
});

test('a refused token ends the account with 401, and the next request is model_not_found without a CLI run', async () => {
  const ui = await boot();
  try {
    ui.setState({ chatError: 'auth' });
    const first = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(first.res.status, 401);
    assert.equal(first.data.error.code, 'qoder_session_expired');
    assert.match(first.data.error.message, /refused this personal access token/);
    assert.equal(ui.chatRuns().length, 1);

    const state = await ui.provider.status();
    assert.equal(state.expired, true);
    assert.equal(state.models.length, 0);
    assert.match(state.expiredReason, /refused/);

    // With no models left, the caller is told the model is unknown rather than being sent to an account that already refused the token.
    const second = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'again' }] });
    assert.equal(second.res.status, 404);
    assert.equal(second.data.error.code, 'model_not_found');
    assert.equal(ui.chatRuns().length, 1);
  } finally { await ui.close(); }
});

test('a rate limit pauses Qoder and the queued request is answered without another run', async () => {
  const ui = await boot();
  try {
    ui.setState({ chatError: 'rate' });
    const first = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(first.res.status, 429);
    assert.equal(first.data.error.code, 'qoder_rate_limited');
    assert.equal(Number(first.res.headers.get('retry-after')) > 0, true);

    const state = await ui.provider.status();
    assert.equal(state.usage.isCooldown, true);
    assert.match(state.usage.cooldownReason, /refused requests/);

    const second = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'again' }] });
    assert.equal(second.res.status, 429);
    assert.equal(second.data.error.code, 'qoder_cooldown');
    assert.equal(ui.chatRuns().length, 1);
  } finally { await ui.close(); }
});

test('a result envelope that refuses the token also ends the account with 401', async () => {
  const ui = await boot();
  try {
    ui.setState({ chatError: 'result-auth' });
    const { res, data } = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 401);
    assert.equal(data.error.code, 'qoder_session_expired');
    assert.equal((await ui.provider.status()).expired, true);
  } finally { await ui.close(); }
});

test('a stop at the model output limit is a length finish', async () => {
  const ui = await boot({ state: { chatError: 'result-truncated' } });
  try {
    const { res, data } = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'write a lot' }] });
    assert.equal(res.status, 200);
    assert.equal(data.choices[0].finish_reason, 'length');
    assert.equal(data.choices[0].message.content, 'Hello from Qoder.');
  } finally { await ui.close(); }
});

test('a CLI without partial messages is asked again without that flag', async () => {
  const ui = await boot();
  try {
    ui.setState({ refusePartial: true });
    const { res, data } = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.equal(data.choices[0].message.content, 'Hello from Qoder.');
    const chats = ui.chatRuns();
    assert.equal(chats.length, 2);
    assert.equal(chats[0].args.includes('--include-partial-messages'), true);
    assert.equal(chats[1].args.includes('--include-partial-messages'), false);
    assert.equal(argAfter(chats[1], '--output-format'), 'stream-json');
  } finally { await ui.close(); }
});

test('a CLI that refuses stream-json is asked again for the plain envelope', async () => {
  const ui = await boot();
  try {
    ui.setState({ refuseStreamJson: true });
    const { res, data } = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.equal(data.choices[0].message.content, 'Hello from Qoder.');
    const chats = ui.chatRuns();
    assert.equal(chats.length, 2);
    assert.equal(argAfter(chats[0], '--output-format'), 'stream-json');
    assert.equal(argAfter(chats[1], '--output-format'), 'json');
    assert.equal(chats[1].args.includes('--include-partial-messages'), false);
  } finally { await ui.close(); }
});

test('linking refuses a bad shape, a missing consent, a rejected token, a missing CLI, an empty list, a network failure and a refusal', async () => {
  const ui = await boot({ link: false });
  try {
    const badShape = await ui.provider.linkToken({ token: 'short', consentAcknowledged: true });
    assert.equal(badShape.ok, false);
    assert.match(badShape.error, /personal access token/);

    const noConsent = await ui.provider.linkToken({ token: PAT });
    assert.equal(noConsent.ok, false);
    assert.match(noConsent.error, /Confirm/);

    ui.setState({ pat: OTHER_PAT });
    const refused = await ui.provider.linkToken({ token: PAT, consentAcknowledged: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /refused this personal access token/);
    ui.setState({ pat: PAT });

    ui.setState({ listError: 'refused' });
    const permission = await ui.provider.linkToken({ token: PAT, consentAcknowledged: true });
    assert.equal(permission.ok, false);
    assert.match(permission.error, /permission denied/);

    ui.setState({ listError: 'empty' });
    const empty = await ui.provider.linkToken({ token: PAT, consentAcknowledged: true });
    assert.equal(empty.ok, false);
    assert.match(empty.error, /returned no models/);

    ui.setState({ listError: 'network' });
    const network = await ui.provider.linkToken({ token: PAT, consentAcknowledged: true });
    assert.equal(network.ok, false);
    assert.match(network.error, /could not be reached/);

    const missing = createQoderProvider({
      dataDir: ui.dir,
      config: ui.config,
      log: () => {},
      cliPath: path.join(ui.dir, 'missing-qoder')
    });
    const notInstalled = await missing.linkToken({ token: PAT, consentAcknowledged: true });
    assert.equal(notInstalled.ok, false);
    assert.match(notInstalled.error, /not installed/);
    assert.match(notInstalled.error, /npm install -g @qoder-ai\/qodercli/);
    await missing.stop();

    assert.equal(fs.existsSync(path.join(ui.dir, 'qoder_key.json')), false);
    assert.equal((await ui.provider.status()).linked, false);
  } finally { await ui.close(); }
});

test('refreshing the model list is throttled unless forced', async () => {
  const ui = await boot();
  try {
    assert.equal(await ui.provider.refreshModels(), true);
    assert.equal(ui.listRuns().length, 1); // the list from linking is still young

    ui.setState({ models: [MODELS[0], MODELS[2]] });
    assert.equal(await ui.provider.refreshModels({ force: true }), true);
    assert.equal(ui.listRuns().length, 2);
    assert.deepEqual(ui.provider.models().map((m) => m.id), ['qoder-qwen3-7-max', 'qoder-glm-5-2']);

    assert.equal(await ui.provider.refreshModels(), true);
    assert.equal(ui.listRuns().length, 2);
  } finally { await ui.close(); }
});

test('the token never appears in a log, the state page, or the command line', async () => {
  const ui = await boot();
  try {
    const { res } = await ui.send({ model: 'qoder-qwen3-7-max', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);

    const chat = ui.chatRuns()[0];
    assert.equal(chat.pat, PAT);
    assert.equal(chat.args.join(' ').includes(PAT), false);
    assert.equal(chat.stdin.includes(PAT), false);

    assert.equal(ui.logs.some((line) => line.includes(PAT)), false);
    assert.equal(JSON.stringify(await ui.provider.status()).includes(PAT), false);

    const page = await (await fetch(`${ui.base}/_/state`, { headers: { authorization: `Bearer ${ui.config.adminToken()}` } })).text();
    assert.equal(page.includes(PAT), false);
  } finally { await ui.close(); }
});

test('unlinking removes the token and the CLI folder', async () => {
  const ui = await boot();
  try {
    assert.equal(fs.existsSync(path.join(ui.dir, 'qoder_key.json')), true);
    assert.equal(fs.existsSync(path.join(ui.dir, 'qoder-cli')), true);

    await ui.provider.unlink();
    assert.equal(fs.existsSync(path.join(ui.dir, 'qoder_key.json')), false);
    assert.equal(fs.existsSync(path.join(ui.dir, 'qoder-cli')), false);
    assert.deepEqual(ui.provider.models(), []);
    assert.equal((await ui.provider.status()).linked, false);
  } finally { await ui.close(); }
});

test('parseModelList keeps a usable key and falls back to the name', () => {
  const rows = parseModelList([
    'MODEL',
    'Qwen3.7-Max (qmodel_preview)',
    'Qoder Auto',
    'A Truncated Name (abcdefghijklmnopqrstuvwxyz0123456789…)',
    'Too Long (abcdefghijklmnopqrstuvwxyz0123456789abcdefgh)',
    'Qwen3.7-Max (qmodel_preview)',
    'Failed to fetch model list: nope'
  ].join('\n'));
  assert.deepEqual(rows, [
    { name: 'Qwen3.7-Max', key: 'qmodel_preview', ref: 'qmodel_preview' },
    { name: 'Qoder Auto', key: null, ref: 'Qoder Auto' },
    { name: 'A Truncated Name', key: null, ref: 'A Truncated Name' },
    { name: 'Too Long', key: null, ref: 'Too Long' }
  ]);
});

test('cleanKey and effortArgs keep the token and the effort to the shapes the CLI knows', () => {
  assert.equal(cleanKey(` ${PAT} `), PAT);
  assert.equal(cleanKey('short'), null);
  assert.equal(cleanKey('a'.repeat(16)), 'a'.repeat(16));
  assert.equal(cleanKey('a'.repeat(4097)), null);
  assert.equal(cleanKey(null), null);

  assert.deepEqual(effortArgs(false, undefined), []);
  assert.deepEqual(effortArgs(true, undefined), ['--thinking', 'enabled']);
  assert.deepEqual(effortArgs(true, 'none'), ['--thinking', 'disabled']);
  assert.deepEqual(effortArgs(false, 'high'), ['--reasoning-effort', 'high']);
  assert.deepEqual(effortArgs(false, 'xhigh'), ['--reasoning-effort', 'xhigh']);
  assert.deepEqual(effortArgs(false, 'minimal'), []);
});

test('childEnv scrubs the desktop and other agent variables and keeps only this token', () => {
  const saved = {};
  const set = (key, value) => { saved[key] = process.env[key]; process.env[key] = value; };
  set('QODER_AGENT_SDK_ENTRYPOINT', '/desktop/entry.js');
  set('QODERCN_REGION', 'cn');
  set('CLAUDE_CODE_ENTRYPOINT', 'cli');
  set('CLAUDECODE', '1');
  set('GEMINI_YOLO', '1');
  try {
    const env = childEnv(PAT);
    assert.equal(env.QODER_PERSONAL_ACCESS_TOKEN, PAT);
    assert.equal(env.QODER_AGENT_SDK_ENTRYPOINT, undefined);
    assert.equal(env.QODERCN_REGION, undefined);
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.GEMINI_YOLO, undefined);
    assert.equal(env.NO_COLOR, '1');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
