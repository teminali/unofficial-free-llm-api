/**
 * The demo provider: no account, no network. It answers by describing what it was sent, so the web interface, the API and a client library can be tried
 * (and tested) before anything is linked. It is only there when the server is started with --demo.
 */
'use strict';

const path = require('path');
const { createChatEngine } = require('../engine');
const { createGovernor } = require('../governor');

const MODELS = [
  { id: 'demo-echo', name: 'Demo echo', thinking: false, escalate: false },
  { id: 'demo-thinker', name: 'Demo thinker', thinking: true, escalate: false }
];

function lastUserText(prompt) {
  const at = prompt.lastIndexOf('USER:\n');
  const text = at >= 0 ? prompt.slice(at + 6) : prompt;
  return text.replace(/\n\nAnswer the latest USER message now\.$/, '').trim();
}

function createDemoProvider({ dataDir, log = () => {}, bus = null }) {
  const governor = createGovernor({ storagePath: path.join(dataDir, 'usage-demo.json'), providerName: 'Demo', dailyCap: 10000, pace: { minGapMs: 1, perMinute: 1000, smooth: true } });
  const web = {
    async completeOnce({ prompt, thinking, signal, onDelta = () => {} }) {
      const said = lastUserText(prompt);
      const words = ['You said:', `"${said.length > 160 ? `${said.slice(0, 160)}...` : said}".`, '\n\nThis is the **demo** provider: nothing here talks to any account.', 'It streams like a real model would, so you can check that your client reads', '`data:` chunks, `[DONE]` and `reasoning_content` the way you expect.'];
      const think = thinking ? 'Reading the message. Choosing a short, friendly answer. ' : '';
      if (think) for (const piece of think.match(/.{1,12}/g)) { if (signal && signal.aborted) return { ok: false, cancelled: true }; onDelta({ type: 'think', text: piece }); await new Promise((r) => setTimeout(r, 25)); }
      let text = '';
      for (const w of words) {
        if (signal && signal.aborted) return { ok: false, cancelled: true };
        const piece = `${text && !w.startsWith('\n') ? ' ' : ''}${w}`;
        text += piece;
        onDelta({ type: 'answer', text: piece });
        await new Promise((r) => setTimeout(r, 40));
      }
      return { ok: true, text, thinking: think.trim() };
    }
  };
  const engine = createChatEngine({ provider: { id: 'demo', name: 'Demo', web, timeoutMs: 30000, idPrefix: 'dm' }, governor, log, onNotice: (n) => { if (bus) bus.emit('notice', n); } });
  const provider = {
    id: 'demo',
    name: 'Demo',
    capabilities: { link: 'none', token: false, settings: ['dailyCap'], demo: true },
    engine,
    governor,
    models: () => MODELS,
    async status() { return { linked: true, expired: false, models: MODELS, usage: governor.getStats(), accountLabel: 'no account' }; },
    async startLink() { return { ok: true }; },
    async finishLink() { return { ok: true, linked: true }; },
    async unlink() { return { linked: true }; },
    resetUsage() { governor.resetUsage(); },
    async setSettings(patch) { if (patch && patch.dailyCap) governor.setDailyCap(patch.dailyCap); return provider.status(); }
  };
  return provider;
}

module.exports = { createDemoProvider, MODELS };
