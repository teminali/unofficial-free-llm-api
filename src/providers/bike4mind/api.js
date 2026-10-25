/**
 * Bike4Mind's own Completions API: the one place that knows its address, its two credentials, its model list and its error shapes.
 *
 * Unlike the website providers beside it, Bike4Mind publishes an API for its own accounts. This provider uses an API key the person makes in their own
 * Bike4Mind account (Profile, API Keys), and every call is billed in that account's credits. Nothing here scrapes a page or keeps a browser open.
 *
 * A completion is always an SSE stream: a `meta` event, `content`/`tool_use` events, an optional terminal `error`, and `data: [DONE]`. Content text may
 * arrive as a delta or as the whole answer so far; readEvents reports both, and web.js turns either into one stream.
 */
'use strict';

const DEFAULT_BASE = 'https://app.bike4mind.com';
const COMPLETIONS = '/api/ai/v1/completions';
const MODELS = '/api/v1/models';
const CREDITS = '/api/v1/credits';
const ME = '/api/v1/me';
const KEY_PREFIX = 'b4m_';
const EXPIRED = 'Your Bike4Mind API key was refused. Make a new key in your Bike4Mind account (Profile, API Keys) and paste it on the Accounts page.';
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/** A loopback stand-in may replace the address only in test mode, as DeepSeek's base does: no flag or config can send a key anywhere else. */
function resolveBase(requested) {
  if (requested && process.env.ULA_TEST_MODE === '1' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(String(requested))) return String(requested);
  return DEFAULT_BASE;
}

/** The key as Bike4Mind makes it, or null. Never trimmed into something that was not offered. */
function cleanKey(value) {
  const key = String(value == null ? '' : value).trim();
  return new RegExp(`^${KEY_PREFIX}[A-Za-z0-9._-]{8,}$`).test(key) ? key : null;
}

function authHeaders(key, extra = {}) {
  return { 'x-api-key': key, accept: 'application/json', 'content-type': 'application/json', ...extra };
}

function httpError(status, data, retryAfter) {
  const detail = String((data && data.error) || `HTTP ${status}`);
  if (status === 401) return Object.assign(new Error(EXPIRED), { authExpired: true, status, retryable: false });
  if (status === 403) {
    const scopes = Array.isArray(data && data.required_scopes) ? data.required_scopes.filter((s) => typeof s === 'string') : [];
    const message = scopes.length
      ? `This Bike4Mind API key does not have the ${scopes.join(' or ')} scope. Make a new key with that scope in your Bike4Mind account, then paste it on the Accounts page.`
      : `Bike4Mind refused this API key (403). Make a new key in your Bike4Mind account, then paste it on the Accounts page.`;
    return Object.assign(new Error(message), { authExpired: true, status, retryable: false, requiredScopes: scopes });
  }
  if (status === 429) {
    const seconds = Number(retryAfter);
    const cooldownMs = Math.max(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0, 60 * 1000);
    return Object.assign(new Error('Bike4Mind is rate limiting this API key. Requests are paused; nothing is retried.'), { rateLimited: true, cooldownMs, status, retryable: false });
  }
  if (status === 413) return Object.assign(new Error('Bike4Mind refused the request: its body is over 25 MB. Send fewer or smaller pictures.'), { status, retryable: false });
  if (status === 422 && data && data.errorCode === 'insufficient_credits') {
    return Object.assign(new Error(`Bike4Mind credits are used up for this account. ${detail} Top up in your Bike4Mind account, or choose another model or provider.`), { outOfCredits: true, status, retryable: false });
  }
  if (status === 422) return Object.assign(new Error(`Bike4Mind refused the request (422): ${detail}`), { status, retryable: false });
  if (status === 400) {
    const code = data && data.errorCode;
    if (code === 'unknown_model') return Object.assign(new Error('Bike4Mind does not offer this model to your account. Read the models again on the Accounts page, or choose another model.'), { status, retryable: false, unknownModel: true });
    return Object.assign(new Error(`Bike4Mind refused the request (400${code ? `, ${code}` : ''}): ${detail}`), { status, retryable: false });
  }
  if (status >= 500) return Object.assign(new Error(`Bike4Mind could not answer (HTTP ${status}): ${detail}`), { status, retryable: true });
  return Object.assign(new Error(`Bike4Mind refused the request (HTTP ${status}): ${detail}`), { status, retryable: false });
}

