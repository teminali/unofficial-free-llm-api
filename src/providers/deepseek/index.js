/**
 * The DeepSeek provider: the person's own chat.deepseek.com account, through the site's own endpoints (web.js) and the session saved by link.js, behind the
 * chat engine and a governor with DeepSeek's own, gentler pace.
 *
 * Models: `deepseek-chat` (the plain chat), `deepseek-reasoner` (DeepThink on), `deepseek-auto` (the plain chat that can hand one hard question to DeepThink
 * when the request has tools; see engine.js).
 */
'use strict';

const path = require('path');
const { createChatEngine } = require('../../engine');
const { createGovernor, DEEPSEEK_PACE } = require('../../governor');
const { bridgeSection } = require('../../bridge');
const { createDeepSeekWeb, REQUEST_TIMEOUT_MS } = require('./web');
const { createDeepSeekAccount } = require('./link');
const { resolveBase } = require('./base');

function createDeepSeekProvider({ dataDir, config, log = () => {}, bus = null, base, pace = DEEPSEEK_PACE, plainChromeArgs, drivenChromeArgs }) {
  const saved = config ? config.providerSettings('deepseek') : {};
  const address = resolveBase(base);
  const governor = createGovernor({ storagePath: path.join(dataDir, 'usage-deepseek.json'), providerName: 'DeepSeek', dailyCap: saved.dailyCap, pace, log });
  const account = createDeepSeekAccount({ dataDir, base: address, log, governor, plainChromeArgs, drivenChromeArgs });
  const web = createDeepSeekWeb({ dataDir, base: address, log, governor, onAuthExpired: (reason) => account.markExpired(reason) });

  const engine = createChatEngine({
    provider: {
      id: 'deepseek',
      name: 'DeepSeek',
      idPrefix: 'ds',
      web,
      // The plain chat's reply ends at about 8,000 tokens (27,000 characters were seen cut off): it is told so up front, with room to spare.
      bridge: (tools) => bridgeSection(tools, { replyChars: 20000, callChars: 15000, thinkWhen: true, batch: true }),
      noToolsHint: 'Answer the latest USER message now. If it needs a tool, reply only with the tool-call blocks.',
      repeatLimit: 3,
      hold: 'marker',
      timeoutMs: REQUEST_TIMEOUT_MS
    },
    governor,
    log,
    onNotice: (n) => { if (bus) bus.emit('notice', n); }
  });

  const provider = {
    id: 'deepseek',
    name: 'DeepSeek',
    capabilities: { link: 'chrome', token: true, settings: ['dailyCap'] },
    engine,
    governor,
    account,
    models: () => account.listModels(),
    status: () => account.status(),
    startLink: (opts) => account.startLink(opts),
    finishLink: (opts) => account.finishLink(opts),
    linkToken: (opts) => account.linkToken(opts),
    unlink: () => account.unlink(),
    resetUsage: () => governor.resetUsage(),
    async setSettings(patch = {}) {
      if (patch.dailyCap !== undefined) {
        const n = Math.floor(Number(patch.dailyCap));
        if (!(n > 0)) throw new Error('The daily cap must be a whole number above zero.');
        governor.setDailyCap(n);
        if (config) config.setProviderSettings('deepseek', { dailyCap: n });
      }
      return account.status();
    },
    stop: () => account.stop()
  };
  return provider;
}

module.exports = { createDeepSeekProvider };
