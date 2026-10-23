'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson, removeTree, ensureDir } = require('../../config');
const { chromeExecutable, NO_CHROME } = require('../chrome');
const { launchChrome, launchPlainChrome } = require('../chrome_cdp');
const { CHAT, AUTH, EXPIRED, accountId, json, modelList } = require('./api');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function browserSession() {
  if (location.origin !== 'https://chat.qwen.ai') return null;
  let state;
  try { state = JSON.parse(localStorage.getItem('qwen_access_token_state')); } catch (_) {}
  const token = state?.token || localStorage.getItem('token');
  const expiresAt = Number(state?.expiresAt || localStorage.getItem('at_expire_time'));
  if (typeof token !== 'string' || !token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  const script = Array.from(document.scripts).map((s) => s.src).find((s) => s.includes('/qwen-chat-fe/')) || '';
  return { token, expiresAt, userAgent: navigator.userAgent, version: /\/qwen-chat-fe\/([^/]+)\//.exec(script)?.[1] || '' };
}

function createQwenAccount({ dataDir, governor, log = () => {} }) {
  const file = path.join(dataDir, 'qwen_session.json');
  const profileDir = path.join(dataDir, 'qwen-chrome');
  const lifetime = new AbortController();
  let waiting = null;
  let signIn = null;
  let checking = null;
  let refreshing = null;
  let readingModels = null;
  let stopped = false;
  let runtime = null;
  let openingBrowser = null;
  const readSession = () => readJson(file);
  const current = (s) => !stopped && readSession()?.linkId === s.linkId;
  const save = (s) => { if (current(s)) writeJson(file, s); };
  const token = () => { const s = readSession(); return s?.token && !s.expired ? s.token : null; };

  async function closeBrowser() {
    if (openingBrowser) await openingBrowser.catch(() => {});
    const mine = runtime;
    runtime = null;
    if (mine) await mine.browser.close();
  }

  async function openChat() {
    if (waiting || stopped) throw new Error('Finish linking Qwen before sending requests.');
    const s = readSession();
    if (!s?.token || s.expired) throw Object.assign(new Error(s?.token ? EXPIRED : 'Link Qwen on the Accounts page first.'), { authExpired: Boolean(s?.token) });
    checkPause();
    if (!runtime?.browser.connected || runtime.page.closed) {
      if (!openingBrowser) {
        openingBrowser = (async () => {
          if (runtime) { await runtime.browser.close(); runtime = null; }
          const executablePath = chromeExecutable();
          if (!executablePath) throw new Error(NO_CHROME);
          const browser = await launchChrome({ executablePath, userDataDir: profileDir, log });
          try {
            const page = await browser.newPage();
            await page.goto(`${CHAT}/`);
            if (!current(s) || waiting) throw new Error('The Qwen account changed while Chrome was opening.');
            runtime = { browser, page };
            log('qwen: opened the dedicated browser for chat requests');
          } catch (error) { await browser.close(); throw error; }
        })().finally(() => { openingBrowser = null; });
      }
      await openingBrowser;
    }
    const page = runtime.page;
    let auth;
    for (const until = Date.now() + 10000; Date.now() < until;) {
      if (!current(s) || waiting) throw new Error('The Qwen account changed while Chrome was opening.');
      auth = await page.evaluate(browserSession);
      if (auth) break;
      await sleep(250);
    }
    if (!auth) throw Object.assign(new Error(EXPIRED), { authExpired: true });
    const cookies = await page.cookies([`${CHAT}/api/v2/`, `${AUTH}/api/v2/auths/refresh`, `${AUTH}/api/v2/auths/`]);
    if (!current(s) || waiting) throw new Error('The Qwen account changed while Chrome was opening.');
    const owner = accountId(s.token);
    if (!owner || accountId(auth.token) !== owner) throw Object.assign(new Error('The Qwen browser account does not match the linked account. Finish signing in again on the Accounts page.'), { authExpired: true });
    const session = { ...readSession(), ...auth, cookies };
    save(session);
    return { page, session };
  }

  function failure(error, session) {
    if (session && !current(session)) return;
    if (error.authExpired) {
      const s = readSession();
      if (s) writeJson(file, { ...s, expired: true, expiredReason: EXPIRED });
    }
    if (error.rateLimited) governor.setCooldown(error.cooldownMs, error.verificationRequired ? 'Qwen requested browser verification' : 'Qwen refused requests');
  }

  function checkPause() {
    const limit = governor.checkLimit();
    if (!limit.allowed && limit.reason === 'cooldown') throw Object.assign(new Error(limit.message), { rateLimited: true, retryable: false });
  }

  async function call(session, url, options = {}) {
    checkPause();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000), ...(options.signal ? [options.signal] : [])]);
    try { return await json(session, url, { ...options, signal }); }
    catch (error) { failure(error, session); throw error; }
  }

  async function getSession() {
    if (waiting || stopped) throw Object.assign(new Error('Finish linking Qwen before sending requests.'), { retryable: false });
    const s = readSession();
    if (!s?.token || s.expired) throw Object.assign(new Error(s?.token ? EXPIRED : 'Link Qwen on the Accounts page first.'), { authExpired: Boolean(s?.token), retryable: false });
    checkPause();
    if (s.expiresAt > Date.now() + 180000) return s;
    if (!refreshing) {
      refreshing = (async () => {
        const result = await call(s, `${AUTH}/api/v2/auths/refresh`);
        const value = result?.data?.access_token;
        let expiry = Number(result?.data?.expires_at) * 1000;
        if (!expiry && typeof value === 'string') {
          try { expiry = Number(JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString()).exp) * 1000; } catch (_) {}
        }
        if (result.success !== true || typeof value !== 'string' || !value || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Qwen did not return a valid refreshed sign-in. Sign in again on the Accounts page.');
        if (!current(s)) throw new Error('The Qwen account changed while its sign-in was being refreshed.');
        if (!accountId(s.token) || accountId(value) !== accountId(s.token)) throw new Error('Qwen refreshed a different account. Finish signing in again on the Accounts page.');
        s.token = value;
        s.expiresAt = expiry;
        save(s);
        return s;
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function refreshModels() {
    if (waiting || !token()) return false;
    if (!readingModels) {
      readingModels = (async () => {
        const s = await getSession();
        const models = modelList(await call(s, `${CHAT}/api/v2/models/`));
        if (!current(s)) return false;
        save({ ...s, models, modelsReadAt: Date.now() });
        return true;
      })().finally(() => { readingModels = null; });
    }
    return readingModels;
  }

  function listModels() {
    const s = readSession();
    return s?.token && !s.expired ? s.models || [] : [];
  }

  async function closeSignIn() {
    const mine = signIn;
    signIn = null;
    if (mine) await mine.close();
  }

  function settle() {
    if (waiting) clearTimeout(waiting.timer);
    waiting = null;
  }

  async function openSignIn(w) {
    ensureDir(profileDir);
    const mine = launchPlainChrome({ executablePath: w.exe, userDataDir: profileDir, url: `${CHAT}/` });
    signIn = mine;
    await Promise.race([mine.exited, sleep(500)]);
    if (!mine.running) throw new Error('Chrome could not open the Qwen sign-in profile. Close only an earlier Qwen sign-in window and try again.');
    mine.exited.then(() => { if (signIn === mine) signIn = null; });
  }

  async function startLink({ consentAcknowledged } = {}) {
    if (!consentAcknowledged) return { ok: false, error: 'Confirm that this bridge may use your Qwen session before linking.' };
    if (waiting) return { ok: true, checking: Boolean(checking) };
    if (stopped) return { ok: false, error: 'The provider is stopping.' };
    const exe = chromeExecutable();
    if (!exe) return { ok: false, error: NO_CHROME };
    const w = { exe, note: '', consentAckAt: new Date().toISOString() };
    waiting = w;
    try {
      await closeBrowser();
      if (waiting !== w || stopped) return { ok: false, cancelled: true };
      await openSignIn(w);
      if (waiting !== w || stopped) return { ok: false, cancelled: true };
      w.timer = setTimeout(() => { if (waiting === w) { settle(); closeSignIn().catch(() => {}); } }, 15 * 60000);
      w.timer.unref();
      return { ok: true };
    } catch (error) { settle(); await closeSignIn(); return { ok: false, error: error.message }; }
  }

  async function checkLink(w) {
    let browser;
    try {
      w.note = 'Checking your Qwen sign-in. Chrome opens briefly on the same private profile.';
      await closeSignIn();
      if (waiting !== w || stopped) return { ok: false, cancelled: true };
      browser = await launchChrome({ executablePath: w.exe, userDataDir: profileDir, log });
      const page = await browser.newPage();
      await page.goto(`${CHAT}/`);
      let auth = null;
      for (const until = Date.now() + 10000; waiting === w && Date.now() < until;) {
        auth = await page.evaluate(browserSession);
        if (auth) break;
        await sleep(400);
      }
      const cookies = auth ? await page.cookies([`${CHAT}/api/v2/`, `${AUTH}/api/v2/auths/refresh`, `${AUTH}/api/v2/auths/`]) : [];
      await browser.close();
      browser = null;
      if (waiting !== w || stopped) return { ok: false, cancelled: true };
      if (!auth) {
        await openSignIn(w);
        w.note = 'No active Qwen sign-in was found. Finish signing in in the Chrome window, then press “I have signed in”.';
        return { ok: false, notSignedIn: true, note: w.note };
      }
      const session = { ...auth, cookies, linkId: crypto.randomUUID(), linkedAt: new Date().toISOString(), consentAckAt: w.consentAckAt, expired: false };
      const profile = await call(session, `${AUTH}/api/v2/auths/`);
      if (profile.success !== true || !profile.data || typeof profile.data !== 'object') throw new Error('Qwen did not confirm this sign-in.');
      session.models = modelList(await call(session, `${CHAT}/api/v2/models/`));
      session.modelsReadAt = Date.now();
      if (waiting !== w || stopped) return { ok: false, cancelled: true };
      writeJson(file, session);
      settle();
      log('qwen: account linked; model list read');
      return { ok: true, linked: true };
    } catch (error) {
      if (error.rateLimited && error.cooldownMs) governor.setCooldown(error.cooldownMs, 'Qwen refused sign-in verification');
      if (waiting === w) w.note = error.authExpired ? EXPIRED : error.rateLimited ? error.message : 'Qwen sign-in could not be checked. No new session was saved. Try again when the site is available.';
      log(`qwen: sign-in check failed${Number.isInteger(error.status) ? ` (HTTP ${error.status})` : ''}`);
      return { ok: false, blocked: true, note: w.note };
    } finally { if (browser) await browser.close(); }
  }

  async function finishLink({ cancel } = {}) {
    if (!waiting) return { ok: false, error: 'No Qwen sign-in is waiting.' };
    if (cancel) { settle(); await closeSignIn(); if (checking) await checking; return { ok: true, cancelled: true }; }
    if (!checking) checking = checkLink(waiting).finally(() => { checking = null; });
    return checking;
  }

  async function stop() {
    stopped = true;
    lifetime.abort();
    settle();
    await closeSignIn();
    if (checking) await checking;
    await closeBrowser();
    await Promise.allSettled([refreshing, readingModels].filter(Boolean));
  }

  async function unlink() {
    settle();
    await closeSignIn();
    if (checking) await checking;
    await closeBrowser();
    fs.rmSync(file, { force: true });
    await removeTree(profileDir);
    governor.clearCooldown();
    return { linked: false, models: [] };
  }

  async function status() {
    const s = readSession();
    return { linked: Boolean(s?.token), expired: Boolean(s?.expired), expiredReason: s?.expiredReason || null, linkedAt: s?.linkedAt || null, models: listModels(), linking: Boolean(waiting), linkNote: waiting?.note || null, usage: governor.getStats() };
  }

  return { readSession, getSession, openChat, save, token, failure, refreshModels, listModels, startLink, finishLink, unlink, stop, status };
}

module.exports = { createQwenAccount };
