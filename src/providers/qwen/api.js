'use strict';

const crypto = require('crypto');

const CHAT = 'https://chat.qwen.ai';
const AUTH = 'https://auth.qwen.ai';
const EXPIRED = 'Your Qwen sign-in has expired. Sign in again on the Accounts page.';

function accountId(token) {
  try {
    const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).id;
    return typeof id === 'string' && id ? id : null;
  } catch (_) { return null; }
}

function cookieMatches(cookie, url) {
  const domain = String(cookie.domain || '');
  const host = domain.replace(/^\./, '');
  const matchesHost = url.hostname === host || (domain.startsWith('.') && url.hostname.endsWith(`.${host}`));
  const p = cookie.path || '/';
  return matchesHost && (url.pathname === p || (url.pathname.startsWith(p) && (p.endsWith('/') || url.pathname[p.length] === '/')))
    && (!(cookie.expires > 0) || cookie.expires * 1000 > Date.now());
}

function headers(session, url, extra = {}) {
  const target = new URL(url);
  if (![CHAT, AUTH].includes(target.origin)) throw new Error('Qwen credentials cannot be sent to another host.');
  const h = { accept: 'application/json', 'content-type': 'application/json', origin: CHAT, referer: `${CHAT}/`, source: 'web', 'x-request-id': crypto.randomUUID(), ...extra };
  if (session.token && target.pathname !== '/api/v2/auths/refresh') h.authorization = `Bearer ${session.token}`;
  if (session.userAgent) h['user-agent'] = session.userAgent;
  if (session.version) h.version = session.version;
  if (target.origin === AUTH) h['x-request-origin'] = CHAT;
  const cookies = (session.cookies || []).filter((c) => cookieMatches(c, target));
  if (cookies.length) h.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return h;
}

function updateCookies(session, response, url) {
  const target = new URL(url);
  for (const raw of response.headers.getSetCookie()) {
    const [pair, ...attrs] = raw.split(';');
    const at = pair.indexOf('=');
    if (at < 1) continue;
    const cookie = { name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim(), domain: target.hostname, path: target.pathname.slice(0, target.pathname.lastIndexOf('/')) || '/', expires: -1 };
    let maxAge = null;
    for (const attr of attrs) {
      const i = attr.indexOf('=');
      const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const value = i < 0 ? '' : attr.slice(i + 1).trim();
      if (key === 'domain') cookie.domain = '.' + value.toLowerCase().replace(/^\./, '');
      if (key === 'path' && value.startsWith('/')) cookie.path = value;
      if (key === 'expires' && Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value) / 1000;
      if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
    }
    const domain = cookie.domain.replace(/^\./, '');
    if (!(domain === 'qwen.ai' || domain === target.hostname)) continue;
    if (maxAge !== null) cookie.expires = Date.now() / 1000 + maxAge;
    session.cookies = (session.cookies || []).filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
    if ((maxAge === null || maxAge > 0) && (cookie.expires < 0 || cookie.expires > Date.now() / 1000)) session.cookies.push(cookie);
  }
}

function responseError(status, data, retryAfter) {
  const detail = data?.error || (data?.success === false ? data.data : null) || data?.detail;
  const code = String(detail?.code || data?.code || '').toLowerCase();
  const blocked = Array.isArray(data?.ret) && data.ret.some((x) => String(x).startsWith('FAIL_SYS_USER_VALIDATE'));
  if (status === 401 || ['unauthorized', 'invalid token', 'invalid_token', 'token_expired'].includes(code)) {
    return Object.assign(new Error(EXPIRED), { authExpired: true, status, retryable: false });
  }
  if (status === 403 || status === 429 || blocked || /rate.?limit|quota|too_many|access_prohibited/.test(code)) {
    const seconds = Number(retryAfter);
    const retryMs = retryAfter ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
    const hours = code === 'ratelimited' ? Number(detail?.num) : 0;
    const cooldownMs = Math.max(Number.isFinite(retryMs) ? retryMs : 0, Number.isFinite(hours) ? hours * 3600000 : 0, 20 * 60000);
    return Object.assign(new Error(blocked ? 'Qwen rejected this request for browser verification, not a confirmed usage limit. Requests are paused; complete any checks in the Qwen window yourself. Nothing was retried.' : 'Qwen refused this request or reached its account limit. Requests are paused; nothing is retried.'), { verificationRequired: blocked, rateLimited: true, cooldownMs, status, retryable: false });
  }
  if (status < 200 || status >= 300 || data?.success === false || data?.error || data?.code || blocked) {
    return Object.assign(new Error(`Qwen did not accept the request${status ? ` (HTTP ${status})` : ''}. No automatic retry was made.`), { status, retryable: false });
  }
  return null;
}

async function request(session, url, { method = 'GET', body, signal, accept = 'application/json' } = {}) {
  const response = await fetch(url, { method, headers: headers(session, url, { accept }), body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'error' });
  updateCookies(session, response, url);
  return response;
}

async function json(session, url, options = {}) {
  const response = await request(session, url, options);
  const data = await response.json().catch(() => null);
  const error = responseError(response.status, data, response.headers.get('retry-after'));
  if (error) throw error;
  if (!data || typeof data !== 'object') throw new Error('Qwen returned an unexpected response instead of JSON.');
  return data;
}

function modelList(data) {
  const rows = data?.data?.data;
  if (data?.success !== true || !Array.isArray(rows)) throw new Error('Qwen changed its model-list format. No models were guessed.');
  return rows.filter((m) => typeof m?.id === 'string' && m.info?.is_active === true && m.info.access_control == null && m.info.meta?.chat_type?.includes('t2t'))
    .map((m) => ({ id: m.id, ref: m.id, name: m.name || m.info.name || m.id, thinking: false, escalate: false, thinkingFormat: m.info.meta.thinking_format || null }));
}

module.exports = { CHAT, AUTH, EXPIRED, accountId, request, json, responseError, modelList };
