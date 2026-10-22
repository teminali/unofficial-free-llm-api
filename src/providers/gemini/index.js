/**
 * The Gemini provider: the person's own gemini.google.com chat, driven in a Chrome that has their profile (page.js, chrome_cdp.js), behind the chat engine.
 *
 * The web chat has no native tool calling, so a request with tools asks the model, in words, for one fenced JSON block (the fence keeps the page's
 * formatting from eating backslashes and anything that looks like HTML), and the call is read back out of it.
 */
'use strict';

const path = require('path');
const { createChatEngine } = require('../../engine');
const { withContext } = require('../../model_info');
const { createGovernor } = require('../../governor');
const { fencedBridgeSection } = require('../../bridge');
const { createGemini } = require('./page');

const LINK_START_WAIT_MS = 8000;

const fencedCall = (call) => '```json\n' + JSON.stringify(call) + '\n```';

function createGeminiProvider({ dataDir, config, log = () => {}, bus = null, appUrl, plainChromeArgs, sessions = true, sessionOptions, firstWordsMaxMs, waitTraceMs, tabIdleMs, maxTabs, modelsTtlMs }) {
  const saved = config ? config.providerSettings('gemini') : {};
  const governor = createGovernor({ storagePath: path.join(dataDir, 'usage-gemini.json'), providerName: 'Gemini', dailyCap: saved.dailyCap, log });
  const page = createGemini({ dataDir, log: (l) => log(l), governor, appUrl, plainChromeArgs, firstWordsMaxMs, waitTraceMs, tabIdleMs, maxTabs, modelsTtlMs });

  const useSessions = sessions !== false && saved.sessions !== false && process.env.ULA_SESSIONS !== '0';

  const engine = createChatEngine({
    sessions: { enabled: useSessions, options: sessionOptions },
    provider: {
      id: 'gemini',
      name: 'Gemini',
      idPrefix: 'gemini',
      web: page,
      bridge: (tools) => fencedBridgeSection(tools, { fileChars: 2500 }),
      formatCall: fencedCall,
      // After a tool result the model is told to finish when it is finished: the free model otherwise answered every result with one more write of the file it had
      // just written (forty times in a row), because the usual hint only says to go on.
      continueHint: 'The tool result above is real. If every step of the task is finished, reply now with a short final answer in plain words and NO tool call: do not rewrite or re-check files that are already written. Otherwise call the next tool in a fenced block.',
      noToolsHint: 'Answer the latest USER message now. If it needs a tool, reply only with the tool-call JSON.',
      repeatLimit: 3,
      hold: 'leading-json',
      timeoutMs: 240000
    },
    governor,
    log,
    onNotice: (n) => { if (bus) bus.emit('notice', n); }
  });

  const provider = {
    id: 'gemini',
    name: 'Gemini',
    capabilities: { link: 'chrome', token: false, settings: ['dailyCap', 'thinkingLevel', 'sessions'] },
    engine,
    governor,
    page,
    models: () => page.listModels().map((m) => withContext({ id: m.id, name: m.name, thinking: true, escalate: false })),
    /** Reads the account's model picker again when the list is old (or `force`); true when it found rows. */
    refreshModels: (opts) => page.refreshModels(opts),
    async status() {
      const s = await page.status();
      return { ...s, models: s.models.map((m) => withContext({ id: m.id, name: m.name, thinking: true })), sessions: engine.sessionInfo() };
    },
    /** Opens the plain Chrome for the sign-in and returns once it is up (the wait for the person goes on behind it). */
    async startLink({ consentAcknowledged }) {
      const waiting = page.link({ consentAcknowledged: consentAcknowledged === true });
      const settled = waiting.then((r) => ({ result: r }), (err) => ({ result: { ok: false, error: String((err && err.message) || err) } }));
      // link() stays pending until the person is done, so "started" is told apart from "failed to start" by looking: it either settles with an error
      // at once (no Chrome, one still running) or the page reports that a link is waiting.
      for (let waited = 0; waited < LINK_START_WAIT_MS; waited += 100) {
        const early = await Promise.race([settled, new Promise((r) => setTimeout(() => r(null), 100))]);
        if (early) return early.result && early.result.ok === false && early.result.error ? { ok: false, error: early.result.error } : { ok: true };
        if ((await page.status()).linking) return { ok: true };
      }
      return { ok: true };
    },
    finishLink: (opts) => page.finishLink(opts),
    unlink: () => page.unlink(),
    resetUsage: () => page.resetUsage(),
    async setSettings(patch = {}) {
      if (patch.dailyCap !== undefined) {
        const n = Math.floor(Number(patch.dailyCap));
        if (!(n > 0)) throw new Error('The daily cap must be a whole number above zero.');
        governor.setDailyCap(n);
        if (config) config.setProviderSettings('gemini', { dailyCap: n });
      }
      if (patch.thinkingLevel !== undefined) {
        const r = await page.setThinkingLevel(patch.thinkingLevel);
        if (r && r.ok === false) throw new Error(r.error);
      }
      if (patch.sessions !== undefined) {
        const on = patch.sessions === true;
        await engine.setSessions(on);
        if (config) config.setProviderSettings('gemini', { sessions: on });
      }
      return provider.status();
    },
    async stop() { await engine.closeSessions(); await page.stop(); }
  };
  return provider;
}

module.exports = { createGeminiProvider };
