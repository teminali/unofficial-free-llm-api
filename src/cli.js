/**
 * The command line: start the server (the default), make and revoke API keys, and ask a running server how it is.
 * No dependencies; the arguments are few enough to read by hand.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { createConfig, defaultDataDir } = require('./config');
const { createRegistry } = require('./registry');
const { createServer } = require('./server');
const { createProviders } = require('./providers');
const pkg = require('../package.json');

const DEFAULT_PORT = 8420;

const HELP = `unofficial-llm-api ${pkg.version}
A local API and web playground for the chat accounts you already have. Unofficial: read DISCLAIMER in the README first.

Usage
  unofficial-llm-api [start] [options]     start the server and open the web interface
  unofficial-llm-api key create [name]     make an API key (printed once)
  unofficial-llm-api key list              list keys (their hints, never the keys)
  unofficial-llm-api key revoke <id>       revoke a key
  unofficial-llm-api status                ask a running server how it is
  unofficial-llm-api login-url             print the link that signs the browser in to the web interface

Options
  --port <n>          port to listen on (default ${DEFAULT_PORT}, env ULA_PORT)
  --host <address>    address to listen on (default 127.0.0.1, env ULA_HOST). Anything but loopback exposes the server to your network.
  --data-dir <dir>    where logins, keys and usage are kept (default ~/.unofficial-llm-api, env ULA_HOME)
  --no-open           do not open the browser
  --cors <origins>    allow browser apps on these origins (comma separated, or *) to call /v1 with a key
  --no-key            serve /v1 without a key (loopback only)
  --demo              add a demo provider that needs no account, to try the interface and your client
  --providers <list>  which providers to load (default deepseek,gemini)
  -v, --version       print the version
  -h, --help          print this help
`;

function parseArgs(argv) {
  const out = { command: '', rest: [], flags: {} };
  const valued = new Set(['port', 'host', 'data-dir', 'cors', 'providers']);
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
  const log = (line) => { if (verbose) io.err(`[${new Date().toISOString()}] ${line}\n`); };
  const { providers, bus } = createProviders({ dataDir, config, log, only });
  const registry = createRegistry({ providers, bus });
  const cors = flags.cors ? String(flags.cors).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const server = createServer({ config, registry, version: pkg.version, host, port, requireKey: !flags['no-key'], cors, log });
  let info;
  try { info = await server.start(); } catch (err) {
    if (err && err.code === 'EADDRINUSE') { io.err(`Port ${port} is already in use. Is another copy running? Choose another with --port.\n`); return 1; }
    throw err;
  }
  let firstKey = null;
  if (!config.listApiKeys().length && !flags['no-key']) firstKey = config.createApiKey('first key').key;
  const login = server.adminLoginUrl();
  io.out([
    '',
    `  Unofficial LLM API ${pkg.version}`,
    `  Web interface   ${login}`,
    `  API base URL    ${info.url}/v1`,
    firstKey ? `  API key         ${firstKey}   (shown once: make more in the web interface)` : (flags['no-key'] ? '  API key         not required (--no-key, loopback only)' : `  API keys        ${config.listApiKeys().length} (make or revoke them in the web interface)`),
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

async function keyCommand(rest, flags, io) {
  const config = createConfig({ dataDir: flags['data-dir'] ? path.resolve(flags['data-dir']) : defaultDataDir() });
  const [sub, arg] = rest;
  if (sub === 'create') {
    const { key, entry } = config.createApiKey(arg || 'key');
    io.out(`${key}\n`);
    io.err(`Made key "${entry.name}" (${entry.id}). It is shown once and stored only as a hash.\n`);
    return 0;
  }
  if (sub === 'list') {
    const keys = config.listApiKeys();
    if (!keys.length) io.out('No keys yet. Make one with: unofficial-llm-api key create\n');
    for (const k of keys) io.out(`${k.id}  ${k.hint}  ${k.name}  made ${k.createdAt.slice(0, 10)}${k.lastUsedAt ? `  last used ${k.lastUsedAt.slice(0, 16).replace('T', ' ')}` : '  never used'}\n`);
    return 0;
  }
  if (sub === 'revoke') {
    if (!arg) { io.err('Which key? unofficial-llm-api key revoke <id>\n'); return 2; }
    if (config.revokeApiKey(arg)) { io.out('Revoked.\n'); return 0; }
    io.err('No key with that id.\n');
    return 1;
  }
  io.err('Usage: unofficial-llm-api key create [name] | list | revoke <id>\n');
  return 2;
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
    io.out(`Not running at ${base}. Start it with: unofficial-llm-api\n`);
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
