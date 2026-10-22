/**
 * The usage governor for one linked personal account.
 *
 * A personal chat account is not an API: the provider can slow it down, mute it or sign it out when it sees traffic that no person would make. The
 * governor is what keeps this bridge on the right side of that, and it is on for every provider:
 *  - Concurrency: exactly one request at a time (mutex lock), and a short queue behind it; a longer queue is refused instead of piling up.
 *  - Pacing: a minimum gap between completions.
 *  - Minute cap: a sliding 60-second window ("smooth" pacing waits for a place in the window instead of failing the call).
 *  - Daily cap: persistent in <dataDir>/usage-<provider>.json (0600), reset at local midnight.
 *  - Cooldown: a pause after the provider refuses, rate-limits, mutes or asks for a human check; every call during it is answered locally and
 *    nothing is sent upstream (a muted account only gets worse with retries).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeJson } = require('./config');

const DEFAULT_DAILY_CAP = 300;
const RATE_LIMIT_PER_MINUTE = 20;
const MIN_GAP_MS = 1000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
/** How many calls may wait behind the one that is running. */
const MAX_QUEUE = 6;
/**
 * DeepSeek's own pace, gentler than the default. DeepSeek refuses an account that sends about 13 messages a minute ("Messages too frequent"), and it has
 * muted and signed out accounts shortly after such a refusal. Spacing calls four seconds apart keeps an agent near 7 a minute (the minute cap is only a
 * backstop that waits); after a refusal the lane rests for 20 minutes. The default pace stays for providers with no such evidence.
 */
const DEEPSEEK_PACE = Object.freeze({ perMinute: 10, minGapMs: 4000, cooldownMs: 20 * 60 * 1000, smooth: true });

