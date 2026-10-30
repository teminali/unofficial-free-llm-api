/**
 * The sessions of one provider: which chat on the provider's side holds which conversation, so the next request can continue it instead of opening a new chat
 * and sending the whole conversation again.
 *
 * An OpenAI-style request carries the whole conversation every time and says nothing about a session. A request belongs to a session when the messages the
 * chat already holds are exactly the first messages of the request (compared by hash, bridge.js: fingerprint), and it brings at least one new message after
 * them. Anything else (a message that was edited, dropped or reordered, other tools, another system prompt, another model) is not a continuation: it starts
 * a new chat, and the old session is left to expire. Nothing is guessed: a request that does not fit is answered like before.
 *
 * What is kept for a session is hashes, counts and the provider's own handle for the chat (`remote`, opaque here, with an `id`): never a prompt or an answer.
 * Sessions live in memory. The chat ids that are open are also written down (`persist`), so a chat left behind by a program that was killed can be removed
 * the next time it starts.
 *
 * A chat is removed on the provider's side (`close(remote)`) when its session is idle too long, pushed out by newer ones, too long to go on with, or ended
 * by the person; removals are spaced out, they are not a burst.
 */
'use strict';

const DEFAULTS = Object.freeze({
  ttlMs: 20 * 60 * 1000,      // a session nobody continued for this long is closed
  maxSessions: 6,             // open sessions at once; the one used longest ago is closed to make room
  maxChars: 150000,           // what a chat has been sent and has answered, in characters; past this a new chat is started, if it would be told much less (maxOverhead)
  maxOverhead: 1.5,           // a long chat is only given up for a new one when the chat holds this many times what the new chat would be sent
  maxTurns: 80,               // a chat that has answered this many requests is given up for a new one
  closeGapMs: 1500,           // between two removals
  sweepMs: 60 * 1000
});

/** How many of the first entries of two lists are the same. */
function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

