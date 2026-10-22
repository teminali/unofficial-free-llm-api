/**
 * The command line: start the server (the default), make and revoke API keys, and ask a running server how it is.
 * No dependencies; the arguments are few enough to read by hand.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { createConfig, defaultDataDir } = require('./config');
const { createLogBuffer } = require('./logbuffer');
const { createRegistry } = require('./registry');
const { createServer } = require('./server');
const { createProviders } = require('./providers');
const pkg = require('../package.json');

const DEFAULT_PORT = 8420;

const HELP = `unofficial-free-llm-api ${pkg.version}
A local API and web playground for the chat accounts you already have. Unofficial: read DISCLAIMER in the README first.

Usage
  unofficial-free-llm-api [start] [options]     start the server and open the web interface
  unofficial-free-llm-api key create [name]     make an API key (printed; show it again any time with key show)
  unofficial-free-llm-api key list              list keys (their hints, never the keys)
  unofficial-free-llm-api key show <id|name>    print a key again
  unofficial-free-llm-api key revoke <id>       revoke a key
  unofficial-free-llm-api status                ask a running server how it is
  unofficial-free-llm-api selftest [--model id] [--turns 3] [--yes]   send a short conversation through a running server and say whether it stayed in one provider chat
  unofficial-free-llm-api doctor [--online]     check this computer (Node, Chrome, the data folder, the port, the accounts); --online also asks npm for the newest version
  unofficial-free-llm-api log [--lines 100]     print the last lines the providers logged (no prompts, no answers, keys scrubbed): what to send when something fails
  unofficial-free-llm-api login-url             print the link that signs the browser in to the web interface

Options
  --port <n>          port to listen on (default ${DEFAULT_PORT}, env ULA_PORT)
  --host <address>    address to listen on (default 127.0.0.1, env ULA_HOST). Anything but loopback exposes the server to your network.
  --data-dir <dir>    where logins, keys and usage are kept (default ~/.unofficial-free-llm-api, env ULA_HOME)
  --no-open           do not open the browser
  --cors <origins>    allow browser apps on these origins (comma separated, or *) to call /v1 with a key
  --no-key            serve /v1 without a key (loopback only)
  --demo              add a demo provider that needs no account, to try the interface and your client
  --providers <list>  which providers to load (default deepseek,gemini)
  --no-sessions       send every request on a new provider chat, as the first version did (env ULA_SESSIONS=0)
  -v, --version       print the version
  -h, --help          print this help
`;

function parseArgs(argv) {
  const out = { command: '', rest: [], flags: {} };
  const valued = new Set(['port', 'host', 'data-dir', 'cors', 'providers', 'model', 'turns', 'lines']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h') out.flags.help = true;
    else if (a === '-v') out.flags.version = true;
    else if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s);
      if (valued.has(name)) { out.flags[name] = inline !== undefined ? inline : argv[i += 1]; } else out.flags[name] = true;
    } else if (!out.command) out.command = a;
    else out.rest.push(a);
  }
  return out;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser to open: the link is printed anyway */ });
    child.unref();
  } catch (_) { /* the link is printed anyway */ }
}

