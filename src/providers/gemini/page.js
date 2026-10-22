/**
 * Gemini account linking and chat driving (main process).
 *
 * Google refuses sign-in inside embedded browser windows, so this lane borrows a real Chrome: the driver in chrome_cdp.js
 * starts it with a profile folder of this program's (never the person's everyday profile) and a visible
 * window, and the person signs in themselves in that window. The profile folder keeps the session between launches, so linking
 * once is enough; unlink deletes the folder and with it every cookie Google left.
 *
 * Chat runs in the same Chrome: one fresh gemini.google.com tab per call, the bridge prompt pasted into the composer, Enter,
 * and the answer read back from the page as it grows. The tab is closed when the answer is in; the conversation stays in the
 * person's Gemini history like any chat they typed themselves.
 *
 * With `keep` the conversation's address (gemini.google.com/app/<id>) is handed back as a `remote`, and a call made with that `remote` opens the same conversation
 * and adds one message to it, the way a person comes back to a chat (src/sessions.js decides when a request is that). The conversations stay in the person's
 * history, one for each session, and are never deleted from here: removing one would mean driving the page's menus.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeJson, removeTree } = require('../../config');
const { chromeExecutable, NO_CHROME } = require('../chrome');

const SESSION_FILE = 'gemini_session.json';
// What the person chose for how long Gemini thinks before it answers. It is a setting of its own, not part of the link, so Unlink does not lose it.
const SETTINGS_FILE = 'gemini_settings.json';
const THINKING_LEVELS = ['low', 'medium', 'high'];
const DEFAULT_THINKING_LEVEL = 'low';
const PROFILE_DIR_NAME = 'gemini-chrome';
const APP_URL = 'https://gemini.google.com/app';
const LOGIN_TTL_MS = 15 * 60 * 1000;
// How often a call looks at the page while it waits for something, and how long an answer must stand still before it counts as finished. These
// were 700 ms and four stills in a row (2.8 s); the page's own "working" sign (the Stop button) is what ends an answer, the stillness only confirms it.
const WAIT_POLL_MS = 150;
const ANSWER_POLL_MS = 250;
const QUIET_MS = 1500;       // the page said it was working and has stopped: the text standing still this long is the end
const QUIET_BLIND_MS = 4000; // the page never showed it was working (a renamed selector): the text alone has to stand still longer
const QUIET_MAX_MS = 8000;   // whatever the page's buttons say, an answer that has not moved for this long is over
const PICKER_WAIT_MS = 10000; // how long the model picker button is waited for while linking: a signed-in page can draw it after its message box
const PICKER_CALL_WAIT_MS = 4000; // the same on a call that reads the picker again
const ROWS_WAIT_MS = 5000; // how long the menu's rows are waited for after the picker was opened
const TAB_IDLE_MS = 5 * 60 * 1000; // a conversation's tab stays open this long after its last answer, like a person's tab that is left up
const MAX_TABS = 3; // and only this many stay open at once: the oldest is closed when another conversation needs its place
// What the page writes where an answer goes when its own request failed (seen 2026-10-22: "Sorry, something went wrong. Please try your request again." and
// "I seem to be encountering an error. Can I try something else for you?"). It is the page's message, not the model's: handing it back as an answer made a
// failure look like a reply. Short and of these exact shapes only, so a real answer is never taken for one.
const PAGE_ERROR_ANSWERS = [
  /^\s*(?:sorry,?\s+)?something went wrong\.?\s*(?:please\s+)?try\b[^.]{0,60}\.?\s*$/i,
  /^\s*i seem to be encountering an error\.?\s*(?:can i try something else for you\??)?\s*$/i
];
const WAIT_TRACE_MS = 10000; // while no word of the answer has shown, what the page shows is written to the log this often, so a slow call can be read afterwards
const FIRST_WORDS_MAX_MS = 4 * 60 * 1000; // a message that was sent and has shown no answer word and no thinking word for this long is given up on, whatever the page says it is doing

// The page's own names for the parts this lane watches. Several selectors per part because Google renames them without notice;
// every miss is logged, so a rename shows up in the run instead of as a silent empty answer.
const COMPOSER_SELECTORS = [
  'rich-textarea .ql-editor[contenteditable="true"]',
  'div.ql-editor[contenteditable="true"]',
  'textarea[aria-label*="prompt" i]',
  'div[contenteditable="true"][aria-label*="prompt" i]',
  'div[contenteditable="true"]'
];
// Read on a live window (2026-10-20): the answer is a div.markdown-main-panel inside message-content inside model-response.
// The outer model-response is deliberately not used: its own innerText starts with the page's label "Gemini said", which would
// land in the answer. The most specific selector comes first, and the first that matches wins.
const ANSWER_SELECTORS = [
  'model-response .markdown-main-panel',
  'message-content .markdown',
  'model-response .markdown',
  '.markdown-main-panel'
];
const THINKING_SELECTORS = [
  'model-response .thought-summary',
  'model-response .expander .markdown',
  'message-content .expander .markdown',
  '[class*="thinking-text"]',
  '.thinking-summary'
];
// Two signs the page is still generating, read on the live window: the dots animation, and a visible Stop button. The Stop
// button alone is not enough (it stays in the page after an answer), so visibility is asked of it and the dots decide.
const RUNNING_SELECTORS = [
  '.thinking-dots-animation',
  'button[aria-label="Stop response"]',
  'stop-response-button'
];
/** The element holding the message that was sent: its appearance is proof Enter was understood. */
const SENT_SELECTORS = ['user-query'];
const MODEL_BUTTON_SELECTORS = [
  'button[aria-label*="mode picker" i]',
  'button[aria-label*="model" i]',
  'model-picker-button button',
  'button.model-selector-button'
];
// The page's own menu of what the account may use (read 2026-10-20 on a signed-out window: gem-menu > gem-menu-item, the names
// "3.5 Flash-Lite", "3.6 Flash", "3.1 Pro", "4 Argon"). The order matters: the most specific first.
const MODEL_OPTION_SELECTORS = [
  '[role="menu"] gem-menu-item',
  'gem-menu-item[role="menuitem"]',
  '[role="menu"] [role="menuitem"]',
  '[role="menu"] [role="menuitemradio"]',
  '[role="listbox"] [role="option"]'
];
// Rows in that menu that are not models (a signed-out window ends with "Sign in for all models"; a signed-in one carries a
// "Thinking level" submenu whose rows are Low, Medium and High): the list stays truthful by naming only what the account can actually
// answer with. "Auto" is NOT here: read on a free account (2026-10-20) it is the only row that is not behind a lock, so dropping it
// left the lane offering exactly the models the account cannot use.
const NOT_A_MODEL = /sign in|log in|all models|thinking level|settings|help|learn more|^(low|medium|high)(\s|$)/i;
/** The model the lane offers when the page's menu could not be read at all: whatever mode the page is on. The relay's own id for it. */
// Names that never go stale in a client's list: they mean "the mode the page is on". `gemini-auto` is the account's own Auto row when its picker has one
// (a free account does), and then that row is really chosen.
const STABLE_MODELS = [
  { id: 'gemini', name: 'Gemini (account default)', thinking: true, alias: true },
  { id: 'gemini-auto', name: 'Gemini Auto (account default)', thinking: true, alias: true }
];
const MODELS_TTL_MS = 15 * 60 * 1000; // the picker is read again when the list is older than this
const MODELS_RETRY_MS = 3 * 60 * 1000; // after a read that found nothing, sooner
const IDLE_CLOSE_MS = 10 * 60 * 1000;
// The driven Chrome has no one looking at it, so it must not treat its pages as unseen: Chrome slows the timers and drawing of a page it thinks is in the background,
// and the page's own streaming of an answer slows with it. These are Chrome's own switches for that; they change nothing about what the page can see of the browser.
const BACKGROUND_FLAGS = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
// The Chrome that answers chat runs without a window (measured 2026-10-20: a headless page stays "visible" and keeps drawing at full rate; a
// minimized one is "hidden" and draws nothing, and macOS pulls a window placed off-screen back onto the screen). ULA_GEMINI_VISIBLE=1 shows it.
const HEADLESS = process.env.ULA_GEMINI_VISIBLE !== '1';
// ULA_GEMINI_MINIMAL=1 starts the driven Chrome with only the flags that driving needs (no background-rendering switches, nothing else): a way to tell whether our own
// extra flags matter, by comparing it with an ordinary Chrome on the same profile. Diagnosis only.
const MINIMAL = process.env.ULA_GEMINI_MINIMAL === '1';
// The page's own way of saying nobody is signed in: a Sign in control. The signed-out window has two of them, and the app must
// not mistake a page that merely loaded for an account that is linked.
// Only controls that SAY "Sign in". A link that merely points at accounts.google.com is not one: a signed-in page has such links (its account menu,
// its footer), and counting them told a signed-in account it was signed out (2026-10-20, the first real link).
const SIGN_IN_SELECTORS = [
  'button[aria-label="Sign in"]',
  'a[aria-label="Sign in"]'
];
const PROFILE_SELECTOR = 'button[aria-label*="Account" i], button[aria-label*="Profile" i], [data-profile-icon], gemini-avatar, account-icon';

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'gemini';
}

