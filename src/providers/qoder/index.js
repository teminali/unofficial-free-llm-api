/**
 * The Qoder provider: the person's own Qoder account, through a personal access token and the official Qoder CLI, behind the chat engine and a governor.
 *
 * The CLI is the only client Qoder lets use the token for model calls, so every request is one `qoder --print` process (cli.js). Tools are a text protocol
 * in the prompt (bridge.js); the CLI has no native tool handoff, no temperature, and no pictures here. Thinking and effort are the CLI's own flags.
 */
'use strict';

const path = require('path');
const { createChatEngine } = require('../../engine');
const { createGovernor } = require('../../governor');
const { withContext } = require('../../model_info');
const { bridgeSection } = require('../../bridge');
const { createQoderAccount } = require('./account');
const { createQoderWeb } = require('./web');
const { CHAT_TIMEOUT_MS } = require('./cli');

const NOT_A_LINK = 'Qoder links with a personal access token: paste one in the token field. No browser window is involved.';

function createQoderProvider({ dataDir, config, log = () => {}, bus = null, cliPath = null } = {}) {
  const saved = config ? config.providerSettings('qoder') : {};
  const governor = createGovernor({ storagePath: path.join(dataDir, 'usage-qoder.json'), providerName: 'Qoder', dailyCap: saved.dailyCap, log });
  const account = createQoderAccount({ dataDir, cliPath, governor, log });
  const web = createQoderWeb({ account, cliPath, log });

  const engine = createChatEngine({
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
    capabilities: { link: 'key', key: true, refreshModels: true, settings: ['dailyCap'] },
    engine,
    governor,
    account,
    models: () => account.listModels().map(withContext),
    status: () => account.status(),
    startLink: () => Promise.resolve({ ok: false, error: NOT_A_LINK }),
    finishLink: () => Promise.resolve({ ok: false, error: NOT_A_LINK }),
    linkToken: (options) => account.linkToken(options),
    unlink: () => account.unlink(),
    refreshModels: (options) => account.refreshModels(options),
    resetUsage: () => governor.resetUsage(),
    async setSettings(patch = {}) {
      if (patch.dailyCap !== undefined) {
        const n = Math.floor(Number(patch.dailyCap));
        if (!(n > 0)) throw new Error('The daily cap must be a whole number above zero.');
        governor.setDailyCap(n);
        if (config) config.setProviderSettings('qoder', { dailyCap: n });
      }
      return provider.status();
    },
    async stop() { await account.stop(); }
  };
  return provider;
}

module.exports = { createQoderProvider };
