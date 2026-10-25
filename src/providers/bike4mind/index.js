/**
 * The Bike4Mind provider: the person's own Bike4Mind account, through its official API key, behind the chat engine and a governor.
 *
 * This is the one provider that is an API rather than a website. The person makes a key in their own Bike4Mind account and pastes it on the Accounts page; every
 * call is billed in credits in that account. There is no Chrome, no session, and no page to keep open. The API's own tools are offered natively; see web.js for
 * how their calls come back in the bridge form the engine reads.
 */
'use strict';

const path = require('path');
const { createChatEngine } = require('../../engine');
const { createGovernor } = require('../../governor');
const { withContext } = require('../../model_info');
const { createBike4MindAccount } = require('./account');
const { createBike4MindWeb } = require('./web');
const { resolveBase, REQUEST_TIMEOUT_MS } = require('./api');

const NOT_A_LINK = 'Bike4Mind links with an API key: paste one in the API key field. No browser window is involved.';

function createBike4MindProvider({ dataDir, config, log = () => {}, bus = null, base } = {}) {
  const saved = config ? config.providerSettings('bike4mind') : {};
  const address = resolveBase(base);
  const governor = createGovernor({ storagePath: path.join(dataDir, 'usage-bike4mind.json'), providerName: 'Bike4Mind', dailyCap: saved.dailyCap, log });
  const account = createBike4MindAccount({ dataDir, base: address, governor, log });
  const web = createBike4MindWeb({ base: address, account, log });

  const engine = createChatEngine({
    provider: {
      id: 'bike4mind',
      name: 'Bike4Mind',
      idPrefix: 'b4m',
      web,
      // The tools go to the API natively, so the prompt carries no tool protocol of its own.
      bridge: () => '',
      noToolsHint: 'Answer the latest USER message now. Call a tool only when the request needs one; otherwise answer in plain words.',
      repeatLimit: 3,
      hold: 'marker',
      timeoutMs: REQUEST_TIMEOUT_MS
    },
    governor,
    log,
    onNotice: (notice) => { if (bus) bus.emit('notice', notice); }
  });

  const provider = {
    id: 'bike4mind',
    name: 'Bike4Mind',
    capabilities: { link: 'key', key: true, temperature: true, refreshModels: true, settings: ['dailyCap'] },
    engine,
    governor,
    account,
    models: () => account.listModels().map(withContext),
    status: () => account.status(),
    startLink: () => Promise.resolve({ ok: false, error: NOT_A_LINK }),
    finishLink: () => Promise.resolve({ ok: false, error: NOT_A_LINK }),
    linkToken: (options) => account.linkToken(options),
    unlink: () => account.unlink(),
    refreshModels: () => account.refreshModels(),
    resetUsage: () => governor.resetUsage(),
    async setSettings(patch = {}) {
      if (patch.dailyCap !== undefined) {
        const n = Math.floor(Number(patch.dailyCap));
        if (!(n > 0)) throw new Error('The daily cap must be a whole number above zero.');
        governor.setDailyCap(n);
        if (config) config.setProviderSettings('bike4mind', { dailyCap: n });
      }
      return provider.status();
    },
    async stop() { await account.stop(); }
  };
  return provider;
}

module.exports = { createBike4MindProvider };
