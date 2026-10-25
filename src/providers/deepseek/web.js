/**
 * The DeepSeek web completion client.
 *
 * The web app's own endpoints are called with the session token saved by link.js: a proof-of-work challenge solved the way the web app solves it (pow.js),
 * then the completion stream. By default one fresh chat session per call, deleted as soon as the answer is in, so the person's web history stays clean. A call
 * made with `keep` leaves the chat open and hands back a `remote` ({ id, lastId }: the chat and the message the next one continues from), and a call made with
 * that `remote` continues the same chat: that is what the engine does for a conversation it has seen before (src/sessions.js), the way the web app continues a
 * chat. The engine asks for a chat to be removed with `closeSession`; only chats this module opened are ever passed to it.
 *
 * Pictures (`images`): the engine hands the pictures of a prompt to `completeOnce`, which sends them to the site as attached files (see "pictures" below) and says
 * in the prompt about any that could not go. What the site does with a picture (reading its text, or looking at it) is the site's: the bridge only attaches it.
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

// A failed network call says "fetch failed" and keeps the real reason in `cause`. These are the reasons that mean the connection, not DeepSeek, failed.
const NETWORK_REASONS = {
  ENOTFOUND: 'its address could not be looked up', EAI_AGAIN: 'its address could not be looked up', ECONNREFUSED: 'the connection was refused',
  ECONNRESET: 'the connection was reset', ETIMEDOUT: 'the connection timed out', UND_ERR_CONNECT_TIMEOUT: 'the connection timed out',
  UND_ERR_HEADERS_TIMEOUT: 'it did not answer in time', UND_ERR_BODY_TIMEOUT: 'it stopped answering', UND_ERR_SOCKET: 'the connection was closed',
  EPIPE: 'the connection was closed', ENETUNREACH: 'there is no network', EHOSTUNREACH: 'it could not be reached', ENETDOWN: 'there is no network'
};
function networkCode(err) {
  const cause = err && err.cause;
  return String((cause && (cause.code || (Array.isArray(cause.errors) && cause.errors[0] && cause.errors[0].code))) || (err && err.code) || '');
}
/** True when the connection failed (not DeepSeek answering badly, not a caller who left). */
function isNetworkError(err) {
  if (!err || err.classified || err.name === 'AbortError') return false;
  if (NETWORK_REASONS[networkCode(err)]) return true;
  return err.name === 'TypeError' && /fetch failed|terminated|other side closed/i.test(String(err.message || ''));
}
function networkReason(err) { return NETWORK_REASONS[networkCode(err)] || 'the connection failed'; }

/** A pause that a caller who leaves cuts short. */
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

/** One event of the stream by its names, never its words: what kind it is, which part it patches, and a state value such as FINISHED. */
function describeEvent(ev) {
  if (!ev || typeof ev !== 'object') return typeof ev;
  const state = (p, v) => (/status/i.test(String(p || '')) && typeof v === 'string' ? `=${v.slice(0, 24)}` : '');
  const parts = [];
  if (ev.type) parts.push(`type=${String(ev.type).slice(0, 24)}`);
  if (ev.p) parts.push(`p=${String(ev.p).slice(0, 40)}${state(ev.p, ev.v)}`);
  if (ev.o) parts.push(`o=${String(ev.o).slice(0, 12)}`);
  if (Array.isArray(ev.v)) parts.push('v:[' + ev.v.slice(0, 4).map((x) => (x && typeof x === 'object' ? String(x.p || x.type || 'object').slice(0, 30) + state(x.p, x.v) : typeof x)).join(',') + ']');
  else if (ev.v && typeof ev.v === 'object') parts.push('v:{' + Object.keys(ev.v).slice(0, 6).join(',') + '}');
  if (!parts.length) parts.push('keys:' + Object.keys(ev).slice(0, 6).join(','));
  return parts.join(' ');
}