/**
 * The account's own rows for what the page's menu read. Only rows the account can answer with are offered; a locked row is never a model
 * (a free account links to its usable rows or to none, never to the ones the first message would be refused on). None read is an empty list:
 * the stable names (withStableNames) still stand for the page's own mode, so "linked" never means "linked, with no model to choose".
 */
function modelsFromRead(read) {
  const names = Array.isArray(read && read.names) ? read.names : [];
  return names.map((name) => ({ id: `gemini-${slug(name)}`, name, thinking: true }));
}

/** What a client is shown: `gemini` and `gemini-auto` first, always (an account's own row of the same name takes the place of the generic one), then the other rows. */
function withStableNames(real) {
  const rows = Array.isArray(real) ? real : [];
  const stable = STABLE_MODELS.map((m) => rows.find((r) => r.id === m.id) || m);
  return [...stable, ...rows.filter((r) => !STABLE_MODELS.some((m) => m.id === r.id))];
}

/** The linked model a request names: its id as listed ("gemini-3-1-pro"), or the same without the leading "gemini-". */
function modelByRef(models, ref) {
  if (!ref || !Array.isArray(models)) return null;
  const id = String(ref);
  return models.find((m) => m.id === id || m.id === `gemini-${id}`) || null;
}

function createGemini({ dataDir, log = () => {}, governor = null, onStatus = () => {}, appUrl = APP_URL, plainChromeArgs = [], firstWordsMaxMs = FIRST_WORDS_MAX_MS, waitTraceMs = WAIT_TRACE_MS, tabIdleMs = TAB_IDLE_MS, maxTabs = MAX_TABS, modelsTtlMs = MODELS_TTL_MS }) {
  const sessionPath = () => path.join(dataDir, SESSION_FILE);
  const settingsPath = () => path.join(dataDir, SETTINGS_FILE);
  const profileDir = () => path.join(dataDir, PROFILE_DIR_NAME);
  // The lane links only on the page it opened: a redirect to accounts.google.com is a sign-in still to do, not an answer.
  let appOrigin = APP_URL;
  try { appOrigin = new URL(appUrl).origin; } catch (_) { /* an odd appUrl keeps the real origin, which never matches it */ }
  let browser = null;
  let launching = null;
  let loginWaiter = null;
  let idleTimer = null;
  let inUse = 0; // chat calls running right now
  let probedFor = null; // the Chrome whose response shape was last logged
  // The tabs of conversations that go on: a person keeps a conversation open in one tab, so after an answer the tab is kept (not closed and
  // opened again by its address on the next message). Keyed by the conversation's id. A tab is out of this map while a call uses it.
  const tabs = new Map();
  let tabTimer = null;

  /** The open tab of a conversation, taken out of the map for the call that uses it; null when there is none (or it is gone). */
  function takeTab(id) {
    const t = tabs.get(id);
    if (!t) return null;
    tabs.delete(id);
    return t.page.closed ? null : t;
  }

  /** Closes tabs that were idle too long, and the oldest ones beyond the few that may stay open. */
  async function trimTabs() {
    const now = Date.now();
    const closing = [];
    for (const [id, t] of [...tabs]) {
      if (t.page.closed || now - t.usedAt >= tabIdleMs) { tabs.delete(id); closing.push(t.page); }
    }
    while (tabs.size > maxTabs) {
      const [oldest] = [...tabs].sort((a, b) => a[1].usedAt - b[1].usedAt);
      tabs.delete(oldest[0]);
      closing.push(oldest[1].page);
    }
    await Promise.all(closing.map((pg) => pg.close().catch(() => {})));
    if (tabTimer) { clearTimeout(tabTimer); tabTimer = null; }
    if (tabs.size) {
      const next = Math.min(...[...tabs.values()].map((t) => t.usedAt)) + tabIdleMs - now + 50;
      tabTimer = setTimeout(() => { tabTimer = null; trimTabs().catch(() => {}); }, Math.max(100, next));
      if (typeof tabTimer.unref === 'function') tabTimer.unref();
    }
  }

  async function keepTab(id, page) {
    tabs.set(id, { page, usedAt: Date.now() });
    await trimTabs();
  }

  /** Forgets every tab at once (the Chrome they lived in is gone). */
  function forgetTabs() {
    tabs.clear();
    if (tabTimer) { clearTimeout(tabTimer); tabTimer = null; }
  }
  let thinkingApplied = null; // the level this Chrome's page was last put on (the page keeps it, so it is set once per Chrome, not per call)
  let thinkingNote = null; // a sentence for the Accounts page when the page would not take the level
  let signIn = null; // the plain Chrome the person signs in on, while a link waits
  let linkWaiting = null; // { resolve, exe, consentAckAt, checking } of the link in progress
  let linkNote = null; // a sentence for the Accounts card while a link waits
  let stopped = false; // stop() was called: no Chrome may be opened any more
  let showing = null; // the visible Chrome being opened for the person after a check, so stop() can wait for it

  function readSession() {
    try {
      const p = sessionPath();
      if (!fs.existsSync(p)) return null;
      try { fs.chmodSync(p, 0o600); } catch (_) {}
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) { return null; }
  }

  function writeSession(data) {
    writeJson(sessionPath(), data);
  }

  function emit() {
    status().then((s) => onStatus(s)).catch(() => {});
  }

  function markExpired(reason = 'Your Gemini sign-in expired. Sign in again on the Accounts page.') {
    const s = readSession();
    if (!s) return;
    s.expired = true;
    s.expiredReason = reason;
    s.expiredAt = new Date().toISOString();
    writeSession(s);
    log('gemini: session marked expired: ' + reason);
    emit();
  }

  function readSettings() {
    try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {}; } catch (_) { return {}; }
  }

  /** How long Gemini is asked to think: low (the quickest), medium or high. */
  function thinkingLevel() {
    const v = String(readSettings().thinkingLevel || '').toLowerCase();
    return THINKING_LEVELS.includes(v) ? v : DEFAULT_THINKING_LEVEL;
  }

  async function setThinkingLevel(level) {
    const v = String(level || '').toLowerCase();
    if (!THINKING_LEVELS.includes(v)) return { ok: false, error: 'Thinking level must be low, medium or high.' };
    writeJson(settingsPath(), { ...readSettings(), thinkingLevel: v });
    thinkingApplied = null; // the next call puts the page on it
    thinkingNote = null;
    log(`gemini: thinking level set to ${v}`);
    emit();
    return status();
  }

  async function status() {
    const s = readSession();
    const usage = governor ? governor.getStats() : null;
    const linking = Boolean(linkWaiting);
    const thinking = { thinkingLevel: thinkingLevel(), thinkingNote };
    if (!s || !s.linked) return { linked: false, models: [], usage, linking, linkNote: linking ? linkNote : null, ...thinking };
    return {
      linked: true,
      models: listModels(),
      linkedAt: s.linkedAt || null,
      expiresAt: null,
      consentAckAt: s.consentAckAt || null,
      expired: Boolean(s.expired),
      expiredReason: s.expired ? (s.expiredReason || 'Your Gemini sign-in expired. Sign in again on the Accounts page.') : null,
      usage,
      linking,
      linkNote: linking ? linkNote : null,
      ...thinking
    };
  }

  /** The linked account's models in the shape the model picker lists. Empty until the account is linked and its picker read. */
  function listModels() {
    const s = readSession();
    if (!s || !s.linked || s.expired) return [];
    // (a link made by an older version stored the one-model fallback as a row called "gemini": it is the stable name now, not a row)
    const real = (Array.isArray(s.models) ? s.models : []).filter((m) => m.id !== 'gemini');
    return withStableNames(real);
  }

  /** Whether the stored list is old enough to be read again from the page's picker. */
  function modelsStale(s) {
    if (!s || !s.linked || s.expired) return false;
    const age = Date.now() - (Number(s.modelsCheckedAt) || 0);
    return age > (s.modelsOk === false ? Math.min(MODELS_RETRY_MS, modelsTtlMs) : modelsTtlMs);
  }

  /** Keeps what a read of the picker found. A read that found rows replaces the list (an account can lose a row as well as gain one); one that found none leaves the list as it is and is tried again sooner. */
  function applyModelsRead(read) {
    const s = readSession();
    if (!s || !s.linked || s.expired) return false;
    const now = Date.now();
    if (read && read.names.length) {
      const models = modelsFromRead(read);
      const changed = JSON.stringify((Array.isArray(s.models) ? s.models : []).map((m) => m.id)) !== JSON.stringify(models.map((m) => m.id));
      writeSession({ ...s, models, modelsCheckedAt: now, modelsOk: true });
      if (changed) { log(`gemini: the model picker offers: ${models.map((m) => m.name).join(', ')}`); emit(); }
      return true;
    }
    writeSession({ ...s, modelsCheckedAt: now, modelsOk: false });
    return false;
  }

  /**
   * Reads the picker again in the background, when the list is old enough (or `force`) and the lane is idle: a client that lists the models gets what there is
   * at once, and the list is right the next time. One read at a time; a lane that is busy, linking or stopping leaves it for later.
   */
  let refreshing = null;
  async function refreshModels({ force = false } = {}) {
    const s = readSession();
    if (!s || !s.linked || s.expired || stopped) return false;
    if (!force && !modelsStale(s)) return false;
    if (refreshing) return refreshing;
    if (inUse > 0 || linkWaiting) return false;
    refreshing = (async () => {
      inUse += 1;
      let page = null;
      try {
        const b = await ensureBrowser();
        page = await b.newPage();
        await page.goto(appUrl).catch(() => {});
        const composer = await waitForComposer(page, 30000);
        if (!composer || await looksSignedOut(page)) { applyModelsRead(null); return false; }
        return applyModelsRead(await scrapeModels(page, { waitMs: PICKER_WAIT_MS }));
      } catch (err) {
        log('gemini: the model list could not be read again: ' + String((err && err.message) || err));
        return false;
      } finally {
        if (page) await page.close().catch(() => {});
        inUse -= 1;
        refreshing = null;
        armIdleClose();
      }
    })();
    return refreshing;
  }

  async function ensureBrowser() {
    if (browser && browser.connected) return browser;
    if (launching) return launching;
    const exe = chromeExecutable();
    if (!exe) throw new Error(NO_CHROME);
    launching = (async () => {
      const { launchChrome } = require('../chrome_cdp');
      const launched = await launchChrome({
        executablePath: exe,
        userDataDir: profileDir(),
        args: [...(HEADLESS ? ['--headless=new'] : []), ...BACKGROUND_FLAGS],
        minimal: MINIMAL,
        log
      });
      launched.onDisconnect(() => { browser = null; thinkingApplied = null; forgetTabs(); });
      browser = launched;
      log('gemini: chrome started with the program\'s profile');
      armIdleClose();
      return launched;
    })();
    try { return await launching; } finally { launching = null; }
  }

  /**
   * A whole Chrome stays in memory for as long as it is open (hundreds of megabytes on a Mac that is short of it). DeepSeek's lane
   * holds nothing between calls, so this one lets go after a quiet stretch; the profile folder keeps the sign-in, and the next call
   * starts Chrome again.
   */
  function armIdleClose() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!browser || inUse > 0 || loginWaiter) return armIdleClose();
      log('gemini: chrome closed after ' + Math.round(IDLE_CLOSE_MS / 60000) + ' idle minutes');
      const b = browser;
      browser = null;
      thinkingApplied = null; // a Chrome started later has not been told the level
      forgetTabs();
      b.close().catch(() => {});
    }, IDLE_CLOSE_MS);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  async function firstOf(page, selectors, what) {
    for (const sel of selectors) {
      const el = await page.$(sel).catch(() => null);
      if (el) return el;
    }
    log(`gemini: no ${what} matched (${selectors.join(' | ')})`);
    return null;
  }

  async function waitForComposer(page, ms) {
    const until = Date.now() + ms;
    for (;;) {
      const el = await firstOfQuiet(page, COMPOSER_SELECTORS);
      if (el) return el;
      if (Date.now() > until) return null;
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    }
  }

  /** Waits until a condition holds on the page (asked every `step` ms) instead of sleeping a fixed time for it. True if it held, false on timeout. */
  async function pollUntil(test, ms, step = WAIT_POLL_MS) {
    const until = Date.now() + ms;
    for (;;) {
      if (await Promise.resolve(test()).catch(() => false)) return true;
      if (Date.now() > until) return false;
      await new Promise((r) => setTimeout(r, step));
    }
  }

  /** Like firstOf but silent: called in a poll loop where a miss is ordinary, not a finding. */
  async function firstOfQuiet(page, selectors) {
    for (const sel of selectors) {
      const el = await page.$(sel).catch(() => null);
      if (el) return el;
    }
    return null;
  }

  /**
   * Reads the account's model picker on the page: the names it offers become the picker's models, nothing more and nothing less.
   * A row the account has locked (read on a signed-in window 2026-10-20: "3.1 Pro" and "4 Argon" behind a lock on a free account)
   * is reported apart, because offering it would sell a model the first message then fails on.
   */
  async function scrapeModels(page, { waitMs = PICKER_WAIT_MS } = {}) {
    // The button is waited for, not asked once: a signed-in page can draw it a moment after the message box, and a single early look
    // left the account linked with the one-model fallback for good.
    let button = null;
    for (const until = Date.now() + waitMs; ;) {
      button = await firstOfQuiet(page, MODEL_BUTTON_SELECTORS);
      if (button || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    }
    if (!button) {
      log(`gemini: no model picker button matched after ${Math.round(waitMs / 1000)} s (${MODEL_BUTTON_SELECTORS.join(' | ')}); the page offers: ${await describePicker(page)}`);
      return { names: [], locked: [] };
    }
    await button.click().catch(() => null);
    let read0 = { names: [], lockedNames: [] };
    for (const until = Date.now() + ROWS_WAIT_MS; ;) {
      read0 = await readRows(page);
      if (read0.names.length || read0.lockedNames.length || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const read = { names: read0.names || [], locked: read0.lockedNames || [] };
    if (!read.names.length && !read.locked.length) log(`gemini: the picker was opened but no rows matched (${MODEL_OPTION_SELECTORS.join(' | ')}); the page offers: ${await describePicker(page)}`);
    await page.keyboard.press('Escape').catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    return finishRead(page, button, read);
  }

  /** The rows of the open menu, by the page's own names for them. */
  async function readRows(page) {
    return page.evaluate((sels, notModel) => {
      const reject = new RegExp(notModel, 'i');
      const isLocked = (el) => el.getAttribute('aria-disabled') === 'true'
        || Boolean(el.querySelector('[aria-label*="lock" i], [data-icon*="lock" i], [fonticon*="lock" i]'));
      // Rows of a submenu (the Thinking level choices) belong to the row that opens them, not to the list of models.
      const nested = (el) => { const menu = el.closest('[role="menu"]'); return Boolean(menu && menu.parentElement && menu.parentElement.closest('[role="menu"]')); };
      const names = [];
      const lockedNames = [];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          // A row is the name on its first line and what it is for on the next ("3.1 Pro", "Advanced reasoning").
          const t = (el.innerText || '').split('\n')[0].trim();
          if (!t || reject.test(t) || nested(el)) continue;
          if (isLocked(el)) { if (!lockedNames.includes(t) && !names.includes(t)) lockedNames.push(t); continue; }
          if (!names.includes(t)) names.push(t);
        }
      }
      return { names, lockedNames: lockedNames.filter((n) => !names.includes(n)) };
    }, MODEL_OPTION_SELECTORS, NOT_A_MODEL.source).catch(() => ({ names: [], lockedNames: [] }));
  }

  /** What is left to do with a picker read: nothing when rows were read; otherwise the button's own label names the model in use. */
  async function finishRead(page, button, read) {
    if (!read.names.length && !read.locked.length) {
      // The menu did not open or renamed itself: the button's own label still names the model in use right now.
      const label = await button.evaluate((el) => (el.innerText || el.getAttribute('aria-label') || '').split('\n').pop().trim()).catch(() => '');
      log('gemini: picker menu unreadable, falling back to the button label');
      return { names: label && !NOT_A_MODEL.test(label) ? [label] : [], locked: [] };
    }
    return read;
  }

  /**
   * Asks the page whether anybody is signed in, by the page's own controls rather than by a guess about its cookies. A question the page cannot
   * answer yet (it is still navigating, so the call throws) is asked again; only a page that never answers counts as signed out.
   */
  async function looksSignedOut(page) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await page.evaluate((sels, profileSel) => {
          const visible = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
          // Signed-in proof: profile avatar or account button. If present, definitely not signed out.
          const profile = document.querySelector(profileSel);
          if (profile && visible(profile)) return false;
          for (const sel of sels) {
            for (const el of document.querySelectorAll(sel)) if (visible(el)) return true;
          }
          return [...document.querySelectorAll('button, a')].some((el) => /^sign in$/i.test((el.innerText || '').trim()) && visible(el));
        }, SIGN_IN_SELECTORS, PROFILE_SELECTOR);
      } catch (_) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    return true;
  }

  /** What the page showed when the check said nobody is signed in: the controls that decided it, so a wrong verdict names its cause in the log. */
  async function describeSignInCheck(page) {
    try {
      const facts = await page.evaluate((sels, profileSel) => {
        const visible = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
        const profile = document.querySelector(profileSel);
        const named = [...document.querySelectorAll(sels.join(','))].filter(visible).slice(0, 3);
        const byText = [...document.querySelectorAll('button, a')].filter((el) => /^sign in$/i.test((el.innerText || '').trim()) && visible(el)).slice(0, 3);
        const brief = (el) => ({ tag: el.tagName.toLowerCase(), text: (el.innerText || '').trim().slice(0, 30), aria: el.getAttribute('aria-label') || '', href: (el.getAttribute('href') || '').slice(0, 60) });
        return { title: document.title.slice(0, 60), profile: profile ? profile.tagName.toLowerCase() : null, named: named.map(brief), byText: byText.map(brief) };
      }, SIGN_IN_SELECTORS, PROFILE_SELECTOR);
      return JSON.stringify({ url: page.url().slice(0, 120), ...facts });
    } catch (err) {
      return JSON.stringify({ url: page.url().slice(0, 120), unreadable: String((err && err.message) || err).slice(0, 80) });
    }
  }

  /** Puts the page on the model the person chose, by clicking the page's own menu row of that name. */
  async function chooseModel(page, name) {
    if (!name) return 'none';
    const button = await firstOfQuiet(page, MODEL_BUTTON_SELECTORS);
    if (!button) return 'no-button';
    // The page keeps the mode of the last chat, so after the first call the button already names the model: nothing to open or click then.
    const norm = (v) => String(v).toLowerCase().replace(/\s+/g, ' ').trim();
    const have = norm(await button.evaluate((el) => el.innerText || el.getAttribute('aria-label') || '').catch(() => ''));
    const want = norm(name);
    if (have && (have === want || have.endsWith(' ' + want) || want.endsWith(' ' + have))) return 'already';
    await button.click().catch(() => null);
    // Rows that are showing (a closed menu may keep its rows in the page, hidden).
    const rowsUp = () => page.evaluate((sels) => sels.some((sel) => [...document.querySelectorAll(sel)].some((el) => el.getBoundingClientRect().width > 0)), MODEL_OPTION_SELECTORS);
    await pollUntil(rowsUp, 3000);
    const clicked = await page.evaluate((sels, wanted) => {
      const same = (a, b) => String(a).toLowerCase().replace(/\s+/g, ' ').trim() === String(b).toLowerCase().replace(/\s+/g, ' ').trim();
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const text = (el.innerText || '').split('\n')[0].trim();
          if (same(text, wanted)) { el.click(); return text; }
        }
      }
      return null;
    }, MODEL_OPTION_SELECTORS, name).catch(() => null);
    if (!clicked) {
      await page.keyboard.press('Escape').catch(() => {});
      log(`gemini: the page offers no model called "${name}"; it will answer with the one it is on`);
      return 'missing';
    }
    await pollUntil(async () => !(await rowsUp()), 2000);
    return 'chosen';
  }

  /**
   * Puts the page's "Thinking level" on low, medium or high. The level is a row of the same menu as the model (read on the real page, 2026-10-20):
   * "Thinking level" opens a submenu of Low, Medium and High. The page keeps the choice, so this runs once per Chrome, not once per call.
   * Resolves 'set', 'already' (the row was already ticked), or why it could not: 'no-button', 'no-menu', 'no-row', 'no-level'.
   */
  async function applyThinkingLevel(page, level) {
    const button = await firstOfQuiet(page, MODEL_BUTTON_SELECTORS);
    if (!button) return 'no-button';
    await button.click().catch(() => null);
    // Rows that are showing (a closed menu may keep its rows in the page, hidden), optionally only the one whose first line is `first`.
    const rowsShowing = (first) => page.evaluate((sels, want) => sels.some((sel) => [...document.querySelectorAll(sel)].some((el) => el.getBoundingClientRect().width > 0 && (!want || (el.innerText || '').split('\n')[0].trim().toLowerCase() === want))), MODEL_OPTION_SELECTORS, first || '');
    if (!(await pollUntil(() => rowsShowing(), 3000))) return 'no-menu';
    // The "Thinking level" row opens the submenu.
    if (!(await pollUntil(() => rowsShowing('thinking level'), 1500))) { await page.keyboard.press('Escape').catch(() => {}); return 'no-row'; }
    await page.evaluate((sels) => {
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if ((el.innerText || '').split('\n')[0].trim().toLowerCase() === 'thinking level') { el.click(); return true; }
        }
      }
      return false;
    }, MODEL_OPTION_SELECTORS);
    if (!(await pollUntil(() => rowsShowing(level), 3000))) { await page.keyboard.press('Escape').catch(() => {}); return 'no-level'; }
    const result = await page.evaluate((sels, want) => {
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if ((el.innerText || '').split('\n')[0].trim().toLowerCase() !== want || el.getBoundingClientRect().width <= 0) continue;
          const ticked = el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' || Boolean(el.querySelector('[fonticon*="check" i], [data-icon*="check" i]'));
          if (!ticked) el.click();
          return ticked ? 'already' : 'set';
        }
      }
      return null;
    }, MODEL_OPTION_SELECTORS, level);
    await pollUntil(async () => !(await rowsShowing()), 2000);
    // A menu that is still open (the level was already ticked, so nothing was clicked) is closed the way a person would.
    if (await rowsShowing().catch(() => false)) await page.keyboard.press('Escape').catch(() => {});
    return result || 'no-level';
  }

  /** Presses the response's collapsed "Show thinking" toggle, once, so the page lays out the thinking it keeps. */
  async function expandThinking(page) {
    return page.evaluate(() => {
      const responses = document.querySelectorAll('model-response');
      const last = responses[responses.length - 1];
      if (!last) return false;
      const toggle = [...last.querySelectorAll('button')].find((b) => b.getAttribute('aria-expanded') === 'false' && /thinking|thoughts/i.test(b.innerText || b.getAttribute('aria-label') || ''));
      if (!toggle) return false;
      toggle.click();
      return true;
    });
  }

  /**
   * The shape of the last response, with no text in it: tag names, the first few class names, the label of a button and whether it is expanded.
   * Logged once per Chrome when a response showed no thinking, so the page's real names for it can be read from the log instead of guessed.
   */
  async function describeResponse(page) {
    try {
      return await page.evaluate(() => {
        const responses = document.querySelectorAll('model-response');
        const root = responses[responses.length - 1];
        if (!root) return 'no model-response in the page';
        const brief = (el, depth) => {
          const raw = el.className && typeof el.className === 'object' ? el.className.baseVal || '' : String(el.className || '');
          const cls = raw.split(/\s+/).filter(Boolean).slice(0, 3).join('.');
          const aria = el.getAttribute('aria-label');
          const exp = el.getAttribute('aria-expanded');
          let s = el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (aria ? `[${aria.slice(0, 24)}]` : '') + (exp !== null ? `{expanded=${exp}}` : '') + '#' + (el.innerText || '').trim().length;
          if (depth < 4) {
            const kids = [...el.children].slice(0, 8).map((c) => brief(c, depth + 1));
            if (kids.length) s += '(' + kids.join(',') + ')';
          }
          return s;
        };
        // Where the last words of the response sit, by tag, class, role and text LENGTH: a control the page adds after a question shows up here.
        const panel = root.querySelector('.markdown-main-panel');
        const tail = [...root.querySelectorAll('*')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).slice(-5).map((el) => {
          const raw = el.className && typeof el.className === 'object' ? el.className.baseVal || '' : String(el.className || '');
          const cls = raw.split(/\s+/).filter(Boolean).slice(0, 2).join('.');
          const role = el.getAttribute('role');
          const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('').length;
          return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (role ? `[role=${role}]` : '') + '#' + own + (panel && panel.contains(el) ? '{in answer}' : '{outside answer}');
        });
        return brief(root, 0).slice(0, 2400) + ' | last elements with their own text: ' + tail.join(', ');
      });
    } catch (err) {
      return 'unreadable: ' + String((err && err.message) || err).slice(0, 80);
    }
  }

  /** Lets go of the Chrome that has the debugging port (a chat's, or the check after a link): it holds the profile folder until it is gone. */
  async function closeDriven() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    thinkingApplied = null;
    forgetTabs();
    if (browser) { const b = browser; browser = null; await b.close().catch(() => {}); }
  }

  /** Quits the plain Chrome the person signs in on. Quitting (not killing) lets Chrome write the sign-in it still holds in memory. */
  async function closeSignIn() {
    const mine = signIn;
    signIn = null;
    if (mine) await mine.close().catch(() => {});
  }

  /**
   * Opens the plain Chrome (no debugging port, see chrome_cdp.js) on the program's profile at Gemini. Chrome started on a profile another Chrome
   * still holds hands over and exits at once: that is an earlier Chrome of this program, still up after a crash, and the person can see it.
   */
  async function openSignIn(exe) {
    const { launchPlainChrome } = require('../chrome_cdp');
    const mine = launchPlainChrome({ executablePath: exe, userDataDir: profileDir(), url: appUrl, args: plainChromeArgs });
    await Promise.race([mine.exited, new Promise((r) => setTimeout(r, 1500))]);
    if (!mine.running) return { ok: false, error: 'A Chrome window that this program opened earlier is still running. Quit that Chrome (Chrome menu, Quit) and try again.' };
    signIn = mine;
    log('gemini: chrome opened without a debugging port, waiting for the person to sign in');
    // Quitting that Chrome before pressing Done is giving up, the same as closing DeepSeek's window.
    mine.exited.then(() => {
      if (signIn !== mine || !linkWaiting) return;
      signIn = null;
      log('gemini: the sign-in Chrome was quit before the link finished');
      settleLink();
    });
    return { ok: true };
  }

  /**
   * Shows the person the Gemini page in a plain, visible Chrome on the program's profile: for a human check or a cookie question that the hidden
   * Chrome met and cannot answer. It is quit when the next call starts (completeOnce), or with Unlink and when the program quits.
   */
  async function showPersonThePage() {
    if (stopped || signIn || linkWaiting) return;
    const exe = chromeExecutable();
    if (!exe) return;
    await closeDriven();
    // Stopping while this was closing the driven Chrome: nothing may be opened after that, or it would outlive the program.
    if (stopped) return;
    const { launchPlainChrome } = require('../chrome_cdp');
    const mine = launchPlainChrome({ executablePath: exe, userDataDir: profileDir(), url: appUrl, args: plainChromeArgs });
    await Promise.race([mine.exited, new Promise((r) => setTimeout(r, 1500))]);
    if (!mine.running) return;
    signIn = mine;
    if (stopped) { await closeSignIn(); return; }
    log('gemini: the hidden Chrome met something only the person can answer; the page is open in a visible Chrome');
    mine.exited.then(() => { if (signIn === mine) signIn = null; });
  }

  /**
   * Ends the link that is waiting, once. The state is cleared BEFORE the answer is read or sent, so the answer never says "still linking" and a
   * Link pressed the next moment starts a new attempt instead of being handed this finished one. A Chrome that has to quit is quit first.
   */
  async function settleLink(value) {
    const w = linkWaiting;
    if (!w) return;
    linkWaiting = null;
    loginWaiter = null;
    linkNote = null;
    clearTimeout(w.timer);
    const answer = value === undefined ? await status() : value;
    w.resolve(answer);
    emit();
  }

  /**
   * Linking is two steps because Google will not take a sign-in from a Chrome that has a debugging port (it is told the browser is automated):
   *  1. link() opens a plain Chrome on the program's own profile folder and waits. The person signs in there themselves and presses Done on the Accounts page.
   *  2. finishLink() quits that Chrome, starts the driven one on the same folder, checks that Gemini shows an account and reads its model picker.
   * The profile folder carries the sign-in from one to the other. Nothing here sees a password.
   */
  async function link(opts = {}) {
    if (!opts || !opts.consentAcknowledged) {
      return { ok: false, error: 'Consent must be acknowledged prior to linking.' };
    }
    if (loginWaiter) return loginWaiter;
    const exe = chromeExecutable();
    if (!exe) return { ok: false, error: NO_CHROME };
    await closeDriven();
    const opened = await openSignIn(exe);
    if (!opened.ok) return opened;
    const consentAckAt = new Date().toISOString();
    const promise = new Promise((resolve) => {
      const timer = setTimeout(async () => {
        log('gemini: link window expired');
        await closeSignIn();
        settleLink();
      }, LOGIN_TTL_MS);
      if (typeof timer.unref === 'function') timer.unref(); // the window's time limit must not keep the program alive
      linkWaiting = { resolve, exe, consentAckAt, checking: false, timer };
      linkNote = null;
    });
    loginWaiter = promise;
    emit();
    return promise;
  }

  /** The person pressed Done (or Cancel) on the Accounts page. Resolves with what the check found. */
  async function finishLink(opts = {}) {
    const waiting = linkWaiting;
    if (!waiting) return { ok: false, error: 'No Gemini link is waiting for you.' };
    if (opts && opts.cancel) {
      log('gemini: link cancelled');
      await closeSignIn();
      await settleLink();
      return { ok: true, cancelled: true };
    }
    if (waiting.checking) return { ok: true, checking: true };
    waiting.checking = true;
    linkNote = 'Checking your sign-in...';
    emit();
    let page = null;
    try {
      await closeSignIn();
      const b = await ensureBrowser();
      page = await b.newPage();
      await page.goto(appUrl).catch(() => {});
      const composer = await waitForComposer(page, 30000);
      const onApp = page.url().startsWith(appOrigin);
      if (composer && onApp && !(await looksSignedOut(page))) {
        const read = await scrapeModels(page);
        if (read.locked.length) log(`gemini: the account keeps these locked, so they are not offered: ${read.locked.join(', ')}`);
        const models = modelsFromRead(read);
        writeSession({ linked: true, models, modelsCheckedAt: models.length ? Date.now() : 0, modelsOk: models.length > 0, linkedAt: new Date().toISOString(), consentAckAt: waiting.consentAckAt, expired: false, expiredReason: null });
        log(`gemini: linked with ${models.length} model(s): ${models.map((m) => m.name).join(', ')}${models.length ? '' : ' (the picker could not be read: gemini and gemini-auto use the page\'s own mode)'}`);
        await page.close().catch(() => {});
        page = null;
        armIdleClose();
        await settleLink();
        return { ok: true, linked: true };
      }
      // Not signed in (Done pressed too early, or the sign-in did not take): the plain Chrome comes back so the person can go on.
      const here = onApp ? 'Gemini still shows "Sign in".' : 'Google is still asking you to sign in.';
      log(`gemini: the sign-in check after Done said nobody is signed in (composer: ${composer ? 'yes' : 'no'}, on gemini: ${onApp ? 'yes' : 'no'}): ${await describeSignInCheck(page)}`);
      if (page) await page.close().catch(() => {});
      page = null;
      await closeDriven();
      const reopened = await openSignIn(waiting.exe);
      if (!reopened.ok) { await settleLink(reopened); return reopened; }
      linkNote = `${here} Finish signing in in the Chrome window, then press Done again.`;
      log('gemini: Done was pressed but nobody is signed in yet');
      return { ok: false, notSignedIn: true, note: linkNote };
    } catch (err) {
      if (page) await page.close().catch(() => {});
      const failure = { ok: false, error: String((err && err.message) || err) };
      await closeSignIn();
      await settleLink(failure);
      return failure;
    } finally {
      waiting.checking = false;
      if (linkWaiting === waiting && linkNote === 'Checking your sign-in...') linkNote = null;
      emit();
    }
  }

  async function unlink() {
    await closeSignIn();
    await settleLink({ linked: false, models: [] });
    await closeDriven();
    try { fs.unlinkSync(sessionPath()); } catch (_) {}
    // The profile folder is this program's copy of the Google session: deleting it signs the lane out everywhere.
    try { await removeTree(profileDir()); } catch (err) { log('gemini: the profile folder could not be removed: ' + String((err && err.message) || err)); }
    if (governor) governor.clearCooldown();
    log('gemini: unlinked');
    emit();
    return { linked: false, models: [], usage: governor ? governor.getStats() : null };
  }

  function resetUsage() {
    if (governor) governor.resetUsage();
    emit();
  }

  function setDailyCap(cap) {
    if (governor) governor.setDailyCap(cap);
    emit();
  }

  /** Whether an address is a conversation page of this app (its own origin, under /app/). */
  function sameApp(url) {
    try { const u = new URL(url); return u.origin === appOrigin && /^\/app\/[A-Za-z0-9_-]{4,}$/.test(u.pathname); } catch (_) { return false; }
  }
  /** The conversation the page is on once an answer is in: { id, url }, or null when the page has no conversation address (nothing to continue). */
  function conversationOf(url) {
    try {
      const u = new URL(url);
      const m = /^\/app\/([A-Za-z0-9_-]{4,})$/.exec(u.pathname);
      return u.origin === appOrigin && m ? { id: m[1], url: `${u.origin}/app/${m[1]}` } : null;
    } catch (_) { return null; }
  }

  /**
   * One chat completion on the page. The prompt goes into the composer as one paste (a long bridge prompt typed key by key would
   * take minutes), Enter sends it, and the answer is read back as it grows: every poll sends only the part that is new.
   */
  async function completeOnce({ prompt, thinking, signal, model = null, thinkingLevel: levelAsked = null, onDelta = () => {}, keep = false, remote = null }) {
    const s = readSession();
    if (!s || !s.linked) return { ok: false, authExpired: true, error: 'Gemini is not linked. Link it on the Accounts page.' };
    if (s.expired) return { ok: false, authExpired: true, error: s.expiredReason || 'Your Gemini sign-in expired. Sign in again on the Accounts page.' };
    // The visible Chrome that showed a check or a question is done with once the next call starts: it holds the profile folder.
    if (signIn && !linkWaiting) await closeSignIn();
    let b;
    try { b = await ensureBrowser(); } catch (err) { return { ok: false, retryable: false, error: String((err && err.message) || err) }; }
    // A conversation that is continued is opened at its own address, and only an address of this app's own origin is ever opened.
    const resume = remote && remote.id && remote.url && sameApp(remote.url) ? remote : null;
    // Its tab, when it is still open from the last answer: the page is not loaded again (a fresh load cost 5 to 11 s and looks like a new visit each time).
    const kept = resume ? takeTab(resume.id) : null;
    let page;
    try { page = kept ? kept.page : await b.newPage(); } catch (err) { return { ok: false, retryable: false, error: String((err && err.message) || err) }; }
    inUse += 1;
    // A page that asks the person for something (a cookie question, a human check) stays open so they can answer it; every other
    // page is closed when the call ends.
    let leaveOpen = false;
    let showAfter = false;
    let sentAnswer = '';
    let sentThinking = '';
    let net = null; // the listener on the page's requests while a message is out (see watchRequests)
    let keepTabFor = null; // the conversation whose tab stays open after this call
    // Google's own interruptions have addresses of their own (its consent page, and the /sorry page it sends automated traffic to): told
    // by the address they need no message box to be found first.
    const interruptionAt = (url) => (/^https?:\/\/consent\.google\./.test(url) ? 'consent' : (/^https?:\/\/[^/]+\/sorry(\/|$|\?)/.test(url) ? 'check' : null));
    const askPerson = (kind) => {
      // A Chrome nobody can see cannot be answered in: the profile is then shown to the person in a plain visible Chrome once this call is over.
      if (HEADLESS) showAfter = true;
      else { leaveOpen = true; page.bringToFront().catch(() => {}); }
      if (kind === 'consent') return { ok: false, retryable: true, error: 'Google is asking about cookies in the Chrome window. Answer it there and send the message again.' };
      // Same as DeepSeek's own refusal: pause the lane for five minutes so the next turn does not walk straight back into the check, and
      // leave the page up front so the person can pass it.
      if (governor) governor.setCooldown(5 * 60 * 1000, 'a human check: pass it in the Chrome window');
      return { ok: false, rateLimited: true, retryable: false, noticeShort: 'Gemini is asking for a human check', error: 'Gemini is asking for a human check. Pass it in the Chrome window, then try again in a few minutes.' };
    };
    const marks = { start: Date.now() };
    const left = () => Boolean(signal && signal.aborted);
    try {
      if (left()) return { ok: false, cancelled: true, sent: false };
      // A kept tab already shows its conversation; anything else (a new one, a tab that wandered off) is opened at its address.
      const onItsConversation = Boolean(kept) && String(page.url()).includes(`/app/${resume.id}`);
      if (!onItsConversation) await page.goto(resume ? resume.url : appUrl).catch(() => {});
      const early = interruptionAt(page.url());
      if (early) return askPerson(early);
      let composer = await waitForComposer(page, 30000);
      if (!composer) {
        const late = interruptionAt(page.url());
        if (late) return askPerson(late);
        if (page.url().includes('accounts.google.com')) {
          markExpired();
          return { ok: false, authExpired: true, error: 'The Gemini sign-in expired. Sign in again on the Accounts page.' };
        }
        return { ok: false, retryable: false, error: 'Gemini did not show its message box.' };
      }
      // The profile folder can outlive the Google session inside it, and Gemini answers signed out: a window nobody is signed in
      // to is not the account that was linked, and saying so is the only honest answer.
      if (await looksSignedOut(page)) {
        markExpired();
        return { ok: false, authExpired: true, error: 'The Gemini sign-in expired. Sign in again on the Accounts page.' };
      }
      // The list of models is kept live: when it is older than a few minutes (or a link could not read the picker, a page still drawing it) the picker is read
      // again while this page is open anyway. Whatever the read finds replaces the list; the next call can choose among the account's rows.
      if (modelsStale(readSession())) applyModelsRead(await scrapeModels(page, { waitMs: PICKER_CALL_WAIT_MS }).catch(() => null));
      // Gemini sends a conversation that is not there (deleted, or not this account's) to a new chat: the answer would then land in the wrong place.
      if (resume && !String(await page.evaluate(() => location.href).catch(() => page.url())).includes(resume.id)) return { ok: false, error: 'The Gemini conversation is not there any more.' };
      marks.ready = Date.now();
      // A fresh tab is already a fresh chat: the New chat button is not pressed (it cost a click and a fixed wait of one and a half seconds).
      // The page keeps the mode of the last chat; the person chose a model, so the page is put on it.
      // The relay names the model without its provider prefix ("3-1-pro"); the linked list keeps ids whole. A lookup by the whole id never
      // matched, so the page stayed on whatever mode it was last on, whatever the picker said. The page-mode model has no menu row to click.
      const wanted = modelByRef(listModels(), model);
      let modelStep = 'none';
      if (wanted && !wanted.alias) modelStep = await chooseModel(page, wanted.name);
      else if (!wanted && model) log(`gemini: the linked list has no model "${model}"; the page answers with the mode it is on`);
      marks.model = Date.now();
      // How long Gemini thinks. The page keeps the level, so it is set once per Chrome and again only when the person changes it (the Accounts page, or reasoning_effort on a request).
      const levelWanted = THINKING_LEVELS.includes(levelAsked) ? levelAsked : thinkingLevel();
      let levelStep = 'kept';
      if (thinkingApplied !== levelWanted) {
        levelStep = await applyThinkingLevel(page, levelWanted).catch((err) => { log('gemini: the thinking level step failed: ' + String((err && err.message) || err)); return 'failed'; });
        // Whatever the answer, it is not asked again for this level until the Chrome restarts or the person changes it: a page that has no such
        // control would otherwise cost a menu open on every call.
        thinkingApplied = levelWanted;
        if (levelStep === 'set' || levelStep === 'already') { if (thinkingNote) { thinkingNote = null; emit(); } }
        else {
          thinkingNote = 'Gemini\'s page did not offer a Thinking level for this model, so the choice could not be applied.';
          log(`gemini: could not put the page on thinking level ${levelWanted} (${levelStep}); it answers with the level it is on`);
          emit();
        }
      }
      marks.level = Date.now();
      // The point of no return: once the message is in the box and Enter is pressed the account is spent. A caller that left while the page was
      // loading or the model was being chosen gets nothing sent.
      if (left()) return { ok: false, cancelled: true, sent: false };
      // What the page already shows (a continued conversation has the earlier turns on it): the answer to read is the one after these.
      const baseline = resume ? await page.evaluate(() => ({ responses: document.querySelectorAll('model-response').length, queries: document.querySelectorAll('user-query').length })).catch(() => null) : null;
      // The page's own requests from here on, to tell Google being slow from the page being late (written to the log with the timings).
      net = await page.watchRequests().catch(() => null);
      // The message box is clicked as a click is made (a mouse event at its middle); the page calling element.click() is the fallback.
      await composer.mouseClick().catch(() => composer.click());
      // A synthetic click does not always move the caret the way a hand does, and the paste lands wherever focus is: focus is
      // set and checked before the text goes in.
      const focused = await composer.evaluate((el) => { el.focus(); return document.activeElement === el; }).catch(() => false);
      if (!focused) log('gemini: the message box would not take focus; the paste may have gone elsewhere');
      if (left()) return { ok: false, cancelled: true, sent: false };
      await page.keyboard.insertText(prompt);
      await page.keyboard.press('Enter');
      const startedAt = Date.now();
      marks.sent = startedAt;
      let quietSince = 0;
      let expandedThinking = false; // the response's "Show thinking" toggle is pressed once per call
      let openFence = false; // the answer ends inside a code block whose closing fence was left off while it grew
      let sawRunning = false;
      let sawSent = false;
      let lastWordAt = startedAt; // when the page last showed a new word of the answer or of the thinking
      let lastTraceAt = startedAt;
      for (;;) {
        if (signal && signal.aborted) return { ok: false, cancelled: true, sent: true };
        const state = await readPage(page, baseline).catch(() => null);
        if (!state) return { ok: false, error: 'The Gemini page went away mid-answer.' };
        if (state.consent) return askPerson('consent');
        if (state.blocked) return askPerson('check');
        if (state.running) { sawRunning = true; if (!marks.runningSeen) marks.runningSeen = Date.now(); }
        if (state.sent) { sawSent = true; if (!marks.sentSeen) marks.sentSeen = Date.now(); }
        openFence = Boolean(state.openFence);
        if (state.thoughtToggle && !expandedThinking) { expandedThinking = true; await expandThinking(page).catch(() => {}); }
        // The page is the truth: what it shows now is the answer so far. Text only ever grows on the way to the relay (what was sent cannot be taken
        // back), but the page also REWRITES text it showed (a tag that was half typed is swallowed when it closes, Markdown settles into formatting).
        // A reader that only followed growth stopped following after the first rewrite, so "the text has stopped changing" could never become true
        // and the call hung until the relay gave up (seen 2026-10-20 once the polling got faster).
        if (state.thinking !== sentThinking) {
          if (state.thinking.length > sentThinking.length && state.thinking.startsWith(sentThinking)) onDelta({ type: 'think', text: state.thinking.slice(sentThinking.length) });
          if (state.thinking.length > sentThinking.length) lastWordAt = Date.now();
          sentThinking = state.thinking;
        }
        if (state.answer !== sentAnswer) {
          if (state.answer.length > sentAnswer.length && state.answer.startsWith(sentAnswer)) onDelta({ type: 'answer', text: state.answer.slice(sentAnswer.length) });
          if (state.answer.length > sentAnswer.length) lastWordAt = Date.now();
          sentAnswer = state.answer;
          if (sentAnswer && !marks.first) marks.first = Date.now();
        }
        const quiet = !state.running && sentAnswer.length > 0 && state.answer === sentAnswer;
        if (quiet) { if (!quietSince) quietSince = Date.now(); } else quietSince = 0;
        const quietFor = quietSince ? Date.now() - quietSince : 0;
        // The dots going away and the text no longer growing is the page's own sign the answer is finished. A long quiet
        // stretch ends the turn whatever the buttons say, so a Stop button left standing in the page cannot hold a turn open.
        // Without the page's own working sign to lean on (a renamed selector), the text standing still is all there is to go by, so it
        // has to stand still twice as long before a slow stream is taken for a finished one.
        if (quietFor >= (sawRunning ? QUIET_MS : QUIET_BLIND_MS) && (sawRunning || sawSent)) break;
        if (quietFor >= QUIET_MAX_MS) break;
        // A slow start is written down as it happens: what the page shows every few seconds (flags, counts, the words of a dialog, never the conversation).
        if (!sentAnswer && Date.now() - lastTraceAt >= waitTraceMs) {
          lastTraceAt = Date.now();
          log(`gemini: still waiting ${Math.round((lastTraceAt - startedAt) / 1000)} s after sending: ${await describeStall(page, baseline, state)}; requests: ${net ? net.summary() : 'not watched'}`);
        }
        // Nothing arrived and the page is idle: the chat refused the message rather than answering it.
        if (!state.running && !sentAnswer && Date.now() - startedAt > 120000) {
          log('gemini: stalled (idle, no answer): ' + await describeStall(page, baseline, state) + '; requests: ' + (net ? net.summary() : 'not watched'));
          return { ok: false, error: 'Gemini sent no answer in two minutes.' };
        }
        // The page says it is working and nothing ever shows: a page waiting on something this program cannot see (a question, a check, a dead stream).
        // Without a limit the call stood until the 15 minute cap of the relay.
        if (!sentAnswer && Date.now() - lastWordAt > firstWordsMaxMs) {
          log('gemini: stalled (working, no words): ' + await describeStall(page, baseline, state) + '; requests: ' + (net ? net.summary() : 'not watched'));
          return { ok: false, error: `Gemini showed no words for ${Math.round(firstWordsMaxMs / 1000)} seconds after the message was sent. It may be waiting on something in its page: see the log line that starts with "gemini: stalled".` };
        }
        await new Promise((r) => setTimeout(r, ANSWER_POLL_MS));
      }
      if (!sentAnswer) return { ok: false, error: 'Gemini answered with nothing.' };
      if (sentAnswer.length <= 120 && PAGE_ERROR_ANSWERS.some((re) => re.test(sentAnswer))) {
        log('gemini: the page answered with its own error message');
        return { ok: false, error: 'Gemini answered with its own error message ("Sorry, something went wrong"). Try again in a moment.' };
      }
      // Where the time of this call went, so the next slow one can be read instead of guessed at.
      marks.done = Date.now();
      const ms = (a, b) => (a && b ? b - a : 0);
      log(`gemini: call took ${marks.done - marks.start} ms: page and message box ${ms(marks.start, marks.ready)}, model (${modelStep}) ${ms(marks.ready, marks.model)}, thinking level (${levelStep}) ${ms(marks.model, marks.level)}, typing and sending ${ms(marks.level, marks.sent)}, message shown ${ms(marks.sent, marks.sentSeen)} ms after sending, page working ${ms(marks.sent, marks.runningSeen)} ms after sending, waiting for the first words ${ms(marks.sent, marks.first)}, writing the answer ${ms(marks.first, marks.done) - (quietSince ? marks.done - quietSince : 0)}, settling ${quietSince ? marks.done - quietSince : 0}; requests: ${net ? net.summary() : 'not watched'}`);
      if (!sawSent) log('gemini: the page never showed the sent message; that selector may have been renamed');
      if (!sawRunning) log('gemini: the page never showed it was working; the end of the answer was judged by the text standing still');
      if (!sentThinking) log('gemini: the page showed no thinking panel for this model');
      // The shape of a real response (tags, classes, text LENGTHS, no text) once per Chrome: where the thinking, the answer and anything the page adds
      // after it (suggestion chips, labels) sit, so a selector that reads too much or too little can be fixed from the log.
      if (probedFor !== browser) { probedFor = browser; log('gemini: shape of the last response (tag.class#text length, no text): ' + await describeResponse(page)); }
      const next = keep ? conversationOf(await page.evaluate(() => location.href).catch(() => page.url())) : null;
      if (next) keepTabFor = next.id;
      return { ok: true, text: openFence ? sentAnswer + '\n```' : sentAnswer, thinking: sentThinking || undefined, ...(keep ? { remote: next } : {}) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    } finally {
      inUse -= 1;
      if (net) await net.stop().catch(() => {});
      if (keepTabFor && !leaveOpen && !page.closed) await keepTab(keepTabFor, page).catch(() => {});
      else if (!leaveOpen) await page.close().catch(() => {});
      if (showAfter) { showing = showPersonThePage().catch(() => {}); }
      armIdleClose();
    }
  }

  /** What the page offers where the model picker should be, for the log: labels of the buttons that look like one, and how many menu parts exist. No conversation text. */
  async function describePicker(page) {
    try {
      return await page.evaluate(() => {
        const aria = (b) => b.getAttribute('aria-label') || '';
        const modelish = /^\s*(gemini\s*)?\d(\.\d)?\s*(flash|pro|argon|lite|ultra|nano)/i;
        const found = [...document.querySelectorAll('button, [role="button"], [role="combobox"]')]
          .filter((b) => /mode|model|pick|select/i.test(aria(b)) || modelish.test((b.innerText || '').trim()))
          .slice(0, 8)
          .map((b) => `${b.tagName.toLowerCase()}[${aria(b).slice(0, 40)}]${modelish.test((b.innerText || '').trim()) ? (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24) : ''}`);
        const counts = ['[role="menu"]', '[role="listbox"]', 'gem-menu', 'mat-menu', '[role="menuitem"]', '[role="option"]'].map((q) => `${q}:${document.querySelectorAll(q).length}`).join(' ');
        return JSON.stringify({ buttons: found, counts });
      });
    } catch (err) { return 'unreadable: ' + String((err && err.message) || err).slice(0, 80); }
  }

  /** What the page looks like when an answer does not come, for the log: counts, flags and the words of any dialog that is open (short). Never the conversation. */
  async function describeStall(page, baseline, state) {
    try {
      const more = await page.evaluate(() => {
        const shown = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
        const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], mat-dialog-container')].filter(shown).map((d) => (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120));
        const send = document.querySelector('button[aria-label*="Send" i]');
        const box = document.querySelector('rich-textarea, [contenteditable="true"], textarea');
        return {
          at: location.origin + location.pathname,
          title: document.title.slice(0, 60),
          users: document.querySelectorAll('user-query').length,
          responses: document.querySelectorAll('model-response').length,
          sendButton: send ? (send.disabled || send.getAttribute('aria-disabled') === 'true' ? 'disabled' : 'enabled') : 'none',
          boxChars: box ? (box.innerText || box.value || '').length : -1,
          dialogs
        };
      });
      const flags = state ? { running: Boolean(state.running), sent: Boolean(state.sent), blocked: Boolean(state.blocked), consent: Boolean(state.consent), answerChars: String(state.answer || '').length, thinkingChars: String(state.thinking || '').length } : {};
      return JSON.stringify({ ...flags, ...more });
    } catch (err) { return 'could not read the page: ' + String((err && err.message) || err).slice(0, 80); }
  }

  /** Reads what the page shows right now: the answer so far, the thinking so far, whether it is still working, and a refusal. */
  async function readPage(page, baseline = null) {
    return page.evaluate((answers, thoughts, running, sent, before) => {
      const last = (list) => {
        for (const sel of list) {
          const nodes = document.querySelectorAll(sel);
          if (nodes.length) return nodes[nodes.length - 1];
        }
        return null;
      };
      const shown = (el) => {
        if (!el) return false;
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      const runningNow = running.some((sel) => [...document.querySelectorAll(sel)].some(shown));
      // The page's own interruptions are told by where they come from (Google's consent and "sorry" pages have addresses of their own,
      // the human check is a frame) or by what a dialog says. The words are never searched in the whole page: it holds the message that
      // was sent and the answer, and a task that mentions a captcha or "before you continue" would otherwise stop the lane.
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], mat-dialog-container')].map((el) => el.innerText || '').join('\n').slice(0, 3000);
      // The page shows a reply as formatted text: outside a code block it drops backslash escapes and swallows anything that looks like HTML (a
      // tool call carrying a web page came back as {"content":"<html lang="en"> ..." with its quotes and tags gone: seen 2026-10-20). What a code
      // block shows is the text as written, so the answer is read with each code block as its own raw text, fenced.
      const rawOf = (root) => {
        if (!root) return '';
        const parts = [];
        let text = '';
        const closeText = () => { if (text) { parts.push({ code: false, v: text }); text = ''; } };
        const walk = (node) => {
          for (const n of node.childNodes) {
            if (n.nodeType === 3) { text += n.textContent.replace(/\s+/g, ' '); continue; }
            if (n.nodeType !== 1) continue;
            const tag = n.tagName.toLowerCase();
            if (tag === 'button' || n.getAttribute('role') === 'button') continue; // a control the page draws in the answer (a quick reply), not words of the model
            if (tag === 'pre' || tag === 'code-block') {
              const code = n.querySelector('pre code') || n.querySelector('code') || n.querySelector('pre') || n;
              closeText();
              parts.push({ code: true, v: code.textContent.replace(/\n$/, '') });
            } else if (/^(p|h[1-6]|blockquote|ul|ol|table|hr)$/.test(tag)) { text += '\u0002'; walk(n); text += '\u0002'; }
            else if (/^(div|li|tr|section|article|br)$/.test(tag)) { text += '\u0001'; walk(n); text += '\u0001'; }
            else walk(n);
          }
        };
        walk(root);
        closeText();
        const prose = (v) => v.replace(/[\u0001\u0002 ]*\u0002[\u0001\u0002 ]*/g, '\n\n').replace(/ *\u0001[\u0001 ]*/g, '\n').replace(/ *\n */g, '\n');
        // A code block that is the end of the answer so far may still be growing: its closing fence is left off, so each read of a growing answer
        // starts with the read before it (the loop sends only what is new). completeOnce closes it once the answer has settled.
        const tail = parts.length && parts[parts.length - 1].code ? parts.length - 1 : -1;
        const joined = parts.map((o, i) => (o.code ? '\n```\n' + o.v + (i === tail ? '' : '\n```\n') : prose(o.v))).join('').replace(/^\n+|\n+$/g, '').replace(/\n{3,}/g, '\n\n');
        return { text: joined, openFence: tail >= 0 };
      };
      // In a continued conversation the page still shows the earlier answers: until a new response has appeared there is no answer to read yet.
      const fresh = !before || (document.querySelectorAll('model-response').length > before.responses);
      const answerEl = fresh ? last(answers) : null;
      // The thinking: the page's listed names first. Then anything in the last response that the page itself calls a thought or thinking (a name the list
      // does not know yet), outside the answer, not a button or an icon or the working animation, and more than a label.
      const responseEl = fresh ? last(['model-response']) : null;
      let thoughtText = fresh ? (last(thoughts) || { innerText: '' }).innerText.trim() : '';
      if (!thoughtText && responseEl) {
        let best = '';
        for (const el of responseEl.querySelectorAll('[class*="thought" i], [class*="thinking" i], model-thoughts, thoughts-content, [data-test-id*="thought" i]')) {
          if (/^(button|svg|mat-icon|a)$/i.test(el.tagName) || /dots|animation|loader|spinner|icon|chevron/i.test(String(el.className || ''))) continue;
          if (answerEl && (el === answerEl || answerEl.contains(el) || el.contains(answerEl))) continue;
          const tx = (el.innerText || el.textContent || '').trim();
          if (tx.length > best.length) best = tx;
        }
        best = best.replace(/^(?:show|hide)?\s*(?:thinking|thoughts?)\s*[:\n]?\s*/i, '').trim();
        if (best.length >= 20) thoughtText = best;
      }
      // A collapsed "Show thinking" toggle in the response: the lane presses it once, so the page shows the thinking it keeps.
      const thoughtToggle = Boolean(responseEl && [...responseEl.querySelectorAll('button')].some((b) => b.getAttribute('aria-expanded') === 'false' && /thinking|thoughts/i.test(b.innerText || b.getAttribute('aria-label') || '')));
      // Controls the page draws inside the answer (a quick reply such as "Yes" under a question, a copy button) are not words of the model. They are hidden for the
      // instant of the read, in the same turn of the script, so nothing is painted between and the page is left as it was.
      const textWithoutControls = (el) => {
        if (!el) return '';
        const hidden = [...el.querySelectorAll('button, [role="button"]')].map((c) => [c, c.style.display]);
        for (const [c] of hidden) c.style.display = 'none';
        try { return el.innerText.trim(); } finally { for (const [c, d] of hidden) c.style.display = d; }
      };
      const hasCode = Boolean(answerEl && answerEl.querySelector('pre, code-block'));
      const raw = hasCode ? rawOf(answerEl) : null;
      return {
        answer: raw ? raw.text : textWithoutControls(answerEl),
        openFence: Boolean(raw && raw.openFence),
        thinking: thoughtText,
        thoughtToggle,
        running: runningNow,
        sent: before ? document.querySelectorAll(sent[0]).length > before.queries : (shown(last(sent)) || Boolean((last(sent) || { innerText: '' }).innerText.trim())),
        consent: /(^|\.)consent\.google\./.test(location.hostname) || /before you continue/i.test(dialogs),
        blocked: /^\/sorry(\/|$)/.test(location.pathname) || Boolean(document.querySelector('iframe[src*="recaptcha" i], iframe[title*="recaptcha" i]')) || /unusual traffic|verify you are|not a robot|captcha/i.test(dialogs)
      };
    }, ANSWER_SELECTORS, THINKING_SELECTORS, RUNNING_SELECTORS, SENT_SELECTORS, baseline);
  }

  function token() {
    const s = readSession();
    return s && s.linked && !s.expired ? 'chrome-profile' : null;
  }

  /** Ends everything this lane has open, and waits for it: a Chrome left running would outlive the program. */
  async function stop() {
    stopped = true;
    if (showing) await showing;
    await closeSignIn();
    await settleLink({ ok: false, error: 'The program is stopping.' }); // a link still waiting ends here, with its time limit
    await closeDriven();
  }

  /** A conversation that ended here stays in the person's Gemini history (nothing is sent to remove it); only its open tab is closed. */
  const closeSession = async (remote) => {
    const t = remote && remote.id ? tabs.get(remote.id) : null;
    if (!t) return;
    tabs.delete(remote.id);
    await t.page.close().catch(() => {});
  };

  return { status, listModels, link, finishLink, setThinkingLevel, unlink, markExpired, resetUsage, setDailyCap, completeOnce, closeSession, tabCount: () => tabs.size, refreshModels, sessions: true, token, stop };
}

module.exports = { createGemini, SESSION_FILE, PROFILE_DIR_NAME };
