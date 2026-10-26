/**
 * Qoder completions through the official CLI, turned into what the chat engine expects.
 *
 * A conversation keeps one CLI process (warm.js): the first turn opens it, and every follow-up goes in as one new message, so the CLI holds the conversation
 * and the eleven seconds of boot are paid once. A chat is held in that process only, never on disk. When the engine asks for no kept chat, or the installed
 * CLI cannot keep one, every request is one `qoder --print` process, as before.
 *
 * Tools are a text protocol (bridge.js writes it into the prompt and parseAnswer reads the calls back). The answer and the thinking stream as the CLI sends
 * partial events when it can. A model that cannot take pictures is never given one: the prompt says the image was omitted.
 */
'use strict';

const { chat, findCli, CLI_MISSING } = require('./cli');
const { openWarm } = require('./warm');

/** What kept chats cost: three live processes at most, each closed after ten idle minutes or twenty-four turns. */
const SESSION_OPTIONS = Object.freeze({ maxSessions: 3, ttlMs: 10 * 60 * 1000, maxTurns: 24, closeGapMs: 500 });

function createQoderWeb({ account, cliPath = null, log = () => {} }) {
  let warmRefused = null; // why this CLI cannot keep a chat, once it has refused the flags

  function failed(error, sent = true) {
    log(`qoder: request failed${error.status ? ` (${error.status})` : ''}${error.cancelled ? ' (the caller left)' : ''}`);
    return {
      ok: false,
      sent: sent && !error.cliMissing,
      error: error.message,
      retryable: error.retryable,
      ...(error.authExpired ? { authExpired: true } : {}),
      ...(error.rateLimited ? { rateLimited: true, cooldownMs: error.cooldownMs, retryAfterSec: Math.ceil((error.cooldownMs || 0) / 1000) } : {}),
      ...(error.cancelled ? { cancelled: true } : {})
    };
  }

  async function completeOnce({ prompt, thinking, thinkingLevel, signal, model, onDelta = () => {}, keep = false, remote = null }) {
    let auth;
    try { auth = account.auth(); } catch (error) {
      return { ok: false, sent: false, error: error.message, retryable: error.retryable === true, ...(error.authExpired ? { authExpired: true } : {}) };
    }
    const executable = findCli(cliPath);
    if (!executable) return { ok: false, sent: false, error: CLI_MISSING, retryable: false };
    const common = { cliPath: executable, pat: auth.pat, configDir: account.cliHome(), model, prompt, thinking, thinkingLevel, signal, onDelta, log };

    // The chat this request continues: only its new messages go in, and it is handed back if it is still open afterwards.
    if (remote) {
      if (typeof remote.alive !== 'function' || !remote.alive()) {
        return { ok: false, sent: false, error: 'The Qoder chat ended. The next request will send the conversation as a new chat.', retryable: true };
      }
      try {
        const out = await remote.ask(prompt, { onDelta, signal });
        return { sent: true, ...out, remote: remote.alive() ? remote : null };
      } catch (error) {
        account.failure(error);
        return failed(error);
      }
    }

    if (keep && !warmRefused) {
      try {
        const opened = await openWarm({ ...common, cwd: common.configDir });
        return { sent: true, ...opened.out, remote: opened.alive ? opened.chat : null };
      } catch (error) {
        if (!error.unsupported) {
          account.failure(error);
          return failed(error);
        }
        warmRefused = error.message;
        log('qoder: this CLI cannot keep a chat; every request gets its own process');
      }
    }

    try {
      const out = await chat(common);
      return { sent: true, ...out };
    } catch (error) {
      account.failure(error);
      return failed(error);
    }
  }

  return {
    completeOnce,
    sessions: true,
    closeSession: (remote) => (remote && typeof remote.close === 'function' ? remote.close() : Promise.resolve())
  };
}

module.exports = { createQoderWeb, SESSION_OPTIONS };
