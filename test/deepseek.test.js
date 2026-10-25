'use strict';

/**
 * The DeepSeek provider against a local copy of the site's endpoints (test/fixtures/fake_deepseek.js) that really checks the token, the cookie and the proof-of-work,
 * with a real headless Chrome for the link flow. No DeepSeek account is involved and nothing here ever reaches deepseek.com: the address is only replaceable
 * with ULA_TEST_MODE=1 and a loopback URL.
 */

process.env.ULA_TEST_MODE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { createConfig } = require('../src/config');
const { cleanupDir } = require('./fixtures/cleanup');
const { createRegistry } = require('../src/registry');
const { createServer } = require('../src/server');
const { DEEPSEEK_PACE } = require('../src/governor');
const { chromeExecutable } = require('../src/providers/chrome');
const { createDeepSeekProvider } = require('../src/providers/deepseek');
const { resolveBase, DEFAULT_BASE } = require('../src/providers/deepseek/base');
const { startFakeDeepSeek, TOKEN, COOKIE } = require('./fixtures/fake_deepseek');
const { classifyError } = require('../src/providers/deepseek/web');
const { createDeepSeekWeb } = require('../src/providers/deepseek/web');
const { checkLogin } = require('../src/providers/deepseek/account');

const FAST = { perMinute: 1000, minGapMs: 1, cooldownMs: DEEPSEEK_PACE.cooldownMs, smooth: true };
const user = (text) => ({ role: 'user', content: text });
const WEATHER = [{ type: 'function', function: { name: 'get_weather', description: 'Current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
const skipChrome = chromeExecutable() ? false : 'Chrome is not installed';
// A windowed Chrome needs a display; a Linux computer with none (a server, CI without xvfb-run) skips the tests that open a window.
const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const skipWindow = skipChrome || (noDisplay ? 'a windowed Chrome needs a display (run under xvfb-run)' : false);

// `sessions` is off here: these tests are about one request on one chat, the way every request ran before sessions (test/deepseek_sessions.test.js is about sessions).
// The Chrome that checks the sign-in is told what to be: hidden by default here (these tests are about everything but that window), or an ordinary window kept out of the way.
const HIDDEN = ['--headless=new'];
const OUT_OF_THE_WAY = ['--window-position=-4000,-4000', '--window-size=400,300'];

async function boot({ link = 'session', pace = FAST, sessions = false, driven = HIDDEN, site: siteState = {} } = {}) {
  const site = await startFakeDeepSeek();
  Object.assign(site.state, siteState);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-ds-'));
  const bus = new EventEmitter();
  const logs = [];
  const config = createConfig({ dataDir: dir });
  const provider = createDeepSeekProvider({ dataDir: dir, config, bus, base: site.base, pace: pace === 'default' ? undefined : pace, log: (l) => logs.push(l), plainChromeArgs: ['--headless=new'], drivenChromeArgs: driven, sessions });
  const srv = createServer({ config, registry: createRegistry({ providers: [provider], bus }), port: 0 });
  const { port } = await srv.start();
  const key = config.createApiKey('t').key;
  const t = {
    site, dir, provider, srv, key, config, logs, base: `http://127.0.0.1:${port}`,
    chat: (body) => fetch(`${t.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) }),
    async close() { await srv.stop(); await site.close(); await cleanupDir(dir); }
  };
  if (link === 'session') {
    // a saved login, as a link would have written it
    fs.writeFileSync(path.join(dir, 'deepseek_session.json'), JSON.stringify({ token: TOKEN, cookies: [{ name: 'ds_standin', value: 'cookie-value-1234' }], linkedAt: new Date().toISOString(), expired: false }), { mode: 0o600 });
  }
  return t;
}

test('the address of DeepSeek can only be replaced in test mode and only by a loopback address', () => {
  assert.equal(resolveBase('http://127.0.0.1:9999'), 'http://127.0.0.1:9999');
  assert.equal(resolveBase('https://evil.example'), DEFAULT_BASE);
  assert.equal(resolveBase('http://localhost:9999'), DEFAULT_BASE);
  assert.equal(resolveBase('http://127.0.0.1.evil.example:9999'), DEFAULT_BASE);
  assert.equal(resolveBase(undefined), 'https://chat.deepseek.com');
  const before = process.env.ULA_TEST_MODE;
  process.env.ULA_TEST_MODE = '';
  assert.equal(resolveBase('http://127.0.0.1:9999'), DEFAULT_BASE, 'outside test mode the request is ignored');
  process.env.ULA_TEST_MODE = before;
});

test('the default pace is the gentle one: one at a time, 4 s apart, 10 a minute, a 20 minute rest', async () => {
  const t = await boot({ pace: 'default' });
  try {
    const stats = t.provider.governor.getStats();
    assert.equal(stats.minGapMs, 4000);
    assert.equal(stats.perMinute, 10);
    assert.equal(t.provider.governor.refusalCooldownMs, 20 * 60 * 1000);
    assert.equal(stats.dailyCap, 300);
  } finally { await t.close(); }
});

// ---- linking ---------------------------------------------------------------------------------------------------------------------------------

test('linking through Chrome reads the session token and the cookies (HttpOnly ones too) from the profile that was signed in on', { skip: skipChrome, timeout: 90000 }, async () => {
  const t = await boot({ link: 'none' });
  try {
    assert.equal((await t.provider.startLink({ consentAcknowledged: false })).ok, false, 'no consent, no link');
    assert.equal((await t.provider.startLink({ consentAcknowledged: true })).ok, true);
    assert.equal((await t.provider.status()).linking, true);
    const done = await t.provider.finishLink({});
    assert.deepEqual({ ok: done.ok, linked: done.linked }, { ok: true, linked: true });
    const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'deepseek_session.json'), 'utf8'));
    assert.equal(saved.token, TOKEN);
    assert.ok(saved.cookies.some((c) => c.name === 'ds_standin' && c.value === 'cookie-value-1234'), 'the HttpOnly cookie was read');
    assert.equal(fs.statSync(path.join(t.dir, 'deepseek_session.json')).mode & 0o777, 0o600);
    const status = await t.provider.status();
    assert.deepEqual([status.linked, status.expired, status.linking], [true, false, false]);
    assert.deepEqual(status.models.map((m) => m.id), ['deepseek-chat', 'deepseek-reasoner', 'deepseek-auto']);
    // the account is told apart by a masked label, and the address never appears whole
    for (let i = 0; i < 40 && !(await t.provider.status()).accountLabel; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await t.provider.status()).accountLabel, 'o***@example.com');
    assert.ok(!fs.readFileSync(path.join(t.dir, 'deepseek_session.json'), 'utf8').includes('owner@example.com'));
    assert.ok(!t.logs.join('\n').includes('owner@example.com'));
  } finally { await t.provider.stop(); await t.close(); }
});

test('the real site refuses a hidden Chrome, so the check that reads the sign-in runs in an ordinary window, and the session it keeps has the WAF token', { skip: skipWindow, timeout: 90000 }, async () => {
  const t = await boot({ link: 'none', driven: OUT_OF_THE_WAY, site: { blockHeadless: true } });
  try {
    assert.equal((await t.provider.startLink({ consentAcknowledged: true })).ok, true);
    const done = await t.provider.finishLink({});
    assert.deepEqual({ ok: done.ok, linked: done.linked }, { ok: true, linked: true }, JSON.stringify(done));
    // (the sign-in Chrome of these tests is hidden by the test's own choice and loads the page first; the check is the last load)
    assert.equal(t.site.state.pageLoads.at(-1).hidden, false, 'the check was an ordinary window, not a hidden Chrome');
    const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'deepseek_session.json'), 'utf8'));
    assert.ok(saved.cookies.some((c) => c.name === 'aws-waf-token'), 'the WAF token the site hands an ordinary window is kept: API calls need it');
  } finally { await t.provider.stop(); await t.close(); }
});

test('the WAF token is waited for: the site issues it a moment after the page loaded, and the session keeps it', { skip: skipWindow, timeout: 90000 }, async () => {
  const t = await boot({ link: 'none', driven: OUT_OF_THE_WAY, site: { wafDelayMs: 1500 } });
  try {
    assert.equal((await t.provider.startLink({ consentAcknowledged: true })).ok, true);
    assert.equal((await t.provider.finishLink({})).linked, true);
    const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'deepseek_session.json'), 'utf8'));
    assert.ok(saved.cookies.some((c) => c.name === 'aws-waf-token' && c.value === 'waf-late'), 'the late cookie was read');
  } finally { await t.provider.stop(); await t.close(); }
});

test('when the site blocks the Chrome that checks the sign-in, the person is told that, not that the sign-in page is showing; the link stays open', { skip: skipChrome, timeout: 90000 }, async () => {
  const t = await boot({ link: 'none', driven: HIDDEN, site: { blockHeadless: true } });
  try {
    assert.equal((await t.provider.startLink({ consentAcknowledged: true })).ok, true);
    const done = await t.provider.finishLink({});
    assert.equal(done.ok, false);
    assert.equal(done.blocked, true);
    assert.equal(done.notSignedIn, undefined, 'a block is not "not signed in"');
    assert.match(done.note, /refused/i);
    assert.ok(!/sign-in page/i.test(done.note));
    assert.equal((await t.provider.status()).linking, true, 'Done can be pressed again');
    assert.ok(t.logs.some((l) => /check saw .*request could not be satisfied/i.test(l)), 'what the check saw is in the log: ' + t.logs.slice(-4).join(' | '));
    assert.equal(fs.existsSync(path.join(t.dir, 'deepseek_session.json')), false);
    assert.equal((await t.provider.finishLink({ cancel: true })).cancelled, true);
  } finally { await t.provider.stop(); await t.close(); }
});

test('when Chrome does not let the site save data, the person is told that and where to change it, not that the sign-in page is showing', { skip: skipChrome, timeout: 90000 }, async () => {
  const t = await boot({ link: 'none', driven: HIDDEN, site: { blockStorage: true } });
  try {
    assert.equal((await t.provider.startLink({ consentAcknowledged: true })).ok, true);
    const done = await t.provider.finishLink({});
    assert.equal(done.ok, false);
    assert.equal(done.storageBlocked, true);
    assert.equal(done.notSignedIn, true, 'the page shows the note the way it shows a sign-in that has not finished');
    assert.match(done.note, /chrome:\/\/settings\/content\/siteData/);
    assert.match(done.note, /save data/i);
    assert.ok(!/sign-in page/i.test(done.note));
    assert.equal((await t.provider.status()).linking, true, 'the link stays open');
    assert.ok(t.logs.some((l) => /check saw .*localStorage -1 entries/.test(l)), t.logs.slice(-4).join(' | '));
    assert.equal((await t.provider.finishLink({ cancel: true })).cancelled, true);
  } finally { await t.provider.stop(); await t.close(); }
});

test('pressing Done before signing in keeps the link open and says so', { skip: skipChrome, timeout: 90000 }, async () => {
  const t = await boot({ link: 'none' });
  try {
    t.site.state.signedIn = false;
    await t.provider.startLink({ consentAcknowledged: true });
    const early = await t.provider.finishLink({});
    assert.equal(early.ok, false);
    assert.equal(early.notSignedIn, true);
    assert.equal((await t.provider.status()).linked, false);
    assert.equal((await t.provider.status()).linking, true);
    assert.equal(fs.existsSync(path.join(t.dir, 'deepseek_session.json')), false, 'an anonymous visitor (ds_session_id) is never taken for a login');
    assert.equal((await t.provider.finishLink({ cancel: true })).cancelled, true);
    assert.equal((await t.provider.status()).linking, false);
  } finally { await t.provider.stop(); await t.close(); }
});

test('a pasted token is checked with DeepSeek before it is kept; the JSON form of it is understood', async () => {
  const t = await boot({ link: 'none' });
  try {
    assert.equal((await t.provider.linkToken({ token: TOKEN, consentAcknowledged: false })).ok, false);
    assert.match((await t.provider.linkToken({ token: 'short', consentAcknowledged: true })).error, /does not look like/);
    assert.match((await t.provider.linkToken({ token: 'x'.repeat(40), consentAcknowledged: true })).error, /did not accept/);
    assert.equal(fs.existsSync(path.join(t.dir, 'deepseek_session.json')), false);
    const ok = await t.provider.linkToken({ token: JSON.stringify({ value: TOKEN, __version: '0' }), consentAcknowledged: true });
    assert.equal(ok.ok, true);
    const status = await t.provider.status();
    assert.equal(status.linked, true);
    assert.equal(status.manual, true);
    assert.equal(status.accountLabel, 'o***@example.com');
    const res = await t.chat({ model: 'deepseek-chat', messages: [user('hi')] });
    assert.equal(res.status, 200, 'a pasted token with no cookies works with the stand-in');
  } finally { await t.close(); }
});

test('unlinking deletes the session and the Chrome profile', { skip: skipChrome, timeout: 90000 }, async () => {
  const t = await boot({ link: 'none' });
  try {
    await t.provider.startLink({ consentAcknowledged: true });
    assert.ok(fs.existsSync(path.join(t.dir, 'deepseek-chrome')));
    await t.provider.finishLink({});
    await t.provider.unlink();
    assert.equal(fs.existsSync(path.join(t.dir, 'deepseek_session.json')), false);
    assert.equal(fs.existsSync(path.join(t.dir, 'deepseek-chrome')), false);
    assert.equal((await t.provider.status()).linked, false);
    assert.equal((await t.chat({ model: 'deepseek-chat', messages: [user('hi')] })).status, 404);
  } finally { await t.provider.stop(); await t.close(); }
});

// ---- chat ------------------------------------------------------------------------------------------------------------------------------------

test('chat: the question goes as it is, with a valid proof-of-work and the saved cookie; the chat session is deleted afterwards', async () => {
  const t = await boot();
  try {
    t.site.state.reply = (prompt) => `You asked: ${prompt}`;
    const res = await t.chat({ model: 'deepseek-chat', messages: [user('What is 3 + 4?')] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, 'You asked: What is 3 + 4?');
    const sent = (await (await fetch(`${t.site.base}/state`)).json());
    assert.equal(sent.powFailures, 0, 'the site accepted the proof-of-work');
    assert.equal(sent.completions.length, 1);
    assert.equal(sent.completions[0].thinking, false);
    assert.equal(sent.completions[0].search, false, 'web search is never switched on');
    assert.match(sent.completions[0].cookie, /ds_standin=cookie-value-1234/);
    assert.match(sent.completions[0].ua, /Chrome\//);
    assert.equal(sent.completions[0].promptHead, 'What is 3 + 4?');
    for (let i = 0; i < 40 && !sent.deleted?.length; i += 1) { await new Promise((r) => setTimeout(r, 25)); Object.assign(sent, await (await fetch(`${t.site.base}/state`)).json()); }
    assert.deepEqual(sent.deleted, sent.created, 'the chat this request opened was deleted, and nothing else');
  } finally { await t.close(); }
});

test('chat: deepseek-reasoner turns DeepThink on and returns the thinking apart from the answer; streaming does too', async () => {
  const t = await boot();
  try {
    t.site.state.reply = (_p, { thinking }) => ({ text: 'Forty-two.', thinking: thinking ? 'Let me work it out carefully.' : '' });
    const whole = await (await t.chat({ model: 'deepseek-reasoner', messages: [user('meaning of life?')] })).json();
    assert.equal(whole.choices[0].message.content, 'Forty-two.');
    assert.equal(whole.choices[0].message.reasoning_content, 'Let me work it out carefully.');
    const events = (await (await t.chat({ model: 'deepseek-reasoner', stream: true, messages: [user('again')] })).text()).split('\n\n').map((b) => (b.split('\n').find((l) => l.startsWith('data: ')) || '').slice(6)).filter((e) => e && e !== '[DONE]').map((e) => JSON.parse(e));
    assert.equal(events.map((e) => e.choices[0].delta.reasoning_content || '').join(''), 'Let me work it out carefully.');
    assert.equal(events.map((e) => e.choices[0].delta.content || '').join(''), 'Forty-two.');
    const sent = (await (await fetch(`${t.site.base}/state`)).json()).completions;
    assert.deepEqual(sent.map((c) => c.thinking), [true, true]);
  } finally { await t.close(); }
});

test('chat: a tool call in the bridge format, and one in DeepSeek\'s own markup, both come back as tool_calls', async () => {
  const t = await boot();
  try {
    t.site.state.reply = () => 'Looking.\n<tool_call>{"name":"get_weather","arguments":{"city":"Dar es Salaam"}}</tool_call>';
    const tag = await (await t.chat({ model: 'deepseek-chat', tools: WEATHER, messages: [user('Weather?')] })).json();
    assert.deepEqual(JSON.parse(tag.choices[0].message.tool_calls[0].function.arguments), { city: 'Dar es Salaam' });
    t.site.state.reply = () => '<｜｜DSML｜｜calls><｜｜DSML｜｜invoke name="get_weather"><｜｜DSML｜｜parameter name="city" string="true">Arusha</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜calls>';
    const dsml = await (await t.chat({ model: 'deepseek-chat', tools: WEATHER, messages: [user('Weather?')] })).json();
    assert.equal(dsml.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(JSON.parse(dsml.choices[0].message.tool_calls[0].function.arguments), { city: 'Arusha' });
    const head = (await (await fetch(`${t.site.base}/state`)).json()).completions[0].promptHead;
    assert.match(head, /Tool bridge/);
  } finally { await t.close(); }
});

test('chat: a plain request about tool markup is just text, with no retry spent', async () => {
  const t = await boot();
  try {
    const text = 'Wrap each call in <tool_call> and </tool_call>, or in <｜｜DSML｜｜calls> blocks.';
    t.site.state.reply = () => text;
    const body = await (await t.chat({ model: 'deepseek-chat', messages: [user('how do tool calls look?')] })).json();
    assert.equal(body.choices[0].message.content, text);
    assert.equal((await (await fetch(`${t.site.base}/state`)).json()).completions.length, 1);
  } finally { await t.close(); }
});

test('chat: a call cut off in the middle of a long file is asked for once more with a note to keep it shorter', async () => {
  const t = await boot();
  try {
    const WRITE = [{ type: 'function', function: { name: 'write', description: 'Write a file', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } }, required: ['filePath', 'content'] } } }];
    let n = 0;
    t.site.state.reply = () => { n += 1; return n === 1 ? '<｜｜DSML｜｜calls>\n<｜｜DSML｜｜invoke name="write">\n<｜｜DSML｜｜parameter name="filePath" string="true">a.css</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="content" string="true">body { margin: 0;' : '<tool_call>{"name":"write","arguments":{"filePath":"a.css","content":"body{margin:0}"}}</tool_call>'; };
    const body = await (await t.chat({ model: 'deepseek-chat', tools: WRITE, messages: [user('Write a.css')] })).json();
    assert.equal(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments).content, 'body{margin:0}');
    const sent = (await (await fetch(`${t.site.base}/state`)).json()).completions;
    assert.equal(sent.length, 2);
  } finally { await t.close(); }
});

test('chat: deepseek-auto hands one hard question to DeepThink, shows the thought, and builds from the answer', async () => {
  const t = await boot();
  try {
    t.site.state.reply = (prompt, { thinking }) => {
      if (thinking) return { text: 'PLAN-FROM-DEEPTHINK: use a grid.', thinking: 'weighing layouts' };
      if (/TOOL RESULT \(think\)/.test(prompt)) return 'Built from: PLAN-FROM-DEEPTHINK';
      return '<tool_call>{"name":"think","arguments":{"question":"How should the page be laid out?"}}</tool_call>';
    };
    const events = (await (await t.chat({ model: 'deepseek-auto', stream: true, tools: WEATHER, messages: [user('Design me a page')] })).text()).split('\n\n').map((b) => (b.split('\n').find((l) => l.startsWith('data: ')) || '').slice(6)).filter((e) => e && e !== '[DONE]').map((e) => JSON.parse(e));
    assert.equal(events.map((e) => e.choices[0].delta.content || '').join(''), 'Built from: PLAN-FROM-DEEPTHINK');
    assert.equal(events.map((e) => e.choices[0].delta.reasoning_content || '').join(''), 'weighing layouts');
    assert.equal(events.flatMap((e) => e.choices[0].delta.tool_calls || []).length, 0, 'the think step is never shown to the client');
    const sent = (await (await fetch(`${t.site.base}/state`)).json()).completions;
    assert.deepEqual(sent.map((c) => c.thinking), [false, true, false]);
    assert.ok(!/Tool bridge/.test(sent[1].promptHead), 'DeepThink is asked a question, not given the tool protocol');
  } finally { await t.close(); }
});

// ---- the account's own refusals ---------------------------------------------------------------------------------------------------------------

test('a mute is read from DeepSeek\'s answer, said with its date, and every later request is answered locally', async () => {
  const t = await boot({ pace: 'default' });
  try {
    t.site.state.muted = true;
    const first = await t.chat({ model: 'deepseek-chat', messages: [user('hi')] });
    assert.equal(first.status, 429);
    const err = (await first.json()).error;
    assert.equal(err.code, 'deepseek_muted');
    assert.match(err.message, /muted this account/);
    assert.match(err.message, /until /);
    assert.ok(Number(first.headers.get('retry-after')) > 60 * 3600, 'Retry-After is the length of the mute (72 hours)');
    assert.equal(t.srv.notices[0].kind, 'muted');
    const stats = t.provider.governor.getStats();
    assert.equal(stats.isCooldown, true);
    const second = await t.chat({ model: 'deepseek-chat', messages: [user('hi again')] });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error.code, 'deepseek_cooldown');
    assert.equal((await (await fetch(`${t.site.base}/state`)).json()).completions.length, 1, 'nothing more was sent to a muted account');
    // a cooldown outlives a restart: the usage file keeps it
    const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'usage-deepseek.json'), 'utf8'));
    assert.ok(saved.cooldownUntil > Date.now() + 60 * 3600 * 1000);
  } finally { await t.close(); }
});

test('"Messages too frequent" is one 429 and a 20 minute rest, with no retry', async () => {
  const t = await boot({ pace: 'default' });
  try {
    t.site.state.notice = 'limit';
    const res = await t.chat({ model: 'deepseek-chat', messages: [user('hi')] });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, 'deepseek_rate_limited');
    const retry = Number(res.headers.get('retry-after'));
    assert.ok(retry > 19 * 60 && retry <= 20 * 60, `retry-after ${retry}`);
    assert.equal((await (await fetch(`${t.site.base}/state`)).json()).completions.length, 1);
  } finally { await t.close(); }
});

test('a token DeepSeek refuses is a 401 that says so, the login is marked expired and offers no models', async () => {
  const t = await boot();
  try {
    t.site.state.authFail = true;
    const res = await t.chat({ model: 'deepseek-chat', messages: [user('hi')] });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'deepseek_session_expired');
    assert.equal((await t.provider.status()).expired, true);
    assert.deepEqual(t.provider.models(), []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'deepseek_session.json'), 'utf8')).expired, true);
    assert.equal((await t.chat({ model: 'deepseek-chat', messages: [user('again')] })).status, 404, 'an expired account offers no models');
  } finally { await t.close(); }
});

test('nothing sensitive is logged: no prompt, answer, token or cookie', async () => {
  const t = await boot();
  try {
    t.site.state.reply = () => 'ANSWER-SECRET-4e1';
    await t.chat({ model: 'deepseek-chat', messages: [user('PROMPT-SECRET-91c')] });
    t.site.state.authFail = true;
    await t.chat({ model: 'deepseek-chat', messages: [user('PROMPT-SECRET-91c')] });
    const seen = JSON.stringify({ logs: t.logs, requests: t.srv.requests, notices: t.srv.notices });
    for (const secret of ['PROMPT-SECRET', 'ANSWER-SECRET', TOKEN, 'cookie-value-1234']) assert.ok(!seen.includes(secret), `${secret} was logged`);
  } finally { await t.close(); }
});

test('an error is told by its status and by DeepSeek\'s own JSON fields, never by words found in a page\'s body', () => {
  const page = '<html><body>Bad gateway. Your token, auth and login service returned 403 and 429. Too many requests (throttle).</body></html>';
  const odd = classifyError(502, null, page);
  assert.equal(odd.type, 'general', 'an error page that happens to contain those words is not an expired login and not a rate limit');
  assert.ok(!odd.message.includes('Bad gateway') && !odd.message.includes('<html'), 'the body of an upstream page is not handed to the API client');
  assert.match(odd.message, /502/);
  assert.equal(classifyError(401, null, '').type, 'auth_expired');
  assert.equal(classifyError(429, null, '').type, 'rate_limited');
  assert.equal(classifyError(403, null, '').type, 'rate_limited');
  assert.equal(classifyError(200, { code: 40003, msg: 'x' }, '').type, 'auth_expired');
  assert.equal(classifyError(200, { code: 1, msg: 'token is invalid' }, '').type, 'auth_expired', 'DeepSeek\'s own message field still counts');
  assert.equal(classifyError(200, { code: 1, msg: 'Too many requests' }, '').type, 'rate_limited');
  assert.equal(classifyError(200, null, '<a href="https://chat.deepseek.com/login">Sign in</a>').type, 'auth_expired', 'its login page is still a login page');
  assert.ok(classifyError(500, { code: 9, msg: 'x'.repeat(2000) }, '').message.length <= 300, 'a long upstream message is cut');
});

test('a DeepSeek address that answers with a redirect is an error: the prompt and the login are not sent on to another address', async () => {
  const seen = [];
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const other = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); req.resume(); res.end('{}'); });
  await listen(other);
  const redirector = http.createServer((req, res) => { req.resume(); res.writeHead(307, { Location: `http://127.0.0.1:${other.address().port}/elsewhere` }); res.end(); });
  await listen(redirector);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-ds-'));
  fs.writeFileSync(path.join(dir, 'deepseek_session.json'), JSON.stringify({ token: TOKEN, cookies: [], linkedAt: new Date().toISOString(), expired: false }), { mode: 0o600 });
  try {
    const base = `http://127.0.0.1:${redirector.address().port}`;
    const web = createDeepSeekWeb({ dataDir: dir, base, log: () => {}, governor: null, onAuthExpired: () => {} });
    const out = await web.completeOnce({ prompt: 'a prompt that must stay between here and DeepSeek' });
    assert.equal(out.ok, false);
    const login = await checkLogin({ token: TOKEN, base });
    assert.equal(login.valid, null, 'the question could not be answered; a redirect is neither a yes nor a no');
    assert.deepEqual(seen, [], 'nothing was sent to the address it pointed at');
  } finally {
    await new Promise((r) => redirector.close(r)); await new Promise((r) => other.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every DeepSeek model in /v1/models says a working context size, and /v1/models/{id} says the same', async () => {
  const t = await boot();
  try {
    const auth = { authorization: `Bearer ${t.key}` };
    const list = await (await fetch(`${t.base}/v1/models`, { headers: auth })).json();
    assert.ok(list.data.length >= 3);
    assert.ok(list.data.every((m) => m.context_length === 128000), JSON.stringify(list.data.map((m) => m.context_length)));
    const one = await (await fetch(`${t.base}/v1/models/deepseek-chat`, { headers: auth })).json();
    assert.equal(one.context_length, 128000);
  } finally { await t.close(); }
});

// ---- the network, and a site that changed (the stand-in closes connections on request) --------------------------------------------------------------------

const hello = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hello' }] };

test('a network blip before the message is sent is tried once more, and the account is spent once', async () => {
  const t = await boot();
  try {
    t.site.state.drop = { '/api/v0/chat_session/create': 1 };
    const res = await t.chat(hello);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(t.site.state.requests['/api/v0/chat_session/create'], 2, 'the chat was asked for twice');
    assert.equal(t.site.state.completions.length, 1, 'one message reached DeepSeek');
    assert.equal(t.provider.governor.getStats().todayCalls, 1, 'one call counted');
  } finally { await t.close(); }
});

test('a connection that stays down is said in words, tried twice and no more, is not a refusal, and costs the account nothing', async () => {
  const t = await boot();
  try {
    t.site.state.drop = { '/api/v0/chat_session/create': 100 };
    const res = await t.chat(hello);
    assert.equal(res.status, 502);
    const message = (await res.json()).error.message;
    assert.match(message, /could not reach DeepSeek/i);
    assert.ok(!/fetch failed/i.test(message), 'not the bare words of the network library: ' + message);
    assert.equal(t.site.state.requests['/api/v0/chat_session/create'], 2, 'twice, not more');
    assert.equal(t.site.state.completions.length, 0);
    assert.equal(t.provider.governor.getStats().todayCalls, 0, 'nothing was sent, so nothing is counted');
    assert.equal(t.provider.governor.getStats().isCooldown, false, 'a bad connection is not a refusal: no pause');
    t.site.state.drop = {};
    const again = await t.chat(hello);
    assert.equal(again.status, 200, 'as soon as the network is back the next request goes through');
    assert.equal((await t.provider.status()).linked, true);
  } finally { await t.close(); }
});

test('an answer that breaks off in the middle is an error in words, never a half answer; the chat is removed and the message is counted', async () => {
  const t = await boot();
  try {
    t.site.state.reply = () => 'A long enough answer that it is sent in several pieces by the stand-in.';
    t.site.state.dropMidStream = 3;
    const res = await t.chat(hello);
    assert.equal(res.status, 502, await res.clone().text());
    const message = (await res.json()).error.message;
    assert.match(message, /connection to DeepSeek dropped while it was answering/i);
    assert.ok(!/terminated|fetch failed/i.test(message), message);
    assert.equal(t.provider.governor.getStats().todayCalls, 1, 'the message was sent, so the account was spent');
    for (let i = 0; i < 50 && !t.site.state.deleted.length; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(t.site.state.deleted, ['standin-1'], 'the chat that was left is removed');
  } finally { await t.close(); }
});

test('a proof-of-work of another kind is named and not worked on, and an unsolvable one is not blamed on DeepSeek', async () => {
  const t = await boot();
  try {
    t.site.state.algorithm = 'DeepSeekHashV2';
    const started = Date.now();
    const res = await t.chat(hello);
    assert.equal(res.status, 502);
    const message = (await res.json()).error.message;
    assert.match(message, /changed its proof-of-work/i);
    assert.match(message, /DeepSeekHashV2/);
    assert.ok(Date.now() - started < 3000, 'no search through the whole difficulty for an algorithm that is not known');
    assert.equal(t.site.state.completions.length, 0);
    assert.equal(t.site.state.powFailures, 0, 'the completion was never asked for');
  } finally { await t.close(); }
});

test('the end of a real stream is logged once by the names of its events, with none of its words', async () => {
  const t = await boot();
  try {
    t.site.state.reply = () => 'Words of the answer that must never reach the log.';
    for (let i = 0; i < 2; i += 1) assert.equal((await t.chat(hello)).status, 200);
    const lines = t.logs.filter((l) => /^deepseek: the stream ended/.test(l));
    assert.equal(lines.length, 1, 'once per run: ' + t.logs.join(' | '));
    assert.match(lines[0], /p=response\/fragments\/-1\/content/, lines[0]);
    assert.ok(!/Words of the answer/.test(t.logs.join('\n')), 'no words of the answer in the log');
  } finally { await t.close(); }
});

// ---- pictures --------------------------------------------------------------------------------------------------------------------------------

const picture = (tag) => `data:image/png;base64,${Buffer.from(`\x89PNG-stand-in-picture-${tag}`).toString('base64')}`;
const askAbout = (text, ...urls) => ({ role: 'user', content: [{ type: 'text', text }, ...urls.map((url) => ({ type: 'image_url', image_url: { url } }))] });
const stateOf = async (t) => (await fetch(`${t.site.base}/state`)).json();

test('pictures: an attached picture is uploaded as a file for its own proof-of-work, waited for, and named in the completion', async () => {
  const t = await boot();
  try {
    t.site.state.reply = () => 'It is a stand-in picture.';
    const res = await t.chat({ model: 'deepseek-chat', messages: [askAbout('What is in this picture?', picture('a'))] });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json()).choices[0].message.content, 'It is a stand-in picture.');
    const s = await stateOf(t);
    assert.equal(s.uploads.length, 1);
    assert.equal(s.uploads[0].mime, 'image/png');
    assert.equal(s.uploads[0].name, 'image-1.png');
    assert.equal(s.uploads[0].size, Buffer.from('\x89PNG-stand-in-picture-a').length, 'the file is the picture, byte for byte');
    assert.equal(s.uploads[0].target, '/api/v0/file/upload_file', 'the proof-of-work was asked for the upload path');
    assert.equal(s.powFailures, 0);
    assert.deepEqual(s.completions[0].files, ['file-1']);
    assert.match(s.completions[0].promptHead, /What is in this picture\?\n\[attached image 1\]/);
    assert.ok(t.site.state.polls['file-1'] >= 2, 'the file was waited for until the site had read it');
    assert.ok(!/omitted/.test(s.completions[0].promptHead));
  } finally { await t.close(); }
});

test('pictures: the same picture sent again is not uploaded again, and a request with no picture sends no files', async () => {
  const t = await boot();
  try {
    for (let i = 0; i < 2; i += 1) assert.equal((await t.chat({ model: 'deepseek-chat', messages: [askAbout(`Question ${i}`, picture('same'))] })).status, 200);
    assert.equal((await t.chat({ model: 'deepseek-chat', messages: [user('No picture here')] })).status, 200);
    const s = await stateOf(t);
    assert.equal(s.uploads.length, 1, 'one upload for one picture');
    assert.deepEqual(s.completions.map((c) => c.files), [['file-1'], ['file-1'], []]);
  } finally { await t.close(); }
});

test('pictures: only the newest four go with a message, and the prompt says which did not', async () => {
  const t = await boot();
  try {
    const res = await t.chat({ model: 'deepseek-chat', messages: [askAbout('Look at all of these', ...['1', '2', '3', '4', '5', '6'].map(picture))] });
    assert.equal(res.status, 200);
    const s = await stateOf(t);
    assert.equal(s.uploads.length, 4);
    assert.equal(s.completions[0].files.length, 4);
    const prompt = t.site.state.completions[0].prompt;
    assert.match(prompt, /image 1: only the newest 4 pictures are sent/);
    assert.match(prompt, /image 2: only the newest 4 pictures are sent/);
    assert.match(prompt, /NOT visible to you/);
  } finally { await t.close(); }
});

test('pictures: a file the site refuses, finds empty or fails on is told to the model, and the question is still answered', async () => {
  for (const [uploadState, words] of [['refuse', /file type not supported/], ['CONTENT_EMPTY', /found nothing in the picture/], ['FAILED', /could not read the picture \(failed\)/]]) {
    const t = await boot({ site: { uploadState, parsingPolls: 0 } });
    try {
      t.site.state.reply = () => 'I could not see it.';
      const res = await t.chat({ model: 'deepseek-chat', messages: [askAbout('What is this?', picture('x'))] });
      assert.equal(res.status, 200, uploadState);
      assert.equal((await res.json()).choices[0].message.content, 'I could not see it.');
      const sent = t.site.state.completions[0];
      assert.deepEqual(sent.files, [], uploadState);
      assert.match(sent.prompt, /Note from the bridge: image 1:/, uploadState);
      assert.match(sent.prompt, words, uploadState);
      assert.match(sent.prompt, /NOT visible to you/);
      assert.ok(!t.logs.join('\n').includes(TOKEN), 'no token in the log');
    } finally { await t.close(); }
  }
});

test('pictures: a login the site refuses while a picture is going up is an expired sign-in, like any other call', async () => {
  const t = await boot({ site: { authFail: true } });
  try {
    const res = await t.chat({ model: 'deepseek-chat', messages: [askAbout('What is this?', picture('x'))] });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error.message, /session has expired/i);
  } finally { await t.close(); }
});

test('pictures: a picture that is an address, not a file, is left out with the note it always had, and nothing is uploaded', async () => {
  const t = await boot();
  try {
    const res = await t.chat({ model: 'deepseek-chat', messages: [askAbout('What is this?', 'https://example.com/a.png')] });
    assert.equal(res.status, 200);
    assert.equal((await stateOf(t)).uploads.length, 0);
    assert.match(t.site.state.completions[0].prompt, /\[image omitted by the bridge\]/);
  } finally { await t.close(); }
});
