/**
 * DeepSeek account linking: the saved session, and the two ways to get one.
 *
 *  1. Through Chrome (the supported way). startLink() opens an ordinary Chrome on a profile folder of this program's (never the person's everyday profile), at
 *     chat.deepseek.com; the person signs in there themselves (password, phone code or Google: the page decides, this program sees none of it) and presses
 *     Done. finishLink() quits that Chrome, starts another on the same profile (an ordinary window for a few seconds: the site refuses a hidden one), reads the web app's own session token from localStorage (userToken.value)
 *     and the site's cookies, saves them, and closes it. Two Chromes because Google refuses a sign-in from a browser that has a debugging port.
 *  2. A pasted token (linkToken), for a machine with no Chrome.
 *
 * The session is the person's own: it is kept in plain files in the data folder (0600), like a browser profile, and only ever leaves this machine toward
 * chat.deepseek.com. Unlink deletes the file and the Chrome profile.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, removeTree } = require('../../config');
const { chromeExecutable, NO_CHROME } = require('../chrome');
const { launchChrome, launchPlainChrome } = require('../chrome_cdp');
const { sessionExpiry } = require('./session_expiry');
const { CHROME_UA, DEFAULT_BASE } = require('./base');
const { checkLogin } = require('./account');

const SESSION_FILE = 'deepseek_session.json';
const PROFILE_DIR_NAME = 'deepseek-chrome';
const LOGIN_TTL_MS = 15 * 60 * 1000;
const TOKEN_WAIT_MS = 10000;
const WAF_WAIT_MS = 8000;
const BACKGROUND_FLAGS = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
// The Chrome that reads the sign-in is an ordinary window for a few seconds. The real site answers a hidden (headless) Chrome with a "request blocked" page and hands
// it no WAF token, and API calls need that token (measured 2026-10-22). ULA_DEEPSEEK_HIDDEN=1 brings the hidden one back.
const HIDDEN = process.env.ULA_DEEPSEEK_HIDDEN === '1';
const CHECKING = 'Checking your sign-in (a Chrome window opens for a moment)...';
const BLOCK_PAGE = /request could not be satisfied|request blocked|access denied/i;
const WAF_COOKIE = 'aws-waf-token';

/** The models of a linked account: the web chat has two modes, offered as three ids (see the README). */
const MODELS = [
  { id: 'deepseek-chat', name: 'DeepSeek Chat', thinking: false, escalate: false },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (DeepThink)', thinking: true, escalate: false },
  { id: 'deepseek-auto', name: 'DeepSeek Auto (chat that can think)', thinking: false, escalate: true }
];

/** Runs inside the page: the web app keeps its session token in localStorage. Never ds_session_id: DeepSeek sets that one for anonymous visitors too. */
function readToken() {
  try {
    for (const key of ['userToken', 'token', 'auth_token', 'ds_token']) {
      const raw = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (!raw) continue;
      try {
        const t = JSON.parse(raw);
        if (t && typeof t.value === 'string' && t.value.length > 20) return { token: t.value, expire: t.expire || t.expires || null };
        if (t && typeof t.token === 'string' && t.token.length > 20) return { token: t.token, expire: t.expire || t.expires || null };
      } catch (_) { /* not JSON: a bare token below */ }
      if (typeof raw === 'string' && raw.length > 20 && !raw.startsWith('{')) return { token: raw, expire: null };
    }
    return null;
  } catch (_) { return null; }
}

