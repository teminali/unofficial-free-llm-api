/**
 * The registry of providers: what the server asks to find a provider by id, to list the models the linked accounts can answer with, and to turn the model
 * name in a request into one of them.
 *
 * A provider is an object with this shape (src/providers/deepseek and src/providers/qoder are the two real ones, test/fixtures/fake_provider.js a small one):
 *   id, name, capabilities: { link: 'chrome' | ..., token: boolean, settings: [...] }
 *   engine                         the chat engine (src/engine.js) that answers its models
 *   models()                       sync: the models usable right now (linked and not expired), each { id, name, thinking, escalate, ref }
 *   status()                       async: { linked, expired, expiredReason, linking, linkNote, models, usage, ... } for the web interface
 *   startLink({ consentAcknowledged }) / finishLink({ cancel }) / unlink() / resetUsage() / setSettings(patch) / linkToken({ token })?
 *   stop()?
 */
'use strict';

function createRegistry({ providers, bus }) {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const listeners = [];
  if (bus) bus.on('notice', (n) => { for (const fn of listeners) { try { fn(n); } catch (_) { /* a listener never stops the bridge */ } } });

  function list() { return [...byId.values()]; }
  function get(id) { return byId.get(id) || null; }

  /** The models of every provider that can answer right now, each tagged with its provider. */
  function models() {
    const out = [];
    for (const p of byId.values()) {
      let own = [];
      try { own = p.models(); } catch (_) { own = []; }
      for (const m of own) out.push({ ...m, provider: p.id });
    }
    return out;
  }

  /**
   * The model a request names. The id as listed ("deepseek-chat"), the id behind its provider ("deepseek/deepseek-chat"), or, when the request names no
   * model at all, the first one there is (a client that leaves it out gets an answer instead of an error).
   */
  function resolveModel(name) {
    const all = models();
    if (!name) return all[0] || null;
    const wanted = String(name).trim();
    const bare = wanted.includes('/') ? wanted.slice(wanted.indexOf('/') + 1) : wanted;
    const prefix = wanted.includes('/') ? wanted.slice(0, wanted.indexOf('/')) : '';
    return all.find((m) => m.id === wanted)
      || all.find((m) => m.id === bare && (!prefix || m.provider === prefix))
      || null;
  }

  function onNotice(fn) { listeners.push(fn); }

  /** Stops every provider and waits for them (a Chrome left running would outlive the program), but not for ever. */
  async function stop() {
    const ends = [];
    for (const p of byId.values()) {
      try { if (p.engine && p.engine.stop) p.engine.stop(); } catch (_) { /* going down anyway */ }
      try { if (typeof p.stop === 'function') ends.push(Promise.resolve(p.stop()).catch(() => {})); } catch (_) { /* going down anyway */ }
    }
    await Promise.race([Promise.all(ends), new Promise((r) => { const t = setTimeout(r, 15000); if (t.unref) t.unref(); })]);
  }

  return { list, get, models, resolveModel, onNotice, stop };
}

module.exports = { createRegistry };
