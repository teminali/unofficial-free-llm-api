/**
 * One Qoder completion through the official CLI: the prompt on stdin, no built-in tools, and the CLI's answer turned into what the chat engine expects.
 *
 * Tools are a text protocol (bridge.js writes it into the prompt and parseAnswer reads the calls back), exactly like the other account-backed providers. The
 * answer and the thinking stream as the CLI sends partial events when it can; the final JSON result is what the answer is taken as. A model that cannot take
 * pictures is never given one: the prompt says the image was omitted, because the engine only sends pictures to a client that says it takes them.
 */
'use strict';

const { chat, findCli, CLI_MISSING } = require('./cli');

function createQoderWeb({ account, cliPath = null, log = () => {} }) {
  async function completeOnce({ prompt, thinking, thinkingLevel, signal, model, onDelta = () => {} }) {
    let auth;
    try { auth = account.auth(); } catch (error) {
      return { ok: false, sent: false, error: error.message, retryable: error.retryable === true, ...(error.authExpired ? { authExpired: true } : {}) };
    }
    const executable = findCli(cliPath);
    if (!executable) return { ok: false, sent: false, error: CLI_MISSING, retryable: false };

    try {
      const out = await chat({
        cliPath: executable,
        pat: auth.pat,
        configDir: account.cliHome(),
        model,
        prompt,
        thinking,
        thinkingLevel,
        signal,
        onDelta,
        log
      });
      return { sent: true, ...out };
    } catch (error) {
      account.failure(error);
      log(`qoder: request failed${error.status ? ` (${error.status})` : ''}${error.cancelled ? ' (the caller left)' : ''}`);
      return {
        ok: false,
        sent: !error.cliMissing,
        error: error.message,
        retryable: error.retryable,
        ...(error.authExpired ? { authExpired: true } : {}),
        ...(error.rateLimited ? { rateLimited: true, cooldownMs: error.cooldownMs, retryAfterSec: Math.ceil((error.cooldownMs || 0) / 1000) } : {}),
        ...(error.cancelled ? { cancelled: true } : {})
      };
    }
  }

  return { completeOnce };
}

module.exports = { createQoderWeb };