/** Runs inside the page: what the check Chrome is looking at, for the log and for telling a block from a sign-in page. No token, no cookie values. */
function pageFacts() {
  try {
    const text = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    let keys = -1;
    try { keys = Object.keys(localStorage).length; } catch (_) { /* storage not readable here */ }
    return { href: location.origin + location.pathname, title: String(document.title || '').slice(0, 80), text, keys };
  } catch (_) { return null; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createDeepSeekAccount({ dataDir, base = DEFAULT_BASE, log = () => {}, governor = null, plainChromeArgs = [], drivenChromeArgs = [] }) {
  const sessionPath = () => path.join(dataDir, SESSION_FILE);
  const profileDir = () => path.join(dataDir, PROFILE_DIR_NAME);
  let signIn = null; // the plain Chrome the person signs in on, while a link waits
  let waiting = null; // { resolve, exe, consentAckAt, checking, timer } of the link in progress
  let note = null; // a sentence for the Accounts card while a link waits
  let labelTriedFor = '';

  const readSession = () => readJson(sessionPath());
  const writeSession = (data) => writeJson(sessionPath(), data);

  function isExpired(s) {
    if (!s || !s.token) return true;
    if (s.expired) return true;
    const exp = sessionExpiry(s);
    return exp !== null && Date.now() >= exp;
  }

  function markExpired(reason = 'Your DeepSeek session has expired. Sign in again on the Accounts page.') {
    const s = readSession();
    if (!s) return;
    writeSession({ ...s, expired: true, expiredReason: reason, expiredAt: new Date().toISOString() });
    log('deepseek: session marked expired: ' + reason);
  }

  const labelOf = (s) => (s && typeof s.accountLabel === 'string' && s.accountTokenTail === String(s.token || '').slice(-8) ? s.accountLabel : '');

  /** Which account is linked, masked (a person can have two). Asked once per login, in the background, and kept in the session file. */
  async function refreshLabel(s) {
    const tail = String(s.token || '').slice(-8);
    const { label } = await checkLogin({ token: s.token, cookies: s.cookies, userAgent: CHROME_UA, base });
    if (!label) return;
    const now = readSession();
    if (!now || String(now.token || '').slice(-8) !== tail) return; // the login changed while this was asked
    writeSession({ ...now, accountLabel: label, accountTokenTail: tail });
  }

  async function status() {
    const s = readSession();
    const usage = governor ? governor.getStats() : null;
    const linking = Boolean(waiting);
    const linkNote = linking ? note : null;
    if (!s || !s.token) return { linked: false, expired: false, models: [], usage, linking, linkNote };
    const expired = isExpired(s);
    if (!expired && !labelOf(s) && labelTriedFor !== String(s.token).slice(-8)) {
      labelTriedFor = String(s.token).slice(-8);
      refreshLabel(s).catch(() => {});
    }
    return {
      linked: true,
      expired,
      expiredReason: expired ? (s.expiredReason || 'Your DeepSeek session has expired. Sign in again on the Accounts page.') : null,
      models: expired ? [] : MODELS,
      linkedAt: s.linkedAt || null,
      expiresAt: sessionExpiry(s) === null ? null : new Date(sessionExpiry(s)).toISOString(),
      accountLabel: labelOf(s),
      manual: Boolean(s.manual),
      usage,
      linking,
      linkNote
    };
  }

  function listModels() {
    const s = readSession();
    return s && s.token && !isExpired(s) ? MODELS : [];
  }

  async function closeSignIn() {
    const mine = signIn;
    signIn = null;
    if (mine) await mine.close().catch(() => {});
  }

  /** Opens the plain Chrome on the sign-in page. Chrome started on a profile another Chrome still holds hands over and exits at once: that is an earlier Chrome of this program, still up after a crash. */
  async function openSignIn(exe) {
    const mine = launchPlainChrome({ executablePath: exe, userDataDir: profileDir(), url: `${base}/`, args: plainChromeArgs });
    await Promise.race([mine.exited, sleep(1500)]);
    if (!mine.running) return { ok: false, error: 'A Chrome window that this program opened earlier is still running. Quit that Chrome (Chrome menu, Quit) and try again.' };
    signIn = mine;
    log('deepseek: chrome opened without a debugging port, waiting for the person to sign in');
    mine.exited.then(() => {
      if (signIn !== mine || !waiting) return;
      signIn = null;
      log('deepseek: the sign-in Chrome was quit before the link finished');
      settle();
    });
    return { ok: true };
  }

  /** Ends the link that is waiting, once. The state is cleared before the answer is built, so it never says "still linking". */
  async function settle() {
    const w = waiting;
    if (!w) return;
    waiting = null;
    note = null;
    clearTimeout(w.timer);
  }

  async function startLink({ consentAcknowledged } = {}) {
    if (!consentAcknowledged) return { ok: false, error: 'Consent must be acknowledged prior to linking.' };
    if (waiting) return { ok: true };
    const exe = chromeExecutable();
    if (!exe) return { ok: false, error: NO_CHROME };
    await closeSignIn();
    const opened = await openSignIn(exe);
    if (!opened.ok) return opened;
    const timer = setTimeout(async () => {
      log('deepseek: link window expired');
      await closeSignIn();
      settle();
    }, LOGIN_TTL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    waiting = { exe, consentAckAt: new Date().toISOString(), checking: false, timer };
    note = null;
    return { ok: true };
  }

  /** The person pressed Done (or Cancel). Reads the session out of the profile they signed in on. */
  async function finishLink({ cancel } = {}) {
    const w = waiting;
    if (!w) return { ok: false, error: 'No DeepSeek link is waiting for you.' };
    if (cancel) {
      log('deepseek: link cancelled');
      await closeSignIn();
      await settle();
      return { ok: true, cancelled: true };
    }
    if (w.checking) return { ok: true, checking: true };
    w.checking = true;
    note = CHECKING;
    let browser = null;
    try {
      await closeSignIn();
      browser = await launchChrome({ executablePath: w.exe, userDataDir: profileDir(), args: [...(HIDDEN ? ['--headless=new'] : []), ...BACKGROUND_FLAGS, ...drivenChromeArgs], log });
      const page = await browser.newPage();
      await page.goto(`${base}/`).catch(() => {});
      let auth = null;
      let seen = null;
      for (const until = Date.now() + TOKEN_WAIT_MS; !auth && Date.now() < until;) {
        auth = await page.evaluate(readToken).catch(() => null);
        if (auth) break;
        seen = (await page.evaluate(pageFacts).catch(() => null)) || seen;
        if (seen && BLOCK_PAGE.test(`${seen.title} ${seen.text}`)) break; // a block page does not change by waiting
        await sleep(400);
      }
      let cookies = [];
      if (auth) {
        // The site issues the WAF token a moment after the page loaded; a session without it is refused by the API.
        for (const until = Date.now() + WAF_WAIT_MS; ;) {
          cookies = await page.cookies([`${base}/`]).catch(() => []);
          if (cookies.some((c) => c.name === WAF_COOKIE) || Date.now() >= until) break;
          await sleep(400);
        }
        if (!cookies.some((c) => c.name === WAF_COOKIE)) log('deepseek: no WAF token cookie arrived within the wait; the link is kept without it');
      } else {
        const names = (await page.cookies([`${base}/`]).catch(() => [])).map((c) => c.name).join(',');
        const blockedNow = Boolean(seen) && BLOCK_PAGE.test(`${seen.title} ${seen.text}`);
        // What the check saw, without any value: the address, the title, how many localStorage entries, which cookies. The page text only when it is a block page.
        log(`deepseek: check saw ${seen ? `${seen.href} "${seen.title}" (localStorage ${seen.keys} entries; cookies: ${names || 'none'})${blockedNow ? ` text: ${seen.text}` : ''}` : 'no page at all'}`);
      }
      await browser.close().catch(() => {});
      browser = null;
      if (!auth && seen && BLOCK_PAGE.test(`${seen.title} ${seen.text}`)) {
        note = 'DeepSeek refused the Chrome that checks your sign-in (it answered "request blocked"). That is not a problem with your login: press Done again in a minute. If it keeps happening, paste the session token instead (Advanced).';
        return { ok: false, blocked: true, note };
      }
      if (!auth) {
        // Not signed in (Done pressed too early, or the sign-in did not take): the plain Chrome comes back so the person can go on.
        log('deepseek: Done was pressed but no session token was found in the profile');
        const reopened = await openSignIn(w.exe);
        if (!reopened.ok) { await settle(); return reopened; }
        // The page's storage cannot even be read: Chrome is not letting this site save data on the computer (a setting, an extension), so no sign-in can stick.
        // Said as that, with where to change it: "the sign-in page is showing" sent a person round in circles (a real blocker, 2026-10-22).
        if (seen && seen.keys === -1) {
          note = 'Chrome is not letting chat.deepseek.com save data on this computer, so a sign-in cannot stay. In the Chrome window, open a new tab, go to chrome://settings/content/siteData and allow sites to save data (or remove chat.deepseek.com from "Not allowed to save data"), check that no extension blocks cookies, then sign in again and press Done.';
          return { ok: false, notSignedIn: true, storageBlocked: true, note };
        }
        note = 'DeepSeek still shows its sign-in page. Finish signing in in the Chrome window, then press Done again.';
        return { ok: false, notSignedIn: true, note };
      }
      const expiresAt = auth.expire && typeof auth.expire === 'number' ? new Date(auth.expire > 1e11 ? auth.expire : auth.expire * 1000).toISOString() : null;
      writeSession({
        token: auth.token,
        cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires })),
        linkedAt: new Date().toISOString(),
        // Only an expiry DeepSeek itself reported is kept; without one the login lives until DeepSeek refuses it.
        expiresAt,
        consentAckAt: w.consentAckAt,
        expired: false,
        expiredReason: null
      });
      log(`deepseek: linked (${expiresAt ? `valid until ${expiresAt}` : 'until DeepSeek refuses it'})`);
      await settle();
      return { ok: true, linked: true };
    } catch (err) {
      await closeSignIn();
      await settle();
      return { ok: false, error: String((err && err.message) || err) };
    } finally {
      if (browser) await browser.close().catch(() => {});
      w.checking = false;
      if (waiting === w && note === CHECKING) note = null;
    }
  }

  /** Links with a token the person pasted (userToken.value from the site's local storage), after DeepSeek says it works. */
  async function linkToken({ token, consentAcknowledged } = {}) {
    if (!consentAcknowledged) return { ok: false, error: 'Consent must be acknowledged prior to linking.' };
    let value = String(token || '').trim();
    if (value.startsWith('{')) { try { const t = JSON.parse(value); value = String(t.value || t.token || ''); } catch (_) { value = ''; } }
    value = value.replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '');
    if (value.length < 20 || /\s/.test(value)) return { ok: false, error: 'That does not look like a DeepSeek session token.' };
    const check = await checkLogin({ token: value, userAgent: CHROME_UA, base });
    if (check.valid === false) return { ok: false, error: 'DeepSeek did not accept that token.' };
    if (check.valid === null) return { ok: false, error: 'Could not reach DeepSeek to check the token. Try again.' };
    writeSession({
      token: value, cookies: [], manual: true, linkedAt: new Date().toISOString(), expiresAt: null, consentAckAt: new Date().toISOString(),
      expired: false, expiredReason: null,
      ...(check.label ? { accountLabel: check.label, accountTokenTail: value.slice(-8) } : {})
    });
    log('deepseek: linked with a pasted token');
    return { ok: true, linked: true };
  }

  async function unlink() {
    await closeSignIn();
    await settle();
    try { fs.unlinkSync(sessionPath()); } catch (_) { /* nothing was saved */ }
    // The profile folder is this program's copy of the DeepSeek session: deleting it signs the lane out everywhere.
    try { await removeTree(profileDir()); } catch (err) { log('deepseek: the profile folder could not be removed: ' + String((err && err.message) || err)); }
    if (governor) governor.clearCooldown();
    log('deepseek: unlinked');
    return { linked: false, models: [], usage: governor ? governor.getStats() : null };
  }

  /** Ends everything this lane has open, and waits for it: a Chrome left running would outlive the program. */
  async function stop() {
    await closeSignIn();
    if (waiting) clearTimeout(waiting.timer);
  }

  return { status, listModels, startLink, finishLink, linkToken, unlink, markExpired, stop, SESSION_FILE };
}

module.exports = { createDeepSeekAccount, MODELS, SESSION_FILE };
