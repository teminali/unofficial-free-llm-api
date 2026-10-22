/**
 * The HTTP server: the OpenAI-compatible API, the admin API the web interface uses, and the web interface itself, on one port.
 *
 *   /v1/models, /v1/chat/completions   the API. A key made in the interface (Authorization: Bearer sk-ula-...), or the interface's own sign-in.
 *   /_/...                             the admin API: link and unlink accounts, keys, settings, activity. The admin sign-in only.
 *   /health                            { ok: true }, no sign-in, for a container's health check.
 *   everything else                    the playground, a static page (web/).
 *
 * Safety, because this process holds the person's logins and anything that can reach it can spend their account:
 *  - It listens on loopback by default. On any other address the API still needs a key and the interface still needs the admin sign-in.
 *  - On loopback the Host header must name this server (a page on another site cannot reach it by rebinding its own name to 127.0.0.1).
 *  - The admin sign-in is a 24-byte token kept in config.json. Opening the login link trades it for a random session (an HttpOnly, SameSite=Strict cookie that
 *    holds nothing but the session's id; sessions live in memory, expire, and end at logout). A request that carries the cookie and is not a plain read must come
 *    from this server's own origin (Origin and Sec-Fetch-Site are checked), so another site cannot act with it.
 *  - With --no-key there is no credential to prove who is calling, so a browser's cross-site request is refused by its origin and the body must be JSON.
 *  - API keys are stored as hashes and shown once; the token and the keys are compared in constant time.
 *  - Bodies are capped, and nothing but metadata (model, status, time, sizes, the key's name) is ever logged or kept: never a prompt or an answer.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { safeEqual, sha256 } = require('./config');
const { sendJson, sendError, readBody, finishUpload } = require('./http_util');

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const UPLOAD_DRAIN_MS = 3000;
const COOKIE_PREFIX = 'ula_admin';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_LOG_KEEP = 100;
const NOTICE_KEEP = 50;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
// The page loads its own script and style and nothing else; the only inline thing it uses is the style the script sets through the CSSOM, which this allows.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function bearer(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  return m ? m[1] : '';
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) {
      try { return decodeURIComponent(part.slice(at + 1).trim()); } catch (_) { return ''; } // not valid percent-encoding: not a cookie of ours
    }
  }
  return '';
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * createServer({ config, registry, version, host, port, webDir, requireKey, cors, log })
 * `registry` is src/providers/index.js: list(), get(id), resolveModel(name), models().
 */
