/**
 * Where this bridge keeps things, and the small config file: API keys (stored as hashes, shown once), the admin token that opens the web interface,
 * and per-provider settings. Everything lives in one folder, `~/.unofficial-llm-api` unless ULA_HOME says otherwise, created 0700; every file in it that
 * holds a login is 0600.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_PREFIX = 'sk-ula-';

function defaultDataDir() {
  return process.env.ULA_HOME ? path.resolve(process.env.ULA_HOME) : path.join(os.homedir(), '.unofficial-llm-api');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) { /* a folder we do not own keeps its mode */ }
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Reads a JSON file; null when it is missing or unreadable. A legacy 0644 file is tightened on the way. */
function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return null; }
}

/** Writes a JSON file 0600 by writing a temporary file next to it first, so a crash never leaves half a login behind. */
function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
}

/**
 * Removes a folder and everything in it, trying again for a moment when the system says it is not empty or busy. A Chrome profile is the case this is for: Chrome's main
 * process has exited but its helper processes can still be writing into the folder, and a single attempt then fails and leaves the signed-in profile behind.
 */
function removeTree(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

function createConfig({ dataDir = defaultDataDir() } = {}) {
  ensureDir(dataDir);
  const file = path.join(dataDir, 'config.json');

  /** The file's content, or an empty config when there is no file. A file that is there but is not a JSON object is an error: it holds the person's keys and settings. */
  function load() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
      if (err && err.code === 'ENOENT') return { adminToken: '', apiKeys: [], providers: {} };
      throw badConfig(err);
    }
    let data;
    try { data = JSON.parse(text); } catch (err) { throw badConfig(err); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw badConfig(new Error('it is not a JSON object'));
    return {
      adminToken: typeof data.adminToken === 'string' && data.adminToken ? data.adminToken : '',
      apiKeys: Array.isArray(data.apiKeys) ? data.apiKeys : [],
      providers: data.providers && typeof data.providers === 'object' ? data.providers : {}
    };
  }
  function badConfig(err) {
    const e = new Error(`${file} is not valid (${String((err && err.message) || err)}). It holds your API key hashes and settings, so it was left as it is: fix it, or move it away to start fresh.`);
    e.friendly = true;
    return e;
  }

  try { fs.chmodSync(file, 0o600); } catch (_) { /* no file yet, or not ours */ }
  let state = load();
  if (!state.adminToken) {
    state.adminToken = crypto.randomBytes(24).toString('base64url');
    writeJson(file, state);
  }
  // The command line makes and revokes keys in the same file while the server runs: a change on disk is picked up at the next look.
  // A file that was edited into something invalid is not picked up (what is loaded keeps working) and is not written over until it is valid again.
  let seen = mtime();
  let broken = null;
  function mtime() { try { return fs.statSync(file).mtimeMs; } catch (_) { return 0; } }
  function refresh() {
    const now = mtime();
    if (now === seen) return;
    seen = now;
    try {
      const next = load();
      state = { ...next, adminToken: next.adminToken || state.adminToken };
      broken = null;
    } catch (err) { broken = err; }
  }
  const save = () => {
    if (broken) throw broken;
    writeJson(file, state);
    seen = mtime();
  };

  /** Makes a key, keeps only its hash, and hands the key back: this is the one time it can be read. */
  function createApiKey(name = '') {
    refresh();
    const secret = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
    const entry = {
      id: crypto.randomBytes(6).toString('hex'),
      name: String(name || '').trim().slice(0, 60) || 'key',
      hash: sha256(secret),
      hint: `${secret.slice(0, KEY_PREFIX.length + 4)}...${secret.slice(-4)}`,
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    };
    state.apiKeys.push(entry);
    save();
    return { key: secret, entry: publicKey(entry) };
  }

  const publicKey = (e) => ({ id: e.id, name: e.name, hint: e.hint, createdAt: e.createdAt, lastUsedAt: e.lastUsedAt });

  function listApiKeys() { refresh(); return state.apiKeys.map(publicKey); }

  function revokeApiKey(id) {
    refresh();
    const before = state.apiKeys.length;
    state.apiKeys = state.apiKeys.filter((k) => k.id !== id);
    if (state.apiKeys.length !== before) save();
    return state.apiKeys.length !== before;
  }

  /** The key entry a bearer secret belongs to, or null. Every stored hash is compared, so the time taken does not say which one was close. */
  function findApiKey(secret) {
    if (!secret) return null;
    refresh();
    const hash = sha256(secret);
    let found = null;
    for (const k of state.apiKeys) if (safeEqual(k.hash, hash)) found = k;
    if (found) {
      // lastUsedAt is kept in memory and written at most once a minute: a busy client must not rewrite the file on every call.
      const now = Date.now();
      const last = found.lastUsedAt ? Date.parse(found.lastUsedAt) : 0;
      found.lastUsedAt = new Date(now).toISOString();
      if (now - last > 60000) { try { save(); } catch (_) { /* a file that cannot be written now is not the caller's problem */ } }
    }
    return found ? { id: found.id, name: found.name } : null;
  }

  function adminTokenMatches(candidate) { return Boolean(candidate) && safeEqual(candidate, state.adminToken); }

  function providerSettings(id) { return { ...(state.providers[id] || {}) }; }

  function setProviderSettings(id, patch) {
    state.providers[id] = { ...(state.providers[id] || {}), ...patch };
    save();
    return providerSettings(id);
  }

  return { dataDir, file, createApiKey, listApiKeys, revokeApiKey, findApiKey, adminTokenMatches, adminToken: () => state.adminToken, providerSettings, setProviderSettings };
}

module.exports = { createConfig, defaultDataDir, readJson, writeJson, removeTree, ensureDir, safeEqual, sha256, KEY_PREFIX };
