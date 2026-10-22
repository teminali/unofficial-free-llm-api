/**
 * The DeepSeek web completion client.
 *
 * The web app's own endpoints are called with the session token saved by link.js: a proof-of-work challenge solved the way the web app solves it (pow.js),
 * then the completion stream. One fresh chat session per call, because the engine rebuilds the whole conversation itself on every request; the session is
 * deleted as soon as the answer is in, so the person's web history stays clean.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { sessionExpiry } = require('./session_expiry');
const { CHROME_UA, DEFAULT_BASE } = require('./base');
const { powHeader: solvePow } = require('./pow');

const REQUEST_TIMEOUT_MS = 180000;

/**
 * What an error answer means. The status code and DeepSeek's own JSON fields decide; words found anywhere in a body that is not DeepSeek's JSON (a proxy's error
 * page, say) decide nothing, because a good login must never be marked expired, or a 20 minute rest set, by a page that merely mentions "token" or "403".
 * Nor is such a body handed to the API client as the error message.
 */
function classifyError(status, data, text) {
  const isJson = Boolean(data) && typeof data === 'object';
  const msg = isJson ? String(data.msg || '').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const loginPage = !isJson && /login\.deepseek\.com|chat\.deepseek\.com\/login/i.test(String(text || '').slice(0, 20000));
  if (status === 401 || (isJson && (data.code === 40001 || data.code === 40003)) || /token|auth|login|unauthorized/i.test(msg) || loginPage) {
    return {
      type: 'auth_expired',
      status: status || 401,
      message: 'Your DeepSeek session has expired. Sign in again on the Accounts page.'
    };
  }
  if (status === 429 || status === 403 || /rate limit|too many requests|throttle/i.test(msg)) {
    return {
      type: 'rate_limited',
      status: status || 429,
      message: `DeepSeek returned ${status || 429} (rate limited or access denied). Pausing DeepSeek requests for a while to protect your account.`
    };
  }
  if (/MISSING_HEADER|\bpow\b|verify/i.test(msg)) {
    return {
      type: 'pow_failed',
      status,
      message: 'DeepSeek refused this request as automated traffic. Try again in a moment.'
    };
  }
  return {
    type: 'general',
    status,
    message: msg || (status ? `DeepSeek answered with HTTP ${status} and could not answer.` : 'DeepSeek could not answer.')
  };
}

/** The time DeepSeek has muted an account until (ms), or null when the answer is not a mute: { data: { biz_code: 5, biz_msg: "user is muted", biz_data: { is_muted: 1, mute_until: <seconds> } } }. */
function mutedUntil(data) {
  const d = data && data.data;
  if (!d || typeof d !== 'object') return null;
  const bizData = d.biz_data && typeof d.biz_data === 'object' ? d.biz_data : {};
  if (!(Number(bizData.is_muted) === 1 || /muted/i.test(String(d.biz_msg || '')))) return null;
  const until = Number(bizData.mute_until);
  return Number.isFinite(until) && until > 0 ? Math.round(until * 1000) : Date.now() + 24 * 3600 * 1000;
}

/** What the person is told: when it ends, why it usually happens, and that nothing is retried (every retry sends more requests to a muted account). */
function mutedMessage(untilMs, account = '') {
  const when = new Date(untilMs).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return `DeepSeek has muted this account${account ? ` (${account})` : ''} until ${when}. DeepSeek does this after messages come too quickly, and nothing can be sent to it from this bridge or from DeepSeek's own site until then. No retries are made: each one would only make it worse.`;
}

function plainError(data) {
  const classified = classifyError(null, data, null);
  return classified.message;
}