function localDateStr(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createGovernor({ storagePath, providerName = 'The provider', dailyCap = DEFAULT_DAILY_CAP, log = () => {}, onUpdate = () => {}, pace = {} }) {
  const perMinute = pace.perMinute || RATE_LIMIT_PER_MINUTE;
  const minGapMs = pace.minGapMs || MIN_GAP_MS;
  const refusalCooldownMs = pace.cooldownMs || DEFAULT_COOLDOWN_MS;
  /** A smooth pace never fails a call for the minute cap: the call waits for a free place in the minute instead (the daily cap and a refusal still stop it). */
  const smooth = pace.smooth === true;

  let cap = Math.floor(Number(dailyCap)) > 0 ? Math.floor(Number(dailyCap)) : DEFAULT_DAILY_CAP;
  let todayCalls = 0;
  let currentDate = localDateStr();
  let cooldownUntil = 0;
  let cooldownReason = '';

  const callTimestamps = [];
  let lastCallFinishedAt = 0;
  let activeLock = Promise.resolve();
  let waiting = 0;

  function loadState() {
    try {
      if (!fs.existsSync(storagePath)) return;
      const data = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
      if (typeof data.cooldownUntil === 'number') cooldownUntil = data.cooldownUntil;
      if (typeof data.cooldownReason === 'string') cooldownReason = data.cooldownReason;
      const today = localDateStr();
      if (data.date === today && typeof data.todayCalls === 'number') {
        currentDate = today;
        todayCalls = data.todayCalls;
      }
    } catch (_) {
      // Corrupt or unreadable: keep the in-memory defaults
    }
  }

  function saveState() {
    try {
      const payload = { date: currentDate, todayCalls, cooldownUntil, cooldownReason, updatedAt: new Date().toISOString() };
      writeJson(storagePath, payload);
    } catch (err) {
      log(`governor ${providerName}: could not save the usage file: ${String((err && err.message) || err)}`);
    }
  }

  loadState();

  function notify() {
    try { onUpdate(getStats()); } catch (_) { /* a listener never stops the governor */ }
  }

  function rollDate() {
    const today = localDateStr();
    if (today === currentDate) return false;
    currentDate = today;
    todayCalls = 0;
    return true;
  }

  /** Whether a call may start now. { allowed: true } or { allowed: false, reason, message, retryAfterSec }. */
  function checkLimit() {
    const now = Date.now();
    if (now < cooldownUntil) {
      const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
      const remainingMin = Math.ceil(remainingSec / 60);
      return {
        allowed: false,
        reason: 'cooldown',
        retryAfterSec: remainingSec,
        message: `${providerName} is cooling down for another ${remainingMin} minute${remainingMin === 1 ? '' : 's'} to protect your account (${cooldownReason || 'rate limit'}). You can clear this on the Accounts page.`
      };
    }
    if (rollDate()) saveState();
    if (todayCalls >= cap) {
      return {
        allowed: false,
        reason: 'daily_cap',
        retryAfterSec: 3600,
        message: `${providerName} daily call limit reached (${todayCalls} of ${cap} calls today). Raise it on the Accounts page, or wait for tomorrow.`
      };
    }
    const windowStart = now - 60000;
    while (callTimestamps.length && callTimestamps[0] < windowStart) callTimestamps.shift();
    if (!smooth && callTimestamps.length >= perMinute) {
      return {
        allowed: false,
        reason: 'minute_cap',
        retryAfterSec: Math.max(1, Math.ceil((callTimestamps[0] + 60000 - now) / 1000)),
        message: `${providerName} rate limit reached (${perMinute} calls/min). Please wait a moment before trying again.`
      };
    }
    return { allowed: true };
  }

  /** How many calls are queued behind the running one. */
  function queueLength() { return waiting; }

  const leftError = () => Object.assign(new Error('The caller left before its turn came.'), { aborted: true });

  /** Resolves after `ms`, or rejects the moment `signal` aborts (and then holds no timer). */
  function pause(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(leftError());
      const onAbort = () => { clearTimeout(timer); reject(leftError()); };
      const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Resolves with `promise`, or rejects the moment `signal` aborts (the promise keeps running; only the wait ends). */
  function untilOrLeft(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(leftError());
      const onAbort = () => reject(leftError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  /**
   * Takes the serialization lock and makes sure the minimum gap has passed since the last completion.
   * Returns a release function that must be called when the request completes.
   *
   * With a `signal`, a caller that leaves while it waits (queued, in the gap, in the per-minute wait) is rejected with `error.aborted = true` and holds
   * nothing: nothing was sent for it, so it must not be sent after it left. Its place in the line is given up without letting those behind it slip past
   * whoever still holds the lock.
   */
  async function acquireSlot(signal) {
    if (signal && signal.aborted) throw leftError();
    let releaseLock;
    const nextLock = new Promise((resolve) => { releaseLock = resolve; });
    const prevLock = activeLock;
    activeLock = nextLock;
    waiting += 1;
    try { await untilOrLeft(prevLock, signal); } catch (err) {
      // Not our turn yet and we are leaving: the line behind us still waits for the holder, so our link opens only when theirs does.
      prevLock.then(releaseLock);
      throw err;
    } finally { waiting -= 1; }

    try {
      const now = Date.now();
      const elapsedSinceLast = now - lastCallFinishedAt;
      if (lastCallFinishedAt > 0 && elapsedSinceLast < minGapMs) await pause(minGapMs - elapsedSinceLast, signal);
      if (smooth) {
        for (;;) {
          const t = Date.now();
          while (callTimestamps.length && callTimestamps[0] < t - 60000) callTimestamps.shift();
          if (callTimestamps.length < perMinute) break;
          await pause(Math.max(50, callTimestamps[0] + 60000 - t + 50), signal);
        }
      }
    } catch (err) {
      releaseLock(); // we held the lock but sent nothing: no gap is owed to the next one
      throw err;
    }
    return () => {
      lastCallFinishedAt = Date.now();
      releaseLock();
    };
  }

  function recordCall() {
    rollDate();
    todayCalls += 1;
    callTimestamps.push(Date.now());
    saveState();
    notify();
  }

  function setCooldown(durationMs = refusalCooldownMs, reason = '') {
    cooldownUntil = Date.now() + durationMs;
    cooldownReason = reason;
    saveState();
    notify();
  }

  function clearCooldown() {
    cooldownUntil = 0;
    cooldownReason = '';
    saveState();
    notify();
  }

  /** The person protecting their own account: clears the cooldown, the minute window and the day's count. */
  function resetUsage() {
    todayCalls = 0;
    cooldownUntil = 0;
    cooldownReason = '';
    callTimestamps.length = 0;
    saveState();
    notify();
  }

  function setDailyCap(next) {
    const n = Math.floor(Number(next));
    if (n > 0) {
      cap = n;
      notify();
    }
  }

  function getStats() {
    const now = Date.now();
    const callsThisMinute = callTimestamps.filter((t) => t >= now - 60000).length;
    return {
      todayCalls,
      dailyCap: cap,
      callsThisMinute,
      perMinute,
      minGapMs,
      cooldownUntil,
      isCooldown: now < cooldownUntil,
      cooldownReason: now < cooldownUntil ? cooldownReason : '',
      remainingToday: Math.max(0, cap - todayCalls),
      queued: waiting
    };
  }

  return { checkLimit, acquireSlot, queueLength, recordCall, setCooldown, refusalCooldownMs, clearCooldown, resetUsage, setDailyCap, getStats, localDateStr };
}

module.exports = { createGovernor, DEFAULT_DAILY_CAP, RATE_LIMIT_PER_MINUTE, MIN_GAP_MS, DEFAULT_COOLDOWN_MS, MAX_QUEUE, DEEPSEEK_PACE };
