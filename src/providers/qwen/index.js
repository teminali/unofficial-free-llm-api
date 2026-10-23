'use strict';

const path = require('path');
const { createChatEngine } = require('../../engine');
const { createGovernor } = require('../../governor');
const { withContext } = require('../../model_info');
const { bridgeSection } = require('../../bridge');
const { createQwenAccount } = require('./link');
const { createQwenWeb, REQUEST_TIMEOUT_MS } = require('./web');

function createQwenProvider({ dataDir, config, log = () => {}, bus, sessions = true }) {
  const saved = config ? config.providerSettings('qwen') : {};
  const governor = createGovernor({ storagePath: path.join(dataDir, 'usage-qwen.json'), providerName: 'Qwen', dailyCap: saved.dailyCap || 100, pace: { perMinute: 6, minGapMs: 10000, cooldownMs: 20 * 60000, smooth: true }, log });
  const account = createQwenAccount({ dataDir, governor, log });
  const web = createQwenWeb({ dataDir, account, governor, log });
  let changing = false;
  let sessionsEnabled = sessions !== false && saved.sessions !== false && process.env.ULA_SESSIONS !== '0';
  const transport = { ...web, completeOnce: (args) => changing ? Promise.resolve({ ok: false, sent: false, retryable: false, error: 'The Qwen account is being changed. Try again after linking finishes.' }) : web.completeOnce(args) };
  const engine = createChatEngine({
    provider: { id: 'qwen', name: 'Qwen', idPrefix: 'qw', web: transport, bridge: (tools) => bridgeSection(tools, { replyChars: 20000, callChars: 15000, batch: true }), repeatLimit: 3, hold: 'marker', timeoutMs: REQUEST_TIMEOUT_MS },
    governor, log,
    sessions: { enabled: sessionsEnabled, orphans: web.orphans },
    onNotice: (notice) => { if (bus) bus.emit('notice', notice); }
  });
  const provider = {
    id: 'qwen', name: 'Qwen', capabilities: { link: 'chrome', token: false, refreshModels: true, settings: ['dailyCap', 'sessions'] },
    engine, governor, account,
    models: () => account.listModels().map(withContext),
    async status() { return { ...(await account.status()), sessions: engine.sessionInfo() }; },
    async startLink(options) {
      if (!options?.consentAcknowledged) return account.startLink(options);
      if (changing || web.busy()) return { ok: false, error: 'Wait for the current Qwen operation to finish before changing accounts.' };
      changing = true;
      try { await engine.closeSessions(); return await account.startLink(options); }
      finally { await engine.setSessions(sessionsEnabled); changing = false; }
    },
    finishLink: (options) => account.finishLink(options),
    refreshModels: () => account.refreshModels(),
    async unlink() {
      if (changing || web.busy()) return { ok: false, error: 'Wait for the current Qwen operation to finish before unlinking.' };
      changing = true;
      try { await engine.closeSessions(); await web.closePending(); return await account.unlink(); }
      finally { await engine.setSessions(sessionsEnabled); changing = false; }
    },
    resetUsage: () => governor.resetUsage(),
    async setSettings(patch = {}) {
      if (patch.dailyCap !== undefined) {
        const n = Math.floor(Number(patch.dailyCap));
        if (!Number.isFinite(n) || n < 1) throw new Error('The daily cap must be a whole number above zero.');
        governor.setDailyCap(n);
        if (config) config.setProviderSettings('qwen', { dailyCap: n });
      }
      if (patch.sessions !== undefined) {
        sessionsEnabled = patch.sessions === true;
        await engine.setSessions(sessionsEnabled);
        if (config) config.setProviderSettings('qwen', { sessions: sessionsEnabled });
      }
      return provider.status();
    },
    async stop() { changing = true; await engine.closeSessions(); await web.closePending(); await account.stop(); }
  };
  return provider;
}

module.exports = { createQwenProvider };