async function start(flags, io) {
  const dataDir = flags['data-dir'] ? path.resolve(flags['data-dir']) : defaultDataDir();
  const port = Number(flags.port || process.env.ULA_PORT || DEFAULT_PORT);
  const host = String(flags.host || process.env.ULA_HOST || '127.0.0.1');
  const config = createConfig({ dataDir });
  const only = flags.providers ? String(flags.providers).split(',').map((s) => s.trim()).filter(Boolean) : ['deepseek', 'gemini'];
  if (flags.demo && !only.includes('demo')) only.push('demo');
  const verbose = Boolean(process.env.ULA_DEBUG);
  const recent = createLogBuffer(300); // what `log` prints: the providers' last lines, kept in memory only
  const log = (line) => { recent.push(line); if (verbose) io.err(`[${new Date().toISOString()}] ${line}\n`); };
  const { providers, bus } = createProviders({ dataDir, config, log, only, sessions: !flags['no-sessions'] });
  const registry = createRegistry({ providers, bus });
  const cors = flags.cors ? String(flags.cors).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const server = createServer({ config, registry, version: pkg.version, host, port, requireKey: !flags['no-key'], cors, log, logBuffer: recent });
  let info;
  try { info = await server.start(); } catch (err) {
    if (err && err.code === 'EADDRINUSE') return alreadyRunning({ host, port, config, flags, io });
    throw err;
  }
  let firstKey = null;
  if (!config.listApiKeys().length && !flags['no-key']) firstKey = config.createApiKey('first key').key;
  const login = server.adminLoginUrl();
  io.out([
    '',
    `  Unofficial Free LLM API ${pkg.version}`,
    `  Web interface   ${login}`,
    `  API base URL    ${info.url}/v1`,
    firstKey ? `  API key         ${firstKey}   (print it again any time: unofficial-free-llm-api key show; make more in the web interface)` : (flags['no-key'] ? '  API key         not required (--no-key, loopback only)' : `  API keys        ${config.listApiKeys().length} (copy one on the API page, or print it: unofficial-free-llm-api key show <name>)`),
    `  Data folder     ${dataDir}`,
    '',
    '  This uses your own chat sessions and is not endorsed by any provider. It can get an account',
    '  slowed down, muted or signed out. Read DISCLAIMER in the README. Press Ctrl+C to stop.',
    ''
  ].join('\n') + '\n');
  if (!flags['no-open'] && io.isTTY) openBrowser(login);
  if (!server.loopbackOnly) io.err('Warning: listening beyond loopback. The API needs a key and the web interface needs its admin token, but this machine\'s network can now reach them.\n');
  return new Promise((resolve) => {
    const stop = async () => { io.out('\nStopping...\n'); await server.stop(); resolve(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/**
 * The port is taken. When what holds it is a copy of this program (it answers /health with a version), that is the likeliest reason, and the useful answer is its
 * link, not an error: launching twice should land on the interface that is already there.
 */
async function alreadyRunning({ host, port, config, flags, io }) {
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  let health = null;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    const data = res.ok ? await res.json() : null;
    if (data && data.ok === true && typeof data.version === 'string') health = data;
  } catch (_) { /* not a copy of this program */ }
  if (!health) { io.err(`Port ${port} is already in use by something else. Choose another with --port.\n`); return 1; }
  // The link works when that copy uses this data folder (the same admin token); say so plainly when it does not.
  const login = `${base}/_/login?token=${encodeURIComponent(config.adminToken())}`;
  let sameFolder = false;
  try { sameFolder = (await fetch(`${base}/_/state`, { headers: { authorization: `Bearer ${config.adminToken()}` }, signal: AbortSignal.timeout(2000) })).ok; } catch (_) { /* told below */ }
  if (sameFolder) {
    io.out(`\n  Unofficial Free LLM API ${health.version} is already running here.\n  Web interface   ${login}\n  API base URL    ${base}/v1\n\n`);
    if (!flags['no-open'] && io.isTTY) openBrowser(login);
    return 0;
  }
  io.err(`Unofficial Free LLM API ${health.version} is already running on port ${port}, with another data folder than this one. Open it with its own link (unofficial-free-llm-api login-url --data-dir <its folder>), or start this one on another port: --port ${port + 1}.\n`);
  return 1;
}

/** The checks of `doctor`: each is { ok, text, fix }. */
async function doctor(flags, io) {
  const dataDir = flags['data-dir'] ? path.resolve(flags['data-dir']) : defaultDataDir();
  const port = Number(flags.port || process.env.ULA_PORT || DEFAULT_PORT);
  const host = String(flags.host || process.env.ULA_HOST || '127.0.0.1');
  const fs = require('fs');
  const checks = [];
  // `fix` is said when the check failed, `note` always (a next step that is not a fault).
  const add = (ok, text, fix = '', note = '') => checks.push({ ok, text, fix, note });
  const [major] = process.versions.node.split('.').map(Number);
  add(major >= 22, `Node.js ${process.versions.node}`, 'Install Node.js 22 or newer: https://nodejs.org');
  const { chromeExecutable } = require('./providers/chrome');
  const chrome = chromeExecutable();
  add(Boolean(chrome), chrome ? `Chrome found: ${chrome}` : 'Chrome not found (needed to link an account; DeepSeek can use a pasted token instead)', 'Install Google Chrome, or set ULA_CHROME_PATH to a Chromium-based browser.');
  let mode = null;
  try { mode = fs.statSync(dataDir).mode & 0o777; } catch (_) { /* not made yet */ }
  if (mode === null) add(true, `Data folder ${dataDir} (not made yet: it is made at the first start)`);
  else add(process.platform === 'win32' || mode === 0o700, `Data folder ${dataDir}${process.platform === 'win32' ? '' : ` (mode ${mode.toString(8)})`}`, `Run: chmod 700 "${dataDir}" (it holds your logins).`);
  const config = createConfig({ dataDir });
  add(true, `${config.listApiKeys().length} API key(s) made`, '', config.listApiKeys().length ? '' : 'Make one on the API page, or: unofficial-free-llm-api key create');
  let running = null; // null: nothing answers on the port
  try {
    const res = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    // Something answered. It is a copy of this program only when it says so; anything else (an error page, text) is another program on the port.
    const data = res.ok ? await res.json().catch(() => null) : null;
    running = data && data.ok === true && data.version ? data : { other: true };
  } catch (_) { running = null; }
  if (!running) add(true, `Port ${port} is free`);
  else if (running.other) add(false, `Port ${port} is used by something that is not this program`, `Start with another port: --port ${port + 1}`);
  else add(true, `A copy (version ${running.version}) is running on port ${port}`);
  const { providers } = createProviders({ dataDir, config, log: () => {}, only: ['deepseek', 'gemini'], sessions: !flags['no-sessions'] });
  for (const p of providers) {
    try {
      const st = await p.status();
      const label = !st.linked ? 'not linked' : st.expired ? 'sign-in expired' : 'linked';
      add(true, `${p.name}: ${label}${st.sessions ? `; one chat per conversation ${st.sessions.enabled ? 'on' : `off${st.sessions.reason ? ` (${st.sessions.reason})` : ''}`}` : ''}`, st.linked && !st.expired ? '' : '', st.linked && !st.expired ? '' : 'Link it on the Accounts page.');
    } catch (err) { add(false, `${p.name}: could not read its state (${(err && err.message) || err})`); }
    try { if (p.stop) await p.stop(); } catch (_) { /* nothing was started */ }
  }
  if (flags.online) {
    try {
      const res = await fetch('https://registry.npmjs.org/unofficial-free-llm-api/latest', { signal: AbortSignal.timeout(5000) });
      const latest = res.ok ? (await res.json()).version : null;
      if (!latest) add(false, 'Could not read the newest version from npm');
      else if (latest === pkg.version) add(true, `Version ${pkg.version} is the newest`);
      else add(false, `Version ${pkg.version}; the newest is ${latest}`, 'Run: npx unofficial-free-llm-api@latest');
    } catch (_) { add(false, 'Could not reach npm to look for a newer version'); }
  } else add(true, `Version ${pkg.version} (add --online to look for a newer one)`);
  for (const c of checks) io.out(`  ${c.ok ? 'ok ' : 'FIX'}  ${c.text}${!c.ok && c.fix ? `\n        ${c.fix}` : ''}${c.note ? `\n        ${c.note}` : ''}\n`);
  return checks.every((c) => c.ok) ? 0 : 1;
}

/**
 * `selftest`: a short conversation through a RUNNING server, to see whether it stays in one provider chat. It spends real requests on the account (one for each turn),
 * so it says so and waits for --yes. It prints sizes and times, never what was said.
 */
async function selftest(flags, io) {
  const dataDir = flags['data-dir'] ? path.resolve(flags['data-dir']) : defaultDataDir();
  const port = Number(flags.port || process.env.ULA_PORT || DEFAULT_PORT);
  const host = String(flags.host || process.env.ULA_HOST || '127.0.0.1');
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const turns = Math.max(2, Math.min(6, Number(flags.turns) || 3));
  const config = createConfig({ dataDir });
  const auth = { authorization: `Bearer ${config.adminToken()}` };
  let state;
  try {
    const res = await fetch(`${base}/_/state`, { headers: auth, signal: AbortSignal.timeout(4000) });
    if (!res.ok) { io.err(`The server at ${base} did not accept this data folder's admin token (${res.status}). Is it using another --data-dir?\n`); return 1; }
    state = await res.json();
  } catch (_) { io.err(`Nothing is running at ${base}. Start it first: unofficial-free-llm-api\n`); return 1; }
  const model = flags.model ? String(flags.model) : (state.models[0] && state.models[0].id);
  if (!model || !state.models.some((m) => m.id === model)) { io.err(`No linked model${flags.model ? ` called "${flags.model}"` : ''}. Link an account on the Accounts page first.${state.models.length ? ` Linked: ${state.models.map((m) => m.id).join(', ')}.` : ''}\n`); return 1; }
  const owner = state.models.find((m) => m.id === model).provider;
  if (owner === 'demo') { io.err('That is the demo provider: it keeps no chat. Name a model of a linked account.\n'); return 1; }
  if (!flags.yes) {
    io.out(`This sends ${turns} short messages to ${owner} through ${base}, one conversation, and spends ${turns} of the account's requests (paced as always).\nIt prints sizes and times, never what was said. Run it again with --yes to go ahead.\n`);
    return 2;
  }
  const history = [];
  const questions = ['Name one colour. One word only.', 'Name one animal. One word only.', 'Name one fruit. One word only.', 'Name one city. One word only.', 'Name one river. One word only.', 'Name one tool. One word only.'];
  const before = (state.providers.find((p) => p.id === owner) || {}).sessions;
  io.out(`Model ${model} (${owner}), ${turns} turns:\n`);
  for (let i = 0; i < turns; i += 1) {
    history.push({ role: 'user', content: questions[i] });
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: history, user: 'ula-selftest' }), signal: AbortSignal.timeout(300000) });
    } catch (err) { io.out(`  turn ${i + 1}: the request failed (${(err && err.message) || err})\n`); return 1; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { io.out(`  turn ${i + 1}: ${res.status} ${(data.error && data.error.code) || ''} ${(data.error && data.error.message) || ''}\n`); return 1; }
    const answer = data.choices[0].message.content || '';
    history.push({ role: 'assistant', content: answer });
    io.out(`  turn ${i + 1}: ${((Date.now() - t0) / 1000).toFixed(1)} s, an answer of ${answer.length} characters\n`);
  }
  const after = ((await (await fetch(`${base}/_/state`, { headers: auth })).json()).providers.find((p) => p.id === owner) || {}).sessions;
  if (!after) { io.out('This provider does not keep chats.\n'); return 0; }
  if (!after.enabled) { io.out(`\nEvery message was a chat of its own: one chat per conversation is OFF${after.reason ? ` (${after.reason})` : ''}.\nSwitch it on on the Accounts page (or start without --no-sessions) and run this again.\n`); return 1; }
  const continued = (after.continued || 0) - ((before && before.continued) || 0);
  const started = (after.started || 0) + (after.diverged || 0) - (((before && before.started) || 0) + ((before && before.diverged) || 0));
  io.out(`\nChats started: ${started}, continued: ${continued}.\n`);
  if (continued === turns - 1 && started === 1) { io.out(`The conversation stayed in one chat. Open ${owner === 'deepseek' ? 'chat.deepseek.com' : 'gemini.google.com'}: its history should show one new chat with ${turns} questions in it.\n`); return 0; }
  io.out('It did not stay in one chat. Start the server with ULA_DEBUG=1 and send the lines that mention "chat" to the issue tracker (no prompts are in them).\n');
  return 1;
}

