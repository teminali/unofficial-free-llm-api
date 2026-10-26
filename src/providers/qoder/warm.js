/**
 * One Qoder CLI process for a whole conversation.
 *
 * `qoder --print --input-format stream-json` reads one JSON message per line and answers each with a result, and the process stays alive between turns. That
 * skips the CLI's boot on every follow-up (about eleven seconds of it) and lets the CLI hold the conversation instead of being sent it again. The conversation
 * is held by the process only (`--no-session-persistence`): nothing is written to disk, and a process that dies is replaced by a new chat built from the
 * caller's own transcript.
 *
 * The caller drives the turns. A caller who leaves interrupts the turn with the CLI's control request, so nothing keeps generating after the connection is
 * gone, and closing the chat ends the process. The token is handed over in the child's environment only, and it is scrubbed from anything logged.
 */
'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const { childEnv, redact, streamReader, describeFailure, effortArgs, CHAT_TIMEOUT_MS } = require('./cli');

const KILL_GRACE_MS = 2000;
const CLOSE_GRACE_MS = 2500;
const MAX_TURN_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;
const MAX_ARG_TRIES = 5;
const VALUED_FLAGS = new Set(['--model', '--config-dir', '--output-format', '--tools', '--input-format', '--max-model-request-retries', '--thinking', '--reasoning-effort']);

function warmArgs({ configDir, model, thinking, thinkingLevel }) {
  return [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--model', model,
    '--tools', '',
    '--config-dir', configDir,
    '--no-session-persistence',
    '--max-model-request-retries', '0',
    ...effortArgs(thinking, thinkingLevel)
  ];
}

function dropFlag(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) { if (VALUED_FLAGS.has(flag)) i += 1; continue; }
    out.push(args[i]);
  }
  return out;
}

function jsonOutput(args) {
  return args
    .map((arg, index) => (args[index - 1] === '--output-format' ? 'json' : arg))
    .filter((arg) => arg !== '--include-partial-messages');
}

const left = () => Object.assign(new Error('The caller left before Qoder answered.'), { cancelled: true, retryable: true });

/** A chat refused the flags it needs: the caller can keep a chat, but this CLI cannot. */
const unsupported = (message) => Object.assign(new Error(message), { unsupported: true, retryable: false });

