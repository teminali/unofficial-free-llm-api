/**
 * The Qoder account: the personal access token the person made in their own Qoder account, the model list the token can call, and the CLI that is allowed
 * to call them.
 *
 * The token is a login: it is written 0600 in the data folder, never logged, and handed only to the official Qoder CLI, in its environment. The CLI keeps
 * its own state in a folder inside the data folder, so a Qoder login that already exists on this computer is neither read nor changed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('../../config');
const {
  cleanKey, findCli, listModels, EXPIRED, KEY_HINT, CLI_MISSING, UNREACHABLE
} = require('./cli');

const REFRESH_AFTER_MS = 10 * 60 * 1000;
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'model';
}

/** A listed row as a model of this bridge. The id is prefixed, so a Qwen or Kimi model Qoder offers cannot be mistaken for another provider's model. */
function toModel(row, used) {
  let id = `qoder-${slug(row.name)}`;
  let n = 2;
  while (used.has(id)) { id = `qoder-${slug(row.name)}-${n}`; n += 1; }
  used.add(id);
  return {
    id,
    ref: row.ref,
    name: row.name,
    thinking: false,
    reasoning: true,
    escalate: false,
    supportsVision: true,
    supportsThinking: true,
    supportsDisabled: true,
    efforts: [...EFFORTS],
    defaultEffort: null,
    isFree: false
  };
}

function createQoderAccount({ dataDir, cliPath = null, governor, log = () => {} }) {
  const file = path.join(dataDir, 'qoder_key.json');
  const cliDir = path.join(dataDir, 'qoder-cli');
  let stopped = false;
  let linking = null;
  let refreshing = null;

  const readSession = () => readJson(file);
  const write = (session) => writeJson(file, session);
  const cli = () => findCli(cliPath);

  function cliHome() {
    fs.mkdirSync(cliDir, { recursive: true, mode: 0o700 });
    return cliDir;
  }

  function listModelsStored() {
    const session = readSession();
    return session && session.pat && !session.expired && Array.isArray(session.models) ? session.models : [];
  }

  function modelInfo(id) {
    return listModelsStored().find((model) => model.id === id || model.ref === id) || null;
  }

  function markExpired(reason) {
    const session = readSession();
    if (!session || !session.pat || session.expired) return;
    write({ ...session, expired: true, expiredReason: reason || EXPIRED, models: [] });
  }

  function failure(error) {
    if (!error) return;
    if (error.authExpired) markExpired(error.message);
    if (error.rateLimited && error.cooldownMs) governor.setCooldown(error.cooldownMs, 'Qoder refused requests');
  }

  /** The token a completion carries. The CLI exchanges it itself; nothing about that exchange is kept here. */
  function auth() {
    if (stopped) throw Object.assign(new Error('Qoder is stopping.'), { retryable: false });
    const session = readSession();
    if (!session || !session.pat) throw Object.assign(new Error('Link Qoder on the Accounts page first: paste a personal access token.'), { retryable: false });
    if (session.expired) throw Object.assign(new Error(session.expiredReason || EXPIRED), { authExpired: true, retryable: false });
    return { pat: session.pat, session };
  }

  /** The models this token can call, read from the CLI. Unless forced, a list younger than ten minutes is reused. */
  async function refreshModels({ force = false } = {}) {
    const session = readSession();
    if (!session || !session.pat || session.expired) return false;
    const readAt = Date.parse(session.modelsReadAt || '') || 0;
    if (!force && Array.isArray(session.models) && session.models.length && Date.now() - readAt < REFRESH_AFTER_MS) return true;
    if (!refreshing) {
      refreshing = (async () => {
        const executable = cli();
        if (!executable) {
          log('qoder: model list was not read (the Qoder CLI was not found)');
          return false;
        }
        try {
          const rows = await listModels({ cliPath: executable, pat: session.pat, configDir: cliHome() });
          const now = readSession();
          if (!now || now.linkId !== session.linkId) return false;
          const used = new Set();
          const models = rows.map((row) => toModel(row, used));
          write({ ...now, models, modelsReadAt: new Date().toISOString() });
          log(`qoder: model list read (${models.length} models)`);
          return true;
        } catch (error) {
          failure(error);
          log(`qoder: model list was not read${error.status ? ` (${error.status})` : ''}`);
          return false;
        } finally { refreshing = null; }
      })();
    }
    return refreshing;
  }

  async function linkToken({ token, consentAcknowledged } = {}) {
    if (!consentAcknowledged) return { ok: false, error: 'Confirm that this bridge may use your Qoder personal access token before linking.' };
    if (stopped) return { ok: false, error: 'The provider is stopping.' };
    const pat = cleanKey(token);
    if (!pat) return { ok: false, error: KEY_HINT };
    const executable = cli();
    if (!executable) return { ok: false, error: CLI_MISSING };
    if (linking) return { ok: false, error: 'This token is already being checked. Wait for it to finish.' };
    linking = (async () => {
      try {
        const rows = await listModels({ cliPath: executable, pat, configDir: cliHome() });
        if (stopped) return { ok: false, cancelled: true };
        const used = new Set();
        const models = rows.map((row) => toModel(row, used));
        write({
          pat,
          linkId: crypto.randomUUID(),
          linkedAt: new Date().toISOString(),
          consentAckAt: new Date().toISOString(),
          models,
          modelsReadAt: new Date().toISOString(),
          accountName: null,
          expired: false,
          expiredReason: null
        });
        governor.clearCooldown();
        log(`qoder: account linked; ${models.length} models`);
        return { ok: true, linked: true, models };
      } catch (error) {
        if (error.cancelled) return { ok: false, cancelled: true };
        if (error.authExpired || error.empty) return { ok: false, error: error.message };
        log(`qoder: token check failed${error.status ? ` (${error.status})` : ''}`);
        return { ok: false, error: error.retryable === false ? String(error.message || UNREACHABLE) : UNREACHABLE };
      } finally { linking = null; }
    })();
    return linking;
  }

  async function unlink() {
    fs.rmSync(file, { force: true });
    fs.rmSync(cliDir, { recursive: true, force: true });
    governor.clearCooldown();
    return { linked: false, models: [] };
  }

  async function status() {
    const session = readSession();
    const linked = Boolean(session && session.pat);
    const executable = cli();
    return {
      linked,
      expired: Boolean(session && session.expired),
      expiredReason: (session && session.expiredReason) || null,
      linkedAt: (session && session.linkedAt) || null,
      models: linked && !session.expired ? listModelsStored() : [],
      accountLabel: (session && session.accountName) || null,
      linking: Boolean(linking),
      linkNote: null,
      cli: { found: Boolean(executable), path: executable || null },
      usage: governor.getStats(),
      keyPlaceholder: 'Paste your Qoder personal access token',
      keyHint: executable
        ? 'Make a personal access token at https://qoder.com/account/integrations, then paste it here. It is kept on this computer and handed only to the Qoder CLI, which uses the models your Qoder plan can call. The CLI is what makes the signed requests; no browser window is involved.'
        : 'The Qoder CLI was not found on this computer. Install it with "npm install -g @qoder-ai/qodercli", then make a personal access token at https://qoder.com/account/integrations and paste it here.'
    };
  }

  async function stop() {
    stopped = true;
    await Promise.allSettled([linking, refreshing].filter(Boolean));
  }

  return {
    readSession, listModels: listModelsStored, modelInfo, auth, failure, refreshModels, linkToken, unlink, status, stop, cliHome
  };
}

module.exports = { createQoderAccount, toModel, EFFORTS };