async function keyCommand(rest, flags, io) {
  const config = createConfig({ dataDir: flags['data-dir'] ? path.resolve(flags['data-dir']) : defaultDataDir() });
  const [sub, arg] = rest;
  if (sub === 'create') {
    const { key, entry } = config.createApiKey(arg || 'key');
    io.out(`${key}\n`);
    io.err(`Made key "${entry.name}" (${entry.id}). Print it again any time with: unofficial-free-llm-api key show ${entry.id}\n`);
    return 0;
  }
  if (sub === 'list') {
    const keys = config.listApiKeys();
    if (!keys.length) io.out('No keys yet. Make one with: unofficial-free-llm-api key create\n');
    for (const k of keys) io.out(`${k.id}  ${k.hint}${k.revealable ? '' : '  (hash only)'}  ${k.name}  made ${k.createdAt.slice(0, 10)}${k.lastUsedAt ? `  last used ${k.lastUsedAt.slice(0, 16).replace('T', ' ')}` : '  never used'}\n`);
    return 0;
  }
  if (sub === 'show') {
    if (!arg) { io.err('Which key? unofficial-free-llm-api key show <id or name>\n'); return 2; }
    const found = config.listApiKeys().filter((k) => k.id === arg || k.name === arg);
    if (!found.length) { io.err('No key with that id or name. See: unofficial-free-llm-api key list\n'); return 1; }
    if (found.length > 1) { io.err('More than one key has that name: use its id (unofficial-free-llm-api key list).\n'); return 1; }
    const secret = config.revealApiKey(found[0].id);
    if (!secret) { io.err('That key was made before keys could be shown again, so only its start and end are known. Make a new one: unofficial-free-llm-api key create\n'); return 1; }
    io.out(`${secret}\n`);
    return 0;
  }
  if (sub === 'revoke') {
    if (!arg) { io.err('Which key? unofficial-free-llm-api key revoke <id>\n'); return 2; }
    if (config.revokeApiKey(arg)) { io.out('Revoked.\n'); return 0; }
    io.err('No key with that id.\n');
    return 1;
  }
  io.err('Usage: unofficial-free-llm-api key create [name] | list | show <id|name> | revoke <id>\n');
  return 2;
}