function createServer({ config, registry, version = '0.0.0', host = '127.0.0.1', port = 8420, webDir = path.join(__dirname, '..', 'web'), requireKey = true, cors = [], log = () => {} }) {
  const loopbackOnly = isLoopback(host);
  if (!requireKey && !loopbackOnly) throw new Error('Refusing to serve the API without keys on an address other than loopback.');
  if (!requireKey && cors.includes('*')) throw new Error('Refusing to serve the API without keys and to every website (--no-key with --cors "*"): any page could spend the account.');
  let server = null;
  let boundPort = port;
  const requests = [];
  const notices = [];
  const sessions = new Map(); // sha256(session id) -> expiry time; in memory, so a restart signs the browser out (the terminal prints a fresh link)
  // Cookies are shared between ports of one host, so each server keeps its own cookie name: two copies do not sign each other out.
  const cookieName = () => `${COOKIE_PREFIX}_${boundPort}`;

  function sessionFor(req) {
    const id = cookieValue(req.headers.cookie, cookieName());
    if (!id) return null;
    const key = sha256(id);
    const until = sessions.get(key);
    if (!until) return null;
    if (until < Date.now()) { sessions.delete(key); return null; }
    return key;
  }
  function startSession() {
    const now = Date.now();
    for (const [key, until] of sessions) if (until < now) sessions.delete(key);
    const id = crypto.randomBytes(32).toString('base64url');
    sessions.set(sha256(id), now + SESSION_MS);
    return id;
  }

  const record = (entry) => { requests.unshift(entry); if (requests.length > REQUEST_LOG_KEEP) requests.pop(); };
  const addNotice = (n) => { notices.unshift({ at: new Date().toISOString(), ...n }); if (notices.length > NOTICE_KEEP) notices.pop(); };
  registry.onNotice(addNotice);

  function allowedHost(header) {
    if (!loopbackOnly) return true; // an exposed server is guarded by its sign-ins, not by its name
    const name = String(header || '').toLowerCase();
    return [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(name);
  }

  /** Who is calling: { kind: 'admin' } for the interface's sign-in, { kind: 'key', name } for an API key, or null. */
  function authenticate(req) {
    const secret = bearer(req.headers.authorization) || String(req.headers['x-api-key'] || '');
    if (secret) {
      if (config.adminTokenMatches(secret)) return { kind: 'admin' };
      const key = config.findApiKey(secret);
      if (key) return { kind: 'key', name: key.name };
    }
    if (sessionFor(req)) return { kind: 'admin', viaCookie: true };
    return null;
  }

  /** A request that carries the sign-in cookie and changes something must come from this server's own pages. */
  function sameOrigin(req) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch (_) { return false; }
  }

  /**
   * With no keys the only thing between a browser page and the account is where the request came from. A request is let in when it carries no browser
   * headers at all (a script, curl, an SDK), or when it comes from this server's own page, or from an origin that --cors names. Anything else is a page
   * on another site, which could otherwise send a "simple" cross-site POST that needs no preflight.
   */
  function openModeAllows(req) {
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (origin !== undefined) {
      if (cors.includes(origin)) return true;
      try { return origin !== 'null' && new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch (_) { return false; }
    }
    return !site || site === 'same-origin' || site === 'none';
  }

  function corsHeaders(req) {
    if (!cors.length) return {};
    const origin = req.headers.origin;
    if (!origin) return {};
    if (!cors.includes('*') && !cors.includes(origin)) return {};
    return { 'Access-Control-Allow-Origin': cors.includes('*') ? '*' : origin, Vary: 'Origin' };
  }

  function baseUrl() { return `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : (host.includes(':') ? `[${host}]` : host)}:${boundPort}`; }

  /** The JSON object in the body, or null after an error has been answered (so a caller's `if (!body) return` is always right). */
  async function jsonBody(req, res) {
    try {
      const raw = await readBody(req, MAX_BODY_BYTES);
      const value = raw ? JSON.parse(raw) : {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        sendError(res, 400, 'bad_body', 'The request body must be a JSON object.');
        return null;
      }
      return value;
    } catch (err) {
      if (err && err.status === 413) await finishUpload(req, UPLOAD_DRAIN_MS);
      sendError(res, err && err.status ? err.status : 400, 'bad_body', err && err.status === 413 ? err.message : 'The request body is not valid JSON.');
      return null;
    }
  }

  // ---- the API --------------------------------------------------------------------------------------------------------------------------------

  async function handleApi(req, res, url, who) {
    const extra = who.kind === 'key' ? corsHeaders(req) : {};
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: registry.models().map((m) => ({ id: m.id, object: 'model', created: m.created || 0, owned_by: m.provider, name: m.name, ...(m.thinking ? { reasoning: true } : {}) }))
      }, extra);
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return sendError(res, 404, 'not_found', 'Unknown route. This server has /v1/models and /v1/chat/completions.', extra);
    if (who.viaCookie && !sameOrigin(req)) return sendError(res, 403, 'forbidden_origin', 'This request did not come from this server\'s own page.');
    if (who.kind === 'open' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return sendError(res, 415, 'unsupported_media_type', 'Without keys the body must be sent as "Content-Type: application/json".');
    }
    const body = await jsonBody(req, res);
    if (!body) return undefined;
    if (!Array.isArray(body.messages) || !body.messages.length) return sendError(res, 400, 'invalid_messages', '"messages" must be a non-empty array.', extra);
    const wanted = typeof body.model === 'string' ? body.model.trim() : '';
    const entry = registry.resolveModel(wanted);
    if (!entry) {
      const names = registry.models().map((m) => m.id);
      return sendError(res, 404, 'model_not_found', `No linked model called "${wanted}".${names.length ? ` Available: ${names.join(', ')}.` : ' No account is linked yet: open the web interface and link one.'}`, extra);
    }
    const provider = registry.get(entry.provider);
    const state = await provider.status();
    if (!state.linked) return sendError(res, 409, `${provider.id}_not_linked`, `${provider.name} is not linked. Open ${baseUrl()} and link it on the Accounts page.`, extra);
    if (state.expired) return sendError(res, 401, `${provider.id}_session_expired`, state.expiredReason || `Your ${provider.name} session has expired. Sign in again on the Accounts page.`, extra);
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    const started = Date.now();
    const result = await provider.engine.chat(res, body, entry);
    record({
      at: new Date(started).toISOString(), provider: provider.id, model: entry.id, stream: body.stream === true, tools: Array.isArray(body.tools) ? body.tools.length : 0,
      status: result.status, code: result.code || null, ms: Date.now() - started, chars: result.chars || 0, by: who.kind === 'key' ? who.name : 'web interface'
    });
    return undefined;
  }

  // ---- the admin API --------------------------------------------------------------------------------------------------------------------------

  async function publicState() {
    const providers = [];
    for (const p of registry.list()) providers.push({ id: p.id, name: p.name, capabilities: p.capabilities, ...(await p.status()) });
    return { version, baseUrl: baseUrl(), providers, keys: config.listApiKeys(), requests, notices, requireKey, models: registry.models() };
  }

  async function handleAdmin(req, res, url) {
    if (req.method !== 'GET' && !sameOrigin(req)) return sendError(res, 403, 'forbidden_origin', 'This request did not come from this server\'s own page.');
    const route = url.pathname.slice(2); // after "/_"
    const send = (payload = { ok: true }) => sendJson(res, 200, payload);

    if (req.method === 'GET' && route === '/state') return send(await publicState());
    if (req.method === 'POST' && route === '/logout') {
      const key = sessionFor(req);
      if (key) sessions.delete(key);
      res.setHeader('Set-Cookie', `${cookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return send();
    }
    if (req.method === 'GET' && route === '/keys') return send({ keys: config.listApiKeys() });
    if (req.method === 'POST' && route === '/keys') {
      const body = await jsonBody(req, res);
      if (!body) return undefined;
      return send(config.createApiKey(body.name));
    }
    const keyMatch = /^\/keys\/([a-f0-9]+)$/.exec(route);
    if (req.method === 'DELETE' && keyMatch) return config.revokeApiKey(keyMatch[1]) ? send() : sendError(res, 404, 'not_found', 'No such key.');

    const providerMatch = /^\/providers\/([a-z0-9-]+)\/(link|finish|unlink|token|settings|reset)$/.exec(route);
    if (providerMatch) {
      const provider = registry.get(providerMatch[1]);
      if (!provider) return sendError(res, 404, 'not_found', 'No such provider.');
      const action = providerMatch[2];
      if (req.method !== 'POST' && !(req.method === 'PUT' && action === 'settings')) return sendError(res, 405, 'method_not_allowed', 'Wrong method.');
      const body = await jsonBody(req, res);
      if (!body) return undefined;
      if (action === 'link') return send(await provider.startLink({ consentAcknowledged: body.consentAcknowledged === true }));
      if (action === 'finish') return send(await provider.finishLink({ cancel: body.cancel === true }));
      if (action === 'unlink') return send(await provider.unlink());
      if (action === 'reset') { provider.resetUsage(); return send(); }
      if (action === 'settings') return send(await provider.setSettings(body));
      if (action === 'token') {
        if (typeof provider.linkToken !== 'function') return sendError(res, 400, 'not_supported', `${provider.name} cannot be linked with a pasted token.`);
        return send(await provider.linkToken({ token: body.token, consentAcknowledged: body.consentAcknowledged === true }));
      }
    }
    return sendError(res, 404, 'not_found', 'Unknown admin route.');
  }

  // ---- the web interface ----------------------------------------------------------------------------------------------------------------------

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method_not_allowed', 'Wrong method.');
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch (_) { return sendError(res, 400, 'bad_url', 'Bad request address.'); }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(webDir, rel));
    if (file !== webDir && !file.startsWith(webDir + path.sep)) return sendError(res, 403, 'forbidden', 'No.');
    let stat;
    try { stat = fs.statSync(file); } catch (_) { return sendError(res, 404, 'not_found', 'Not found.'); }
    if (!stat.isFile()) return sendError(res, 404, 'not_found', 'Not found.');
    const headers = {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    };
    if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
    // Open first, answer after: a file that stats fine but cannot be opened (permissions, deleted a moment ago) is an error response, not a thrown event.
    const stream = fs.createReadStream(file);
    stream.once('error', () => {
      if (!res.headersSent) sendError(res, 500, 'server_error', 'That file could not be read.');
      else res.destroy();
    });
    stream.once('open', () => { res.writeHead(200, headers); stream.pipe(res); });
    res.once('close', () => stream.destroy());
    return undefined;
  }

  /** `GET /_/login?token=...` sets the sign-in cookie and goes to the page: the link the terminal prints. */
  function handleLogin(req, res, url) {
    const token = url.searchParams.get('token') || '';
    if (!config.adminTokenMatches(token)) return sendError(res, 401, 'bad_token', 'That token is not this server\'s admin token.');
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': `${cookieName()}=${startSession()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    });
    return res.end();
  }

  async function handle(req, res) {
    if (!allowedHost(req.headers.host)) return sendError(res, 403, 'forbidden_host', 'This server answers only to its own address.');
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || host}`); } catch (_) { return sendError(res, 400, 'bad_url', 'Bad request address.'); }
    const pathname = url.pathname;

    if (pathname === '/health') return sendJson(res, 200, { ok: true, version });
    if (pathname === '/_/login' && req.method === 'GET') return handleLogin(req, res, url);

    if (pathname.startsWith('/v1/') || pathname === '/v1') {
      if (req.method === 'OPTIONS') {
        const extra = corsHeaders(req);
        if (!Object.keys(extra).length) return sendError(res, 403, 'cors_off', 'Cross-origin calls are off. Start the server with --cors to allow them.');
        res.writeHead(204, { ...extra, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type, x-api-key', 'Access-Control-Max-Age': '600' });
        return res.end();
      }
      const who = authenticate(req);
      if (!who && !(!requireKey && loopbackOnly)) {
        return sendError(res, 401, 'invalid_api_key', 'Missing or wrong API key. Send "Authorization: Bearer sk-ula-..." with a key made in the web interface.', { 'WWW-Authenticate': 'Bearer' });
      }
      if (!who && !openModeAllows(req)) return sendError(res, 403, 'forbidden_origin', 'Without keys, this server does not answer pages from other sites.');
      return handleApi(req, res, url, who || { kind: 'open' });
    }

    if (pathname.startsWith('/_/')) {
      const who = authenticate(req);
      if (!who || who.kind !== 'admin') return sendError(res, 401, 'admin_required', 'Sign in to the web interface first (open the link the terminal printed).');
      return handleAdmin(req, res, url);
    }
    return serveStatic(req, res, url);
  }

  function start() {
    if (server) return Promise.resolve({ url: baseUrl(), port: boundPort });
    return new Promise((resolve, reject) => {
      const listener = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          log(`server: request failed: ${String((e && e.message) || e)}`);
          if (!res.headersSent) sendError(res, 500, 'server_error', 'The server hit an error handling this request.');
          else if (!res.writableEnded) res.end();
        });
      });
      listener.once('error', (err) => reject(err));
      listener.listen(port, host, () => {
        server = listener;
        boundPort = listener.address().port;
        log(`server: listening on ${host}:${boundPort}`);
        resolve({ url: baseUrl(), port: boundPort });
      });
    });
  }

  async function stop() {
    await registry.stop();
    const listener = server;
    server = null;
    if (!listener) return;
    await new Promise((resolve) => {
      if (typeof listener.closeAllConnections === 'function') listener.closeAllConnections();
      listener.close(() => resolve());
    });
  }

  return { start, stop, url: baseUrl, requests, notices, loopbackOnly, adminLoginUrl: () => `${baseUrl()}/_/login?token=${encodeURIComponent(config.adminToken())}` };
}

module.exports = { createServer, bearer, cookieValue, isLoopback, safeEqual };
