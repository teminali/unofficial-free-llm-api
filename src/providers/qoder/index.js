/**
 * The Qoder provider: the person's own Qoder account, through a personal access token and the official Qoder CLI, behind the chat engine and a governor.
 *
 * The CLI is the only client Qoder lets use the token for model calls. A conversation keeps one CLI process (warm.js), so a follow-up costs about three
 * seconds instead of fifteen; with sessions off, every request is one `qoder --print` process (cli.js). Tools are a text protocol in the prompt (bridge.js);
 * the CLI has no native tool handoff and no temperature. Pictures go in as image blocks (web.js). Thinking and effort are the CLI's own flags.
 */
'use strict';

const path = require('path');
const { createChatEngine } = require('../../engine');
const { createGovernor } = require('../../governor');
const { withContext } = require('../../model_info');
const { bridgeSection } = require('../../bridge');
const { createQoderAccount } = require('./account');
const { createQoderWeb, SESSION_OPTIONS } = require('./web');
const { CHAT_TIMEOUT_MS } = require('./cli');

const NOT_A_LINK = 'Qoder links with a personal access token: paste one in the token field. No browser window is involved.';

function createQoderProvider({ dataDir, config, log = () => {}, bus = null, cliPath = null } = {}) {
  const saved = config ? config.providerSettings('qoder') : {};
  const governor = createGovernor({ storagePath: path.join(dataDir, 'usage-qoder.json'), providerName: 'Qoder', dailyCap: saved.dailyCap, log });
  const account = createQoderAccount({ dataDir, cliPath, governor, log });
  const web = createQoderWeb({ account, cliPath, log });
  const useSessions = saved.sessions !== false && process.env.ULA_SESSIONS !== '0';

  const engine = createChatEngine({
    sessions: { enabled: useSessions, options: SESSION_OPTIONS },
    provider: {
      id: 'qoder',
      name: 'Qoder',
      idPrefix: 'qd',
      web,
      // The CLI has no native tool handoff, so the tools go in the prompt as the text protocol every account-backed provider uses.
      bridge: (tools) => bridgeSection(tools, { replyChars: 20000, callChars: 15000, batch: true }),
      noToolsHint: 'Answer the latest USER message now. If it needs a tool, reply only with the tool-call blocks.',
      repeatLimit: 3,
      hold: 'marker',
      timeoutMs: CHAT_TIMEOUT_MS
    },
    governor,
    log,
    onNotice: (notice) => { if (bus) bus.emit('notice', notice); }
  });

  const provider = {
    id: 'qoder',
    name: 'Qoder',
    capabilities: { link: 'key', key: true, refreshModels: true, settings: ['dailyCap', 'sessions'] },
    engine,
    governor,
    account,
    models: () => account.listModels().map(withContext),
    async status() { return { ...(await account.status()), sessions: engine.sessionInfo() }; },
    startLink: () => Promise.resolve({ ok: false, error: NOT_A_LINK }),
    finishLink: () => Promise.resolve({ ok: false, error: NOT_A_LINK }),
    // A different token or no account: every open chat belongs to the old one.
    async linkToken(options) {
      const out = await account.linkToken(options);
      if (out && out.ok) await engine.closeSessions();
      return out;
    },
    async unlink() {
      await engine.closeSessions();
      return account.unlink();
    },
    refreshModels: (options) => account.refreshModels(options),
    resetUsage: () => governor.resetUsage(),
    async setSettings(patch = {}) {
      if (patch.dailyCap !== undefined) {
        const n = Math.floor(Number(patch.dailyCap));
        if (!(n > 0)) throw new Error('The daily cap must be a whole number above zero.');
        governor.setDailyCap(n);
        if (config) config.setProviderSettings('qoder', { dailyCap: n });
      }
      if (patch.sessions !== undefined) {
        const on = patch.sessions === true;
        await engine.setSessions(on);
        if (config) config.setProviderSettings('qoder', { sessions: on });
      }
      return provider.status();
    },
    async stop() { await engine.closeSessions(); await account.stop(); }
  };
  return provider;
}

module.exports = { createQoderProvider };