function createDeepSeekWeb({ dataDir, base = DEFAULT_BASE, log = () => {}, governor = null, onAuthExpired = () => {} }) {
  const BASE = base;
  const sessionPath = () => path.join(dataDir, 'deepseek_session.json');

  function token() {
    try {
      const data = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
      if (!data || typeof data.token !== 'string' || !data.token) return null;
      if (data.expired) return null;
      const exp = sessionExpiry(data);
      if (exp !== null && Date.now() >= exp) return null;
      return data.token;
    } catch (_) { return null; }
  }

  /** A login that was linked and has since expired (DeepSeek refused it, or its own expiry passed): different from no login at all. */
  function hadLogin() {
    try {
      const data = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
      return Boolean(data && typeof data.token === 'string' && data.token);
    } catch (_) { return false; }
  }

  /** The masked account label kept in the session file (account.js), only for the login it was read with. */
  function savedAccountLabel() {
    try {
      const data = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
      return data && typeof data.accountLabel === 'string' && data.accountTokenTail === String(data.token || '').slice(-8) ? data.accountLabel : '';
    } catch (_) { return ''; }
  }

  function cookieHeader() {
    try {
      const data = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
      if (Array.isArray(data.cookies) && data.cookies.length > 0) {
        return data.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      }
    } catch (_) {}
    return '';
  }

  function headers(extra = {}) {
    const c = cookieHeader();
    const h = {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
      'user-agent': CHROME_UA,
      origin: BASE,
      referer: `${BASE}/`,
      ...extra
    };
    if (c) h.cookie = c;
    return h;
  }

  async function api(pathname, body, signal) {
    const res = await fetch(BASE + pathname, { method: 'POST', headers: headers(), body: JSON.stringify(body || {}), signal, redirect: 'error' });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = null; }
    const mutedMs = mutedUntil(data);
    if (mutedMs) { const err = new Error(mutedMessage(mutedMs, savedAccountLabel())); err.classified = { type: 'muted', status: res.status, message: err.message, until: mutedMs }; err.status = res.status; throw err; }
    if (!res.ok || (data && data.code && data.code !== 0)) {
      const errInfo = classifyError(res.status, data, text);
      const err = new Error(errInfo.message);
      err.classified = errInfo;
      err.status = res.status;
      throw err;
    }
    return { status: res.status, data, text };
  }

  async function createSession(signal) {
    const r = await api('/api/v0/chat_session/create', {}, signal);
    // DeepSeek answers in two shapes at the same time (seen 2026-10-20, about half each): the id at biz_data.id, or at biz_data.chat_session.id.
    const biz = r.data && r.data.data && r.data.data.biz_data;
    const id = biz && (biz.id || (biz.chat_session && biz.chat_session.id));
    if (!id) throw new Error('DeepSeek did not open a chat session');
    return id;
  }

  /**
   * Removes a chat session the bridge opened. Fire and forget: the answer has already been read, and a
   * cleanup failure must never fail the turn. Only ids this module created are ever passed here.
   */
  function discardSession(id) {
    if (!id) return;
    let signal;
    try { signal = AbortSignal.timeout(15000); } catch (_) { signal = undefined; }
    fetch(`${BASE}/api/v0/chat_session/delete`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ chat_session_id: id }),
      signal,
      redirect: 'error'
    }).then((res) => {
      if (!res.ok) log(`deepseek web: session cleanup returned ${res.status}`);
    }).catch((err) => {
      log('deepseek web: session cleanup failed: ' + String((err && err.message) || err));
    });
  }

  async function powHeader(signal) {
    const r = await api('/api/v0/chat/create_pow_challenge', { target_path: '/api/v0/chat/completion' }, signal);
    const challenge = r.data && r.data.data && r.data.data.biz_data && r.data.data.biz_data.challenge;
    if (!challenge) throw new Error('DeepSeek did not send a proof-of-work challenge');
    return solvePow(challenge);
  }

  /** One completion on one chat session. Resolves { ok, text, thinking, responseMessageId } or { failed, code, authExpired, rateLimited }. */
  async function completion({ chatSessionId, parentMessageId = null, prompt, thinking = true, signal, onDelta = () => {}, onSent = () => {} }) {
    const pow = await powHeader(signal);
    if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    onSent();
    const res = await fetch(`${BASE}/api/v0/chat/completion`, {
      method: 'POST',
      headers: headers({ 'x-ds-pow-response': pow, accept: 'text/event-stream' }),
      body: JSON.stringify({
        chat_session_id: chatSessionId,
        parent_message_id: parentMessageId,
        prompt,
        ref_file_ids: [],
        thinking_enabled: Boolean(thinking),
        search_enabled: false
      }),
      signal,
      redirect: 'error' // a redirect would send the prompt (a POST body) on to wherever it points
    });
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/event-stream')) {
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { data = null; }
      const mutedMs = mutedUntil(data);
      if (mutedMs) return { failed: mutedMessage(mutedMs, savedAccountLabel()), muted: true, mutedUntilMs: mutedMs };
      const errInfo = classifyError(res.status, data, text);
      return {
        failed: errInfo.message,
        code: data && data.code,
        authExpired: errInfo.type === 'auth_expired',
        rateLimited: errInfo.type === 'rate_limited'
      };
    }

    let answer = '';
    let think = '';
    let lastType = thinking ? 'THINK' : 'RESPONSE';
    let responseMessageId = null;
    let notice = null;
    const take = (f) => {
      lastType = f.type;
      if (!f.content) return;
      if (f.type === 'THINK') { think += f.content; onDelta({ type: 'think', text: f.content }); }
      else { answer += f.content; onDelta({ type: 'answer', text: f.content }); }
    };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const consume = (line) => {
      if (!line.startsWith('data: ')) return;
      const payload = line.slice(6).trim();
      if (!payload) return;
      let ev;
      try { ev = JSON.parse(payload); } catch (_) { return; }
      if (ev.response_message_id) responseMessageId = ev.response_message_id;
      // DeepSeek's own notice that it will not answer (a "hint" event): { type: 'error', content, clear_response, finish_reason: 'rate_limit_reached' }.
      if (ev.type === 'error' && (ev.finish_reason || ev.clear_response)) {
        notice = { message: String(ev.content || '').replace(/\s+/g, ' ').trim().slice(0, 300), reason: String(ev.finish_reason || ''), clear: Boolean(ev.clear_response) };
        return;
      }
      if (ev.v && ev.v.response) {
        for (const f of ev.v.response.fragments || []) take(f);
        return;
      }
      if (ev.p === 'response/fragments' && ev.o === 'APPEND' && Array.isArray(ev.v)) {
        for (const f of ev.v) take(f);
        return;
      }
      const append = (ev.p === 'response/fragments/-1/content' || ev.p === undefined) && typeof ev.v === 'string';
      if (append) {
        if (lastType === 'THINK') { think += ev.v; onDelta({ type: 'think', text: ev.v }); }
        else { answer += ev.v; onDelta({ type: 'answer', text: ev.v }); }
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, '');
        buffer = buffer.slice(at + 1);
        consume(line);
      }
    }
    if (buffer) consume(buffer.replace(/\r$/, ''));
    // The notice replaces the answer: what was streamed before it is withdrawn, and an empty answer behind it is not "finished".
    if (notice && (notice.clear || !answer.trim())) {
      const limited = /rate.?limit|too.?many|busy|quota|limit/i.test(`${notice.reason} ${notice.message}`);
      if (limited) {
        return {
          failed: `DeepSeek has reached its own limit for this account${notice.message ? ` ("${notice.message}")` : ''}. Pausing DeepSeek requests for ${Math.round(((governor && governor.refusalCooldownMs) || 300000) / 60000)} minutes to protect your account.`,
          rateLimited: true
        };
      }
      return { failed: notice.message || 'DeepSeek could not answer.' };
    }
    return { ok: true, text: answer, thinking: think, responseMessageId };
  }

  /**
   * One prompt on a fresh chat session.
   * On auth expiration or 429/403, notifies and halts immediately without blind retries.
   */
  async function completeOnce({ prompt, thinking = true, signal = null, onDelta = () => {} }) {
    if (!token()) {
      // A call that arrives after another one found the login refused (a title and the turn itself, say) gets the same plain answer, not "link an account".
      if (hadLogin()) return { ok: false, error: 'Your DeepSeek session has expired. Sign in again on the Accounts page.', authExpired: true };
      return { ok: false, error: 'Link a DeepSeek account first on the Accounts page.' };
    }
    let chatSessionId = null;
    let sent = false; // the completion request left: from here on the account has been spent, whether or not anyone reads the answer
    try {
      chatSessionId = await createSession(signal);
      const out = await completion({ chatSessionId, prompt, thinking, signal, onDelta, onSent: () => { sent = true; } });
      discardSession(chatSessionId);
      if (!out.failed) return { ok: true, text: out.text, thinking: out.thinking };
      if (out.muted) {
        if (governor) governor.setCooldown(Math.max(60000, out.mutedUntilMs - Date.now()), 'DeepSeek muted this account');
        return { ok: false, error: out.failed, rateLimited: true, noticeKind: 'muted', noticeShort: 'DeepSeek muted this account' };
      }
      if (out.authExpired) {
        onAuthExpired(out.failed);
        return { ok: false, error: out.failed, authExpired: true };
      }
      if (out.rateLimited) {
        if (governor) governor.setCooldown(undefined, '429/403 rate limit');
        return { ok: false, error: out.failed, rateLimited: true };
      }
      return { ok: false, error: out.failed };
    } catch (err) {
      discardSession(chatSessionId);
      if (signal && signal.aborted) return { ok: false, cancelled: true, sent };
      const classified = err && err.classified ? err.classified : null;
      if (classified?.type === 'muted') {
        if (governor) governor.setCooldown(Math.max(60000, classified.until - Date.now()), 'DeepSeek muted this account');
        return { ok: false, error: classified.message, rateLimited: true, noticeKind: 'muted', noticeShort: 'DeepSeek muted this account' };
      }
      if (classified?.type === 'auth_expired') {
        onAuthExpired(classified.message);
        return { ok: false, error: classified.message, authExpired: true };
      }
      if (classified?.type === 'rate_limited') {
        if (governor) governor.setCooldown(undefined, '429/403 rate limit');
        return { ok: false, error: classified.message, rateLimited: true };
      }
      const msg = String((err && err.message) || err);
      log('deepseek web error: ' + msg);
      return { ok: false, error: msg || 'DeepSeek could not answer.' };
    }
  }

  return { token, completeOnce, REQUEST_TIMEOUT_MS };
}

module.exports = { createDeepSeekWeb, plainError, classifyError, mutedUntil, mutedMessage, REQUEST_TIMEOUT_MS };