class WarmChat {
  constructor({ cliPath, pat, args, cwd, log = () => {} }) {
    this.id = `qdw_${crypto.randomBytes(6).toString('hex')}`;
    this.pat = pat;
    this.log = log;
    this.args = args;
    this.closed = false;
    this.exited = false;
    this.exit = null;
    this.spawnError = null;
    this.stderr = '';
    this.buffer = '';
    this.current = null;
    this.settled = false;
    this.openedAt = Date.now();
    this.child = spawn(cliPath, args, { cwd, env: childEnv(pat), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { if (this.stderr.length < MAX_STDERR_BYTES) this.stderr += chunk; });
    this.child.stdin.on('error', () => { /* the CLI may exit before reading */ });
    this.child.on('error', (error) => { this.spawnError = error; this.dead(); });
    this.child.on('exit', (code, signal) => { this.exited = true; this.exit = { code, signal }; this.dead(); });
  }

  alive() {
    return !this.closed && !this.exited;
  }

  consume(chunk) {
    const turn = this.current;
    if (turn) {
      turn.bytes += Buffer.byteLength(chunk);
      if (turn.bytes > MAX_TURN_BYTES) {
        this.log(`qoder cli: a turn passed ${MAX_TURN_BYTES} bytes, ending the chat`);
        this.kill();
        return;
      }
    }
    this.buffer += chunk;
    let at;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line) this.line(line);
    }
  }

  /** One line of the CLI's output. A result ends the turn that is waiting for it; anything else is the answer as it arrives. */
  line(line) {
    let event;
    try { event = JSON.parse(line); } catch (_) { return; }
    if (!event || typeof event !== 'object') return;
    const turn = this.current;
    if (event.type === 'control_response') return;
    if (!turn) return;
    turn.sawLine = true;
    if (!turn.firstAt) {
      turn.firstAt = Date.now() - turn.started;
      this.log(`qoder cli: its first output came after ${turn.firstAt}ms`);
    }
    turn.reader.take(event);
    if (event.type === 'result') this.settle(turn);
  }

  ask(prompt, { onDelta = () => {}, signal = null, timeoutMs = CHAT_TIMEOUT_MS } = {}) {
    if (!this.alive()) return Promise.reject(this.deathError());
    if (this.current) return Promise.reject(Object.assign(new Error('The Qoder CLI is answering another turn.'), { retryable: true }));
    return new Promise((resolve, reject) => {
      const turn = {
        reader: streamReader(this.pat, onDelta), resolve, reject, signal, started: Date.now(), firstAt: 0,
        sawLine: false, bytes: 0, aborted: false, interrupted: false, timedOut: false, timer: null, interruptTimer: null, onAbort: null
      };
      this.current = turn;
      turn.timer = setTimeout(() => { turn.timedOut = true; this.interrupt(turn); }, timeoutMs);
      if (turn.timer.unref) turn.timer.unref();
      if (signal) {
        if (signal.aborted) {
          this.current = null;
          clearTimeout(turn.timer);
          turn.reject(left());
          return;
        }
        turn.onAbort = () => this.interrupt(turn);
        signal.addEventListener('abort', turn.onAbort, { once: true });
      }
      try {
        this.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`);
      } catch (_) {
        this.kill();
      }
    });
  }

  /** Ends the turn now, the way the CLI's own client does, so the process can be used again or closed. */
  interrupt(turn) {
    if (this.current !== turn || turn.interrupted) return;
    turn.interrupted = true;
    if (turn.signal && turn.signal.aborted) turn.aborted = true;
    this.log(`qoder cli: ending the turn (${turn.aborted ? 'the caller left' : 'it went quiet'})`);
    try {
      this.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `int_${crypto.randomBytes(4).toString('hex')}`, request: { subtype: 'interrupt' } })}\n`);
    } catch (_) { this.kill(); return; }
    turn.interruptTimer = setTimeout(() => this.kill(), KILL_GRACE_MS);
    if (turn.interruptTimer.unref) turn.interruptTimer.unref();
  }

  settle(turn) {
    if (this.current !== turn) return;
    this.current = null;
    clearTimeout(turn.timer);
    clearTimeout(turn.interruptTimer);
    if (turn.onAbort && turn.signal) turn.signal.removeEventListener('abort', turn.onAbort);
    if (turn.aborted) { turn.reject(this.deathError(turn)); return; }
    if (turn.timedOut) { turn.reject(this.deathError(turn)); return; }
    try {
      const out = turn.reader.finish();
      this.log(`qoder cli: a turn answered in ${Date.now() - turn.started}ms`);
      turn.resolve(out);
    } catch (error) {
      turn.reject(error);
    }
  }

  /** The process is gone: the turn it was answering fails, and the chat can never be used again. */
  dead() {
    if (this.settled) return;
    this.settled = true;
    this.closed = true;
    if (this.buffer.trim()) {
      const line = this.buffer.trim();
      this.buffer = '';
      this.line(line);
    }
    const turn = this.current;
    this.current = null;
    if (!turn) return;
    clearTimeout(turn.timer);
    clearTimeout(turn.interruptTimer);
    if (turn.onAbort && turn.signal) turn.signal.removeEventListener('abort', turn.onAbort);
    turn.reject(this.deathError(turn));
  }

  deathError(turn = null) {
    if (turn && turn.aborted) return left();
    if (turn && turn.timedOut) return Object.assign(new Error('The Qoder CLI did not answer within ten minutes.'), { retryable: true, timedOut: true });
    if (this.spawnError) return describeFailure({ spawnError: this.spawnError, code: null, stdout: '', stderr: this.stderr }, this.pat);
    let error;
    try {
      error = describeFailure({ code: this.exit ? this.exit.code : null, stdout: '', stderr: this.stderr }, this.pat);
    } catch (_) {
      error = Object.assign(new Error('The Qoder CLI ended before it answered.'), { retryable: true });
    }
    if (turn && turn.sawLine) {
      // It answered and then stopped: the chat can be re-opened from the caller's own transcript.
      error.retryable = true;
      if (!error.status) error.status = 502;
    }
    if (!(turn && turn.sawLine)) {
      const unknown = /unknown option '([^']+)'/i.exec(this.stderr) || /unknown option "([^"]+)"/i.exec(this.stderr);
      if (unknown) error.refusedFlag = unknown[1];
      if (/(allowed choices|invalid (?:value|choice))/i.test(this.stderr) && /--output-format/.test(this.stderr)) error.refusedFormat = true;
    }
    return error;
  }

  kill() {
    try { this.child.kill('SIGTERM'); } catch (_) { /* already gone */ }
    const timer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch (_) { /* already gone */ } }, KILL_GRACE_MS);
    if (timer.unref) timer.unref();
  }

  close() {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const turn = this.current;
    this.current = null;
    if (turn) {
      clearTimeout(turn.timer);
      clearTimeout(turn.interruptTimer);
      if (turn.onAbort && turn.signal) turn.signal.removeEventListener('abort', turn.onAbort);
      turn.reject(left());
    }
    const child = this.child;
    if (!child) return Promise.resolve();
    const exited = new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    try { child.stdin.end(); } catch (_) { /* already gone */ }
    const term = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) { /* already gone */ } }, 200);
    if (term.unref) term.unref();
    this.kill();
    return Promise.race([exited, new Promise((resolve) => { const t = setTimeout(resolve, CLOSE_GRACE_MS); if (t.unref) t.unref(); })]);
  }
}

/**
 * Opens a chat and asks its first question. A CLI that does not know one of the flags is asked again without it, before anything was spent: it refused the
 * command line, so no model call was made. A CLI that does not know `--input-format` cannot keep a chat, and the caller is told so.
 */
async function openWarm({ cliPath, pat, configDir, cwd, model, thinking, thinkingLevel, prompt, signal = null, onDelta = () => {}, log = () => {}, timeoutMs = CHAT_TIMEOUT_MS }) {
  let args = warmArgs({ configDir, model, thinking, thinkingLevel });
  let lastError = null;
  for (let attempt = 0; attempt < MAX_ARG_TRIES; attempt += 1) {
    const chat = new WarmChat({ cliPath, pat, args, cwd, log });
    try {
      const out = await chat.ask(prompt, { signal, onDelta, timeoutMs });
      return { chat, out, alive: chat.alive() };
    } catch (error) {
      lastError = error;
      await chat.close();
      if (error.refusedFlag) {
        if (error.refusedFlag === '--input-format') throw unsupported(redact(error.message, pat));
        log(`qoder cli: this CLI does not know ${error.refusedFlag}; asking again without it`);
        args = dropFlag(args, error.refusedFlag);
        continue;
      }
      if (error.refusedFormat) {
        log('qoder cli: this CLI does not stream JSON; asking again for the plain envelope');
        args = jsonOutput(args);
        continue;
      }
      throw error;
    }
  }
  throw lastError || Object.assign(new Error('The Qoder CLI would not accept the request.'), { retryable: false });
}

module.exports = { WarmChat, openWarm, warmArgs };
