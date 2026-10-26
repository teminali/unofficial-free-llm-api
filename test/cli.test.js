'use strict';

/**
 * The command line: starting a second copy lands on the one that is already running, and `doctor` says what is wrong with a computer in words.
 */

process.env.ULA_TEST_MODE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { run, parseArgs } = require('../src/cli');
const { createConfig } = require('../src/config');
const { createRegistry } = require('../src/registry');
const { createServer } = require('../src/server');
const { createLogBuffer } = require('../src/logbuffer');
const { createProviders } = require('../src/providers');
const { chromeExecutable } = require('../src/providers/chrome');
const { cleanupDir } = require('./fixtures/cleanup');
const { createDeepSeekProvider } = require('../src/providers/deepseek');
const { startFakeDeepSeek, TOKEN } = require('./fixtures/fake_deepseek');

function io() {
  const out = [];
  const err = [];
  return { out: (s) => out.push(s), err: (s) => err.push(s), isTTY: false, text: () => out.join(''), errText: () => err.join('') };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ula-cli-'));

/** A web server that is not this program: it answers every request with text that is not JSON. */
async function somethingElse() {
  const http = require('http');
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('not us'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

async function running(dir, { logBuffer } = {}) {
  const config = createConfig({ dataDir: dir });
  const { providers, bus } = createProviders({ dataDir: dir, config, only: ['demo'] });
  const server = createServer({ config, registry: createRegistry({ providers, bus }), port: 0, version: '9.9.9', logBuffer });
  const { port } = await server.start();
  return { server, port, config };
}

test('--no-sessions is a flag without a value', () => {
  assert.equal(parseArgs(['--no-sessions', '--port', '9000']).flags['no-sessions'], true);
  assert.equal(parseArgs(['doctor', '--online']).command, 'doctor');
});

test('starting again while a copy is running (the same data folder) prints that copy\'s link and ends well, instead of an error', async () => {
  const dir = tmp();
  const a = await running(dir);
  try {
    const out = io();
    const code = await run(['start', '--port', String(a.port), '--data-dir', dir, '--no-open', '--providers', 'demo'], out);
    assert.equal(code, 0);
    assert.match(out.text(), /9\.9\.9 is already running here/);
    assert.match(out.text(), new RegExp(`http://127\\.0\\.0\\.1:${a.port}/_/login\\?token=`));
    assert.match(out.text(), new RegExp(`/v1`));
    assert.equal(out.errText(), '');
  } finally { await a.server.stop(); await cleanupDir(dir); }
});

test('a copy running with another data folder is named as that, with what to do; something else on the port is said to be something else', async () => {
  const dirA = tmp();
  const dirB = tmp();
  const a = await running(dirA);
  try {
    const out = io();
    assert.equal(await run(['start', '--port', String(a.port), '--data-dir', dirB, '--no-open', '--providers', 'demo'], out), 1);
    assert.match(out.errText(), /already running on port \d+, with another data folder/);
    assert.match(out.errText(), /--port \d+/);
    // a port held by a program that is not this one
    const other = await somethingElse();
    try {
      const out2 = io();
      assert.equal(await run(['start', '--port', String(other.port), '--data-dir', dirB, '--no-open', '--providers', 'demo'], out2), 1);
      assert.match(out2.errText(), /already in use by something else/);
    } finally { await other.close(); }
  } finally { await a.server.stop(); await cleanupDir(dirA); await cleanupDir(dirB); }
});

test('doctor reads the computer in words: what is fine, what is not, and what to do about it', async () => {
  const dir = tmp();
  try {
    fs.chmodSync(dir, 0o755);
    const out = io();
    const code = await run(['doctor', '--data-dir', dir, '--port', '8499'], out);
    const text = out.text();
    assert.match(text, /Node\.js \d+/);
    assert.match(text, /Data folder .*mode 755/);
    if (process.platform !== 'win32') {
      assert.match(text, /FIX {2}Data folder/);
      assert.match(text, /chmod 700/);
      assert.equal(code, 1, 'a folder that anyone can read is a fault');
    }
    assert.match(text, /DeepSeek: not linked/);
    assert.match(text, /Qoder: not linked/);
    assert.match(text, /one chat per conversation on/);
    assert.match(text, /Chrome (found|not found)/);
    assert.match(text, /Version \d+\.\d+\.\d+ \(add --online/);
    fs.chmodSync(dir, 0o700);
    const again = io();
    const ok = await run(['doctor', '--data-dir', dir, '--port', '8499'], again);
    assert.match(again.text(), /ok {3}Data folder/);
    assert.equal(ok, chromeExecutable() ? 0 : 1, 'only a missing Chrome is left to fix');
  } finally { await cleanupDir(dir); }
});

test('doctor sees a copy that is running, says whose it is, and names a port that something else holds', async () => {
  const dir = tmp();
  const a = await running(dir);
  try {
    const out = io();
    await run(['doctor', '--data-dir', dir, '--port', String(a.port)], out);
    assert.match(out.text(), new RegExp(`A copy \\(version 9\\.9\\.9\\) is running on port ${a.port}`));
    const other = await somethingElse();
    try {
      const out2 = io();
      const code = await run(['doctor', '--data-dir', dir, '--port', String(other.port)], out2);
      assert.equal(code, 1);
      assert.match(out2.text(), /FIX {2}Port \d+ is used by something that is not this program/);
    } finally { await other.close(); }
  } finally { await a.server.stop(); await cleanupDir(dir); }
});

test('doctor says one chat per conversation is off when the person switched it off', async () => {
  const dir = tmp();
  try {
    createConfig({ dataDir: dir }).setProviderSettings('deepseek', { sessions: false });
    const out = io();
    await run(['doctor', '--data-dir', dir, '--port', '8499'], out);
    assert.match(out.text(), /DeepSeek: not linked; one chat per conversation off/);
    assert.match(out.text(), /Qoder: not linked/);
  } finally { await cleanupDir(dir); }
});

// ---- selftest -------------------------------------------------------------------------------------------------------------------------------

async function withDeepSeek(sessions) {
  const site = await startFakeDeepSeek();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'deepseek_session.json'), JSON.stringify({ token: TOKEN, cookies: [{ name: 'ds_standin', value: 'cookie-value-1234' }], linkedAt: new Date().toISOString(), expired: false }), { mode: 0o600 });
  const bus = new EventEmitter();
  const config = createConfig({ dataDir: dir });
  const provider = createDeepSeekProvider({ dataDir: dir, config, bus, base: site.base, pace: { perMinute: 1000, minGapMs: 1, cooldownMs: 60000, smooth: true }, log: () => {}, sessions, sessionOptions: { closeGapMs: 2 } });
  const server = createServer({ config, registry: createRegistry({ providers: [provider], bus }), port: 0 });
  const { port } = await server.start();
  site.state.reply = () => 'Blue';
  return { site, dir, server, port, close: async () => { await server.stop(); await site.close(); await cleanupDir(dir); } };
}

test('selftest spends real requests, so it says so and waits for --yes', async () => {
  const t = await withDeepSeek(true);
  try {
    const out = io();
    assert.equal(await run(['selftest', '--port', String(t.port), '--data-dir', t.dir], out), 2);
    assert.match(out.text(), /sends 3 short messages to deepseek/);
    assert.match(out.text(), /--yes/);
    assert.equal(t.site.state.completions.length, 0, 'nothing was sent');
  } finally { await t.close(); }
});

test('selftest: a conversation that stays in one chat is a pass, and it prints sizes and never words', async () => {
  const t = await withDeepSeek(true);
  try {
    const out = io();
    assert.equal(await run(['selftest', '--port', String(t.port), '--data-dir', t.dir, '--yes', '--turns', '4'], out), 0, out.text() + out.errText());
    assert.match(out.text(), /turn 4: [\d.]+ s, an answer of 4 characters/);
    assert.match(out.text(), /Chats started: 1, continued: 3/);
    assert.match(out.text(), /stayed in one chat/);
    assert.ok(!/Blue/.test(out.text()), 'never what was said');
    assert.equal(t.site.state.created.length, 1);
    assert.equal(t.site.state.completions.length, 4);
  } finally { await t.close(); }
});

test('selftest: when sessions are off it says the conversation did not stay in one chat and that the switch is off', async () => {
  const t = await withDeepSeek(false);
  try {
    const out = io();
    assert.equal(await run(['selftest', '--port', String(t.port), '--data-dir', t.dir, '--yes'], out), 1);
    assert.match(out.text(), /Every message was a chat of its own: one chat per conversation is OFF/);
    assert.equal(t.site.state.created.length, 3);
  } finally { await t.close(); }
});

test('selftest: no server, no linked model and the demo provider are each said in words', async () => {
  const dir = tmp();
  try {
    const none = io();
    assert.equal(await run(['selftest', '--port', '8497', '--data-dir', dir, '--yes'], none), 1);
    assert.match(none.errText(), /Nothing is running at/);
    const a = await running(dir); // only the demo provider
    try {
      const demo = io();
      assert.equal(await run(['selftest', '--port', String(a.port), '--data-dir', dir, '--yes'], demo), 1);
      assert.match(demo.errText(), /demo provider: it keeps no chat/);
    } finally { await a.server.stop(); }
    const dir2 = tmp();
    const config = createConfig({ dataDir: dir2 });
    const { providers, bus } = createProviders({ dataDir: dir2, config, only: ['deepseek'] });
    const server = createServer({ config, registry: createRegistry({ providers, bus }), port: 0 });
    const { port } = await server.start();
    try {
      const unlinked = io();
      assert.equal(await run(['selftest', '--port', String(port), '--data-dir', dir2, '--yes'], unlinked), 1);
      assert.match(unlinked.errText(), /No linked model\. Link an account/);
    } finally { await server.stop(); await cleanupDir(dir2); }
  } finally { await cleanupDir(dir); }
});

// ---- log -------------------------------------------------------------------------------------------------------------------------------------

test('log prints the last lines the providers logged, with keys and tokens scrubbed, and only to the admin', async () => {
  const dir = tmp();
  const logBuffer = createLogBuffer(5);
  for (let i = 1; i <= 7; i += 1) logBuffer.push(`qoder: line ${i}`);
  logBuffer.push('deepseek: sent with sk-ula-abcdef0123456789 and token=AAAAAAAAAAAAAAAAAAAAAAAA');
  const a = await running(dir, { logBuffer });
  try {
    const out = io();
    assert.equal(await run(['log', '--port', String(a.port), '--data-dir', dir], out), 0, out.errText());
    assert.match(out.text(), /qoder: line 7/);
    assert.ok(!/qoder: line 1\b/.test(out.text()), 'only the last five are kept');
    assert.ok(!/sk-ula-abcdef/.test(out.text()) && !/AAAAAAAAAAAA/.test(out.text()), 'keys and tokens are scrubbed: ' + out.text());
    const some = io();
    await run(['log', '--lines', '2', '--port', String(a.port), '--data-dir', dir], some);
    assert.equal(some.text().trim().split('\n').length, 2);
    const anon = await fetch(`http://127.0.0.1:${a.port}/_/log`);
    assert.equal(anon.status, 401, 'not for a caller who is not the admin');
    const none = io();
    assert.equal(await run(['log', '--port', '8496', '--data-dir', dir], none), 1);
    assert.match(none.text() + none.errText(), /Not running/);
  } finally { await a.server.stop(); await cleanupDir(dir); }
});
