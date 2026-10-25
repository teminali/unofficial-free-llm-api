/**
 * A local copy of the parts of chat.deepseek.com this program uses, for tests (never a real address; see src/providers/deepseek/base.js):
 *
 *   GET  /                          a page that, when `signedIn`, stores a session token in localStorage (userToken) and sets an HttpOnly cookie, like the web app
 *   GET  /api/v0/users/current      the profile (an example address that must only ever be seen masked)
 *   POST /api/v0/chat_session/create, /delete
 *   POST /api/v0/chat/create_pow_challenge   a challenge DeepSeekHashV1 can answer
 *   POST /api/v0/file/upload_file, GET /api/v0/file/fetch_files   an attached file: a proof-of-work for its path, a multipart upload, then its state (state.uploads, uploadState)
 *   POST /api/v0/chat/completion    checks the token, the cookie and the proof-of-work, then streams events in the shapes seen from the real site
 *
 * `state.reply(prompt, { thinking })` returns what the chat says: a string, or { text, thinking }. Other switches: muted, notice ('limit'), authFail, cut,
 * and failures of the network: `drop: { '<path>': n }` closes the connection on the next n requests to that path before any answer, `dropMidStream: n` closes it
 * after n events of a completion, `deleteStatus` answers every chat delete with that HTTP status, `algorithm` names another proof-of-work than DeepSeekHashV1.
 *
 * A chat keeps its messages like the real one: each answer has a message id that follows the one before it, and a completion that names a parent that is not the
 * chat's last message, or a chat that was deleted, is refused (`state.refuseParent` makes every continuation refused, to see the program recover).
 * `state.completions[i]` records `parent` (what the request named) and `session`; `state.requests` counts every request by path.
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const { deepseekHash } = require('../../src/providers/deepseek/pow');

const TOKEN = 'standin-token-0123456789abcdef0123456789';
const COOKIE = 'ds_standin=cookie-value-1234';

function startFakeDeepSeek() {
  const state = {
    signedIn: true,
    blockHeadless: false, // answer a hidden Chrome with the block page, like the real site
    blockStorage: false, // the page cannot use localStorage (a Chrome that does not allow site data)
    pageLoads: [], // who loaded the page: { hidden }
    wafDelayMs: 0, // issue the WAF token cookie this long after the page loaded (the real one is not instant)
    token: TOKEN,
    reply: () => 'Hello from the stand-in.',
    muted: false,
    notice: null,   // 'limit': DeepSeek's own "Messages too frequent" event
    authFail: false,
    completions: [],
    chats: new Map(), // chat id -> { last: id of its last message }
    refuseParent: false,
    requests: {},
    sessions: 0,
    created: [],
    deleted: [],
    challenges: new Map(),
    powFailures: 0,
    cookiesSeen: [],
    drop: {},
    dropMidStream: 0,
    deleteStatus: 0,
    algorithm: 'DeepSeekHashV1',
    uploads: [], // every file the stand-in took: { name, mime, size, sha, target (the proof-of-work path it was solved for) }
    uploadState: 'SUCCESS', // what the site says of a file once it has read it: SUCCESS, CONTENT_EMPTY, FAILED, or 'refuse' (the upload itself is answered with an error)
    parsingPolls: 1, // how many times fetch_files says PARSING before the state above
    polls: {}
  };
  const server = http.createServer((req, res) => {
    const body = (done) => { let text = ''; req.on('data', (c) => { text += c; }); req.on('end', () => { let json = {}; try { json = JSON.parse(text || '{}'); } catch (_) { /* keep what was there */ } done(json); }); };
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const authorized = () => req.headers.authorization === `Bearer ${state.token}` && !state.authFail;
    if (req.method === 'GET' && req.url === '/state') return json(200, { completions: state.completions.map(({ prompt, ...rest }) => ({ ...rest, promptHead: prompt.slice(0, 200) })), created: state.created, deleted: state.deleted, powFailures: state.powFailures, uploads: state.uploads });
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      const hidden = /HeadlessChrome/.test(String(req.headers['user-agent'] || ''));
      state.pageLoads.push({ hidden });
      // The real site answers a hidden (headless) Chrome with a "request blocked" page (measured 2026-10-22); an ordinary window gets the app and a WAF token
      if (state.blockHeadless && hidden) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><title>ERROR: The request could not be satisfied</title><body><h1>403 ERROR</h1><p>The request could not be satisfied. Request blocked.</p></body>');
      }
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      // a Chrome that does not let the site save data on the device: localStorage throws SecurityError, as in a sandboxed document
      if (state.blockStorage) headers['content-security-policy'] = 'sandbox allow-scripts';
      // ds_session_id is what DeepSeek gives anonymous visitors too: it must never be mistaken for a login
      if (state.signedIn) headers['set-cookie'] = [`${COOKIE}; Path=/; HttpOnly`, 'ds_session_id=anonymous-visitor; Path=/'];
      if (state.signedIn && !state.wafDelayMs) headers['set-cookie'].push('aws-waf-token=waf-standin; Path=/');
      res.writeHead(200, headers);
      return res.end(`<!doctype html><meta charset="utf-8"><title>DeepSeek</title><body><h1>${state.signedIn ? 'Chat' : 'Sign in'}</h1><script>${state.signedIn ? `localStorage.setItem('userToken', JSON.stringify({ value: ${JSON.stringify(state.token)}, __version: '0' }));` : ''}localStorage.setItem('ds_session_id', 'anonymous-visitor');${state.signedIn && state.wafDelayMs ? `setTimeout(function(){document.cookie='aws-waf-token=waf-late; path=/';}, ${Number(state.wafDelayMs)});` : ''}</script></body>`);
    }
    if (req.method === 'GET' && req.url === '/api/v0/users/current') {
      if (!authorized()) return json(401, { code: 40003, msg: 'token' });
      return json(200, { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { id: 'standin-user', email: 'owner@example.com', mobile_number: '', area_code: '' } } });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/v0/file/fetch_files')) {
      if (!authorized()) return json(401, { code: 40003, msg: 'token' });
      const id = new URL(req.url, 'http://x').searchParams.get('file_ids');
      state.polls[id] = (state.polls[id] || 0) + 1;
      const status = state.polls[id] <= state.parsingPolls ? 'PARSING' : state.uploadState;
      return json(200, { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { files: [{ id, status, file_name: 'x', file_size: 1 }] } } });
    }
    if (req.method !== 'POST') return json(404, { code: 404 });
    state.requests[req.url] = (state.requests[req.url] || 0) + 1;
    if (state.drop[req.url] > 0) { state.drop[req.url] -= 1; return req.socket.destroy(); } // the network went away: no answer at all
    if (!authorized()) return json(401, { code: 40003, msg: 'token' });
    if (req.url === '/api/v0/chat_session/create') { state.sessions += 1; const id = `standin-${state.sessions}`; state.created.push(id); state.chats.set(id, { last: 0 }); return json(200, { code: 0, msg: '', data: { biz_data: state.sessions % 2 ? { id } : { chat_session: { id } } } }); }
    if (req.url === '/api/v0/chat_session/delete') return body((b) => { if (state.deleteStatus) return json(state.deleteStatus, { code: state.deleteStatus, msg: 'stand-in failure' }); state.deleted.push(b.chat_session_id); json(200, { code: 0, msg: '', data: {} }); });
    if (req.url === '/api/v0/chat/create_pow_challenge') {
      return body((b) => {
        const target = String(b.target_path || '/api/v0/chat/completion');
        const salt = crypto.randomBytes(6).toString('hex');
        const expire_at = Math.floor(Date.now() / 1000) + 3600;
        const answer = Math.floor(Math.random() * 400) + 30;
        const challenge = deepseekHash(Buffer.from(`${salt}_${expire_at}_${answer}`, 'utf8'));
        const signature = crypto.randomBytes(8).toString('hex');
        state.challenges.set(signature, { challenge, salt, expire_at, answer, target });
        json(200, { code: 0, msg: '', data: { biz_data: { challenge: { algorithm: state.algorithm, challenge, salt, expire_at, difficulty: 1000, signature, target_path: target } } } });
      });
    }
    if (req.url === '/api/v0/file/upload_file') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let pow = null;
        try { pow = JSON.parse(Buffer.from(String(req.headers['x-ds-pow-response'] || ''), 'base64').toString('utf8')); } catch (_) { pow = null; }
        const known = pow && state.challenges.get(pow.signature);
        const solved = known && known.target === '/api/v0/file/upload_file' && deepseekHash(Buffer.from(`${known.salt}_${known.expire_at}_${pow.answer}`, 'utf8')) === known.challenge;
        if (!solved) { state.powFailures += 1; return json(400, { code: 40300, msg: 'MISSING_HEADER' }); }
        state.challenges.delete(pow.signature);
        if (state.uploadState === 'refuse') return json(400, { code: 40500, msg: 'file type not supported' }); // a refused file is not a refused login
        const raw = Buffer.concat(chunks);
        const text = raw.toString('latin1');
        const head = /name="file"; filename="([^"]*)"\r\nContent-Type: ([^\r]*)\r\n\r\n/.exec(text);
        if (!head) return json(400, { code: 40501, msg: 'no file' });
        const start = head.index + head[0].length;
        const end = raw.lastIndexOf(Buffer.from(`\r\n--${/boundary=(.+)$/.exec(String(req.headers['content-type'] || ''))[1]}`));
        const bytes = raw.subarray(start, end);
        const id = `file-${state.uploads.length + 1}`;
        state.uploads.push({ id, name: head[1], mime: head[2], size: bytes.length, sha: crypto.createHash('sha256').update(bytes).digest('hex'), target: known.target });
        json(200, { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { files: [{ id, status: 'PENDING', file_name: head[1], file_size: bytes.length }] } } });
      });
      return undefined;
    }
    if (req.url === '/api/v0/chat/completion') {
      return body(async (b) => {
        let pow = null;
        try { pow = JSON.parse(Buffer.from(String(req.headers['x-ds-pow-response'] || ''), 'base64').toString('utf8')); } catch (_) { pow = null; }
        const known = pow && state.challenges.get(pow.signature);
        const solved = known && deepseekHash(Buffer.from(`${known.salt}_${known.expire_at}_${pow.answer}`, 'utf8')) === known.challenge;
        if (!solved) { state.powFailures += 1; return json(400, { code: 40300, msg: 'MISSING_HEADER' }); }
        state.challenges.delete(pow.signature);
        const prompt = String(b.prompt || '');
        const thinking = b.thinking_enabled === true;
        const chat = state.chats.get(b.chat_session_id);
        const parent = b.parent_message_id === undefined ? null : b.parent_message_id;
        if (state.deleted.includes(b.chat_session_id) || !chat) return json(200, { code: 40400, msg: 'chat session not found', data: null });
        if (parent !== null && (state.refuseParent || parent !== chat.last)) return json(200, { code: 40400, msg: 'parent message not found', data: null });
        if (parent === null && chat.last !== 0) return json(200, { code: 40400, msg: 'parent message required', data: null });
        const respId = chat.last + 2;
        chat.last = respId;
        state.completions.push({ thinking, search: b.search_enabled, files: b.ref_file_ids, session: b.chat_session_id, parent, respId, cookie: String(req.headers.cookie || ''), prompt, ua: req.headers['user-agent'] });
        // DeepSeek muting the account, as seen in a real log: a successful HTTP answer whose body says the user is muted.
        if (state.muted) return json(200, { code: 0, msg: '', data: { biz_code: 5, biz_msg: 'user is muted', biz_data: { is_muted: 1, mute_until: (Date.now() + 72 * 3600 * 1000) / 1000 } } });
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        const events = [];
        if (state.notice === 'limit') {
          events.push({ type: 'error', content: 'Messages too frequent. Try again later.', finish_reason: 'rate_limit_reached', clear_response: true });
        } else {
          const said = await state.reply(prompt, { thinking });
          const out = typeof said === 'string' ? { text: said } : said;
          const chunks = (s) => s.match(/[\s\S]{1,9}/g) || [];
          if (thinking) {
            const [first = '', ...rest] = chunks(out.thinking || 'Weighing the options. ');
            events.push({ response_message_id: respId, v: { response: { fragments: [{ type: 'THINK', content: first }] } } });
            for (const c of rest) events.push({ p: 'response/fragments/-1/content', o: 'APPEND', v: c });
            const [t0 = '', ...tRest] = chunks(out.text || '');
            if (out.text) {
              events.push({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: t0 }] });
              for (const c of tRest) events.push({ p: 'response/fragments/-1/content', o: 'APPEND', v: c });
            }
          } else {
            const [first = '', ...rest] = chunks(out.text || '');
            events.push({ response_message_id: respId, v: { response: { fragments: [{ type: 'RESPONSE', content: first }] } } });
            for (const c of rest) events.push({ p: 'response/fragments/-1/content', o: 'APPEND', v: c });
          }
        }
        let i = 0;
        const next = () => {
          if (state.dropMidStream && i >= state.dropMidStream) return req.socket.destroy(); // the connection breaks in the middle of the answer
          if (i < events.length) { res.write(`data: ${JSON.stringify(events[i++])}\n\n`); setTimeout(next, 2); } else res.end();
        };
        next();
      });
    }
    return json(404, { code: 404 });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, state, port, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

module.exports = { startFakeDeepSeek, TOKEN, COOKIE };