/** An error that arrived inside the stream, after the 200 was sent. `code` is the only stable part; `message` is prose. */
function streamError(event) {
  const code = typeof event.code === 'string' ? event.code : '';
  const message = String(event.message || 'Bike4Mind stopped the answer without saying why.');
  if (code === 'insufficient_credits' || code === 'spend_cap_exceeded') {
    return Object.assign(new Error(`Bike4Mind credits are used up for this account. ${message} Top up in your Bike4Mind account, or choose another model or provider.`), { outOfCredits: true, code, retryable: false });
  }
  if (code === 'invalid_request' || code === 'content_blocked') return Object.assign(new Error(message), { code, retryable: false });
  if (code === 'provider_rejected') return Object.assign(new Error(`Bike4Mind's model provider refused the request: ${message}`), { code, retryable: true });
  return Object.assign(new Error(message), { code: code || 'provider_error', retryable: true });
}

async function getJson({ base, key, path, signal, timeoutMs = 20000 }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${base}${path}`, { headers: authHeaders(key), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!response.ok) throw httpError(response.status, data, response.headers.get('retry-after'));
  if (!data || typeof data !== 'object') throw Object.assign(new Error('Bike4Mind returned an unexpected response instead of JSON.'), { status: response.status, retryable: true });
  return data;
}

/** The text of the `data:` lines of each SSE block, trimmed of its SSE framing and nothing else. */
async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const take = (block) => block.split('\n')
    .map((line) => (line.startsWith('data:') ? line.slice(5).replace(/^ /, '') : null))
    .filter((line) => line !== null && line !== '')
    .join('\n');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at >= 0) {
        const data = take(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
        if (data) yield data;
        at = buffer.indexOf('\n\n');
      }
    }
    const tail = take(buffer);
    if (tail) yield tail;
  } finally {
    try { await reader.cancel(); } catch (_) { /* the server ended it already */ }
  }
}

function mapModel(m) {
  return {
    id: m.id,
    ref: m.id,
    name: m.name || m.id,
    thinking: false,
    escalate: false,
    context_length: Number.isFinite(m.context_window) && m.context_window > 0 ? m.context_window : undefined,
    supportsTools: m.supports_tools === true,
    supportsThinking: m.supports_thinking === true,
    supportsVision: m.supports_vision === true,
    reasoningEfforts: Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts.filter((level) => typeof level === 'string') : [],
    price: m.credits_per_1m_tokens && typeof m.credits_per_1m_tokens === 'object' ? m.credits_per_1m_tokens : null
  };
}

/** Every text model this key can call right now. A list that is not the documented shape is an error, never a guessed list. */
async function readModels({ base, key, signal }) {
  const models = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', String(cursor));
    const data = await getJson({ base, key, path: `${MODELS}?${query}`, signal });
    if (!Array.isArray(data.data)) throw new Error('Bike4Mind changed its model-list format. No models were guessed.');
    for (const m of data.data) if (m && typeof m.id === 'string' && m.type === 'text') models.push(mapModel(m));
    const next = data.next_cursor == null ? null : String(data.next_cursor);
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return models;
}

async function readCredits({ base, key, signal }) {
  const data = await getJson({ base, key, path: CREDITS, signal });
  return Number.isFinite(data.balance) ? data.balance : null;
}

/** Best effort: an API key made only for chatting has no `me:read` scope, and the account name is a nicety, not a requirement. */
async function readAccount({ base, key, signal }) {
  try {
    const data = await getJson({ base, key, path: ME, signal });
    return { name: typeof data.name === 'string' ? data.name : null, tier: typeof data.tier === 'string' ? data.tier : null };
  } catch (_) { return { name: null, tier: null }; }
}

module.exports = {
  DEFAULT_BASE, COMPLETIONS, MODELS, CREDITS, ME, KEY_PREFIX, EXPIRED, REQUEST_TIMEOUT_MS,
  resolveBase, cleanKey, authHeaders, httpError, streamError, getJson, readEvents, mapModel, readModels, readCredits, readAccount
};