function createDeepSeekWeb({ dataDir, base = DEFAULT_BASE, log = () => {}, governor = null, onAuthExpired = () => {}, networkRetryMs = 800, closeRetryMs = 30000, uploadPollMs = 800, uploadWaitMs = 40000, uploadKeepMs = 15 * 60 * 1000, maxPictures = 4, maxPictureBytes = 10 * 1048576 }) {
  const BASE = base;
  let streamEndLogged = false; // how a real stream ends is written to the log once per run, by names only (see completion)
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
    return read(res);
  }

  /** What an answer of the site's JSON API means: { status, data, text }, or an error that says what it was (muted, refused, expired). */
  async function read(res) {
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
   * Removes a chat session the bridge opened. Never rejects, and a cleanup failure must never fail the turn. Only ids this module created are ever passed here.
   * Resolves 'done' (removed, or DeepSeek's answer says there is nothing to wait for: the chat is gone, the login is refused) or 'later' (the network failed or DeepSeek
   * had an error of its own: the chat is still there and removing it is worth asking again).
   */
  async function deleteChat(id) {
    if (!id || !token()) return 'done';
    let signal;
    try { signal = AbortSignal.timeout(15000); } catch (_) { signal = undefined; }
    try {
      const res = await fetch(`${BASE}/api/v0/chat_session/delete`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ chat_session_id: id }),
        signal,
        redirect: 'error'
      });
      if (res.ok) return 'done';
      log(`deepseek web: session cleanup returned ${res.status}`);
      return res.status >= 500 || res.status === 429 ? 'later' : 'done';
    } catch (err) {
      log('deepseek web: session cleanup failed: ' + String((err && err.message) || err));
      return 'later';
    }
  }
  function discardSession(id) {
    deleteChat(id);
  }
  /**
   * Removes a chat that was kept for a session (the engine's call: the session ended, expired, or the program is stopping). While the account is resting after a
   * refusal nothing is sent to it, not even this: the answer says to ask again later. So does a removal that failed because of the network: the chat stays on the
   * engine's list (and written down), and is removed when it can be.
   */
  async function closeSession(remote) {
    if (!remote || !remote.id) return undefined;
    const limit = governor ? governor.checkLimit() : { allowed: true };
    if (!limit.allowed && limit.reason === 'cooldown') return { retryAfterMs: Math.min(15 * 60 * 1000, Math.max(30 * 1000, (limit.retryAfterSec || 60) * 1000)) };
    return (await deleteChat(remote.id)) === 'later' ? { retryAfterMs: closeRetryMs } : undefined;
  }

  async function powHeader(signal, target = '/api/v0/chat/completion') {
    const r = await api('/api/v0/chat/create_pow_challenge', { target_path: target }, signal);
    const challenge = r.data && r.data.data && r.data.data.biz_data && r.data.data.biz_data.challenge;
    if (!challenge) throw new Error('DeepSeek did not send a proof-of-work challenge');
    // Only the one algorithm this program has is worked on: another one would be searched through its whole difficulty and then fail.
    if (challenge.algorithm && challenge.algorithm !== 'DeepSeekHashV1') {
      throw new Error(`DeepSeek has changed its proof-of-work: it now asks for "${String(challenge.algorithm).slice(0, 40)}", which this version of the bridge does not know. The bridge needs an update.`);
    }
    return solvePow(challenge);
  }

  // ---- pictures ---------------------------------------------------------------------------------------------------------------------------------
  // A picture goes to the site the way the web app sends an attached file: a proof-of-work for the upload path, a multipart POST, a wait until the site has
  // read the file, and then its id in `ref_file_ids` of the completion. A file belongs to the account, not to a chat, so one upload serves every chat; it is
  // kept by its content for a while, so a conversation that sends the same picture again does not upload it again. Nothing here is logged but names and sizes.
  const FILE_STATES_FAILED = /FAIL|ERROR|UNSUPPORTED|REJECT|TOO_LARGE|EXPIRED/i;
  const uploaded = new Map(); // hash -> { id, at }

  const fileOf = (biz, id) => {
    const list = biz && Array.isArray(biz.files) ? biz.files : [];
    return (id ? list.find((f) => f && String(f.id || f.file_id) === String(id)) : list[0]) || (biz && biz.file) || (biz && !Array.isArray(biz.files) && (biz.id || biz.file_id) ? biz : null);
  };

  async function uploadPicture(pic, signal) {
    const cached = uploaded.get(pic.hash);
    if (cached && Date.now() - cached.at < uploadKeepMs) return cached.id;
    const started = Date.now();
    const pow = await powHeader(signal, '/api/v0/file/upload_file');
    const form = new FormData();
    form.append('file', new Blob([pic.bytes], { type: pic.mime }), `image-${pic.n}.${pic.ext}`);
    const h = headers({ 'x-ds-pow-response': pow });
    delete h['content-type']; // the multipart boundary is the request's own
    const sent = await read(await fetch(`${BASE}/api/v0/file/upload_file`, { method: 'POST', headers: h, body: form, signal, redirect: 'error' }));
    let file = fileOf(sent.data && sent.data.data && sent.data.data.biz_data, null);
    const id = file && (file.id || file.file_id);
    if (!id) throw new Error('DeepSeek did not accept the picture (no file came back)');
    // The site reads the file (it is parsed on its side) before a chat can use it: wait for that, a short while.
    for (let waited = 0; ; waited += uploadPollMs) {
      const state = String((file && (file.status || file.state)) || '');
      if (/^(SUCCESS|READY|DONE|PARSED)$/i.test(state)) break;
      if (/EMPTY/i.test(state)) throw new Error('DeepSeek found nothing in the picture that it could read');
      if (FILE_STATES_FAILED.test(state)) throw new Error(`DeepSeek could not read the picture (${state.slice(0, 40).toLowerCase()})`);
      if (waited >= uploadWaitMs) throw new Error('DeepSeek did not finish reading the picture in time');
      await pause(uploadPollMs, signal);
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const h2 = headers(); delete h2['content-type'];
      const now = await read(await fetch(`${BASE}/api/v0/file/fetch_files?file_ids=${encodeURIComponent(id)}`, { headers: h2, signal, redirect: 'error' }));
      file = fileOf(now.data && now.data.data && now.data.data.biz_data, id) || file;
    }
    uploaded.set(pic.hash, { id, at: Date.now() });
    while (uploaded.size > 60) uploaded.delete(uploaded.keys().next().value);
    log(`deepseek web: picture uploaded (${pic.ext}, ${Math.ceil(pic.bytes.length / 1024)} KB, ${Date.now() - started} ms)`);
    return id;
  }

  /**
   * The pictures that go with one prompt: { ids, note }. The newest ones are sent (a message carries a few, not a whole conversation's); one that cannot be
   * sent is said in `note`, which is added to the prompt so the model says so instead of guessing what the picture shows. A refusal of the account (expired
   * sign-in, rate limit, mute) and a caller who left are not a picture's trouble: they go on as the error they are.
   */
  async function attachPictures(images, signal) {
    const list = Array.isArray(images) ? images : [];
    if (!list.length) return { ids: [], note: '' };
    const send = list.slice(-maxPictures);
    const problems = list.slice(0, list.length - send.length).map((p) => `image ${p.n}: only the newest ${maxPictures} pictures are sent with a message`);
    const ids = [];
    for (const pic of send) {
      if (pic.bytes.length > maxPictureBytes) { problems.push(`image ${pic.n}: larger than ${Math.round(maxPictureBytes / 1048576)} MB`); continue; }
      try {
        ids.push(await uploadPicture(pic, signal));
      } catch (err) {
        if (err && ((err.classified && ['muted', 'auth_expired', 'rate_limited'].includes(err.classified.type)) || err.name === 'AbortError' || (signal && signal.aborted))) throw err;
        const why = String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 160);
        log(`deepseek web: a picture could not be sent: ${why}`);
        problems.push(`image ${pic.n}: ${why}`);
      }
    }
    const note = problems.length ? `\n\n[Note from the bridge: ${problems.join('; ')}. Those pictures are NOT visible to you. Say so if the answer depends on them; do not guess what they show.]` : '';
    return { ids, note };
  }

  /** One completion on one chat session. Resolves { ok, text, thinking, responseMessageId } or { failed, code, authExpired, rateLimited }. */
  async function completion({ chatSessionId, parentMessageId = null, prompt, fileIds = [], thinking = true, signal, onDelta = () => {}, onSent = () => {} }) {
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
        ref_file_ids: fileIds,
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
    let eventCount = 0;
    const lastEvents = []; // the last few events by their names, for the one log line about how a stream ends
    const eventLines = new Set(); // the names on `event:` lines
    const consume = (line) => {
      if (line.startsWith('event:')) { if (eventLines.size < 8) eventLines.add(line.slice(6).trim().slice(0, 24)); return; }
      if (!line.startsWith('data: ')) return;
      const payload = line.slice(6).trim();
      if (!payload) return;
      let ev;
      try { ev = JSON.parse(payload); } catch (_) { return; }
      eventCount += 1;
      lastEvents.push(describeEvent(ev));
      if (lastEvents.length > 4) lastEvents.shift();
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
    if (!streamEndLogged) {
      streamEndLogged = true;
      log(`deepseek: the stream ended after ${eventCount} events (names only, no words). The last ones: ${lastEvents.join(' | ') || 'none'}. Event lines: ${[...eventLines].join(', ') || 'none'}`);
    }
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
   * One prompt on a fresh chat session, or, with `remote`, on the chat it names (the message after the last one it holds). With `keep` the chat is left open and
   * the result carries a `remote` for the next call; without it the chat is deleted once the answer is in.
   * On auth expiration or 429/403, notifies and halts immediately without blind retries. A chat opened for this call is deleted when the call fails; one that was
   * continued is left to the engine, which ends its session.
   */
  async function completeOnce({ prompt, images = [], thinking = true, signal = null, onDelta = () => {}, keep = false, remote = null }) {
    if (!token()) {
      // A call that arrives after another one found the login refused (a title and the turn itself, say) gets the same plain answer, not "link an account".
      if (hadLogin()) return { ok: false, error: 'Your DeepSeek session has expired. Sign in again on the Accounts page.', authExpired: true };
      return { ok: false, error: 'Link a DeepSeek account first on the Accounts page.' };
    }
    const continued = Boolean(remote && remote.id);
    let sent = false; // the completion request left: from here on the account has been spent, whether or not anyone reads the answer
    for (let attempt = 1; ; attempt += 1) {
      let chatSessionId = null;
      const lose = () => { if (!continued) discardSession(chatSessionId); };
      try {
        const files = await attachPictures(images, signal);
        chatSessionId = continued ? remote.id : await createSession(signal);
        const out = await completion({ chatSessionId, parentMessageId: continued ? (remote.lastId === undefined ? null : remote.lastId) : null, prompt: prompt + files.note, fileIds: files.ids, thinking, signal, onDelta, onSent: () => { sent = true; } });
        if (!out.failed) {
          // A chat can only be continued from the message that answered: without its id the chat is not kept.
          if (keep && out.responseMessageId !== null && out.responseMessageId !== undefined) {
            return { ok: true, text: out.text, thinking: out.thinking, remote: { id: chatSessionId, lastId: out.responseMessageId } };
          }
          if (continued) { /* the engine ends this session */ } else discardSession(chatSessionId);
          return { ok: true, text: out.text, thinking: out.thinking };
        }
        lose();
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
        lose();
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
        if (isNetworkError(err)) {
          // The connection failed, which says nothing about the account (no pause, no sign-out). Before the message went out nothing was spent, so one more try is safe: the
          // first request after a laptop wakes up often fails this way. Once the message is out it is not sent again.
          if (!sent && attempt === 1) {
            log(`deepseek web: the connection failed before anything was sent (${networkReason(err)}); trying once more`);
            await pause(networkRetryMs, signal);
            if (signal && signal.aborted) return { ok: false, cancelled: true, sent };
            continue;
          }
          log(`deepseek web error: ${String((err && err.message) || err)} (${networkReason(err)})`);
          return sent
            ? { ok: false, sent: true, error: `The connection to DeepSeek dropped while it was answering (${networkReason(err)}). The answer is not used because part of it is missing. Try again.` }
            : { ok: false, sent: false, error: `Could not reach DeepSeek (${networkReason(err)}). Nothing was sent. Check the connection and try again.` };
        }
        const msg = String((err && err.message) || err);
        log('deepseek web error: ' + msg);
        return { ok: false, sent, error: msg || 'DeepSeek could not answer.' };
      }
    }
  }

  return { token, completeOnce, closeSession, sessions: true, images: true, REQUEST_TIMEOUT_MS };
}

module.exports = { createDeepSeekWeb, plainError, classifyError, mutedUntil, mutedMessage, REQUEST_TIMEOUT_MS };
