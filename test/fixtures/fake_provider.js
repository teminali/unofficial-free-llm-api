/**
 * A provider with no account behind it, for tests: the real engine and the real governor in front of a scripted "web chat".
 *
 *   const fake = createFakeProvider({ dir });
 *   fake.script.reply = (prompt, { thinking }) => ({ ok: true, text: 'hello' });   // what the chat answers, per call
 *   fake.calls                                                                      // every call that reached the "chat", with its prompt and mode
 */
'use strict';

const path = require('path');
const { createChatEngine } = require('../../src/engine');
const { createGovernor } = require('../../src/governor');
const { fencedBridgeSection } = require('../../src/bridge');

function createFakeProvider({ dir, bus = null, id = 'fake', name = 'Fake', pace = { minGapMs: 1, perMinute: 1000, smooth: true, cooldownMs: 60000 }, dailyCap = 300, fenced = false, keyLink = false } = {}) {
  const governor = createGovernor({ storagePath: path.join(dir, `usage-${id}.json`), providerName: name, dailyCap, pace });
  const calls = [];
  const script = {
    linked: true,
    expired: false,
    delayMs: 0,
    chunk: 6,
    credits: null,
    reply: () => ({ ok: true, text: 'Hello from the fake chat.' })
  };
  const MODELS = [
    { id: `${id}-chat`, name: 'Fake Chat', thinking: false, escalate: false },
    { id: `${id}-reasoner`, name: 'Fake Reasoner', thinking: true, escalate: false },
    { id: `${id}-auto`, name: 'Fake Auto', thinking: false, escalate: true }
  ];

  const web = {
    async completeOnce({ prompt, thinking, signal, model, thinkingLevel, onDelta = () => {} }) {
      calls.push({ prompt, thinking: Boolean(thinking), model, thinkingLevel, at: Date.now() });
      if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
      if (signal && signal.aborted) return { ok: false, cancelled: true, sent: true };
      const out = await script.reply(prompt, { thinking: Boolean(thinking), call: calls.length, model });
      if (!out.ok) return out;
      if (out.thinking) onDelta({ type: 'think', text: out.thinking });
      const text = out.text || '';
      for (let i = 0; i < text.length; i += script.chunk) {
        if (signal && signal.aborted) return { ok: false, cancelled: true, sent: true };
        onDelta({ type: 'answer', text: text.slice(i, i + script.chunk) });
        if (script.delayMs) await new Promise((r) => setTimeout(r, 1));
      }
      return { ok: true, text, thinking: out.thinking };
    }
  };

  const engine = createChatEngine({
    provider: {
      id, name, web,
      ...(fenced ? { bridge: (tools) => fencedBridgeSection(tools, {}), hold: 'leading-json', formatCall: (call) => '```json\n' + JSON.stringify(call) + '\n```' } : {}),
      timeoutMs: 5000
    },
    governor,
    onNotice: (n) => { if (bus) bus.emit('notice', n); }
  });

  const provider = {
    id, name,
    capabilities: keyLink
      ? { link: 'key', key: true, refreshModels: true, settings: ['dailyCap'] }
      : { link: 'chrome', token: false, settings: ['dailyCap'] },
    engine, governor, web, calls, script,
    models: () => (script.linked && !script.expired ? MODELS : []),
    async status() {
      return {
        linked: script.linked,
        expired: script.expired,
        expiredReason: script.expired ? `Your ${name} session has expired. Sign in again on the Accounts page.` : null,
        models: provider.models(),
        ...(Number.isFinite(script.credits) ? { credits: { balance: script.credits, checkedAt: new Date().toISOString() } } : {}),
        usage: governor.getStats()
      };
    },
    async startLink() { script.linked = true; script.expired = false; return { ok: true }; },
    async finishLink() { return { ok: true, linked: true }; },
    ...(keyLink ? {
      async linkToken({ token, consentAcknowledged } = {}) {
        if (!consentAcknowledged) return { ok: false, error: 'Confirm that this bridge may use your Fake API key before linking.' };
        if (!/^b4m_[A-Za-z0-9._-]{8,}$/.test(String(token || '').trim())) return { ok: false, error: 'That is not a Bike4Mind API key. Keys begin with b4m_.' };
        script.linked = true;
        script.expired = false;
        script.credits = 5000;
        return { ok: true, linked: true };
      },
      async refreshModels() { return Boolean(script.linked && !script.expired); }
    } : {}),
    async unlink() { script.linked = false; script.credits = null; return { linked: false }; },
    resetUsage() { governor.resetUsage(); },
    async setSettings(patch) { if (patch.dailyCap) governor.setDailyCap(patch.dailyCap); return provider.status(); }
  };
  return provider;
}

module.exports = { createFakeProvider };