async function logCommand(flags, io) {
  const dataDir = flags['data-dir'] ? path.resolve(flags['data-dir']) : defaultDataDir();
  const port = Number(flags.port || process.env.ULA_PORT || DEFAULT_PORT);
  const host = String(flags.host || process.env.ULA_HOST || '127.0.0.1');
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const config = createConfig({ dataDir });
  let res;
  try { res = await fetch(`${base}/_/log?lines=${encodeURIComponent(String(flags.lines || 100))}`, { headers: { authorization: `Bearer ${config.adminToken()}` }, signal: AbortSignal.timeout(5000) }); } catch (_) {
    io.err(`Not running at ${base}. Start it first: unofficial-free-llm-api\n`);
    return 1;
  }
  if (res.status === 404) { io.err('This copy is older than the log command: restart it from the newest version first.\n'); return 1; }
  if (!res.ok) { io.err(`Running at ${base}, but it did not accept this data folder's admin token (${res.status}). Is it using another --data-dir?\n`); return 1; }
  const { lines } = await res.json();
  if (!lines.length) io.out('Nothing logged yet. Send a message through a linked account, then run this again.\n');
  for (const l of lines) io.out(`${l.at} ${l.line}\n`);
  return 0;
}

async function status(flags, io) {
  const dataDir = flags['data-dir'] ? path.resolve(flags['data-dir']) : defaultDataDir();
  const port = Number(flags.port || process.env.ULA_PORT || DEFAULT_PORT);
  const host = String(flags.host || process.env.ULA_HOST || '127.0.0.1');
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const config = createConfig({ dataDir });
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error(`answered ${health.status}`);
  } catch (_) {
    io.out(`Not running at ${base}. Start it with: unofficial-free-llm-api\n`);
    return 1;
  }
  const res = await fetch(`${base}/_/state`, { headers: { authorization: `Bearer ${config.adminToken()}` }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) { io.out(`Running at ${base}, but it did not accept this data folder's admin token (${res.status}). Is it using another --data-dir?\n`); return 1; }
  const state = await res.json();
  io.out(`Running at ${base} (version ${state.version}). ${state.keys.length} API key(s).\n`);
  for (const p of state.providers) {
    const label = !p.linked ? 'not linked' : p.expired ? 'sign-in expired' : (p.linking ? 'linking...' : 'linked');
    const u = p.usage;
    io.out(`  ${p.name.padEnd(10)} ${label.padEnd(16)}${u ? ` ${u.todayCalls}/${u.dailyCap} calls today${u.isCooldown ? `, paused (${u.cooldownReason})` : ''}` : ''}\n`);
  }
  return 0;
}

async function run(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), isTTY: Boolean(process.stdout.isTTY) }) {
  const { command, rest, flags } = parseArgs(argv);
  if (flags.version) { io.out(`${pkg.version}\n`); return 0; }
  if (flags.help || command === 'help') { io.out(HELP); return 0; }
  switch (command || 'start') {
    case 'start': return start(flags, io);
    case 'key': case 'keys': return keyCommand(rest, flags, io);
    case 'status': return status(flags, io);
    case 'log': return logCommand(flags, io);
    case 'doctor': return doctor(flags, io);
    case 'selftest': return selftest(flags, io);
    case 'login-url': {
      const dataDir = flags['data-dir'] ? path.resolve(flags['data-dir']) : defaultDataDir();
      const port = Number(flags.port || process.env.ULA_PORT || DEFAULT_PORT);
      io.out(`http://127.0.0.1:${port}/_/login?token=${encodeURIComponent(createConfig({ dataDir }).adminToken())}\n`);
      return 0;
    }
    default:
      io.err(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

module.exports = { run, parseArgs, HELP };
