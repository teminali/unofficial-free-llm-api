/**
 * The Bike4Mind account: the API key the person made in their own account, the model list that key can call, and the credit balance it draws on.
 *
 * The key is a login: it is written 0600 in the data folder, never logged, and only ever sent to app.bike4mind.com (or the loopback stand-in the tests use).
 * There is no Chrome, no session and nothing to keep open.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('../../config');
const { cleanKey, readModels, readCredits, readAccount, EXPIRED } = require('./api');

const KEY_HINT = 'That is not a Bike4Mind API key. Keys begin with b4m_; make one in your Bike4Mind account under Profile, then API Keys.';
const UNREACHABLE = 'Bike4Mind could not be reached to check this key. Check your connection and try again.';

function createBike4MindAccount({ dataDir, base, governor, log = () => {} }) {
  const file = path.join(dataDir, 'bike4mind_key.json');
  let stopped = false;
  let linking = null;
  let refreshing = null;
  let readingCredits = null;

  const readSession = () => readJson(file);
  const current = (s) => Boolean(s && s.key && !stopped && (readSession() || {}).linkId === s.linkId);
  const save = (s) => { if (!stopped) writeJson(file, s); };
  const write = (s) => { writeJson(file, s); };

  function listModels() {
    const s = readSession();
    return s && s.key && !s.expired && Array.isArray(s.models) ? s.models : [];
  }

  function modelInfo(id) {
    return listModels().find((m) => m.id === id || m.ref === id) || null;
  }

  function getKey() {
    if (stopped) throw Object.assign(new Error('Bike4Mind is stopping.'), { retryable: false });
    const s = readSession();
    if (!s || !s.key) throw Object.assign(new Error('Link Bike4Mind on the Accounts page first: paste an API key from your account.'), { retryable: false });
    if (s.expired) throw Object.assign(new Error(s.expiredReason || EXPIRED), { authExpired: true, retryable: false });
    return { key: s.key, session: s };
  }

  function markExpired(reason) {
    const s = readSession();
    if (!s || !s.key || s.expired) return;
    write({ ...s, expired: true, expiredReason: reason || EXPIRED, models: [] });
  }

  function failure(error) {
    if (!error) return;
    if (error.authExpired) markExpired(error.message);
    if (error.rateLimited && error.cooldownMs) governor.setCooldown(error.cooldownMs, 'Bike4Mind refused requests');
  }

  /** The stream's settlement event prices the call; keep the displayed balance in step with it. */
  function spendCredits(used) {
    const s = readSession();
    const amount = Number(used);
    if (!s || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(s.credits)) return;
    save({ ...s, credits: Math.max(0, s.credits - amount), creditsAt: new Date().toISOString() });
  }

  async function fetchCredits(s = readSession()) {
    if (!s || !s.key || s.expired) return null;
    if (!readingCredits) {
      readingCredits = (async () => {
        try {
          const balance = await readCredits({ base, key: s.key });
          if (Number.isFinite(balance) && current(s)) save({ ...s, credits: balance, creditsAt: new Date().toISOString() });
          return balance;
        } catch (error) {
          if (error.authExpired) failure(error);
          return null;
        } finally { readingCredits = null; }
      })();
    }
    return readingCredits;
  }

  async function refreshModels() {
    const s = readSession();
    if (!s || !s.key || s.expired) return false;
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const models = await readModels({ base, key: s.key });
          if (!current(s)) return false;
          const credits = await readCredits({ base, key: s.key }).catch((error) => { if (error.authExpired) failure(error); return undefined; });
          save({ ...s, models, modelsReadAt: new Date().toISOString(), ...(Number.isFinite(credits) ? { credits, creditsAt: new Date().toISOString() } : {}) });
          log(`bike4mind: model list read (${models.length} models)`);
          return true;
        } catch (error) {
          if (error.authExpired) markExpired(error.message);
          log(`bike4mind: model list was not read (${error.status ? `HTTP ${error.status}, ` : ''}${String(error.message || '').slice(0, 120)})`);
          return false;
        } finally { refreshing = null; }
      })();
    }
    return refreshing;
  }

  async function linkToken({ token, consentAcknowledged } = {}) {
    if (!consentAcknowledged) return { ok: false, error: 'Confirm that this bridge may use your Bike4Mind API key before linking.' };
    if (stopped) return { ok: false, error: 'The provider is stopping.' };
    const key = cleanKey(token);
    if (!key) return { ok: false, error: KEY_HINT };
    if (linking) return { ok: false, error: 'This key is already being checked. Wait for it to finish.' };
    linking = (async () => {
      try {
        const models = await readModels({ base, key });
        const credits = await readCredits({ base, key });
        const account = await readAccount({ base, key });
        if (stopped) return { ok: false, cancelled: true };
        write({
          key,
          linkId: crypto.randomUUID(),
          linkedAt: new Date().toISOString(),
          consentAckAt: new Date().toISOString(),
          models,
          modelsReadAt: new Date().toISOString(),
          credits: Number.isFinite(credits) ? credits : null,
          creditsAt: Number.isFinite(credits) ? new Date().toISOString() : null,
          accountName: account.name,
          tier: account.tier,
          expired: false
        });
        governor.clearCooldown();
        log(`bike4mind: account linked; ${models.length} models, ${Number.isFinite(credits) ? `${credits} credits` : 'balance not reported'}`);
        return { ok: true, linked: true, models };
      } catch (error) {
        if (error.authExpired || error.requiredScopes || error.outOfCredits) return { ok: false, error: error.message };
        log(`bike4mind: key check failed${error.status ? ` (HTTP ${error.status})` : ''}`);
        // A refused request (400/422) has something to say; a connection that never answered does not.
        return { ok: false, error: error.retryable === false ? String(error.message || UNREACHABLE) : UNREACHABLE };
      } finally { linking = null; }
    })();
    return linking;
  }

  async function unlink() {
    fs.rmSync(file, { force: true });
    governor.clearCooldown();
    return { linked: false, models: [] };
  }

  async function status() {
    const s = readSession();
    const linked = Boolean(s && s.key);
    // The settlement of each request keeps the balance close; after ten quiet minutes, ask the API again in the background.
    const checkedAt = Date.parse(s && s.creditsAt ? s.creditsAt : '') || 0;
    if (linked && !s.expired && checkedAt && Date.now() - checkedAt > 10 * 60 * 1000) fetchCredits(s);
    return {
      linked,
      expired: Boolean(s && s.expired),
      expiredReason: (s && s.expiredReason) || null,
      linkedAt: (s && s.linkedAt) || null,
      models: linked && !s.expired ? listModels() : [],
      credits: linked && Number.isFinite(s.credits) ? { balance: s.credits, checkedAt: s.creditsAt || null } : null,
      accountLabel: (s && s.accountName) || null,
      tier: (s && s.tier) || null,
      linking: Boolean(linking),
      linkNote: null,
      usage: governor.getStats()
    };
  }

  async function stop() {
    stopped = true;
    await Promise.allSettled([linking, refreshing, readingCredits].filter(Boolean));
  }

  return {
    readSession, listModels, modelInfo, getKey, markExpired, failure, spendCredits, fetchCredits,
    refreshModels, linkToken, unlink, status, stop
  };
}

module.exports = { createBike4MindAccount };
