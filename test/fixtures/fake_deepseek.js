/**
 * A local copy of the parts of chat.deepseek.com this program uses, for tests (never a real address; see src/providers/deepseek/base.js):
 *
 *   GET  /                          a page that, when `signedIn`, stores a session token in localStorage (userToken) and sets an HttpOnly cookie, like the web app
 *   GET  /api/v0/users/current      the profile (an example address that must only ever be seen masked)
 *   POST /api/v0/chat_session/create, /delete
 *   POST /api/v0/chat/create_pow_challenge   a challenge DeepSeekHashV1 can answer
 *   POST /api/v0/chat/completion    checks the token, the cookie and the proof-of-work, then streams events in the shapes seen from the real site
 *
 * `state.reply(prompt, { thinking })` returns what the chat says: a string, or { text, thinking }. Other switches: muted, notice ('limit'), authFail, cut.
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
    token: TOKEN,
    reply: () => 'Hello from the stand-in.',
    muted: false,
    notice: null,   // 'limit': DeepSeek's own "Messages too frequent" event
    authFail: false,
    completions: [],
    sessions: 0,
    created: [],
    deleted: [],
    challenges: new Map(),
    powFailures: 0,
    cookiesSeen: []
  };
  const server = http.createServer((req, res) => {
    const body = (done) => { let text = ''; req.on('data', (c) => { text += c; }); req.on('end', () => { let json = {}; try { json = JSON.parse(text || '{}'); } catch (_) { /* keep what was there */ } done(json); }); };
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const authorized = () => req.headers.authorization === `Bearer ${state.token}` && !state.authFail;
    if (req.method === 'GET' && req.url === '/state') return json(200, { completions: state.completions.map(({ prompt, ...rest }) => ({ ...rest, promptHead: prompt.slice(0, 200) })), created: state.created, deleted: state.deleted, powFailures: state.powFailures });
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      // ds_session_id is what DeepSeek gives anonymous visitors too: it must never be mistaken for a login
      if (state.signedIn) headers['set-cookie'] = [`${COOKIE}; Path=/; HttpOnly`, 'ds_session_id=anonymous-visitor; Path=/'];
      res.writeHead(200, headers);
      return res.end(`<!doctype html><meta charset="utf-8"><title>DeepSeek</title><body><h1>${state.signedIn ? 'Chat' : 'Sign in'}</h1><script>${state.signedIn ? `localStorage.setItem('userToken', JSON.stringify({ value: ${JSON.stringify(state.token)}, __version: '0' }));` : ''}localStorage.setItem('ds_session_id', 'anonymous-visitor');</script></body>`);
    }
    if (req.method === 'GET' && req.url === '/api/v0/users/current') {
      if (!authorized()) return json(401, { code: 40003, msg: 'token' });
      return json(200, { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { id: 'standin-user', email: 'owner@example.com', mobile_number: '', area_code: '' } } });
    }
    if (req.method !== 'POST') return json(404, { code: 404 });
    if (!authorized()) return json(401, { code: 40003, msg: 'token' });
    if (req.url === '/api/v0/chat_session/create') { state.sessions += 1; const id = `standin-${state.sessions}`; state.created.push(id); return json(200, { code: 0, msg: '', data: { biz_data: state.sessions % 2 ? { id } : { chat_session: { id } } } }); }
    if (req.url === '/api/v0/chat_session/delete') return body((b) => { state.deleted.push(b.chat_session_id); json(200, { code: 0, msg: '', data: {} }); });
    if (req.url === '/api/v0/chat/create_pow_challenge') {
      const salt = crypto.randomBytes(6).toString('hex');
      const expire_at = Math.floor(Date.now() / 1000) + 3600;
      const answer = Math.floor(Math.random() * 400) + 30;
      const challenge = deepseekHash(Buffer.from(`${salt}_${expire_at}_${answer}`, 'utf8'));
      const signature = crypto.randomBytes(8).toString('hex');
      state.challenges.set(signature, { challenge, salt, expire_at, answer });
      return json(200, { code: 0, msg: '', data: { biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge, salt, expire_at, difficulty: 1000, signature, target_path: '/api/v0/chat/completion' } } } });
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
        state.completions.push({ thinking, search: b.search_enabled, session: b.chat_session_id, cookie: String(req.headers.cookie || ''), prompt, ua: req.headers['user-agent'] });
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
            events.push({ response_message_id: 2, v: { response: { fragments: [{ type: 'THINK', content: first }] } } });
            for (const c of rest) events.push({ p: 'response/fragments/-1/content', o: 'APPEND', v: c });
            const [t0 = '', ...tRest] = chunks(out.text || '');
            if (out.text) {
              events.push({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: t0 }] });
              for (const c of tRest) events.push({ p: 'response/fragments/-1/content', o: 'APPEND', v: c });
            }
          } else {
            const [first = '', ...rest] = chunks(out.text || '');
            events.push({ response_message_id: 2, v: { response: { fragments: [{ type: 'RESPONSE', content: first }] } } });
            for (const c of rest) events.push({ p: 'response/fragments/-1/content', o: 'APPEND', v: c });
          }
        }
        let i = 0;
        const next = () => { if (i < events.length) { res.write(`data: ${JSON.stringify(events[i++])}\n\n`); setTimeout(next, 2); } else res.end(); };
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
