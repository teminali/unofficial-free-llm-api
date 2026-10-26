/**
 * Builds the providers this server offers. Each factory gets { dataDir, config, log, bus } and returns a provider (see src/registry.js for its shape);
 * `bus` is where a provider announces notices ("paused to protect your account") that the web interface shows on its Activity page.
 */
'use strict';

const { EventEmitter } = require('events');

const FACTORIES = {
  deepseek: () => require('./deepseek').createDeepSeekProvider,
  qoder: () => require('./qoder').createQoderProvider,
  demo: () => require('./demo').createDemoProvider
};

function createProviders({ dataDir, config, log = () => {}, only = ['deepseek', 'qoder'], sessions = true }) {
  const bus = new EventEmitter();
  const providers = only.map((id) => {
    if (!FACTORIES[id]) throw new Error(`Unknown provider "${id}". Known: ${Object.keys(FACTORIES).join(', ')}.`);
    return FACTORIES[id]()({ dataDir, config, log, bus, sessions });
  });
  return { providers, bus };
}

module.exports = { createProviders, PROVIDER_IDS: Object.keys(FACTORIES) };