function createSessionStore({ close = async () => {}, persist = null, now = Date.now, log = () => {}, options = {} } = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const sessions = new Map(); // id -> session
  const closing = []; // remotes waiting to be removed, oldest first
  let draining = false;
  let sweeper = null;
  let seq = 0;
  const stats = { continued: 0, started: 0, diverged: 0, failed: 0 };
  let off = null; // a reason this store stopped continuing chats, once a continuation kept failing
  let failures = 0; // continued requests that failed in a row

  const saveIds = () => {
    if (!persist) return;
    try { persist([...sessions.values()].map((s) => s.remote && s.remote.id).filter(Boolean).concat(closing.map((r) => r && r.id).filter(Boolean))); } catch (_) { /* a failed write is not a failed chat */ }
  };

  /** Removes one chat on the provider's side, after the ones before it, never two in a burst. */
  function closeRemote(remote) {
    if (!remote) return;
    closing.push(remote);
    saveIds();
    drain();
  }
  function drain() {
    if (draining) return;
    draining = true;
    const next = async () => {
      const remote = closing.shift();
      if (!remote) { draining = false; saveIds(); return; }
      let wait = cfg.closeGapMs;
      try {
        const r = await close(remote);
        // The provider's client can say "not now" (the account is resting after a refusal): the chat goes back to the front and is asked again later.
        if (r && r.retryAfterMs) { closing.unshift(remote); wait = r.retryAfterMs; }
      } catch (err) { log(`sessions: could not remove a chat: ${String((err && err.message) || err)}`); }
      saveIds();
      if (!closing.length) { draining = false; return; }
      const t = setTimeout(next, wait);
      if (t.unref) t.unref();
    };
    next();
  }

  /**
   * A chat is given up for a new one when going on in it is worse than starting again. A new chat is told the whole conversation, so a chat whose length is
   * about the conversation's own (all an agent's chat ever is: one task, growing step by step) is never too long: the new chat would be just as long, and
   * every step after it would start yet another one, sent everything again. What a new chat sheds is what the kept one gathered on top of the
   * conversation (the bridge's rules said again, answers that were asked again), so the chat is too long only when it holds clearly more than a new chat
   * would be sent (maxOverhead), or when it has answered maxTurns requests.
   */
  function tooLong(s, freshChars) {
    if (s.turns >= cfg.maxTurns) return true;
    if (s.chars < cfg.maxChars) return false;
    return !(freshChars > 0) || s.chars >= freshChars * cfg.maxOverhead;
  }

  /**
   * The session a request continues, or none. `key` names what a session is for (model, thinking level, tools), `tag` is a name the caller gave (or ''), `hashes` is
   * [system hash, ...one hash for each message of the request], `freshChars` the length of the prompt a new chat would be sent for this request (0: not known). Returns { session, from } where `from` is how many of the request's messages the chat already
   * holds (not counting the system hash), or { session: null, reason: 'new' | 'diverged' | 'full' | 'off' }.
   */
  function match({ key, tag = '', hashes, freshChars = 0 }) {
    if (off) return { session: null, reason: 'off' };
    const t = now();
    let best = null;
    let bestPrefix = 0;
    let sawPartial = false;
    const full = [];
    for (const s of sessions.values()) {
      if (s.busy || s.key !== key || s.tag !== tag) continue;
      const p = commonPrefix(s.hashes, hashes);
      if (p === s.hashes.length && hashes.length > p) {
        if (tooLong(s, freshChars)) { full.push(s); continue; }
        if (p > bestPrefix) { best = s; bestPrefix = p; }
      } else if (p > 1) sawPartial = true; // more than the system hash in common, but not all of it: the conversation was changed
    }
    if (!best) {
      // The conversation goes on in a new chat, so the long one has no use any more.
      if (full.length) { for (const s of full) end(s, 'long'); return { session: null, reason: 'full' }; }
      stats[sawPartial ? 'diverged' : 'started'] += 1;
      return { session: null, reason: sawPartial ? 'diverged' : 'new' };
    }
    best.busy = true;
    best.lastUsed = t;
    stats.continued += 1;
    return { session: best, from: bestPrefix - 1 };
  }

  /**
   * A request that ended well on `remote`: the chat now holds `hashes`. `session` is the one that was continued (or null for a new chat). Returns the session.
   */
  function commit({ session = null, key, tag = '', hashes, remote, chars = 0, meta = {} }) {
    const t = now();
    let s = session;
    if (s) {
      s.hashes = hashes;
      s.remote = remote;
      s.turns += 1;
      s.chars += chars;
      s.lastUsed = t;
      s.busy = false;
      s.meta = { ...s.meta, ...meta };
    } else {
      seq += 1;
      s = { id: `s${t.toString(36)}${seq}`, key, tag, hashes, remote, turns: 1, chars, createdAt: t, lastUsed: t, busy: false, meta };
      sessions.set(s.id, s);
      // Room for the new one: the session used longest ago goes first.
      while (sessions.size > cfg.maxSessions) {
        const oldest = [...sessions.values()].filter((x) => !x.busy && x !== s).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!oldest) break;
        end(oldest, 'room');
      }
      // A session with a name has one chat: a new chat under the same name replaces the one that was there.
      if (tag) for (const x of [...sessions.values()]) if (x !== s && x.tag === tag && x.key === key && !x.busy) end(x, 'replaced');
    }
    saveIds();
    return s;
  }

  /** Ends a session: it is forgotten and its chat is removed on the provider's side. */
  function end(session, why = 'ended') {
    if (!session || !sessions.has(session.id)) return false;
    sessions.delete(session.id);
    log(`sessions: closed ${session.id} (${why}, ${session.turns} turns)`);
    closeRemote(session.remote);
    return true;
  }

  /** A continued request failed: the session cannot be trusted any more. `general` is a failure that says nothing about the account (not a refusal, not a sign-in). */
  function drop(session, { general = false } = {}) {
    if (!session) return;
    session.busy = false;
    end(session, 'dropped');
    if (general) {
      stats.failed += 1;
      failures += 1;
      if (failures >= 2) { off = 'continuing a chat failed twice in a row'; log(`sessions: off (${off})`); }
    }
  }
  /** The person turned the continuing on again by hand: whatever switched it off is theirs to try again, and the count starts over. */
  function reset() {
    off = null;
    failures = 0;
    log('sessions: switched on again by hand');
  }

  /** A continued request ended well: the run of failures is over. */
  function worked() { failures = 0; }

  function list() {
    return [...sessions.values()].sort((a, b) => b.lastUsed - a.lastUsed).map((s) => ({
      id: s.id, tag: s.tag || null, turns: s.turns, chars: s.chars, createdAt: new Date(s.createdAt).toISOString(), lastUsed: new Date(s.lastUsed).toISOString(),
      busy: s.busy, ...s.meta
    }));
  }

  function endById(id) {
    const s = sessions.get(id);
    if (!s || s.busy) return false;
    return end(s, 'ended by the person');
  }

  function sweep() {
    const t = now();
    for (const s of [...sessions.values()]) {
      if (!s.busy && t - s.lastUsed >= cfg.ttlMs) end(s, 'idle');
      else if (s.busy && t - s.lastUsed >= cfg.ttlMs * 2) end(s, 'stuck'); // a request that never finished (no request runs this long)
    }
  }
  function start() {
    if (sweeper) return;
    sweeper = setInterval(sweep, cfg.sweepMs);
    if (sweeper.unref) sweeper.unref();
  }

  /** Chats an earlier run left behind (ids written down by `persist`): removed, spaced out. */
  function adopt(ids) {
    for (const id of Array.isArray(ids) ? ids : []) if (id) closeRemote({ id: String(id) });
  }

  /** The program is stopping: every open chat is removed now (not spaced out), for as long as `timeoutMs` allows. */
  async function closeAll(timeoutMs = 4000) {
    if (sweeper) { clearInterval(sweeper); sweeper = null; }
    const remotes = [...sessions.values()].map((s) => s.remote).concat(closing.splice(0)).filter(Boolean);
    sessions.clear();
    draining = false;
    const left = []; // chats the provider's client would not remove now: written down, so the next start removes them
    await Promise.race([
      Promise.all(remotes.map((r) => Promise.resolve().then(() => close(r)).then((answer) => { if (answer && answer.retryAfterMs) left.push(r); }).catch(() => { left.push(r); }))),
      new Promise((resolve) => { const t = setTimeout(resolve, timeoutMs); if (t.unref) t.unref(); })
    ]);
    closing.push(...left);
    saveIds();
    closing.length = 0;
  }

  return { match, commit, drop, reset, worked, end, endById, list, sweep, start, adopt, closeAll, closeRemote, stats, size: () => sessions.size, disabledReason: () => off, config: cfg };
}

module.exports = { createSessionStore, commonPrefix, DEFAULTS };
