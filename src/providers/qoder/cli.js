/**
 * The official Qoder CLI, driven one request at a time.
 *
 * Qoder's model server cannot be called with a personal access token from outside its own client: the catalog and the model calls are signed by the CLI's
 * own handshake. The CLI is the client that is allowed to make them, and it authenticates a personal access token through QODER_PERSONAL_ACCESS_TOKEN.
 * So one completion is one `qoder --print` process: the prompt on stdin, the answer from its JSON output, no built-in tools, and an isolated config folder
 * so no saved login of the person's is read or changed.
 *
 * Nothing here ever puts the token on a command line or in a log. It is handed over in the child's environment only.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const LIST_TIMEOUT_MS = 120000;
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 3000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;
const MIN_KEY_LENGTH = 16;
const MAX_KEY_LENGTH = 4096;

const EXPIRED = 'Qoder refused this personal access token. Make a new one at https://qoder.com/account/integrations, then paste it on the Accounts page.';
const KEY_HINT = 'That does not look like a Qoder personal access token. Make one at https://qoder.com/account/integrations, then paste it here.';
const CLI_MISSING = 'The Qoder CLI is not installed, so Qoder cannot answer. Install it with "npm install -g @qoder-ai/qodercli", then link the token again.';
const UNREACHABLE = 'Qoder could not be reached. Check your connection and try again.';
const EMPTY_MODELS = 'Qoder returned no models this account can use. Check your Qoder plan, then try again.';

const PATHS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin')];

/** A token as the person pastes it: any run of non-space characters of a sane length. The CLI decides whether it is real. */
function cleanKey(value) {
  const key = String(value == null ? '' : value).trim();
  return new RegExp(`^\\S{${MIN_KEY_LENGTH},${MAX_KEY_LENGTH}}$`).test(key) ? key : null;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (_) { return false; }
}

/** The CLI this computer has: an explicit path (tests, a person's own build), QODER_CLI_PATH, or `qoder` on PATH and the usual install folders. */
function findCli(explicit = null) {
  if (explicit) {
    const given = path.resolve(String(explicit));
    return isExecutable(given) ? given : null;
  }
  const named = process.env.ULA_QODER_CLI || process.env.QODER_CLI_PATH;
  if (named) {
    const given = path.resolve(String(named));
    if (isExecutable(given)) return given;
  }
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), ...PATHS].filter(Boolean);
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const name of ['qoder', 'qodercli']) {
      const file = path.join(dir, name);
      if (isExecutable(file)) return file;
    }
  }
  return null;
}

/**
 * The child's environment: the person's shell without anything Qoder Desktop (or another coding agent) put there, one personal access token, and a PATH
 * that still finds the CLI. Qoder Desktop exports its own agent SDK variables, which the CLI refuses as an incomplete SDK call.
 */
function childEnv(pat) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^QODER(CN)?_/i.test(key)) continue;
    if (/^CLAUDE_CODE_/i.test(key) || key === 'CLAUDECODE') continue;
    if (/^GEMINI_/i.test(key)) continue;
    env[key] = value;
  }
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const extra of PATHS) if (!dirs.includes(extra)) dirs.push(extra);
  env.PATH = dirs.join(path.delimiter);
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.QODER_PERSONAL_ACCESS_TOKEN = pat;
  return env;
}

/** The token is a secret: it is scrubbed from anything that may be shown or logged. */
function redact(text, pat) {
  const value = String(text == null ? '' : text);
  return pat ? value.split(pat).join('***') : value;
}

/**
 * One CLI process. Resolves with its exit code and output; it never rejects for a failed command, so the caller can read what the CLI said.
 * `onLine` sees stdout line by line as it arrives (the stream-json output), while the whole output is still collected for a fallback.
 */
function runCli({ cliPath, args, env, cwd, input = '', signal = null, timeoutMs = LIST_TIMEOUT_MS, onLine = null }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cliPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ spawnError: error, code: null, signal: null, stdout: '', stderr: '', aborted: false, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let errBytes = 0;
    let tail = '';
    let timedOut = false;
    let aborted = false;
    let done = false;

    const kill = () => {
      try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* already gone */ } }, KILL_GRACE_MS);
      if (timer.unref) timer.unref();
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    if (timer.unref) timer.unref();
    const onAbort = () => { aborted = true; kill(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outBytes += Buffer.byteLength(chunk);
      if (outBytes > MAX_STDOUT_BYTES) { kill(); return; }
      stdout += chunk;
      if (!onLine) return;
      tail += chunk;
      let at = tail.indexOf('\n');
      while (at >= 0) {
        const line = tail.slice(0, at).replace(/\r$/, '');
        tail = tail.slice(at + 1);
        try { onLine(line); } catch (_) { /* a line that does not parse is skipped, never fatal */ }
        at = tail.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errBytes += Buffer.byteLength(chunk);
      if (errBytes <= MAX_STDERR_BYTES) stderr += chunk;
    });
    child.on('error', (error) => finish({ spawnError: error, code: null, signal: null, stdout, stderr, aborted, timedOut }));
    child.on('close', (code, sig) => {
      if (tail && onLine) { try { onLine(tail.replace(/\r$/, '')); } catch (_) { /* ignored */ } }
      finish({ code, signal: sig, stdout, stderr, aborted, timedOut });
    });
    try {
      child.stdin.on('error', () => { /* the CLI may exit before reading it */ });
      child.stdin.end(input);
    } catch (_) { /* the process is already gone; its close event says why */ }
  });
}

/** The first line of an error that says something, without the CLI's "An unexpected critical error occurred:" wrapper. */
function usefulLine(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const line = lines.find((candidate) => !/^at\s/.test(candidate) && !/^Node\.js v/i.test(candidate)) || '';
  return line.replace(/^An unexpected critical error occurred:\s*/i, '').replace(/^[A-Za-z]*Error:\s*/, '').slice(0, 600);
}

const AUTH = /token that was rejected|not logged in|authentication[_ ]failed|invalid[_ ]token|token[_ ]expired|unauthorized|qoderauth|\b401\b/i;
const RATE = /rate limit|too many requests|\b429\b/i;
const BILLING = /billing[_ ]error|out of credits|credits? (?:are )?(?:used up|exhausted)|quota exceeded|free trial|limit reached/i;
const NETWORK = /fetch failed|network|econn|enotfound|etimedout|socket hang up|connection (?:closed|reset)|getaddrinfo/i;
const MODEL = /invalid model|model not found|no such model/i;
const TOO_LONG = /max[_ ]output[_ ]tokens|max[_ ]tokens|\blength\b/i;

/** How a failed CLI run is told apart: a refused login, a rate limit, a billing limit, a bad model, an unreachable host, or a plain refusal. */
function describeFailure(result, pat) {
  if (result.spawnError) {
    const code = result.spawnError.code;
    if (code === 'ENOENT') return Object.assign(new Error(CLI_MISSING), { retryable: false, cliMissing: true });
    return Object.assign(new Error(redact(`The Qoder CLI could not be started${code ? ` (${code})` : ''}.`, pat)), { retryable: false });
  }
  if (result.timedOut) return Object.assign(new Error('The Qoder CLI did not answer in time.'), { retryable: true, timedOut: true });
  if (result.aborted) return Object.assign(new Error('The caller left before Qoder answered.'), { cancelled: true, retryable: true });
  const said = redact(usefulLine(result.stderr) || usefulLine(result.stdout), pat);
  if (AUTH.test(said)) return Object.assign(new Error(EXPIRED), { authExpired: true, status: 401, retryable: false });
  if (RATE.test(said)) return Object.assign(new Error('Qoder is rate limiting this account. Requests are paused; nothing is retried.'), { rateLimited: true, cooldownMs: 60000, status: 429, retryable: false });
  if (BILLING.test(said)) return Object.assign(new Error(`Qoder refused this request: ${said || 'the account allowance is used up.'}`), { status: 402, retryable: false });
  if (MODEL.test(said)) return Object.assign(new Error(said), { status: 400, retryable: false });
  if (NETWORK.test(said)) return Object.assign(new Error(UNREACHABLE), { retryable: true });
  return Object.assign(new Error(`Qoder refused the request: ${said || `the CLI exited with code ${result.code}.`}`), { retryable: false, status: result.code ? 400 : 502 });
}

/**
 * The model list as text: a MODEL header, then `Display Name (modelKey)` for a model the account defines and `Display Name` for one Qoder defines. A key
 * the CLI shortened with an ellipsis is not usable as a model name, so that row falls back to its display name.
 */
function parseModelList(text) {
  const rows = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^model$/i.test(line)) continue;
    if (/^(failed|error|not logged in|warning)\b/i.test(line)) continue;
    const match = /^(.*?)\s*\(([^()]*)\)$/.exec(line);
    const name = (match ? match[1] : line).trim();
    const key = match ? match[2].trim() : '';
    if (!name) continue;
    const usable = Boolean(key) && key.length <= 40 && !key.includes('…') && !key.includes('...');
    const id = `${name}\u0000${usable ? key : ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ name, key: usable ? key : null, ref: usable ? key : name });
  }
  return rows;
}

/** Asks the CLI for the models this token can call. Throws the classified error when it cannot list them. */
async function listModels({ cliPath, pat, configDir, signal = null }) {
  const result = await runCli({
    cliPath,
    args: ['--list-models', '--config-dir', configDir],
    env: childEnv(pat),
    cwd: configDir,
    signal,
    timeoutMs: LIST_TIMEOUT_MS
  });
  if (result.code !== 0 || result.aborted || result.timedOut || result.spawnError) throw describeFailure(result, pat);
  const rows = parseModelList(result.stdout);
  if (!rows.length) {
    const said = redact(usefulLine(result.stderr), pat);
    throw Object.assign(new Error(said && !/^MODEL$/i.test(said) ? `${EMPTY_MODELS} (${said})` : EMPTY_MODELS), { retryable: false, empty: true });
  }
  return rows;
}

function effortArgs(thinking, thinkingLevel) {
  const level = String(thinkingLevel || '').toLowerCase().trim();
  if (level === 'none') return ['--thinking', 'disabled'];
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) return ['--reasoning-effort', level];
  if (thinking === true) return ['--thinking', 'enabled'];
  return [];
}

/** The answer text so far, then what is new in `next`: a stream repeats nothing, and a whole message is not appended twice. */
function newText(previous, next) {
  if (!next || next === previous) return '';
  if (next.startsWith(previous)) return next.slice(previous.length);
  if (previous.endsWith(next)) return '';
  return next;
}

/** The final result's text wins over the streamed one, but only the part not streamed already is sent. */
function mergeFinal(streamed, final) {
  if (!final) return { text: streamed, added: '' };
  if (!streamed) return { text: final, added: final };
  if (final.startsWith(streamed)) return { text: final, added: final.slice(streamed.length) };
  if (streamed.startsWith(final)) return { text: streamed, added: '' };
  return { text: final, added: '' };
}

function envelopeFailure(data, pat) {
  const code = data && data.error_code;
  const said = redact(String((data && data.result) || ''), pat).trim();
  if (code === 'max_output_tokens') return Object.assign(new Error(said || 'The answer reached the model output limit.'), { truncatedOnly: true });
  if (code === 'authentication_failed' || AUTH.test(said)) return Object.assign(new Error(EXPIRED), { authExpired: true, status: 401, retryable: false });
  if (code === 'rate_limit' || RATE.test(said)) return Object.assign(new Error('Qoder is rate limiting this account. Requests are paused; nothing is retried.'), { rateLimited: true, cooldownMs: 60000, status: 429, retryable: false });
  if (code === 'billing_error' || BILLING.test(said)) return Object.assign(new Error(`Qoder refused this request: ${said || 'the account allowance is used up.'}`), { status: 402, retryable: false });
  if (MODEL.test(said)) return Object.assign(new Error(said), { status: 400, retryable: false });
  return Object.assign(new Error(`Qoder stopped the answer: ${said || 'it did not say why.'}`), { retryable: false });
}

/** One line of the stream-json output, folded into the answer and the thinking as it arrives. */
function streamReader(pat, onDelta) {
  const state = { answer: '', thinking: '', result: null, error: null, stopReason: '', streamed: false };
  const delta = (kind, text) => {
    if (typeof text !== 'string' || !text) return;
    if (kind === 'answer') state.answer += text;
    else state.thinking += text;
    state.streamed = true;
    onDelta({ type: kind, text });
  };
  const whole = (kind, text) => {
    if (typeof text !== 'string' || !text) return;
    const current = kind === 'answer' ? state.answer : state.thinking;
    const added = newText(current, text);
    if (!added) return;
    if (kind === 'answer') state.answer += added;
    else state.thinking += added;
    state.streamed = true;
    onDelta({ type: kind, text: added });
  };
  const take = (line) => {
    const text = String(line || '').trim();
    if (!text) return;
    let event;
    try { event = JSON.parse(text); } catch (_) { return; }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'stream_event' && event.event && typeof event.event === 'object') {
      const inner = event.event;
      if (inner.type === 'content_block_delta' && inner.delta && typeof inner.delta === 'object') {
        if (inner.delta.type === 'text_delta') delta('answer', inner.delta.text);
        else if (inner.delta.type === 'thinking_delta') delta('think', inner.delta.thinking);
      } else if (inner.type === 'content_block_start' && inner.content_block && inner.content_block.type === 'text') {
        whole('answer', inner.content_block.text);
      } else if (inner.type === 'message_delta' && inner.delta && typeof inner.delta.stop_reason === 'string' && inner.delta.stop_reason) {
        state.stopReason = inner.delta.stop_reason;
      }
      return;
    }
    if (event.type === 'assistant' && event.message && typeof event.message === 'object') {
      for (const block of Array.isArray(event.message.content) ? event.message.content : []) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') whole('answer', block.text);
        else if (block.type === 'thinking') whole('think', block.thinking);
      }
      if (typeof event.message.stop_reason === 'string' && event.message.stop_reason) state.stopReason = event.message.stop_reason;
      return;
    }
    if (event.type === 'result') { state.result = event; return; }
    if (event.type === 'error' || event.type === 'error_notification') state.error = event;
  };
  const finish = () => {
    if (state.error && !state.result) {
      const said = redact(usefulLine(state.error.message || state.error.error || JSON.stringify(state.error)), pat);
      throw Object.assign(new Error(`Qoder stopped the answer: ${said || 'it did not say why.'}`), { retryable: false });
    }
    const data = state.result;
    if (!data) {
      if (state.answer.trim()) return { ok: true, text: state.answer, thinking: state.thinking, stopReason: state.stopReason || null, truncated: false, usage: null };
      throw Object.assign(new Error('The Qoder CLI ended without an answer.'), { retryable: true });
    }
    if (data.is_error === true || data.subtype === 'error') {
      const error = envelopeFailure(data, pat);
      if (error.truncatedOnly) {
        return { ok: true, text: state.answer, thinking: state.thinking, stopReason: 'max_tokens', truncated: true, usage: data.usage || null };
      }
      throw error;
    }
    const merged = mergeFinal(state.answer, typeof data.result === 'string' ? data.result : '');
    if (merged.added) onDelta({ type: 'answer', text: merged.added });
    const stop = state.stopReason || data.stop_reason || null;
    return {
      ok: true,
      text: merged.text,
      thinking: state.thinking,
      stopReason: stop,
      truncated: TOO_LONG.test(String(stop || '')),
      usage: data.usage && typeof data.usage === 'object' ? data.usage : null
    };
  };
  return { take, finish };
}

/** The single JSON object `--output-format json` prints, or the last JSON line of a noisy stream. */
function lastJson(text) {
  const whole = String(text || '').trim();
  if (!whole) return null;
  try { const data = JSON.parse(whole); return data && typeof data === 'object' ? data : null; } catch (_) { /* try lines */ }
  const lines = whole.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try { const data = JSON.parse(line); if (data && typeof data === 'object') return data; } catch (_) { /* keep looking */ }
  }
  return null;
}

function dropOption(args, flag) {
  const valued = new Set(['--model', '--config-dir', '--output-format', '--tools', '--max-model-request-retries']);
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) { if (valued.has(flag)) i += 1; continue; }
    out.push(args[i]);
  }
  return out;
}

/**
 * One completion through the CLI. It asks for stream-json with partial messages when the CLI knows them, so the answer and the thinking stream as they come;
 * a CLI that refuses those flags is asked again for the plain JSON envelope. An unknown option is dropped and the same request is sent once more: the CLI
 * refused it before any model call, so nothing is spent twice.
 */
async function chat({ cliPath, pat, configDir, model, prompt, thinking, thinkingLevel, signal = null, onDelta = () => {}, log = () => {} }) {
  const started = Date.now();
  let firstOutputAt = 0;
  let args = [
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--model', model,
    '--tools', '',
    '--config-dir', configDir,
    '--no-session-persistence',
    '--max-model-request-retries', '0',
    ...effortArgs(thinking, thinkingLevel)
  ];
  const at = (flag) => (args.includes(flag) ? ` ${args[args.indexOf(flag) + 1]}` : '');
  log(`qoder cli: model ${model}, ${args.includes('--reasoning-effort') ? `effort${at('--reasoning-effort')}` : args.includes('--thinking') ? `thinking${at('--thinking')}` : 'thinking as the CLI chooses'}`);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const streaming = args.includes('stream-json');
    const reader = streaming ? streamReader(pat, onDelta) : null;
    const onLine = (text) => {
      if (!firstOutputAt) {
        firstOutputAt = Date.now();
        log(`qoder cli: its first output came after ${firstOutputAt - started}ms`);
      }
      if (reader) reader.take(text);
    };
    const result = await runCli({
      cliPath,
      args,
      env: childEnv(pat),
      cwd: configDir,
      input: prompt,
      signal,
      timeoutMs: CHAT_TIMEOUT_MS,
      onLine
    });
    if (result.aborted) throw Object.assign(new Error('The caller left before Qoder answered.'), { cancelled: true });
    if (result.timedOut) throw Object.assign(new Error('Qoder did not answer within ten minutes.'), { retryable: true, timedOut: true });
    if (result.spawnError) throw describeFailure(result, pat);

    if (result.code === 0) {
      if (reader) return reader.finish();
      const data = lastJson(result.stdout);
      if (!data) {
        const said = redact(usefulLine(result.stderr), pat);
        throw Object.assign(new Error(`Qoder answered in a shape this bridge does not read.${said ? ` ${said}` : ''}`), { retryable: true });
      }
      if (data.type !== 'result') throw Object.assign(new Error('Qoder answered with something other than a result. Nothing was guessed.'), { retryable: true });
      if (data.is_error === true || data.subtype === 'error') {
        const error = envelopeFailure(data, pat);
        if (error.truncatedOnly) return { ok: true, text: '', thinking: '', stopReason: 'max_tokens', truncated: true, usage: data.usage || null };
        throw error;
      }
      const text = typeof data.result === 'string' ? data.result : '';
      if (text) onDelta({ type: 'answer', text });
      const stop = data.stop_reason || null;
      return { ok: true, text, thinking: '', stopReason: stop, truncated: TOO_LONG.test(String(stop || '')), usage: data.usage || null };
    }

    // A flag this CLI version does not know: drop it and ask again before anything was spent.
    if (!reader?.streamed) {
      const unknown = /unknown option '([^']+)'/i.exec(result.stderr) || /unknown option "([^"]+)"/i.exec(result.stderr);
      if (unknown && args.includes(unknown[1])) { args = dropOption(args, unknown[1]); continue; }
      if (/stream-json/i.test(args.join(' ')) && /(allowed choices|invalid (?:value|choice)).{0,80}(json|text)/i.test(result.stderr)) {
        args = args.map((arg, index) => (args[index - 1] === '--output-format' ? 'json' : arg)).filter((arg) => arg !== '--include-partial-messages');
        continue;
      }
    }
    throw describeFailure(result, pat);
  }
  throw Object.assign(new Error('The Qoder CLI would not accept the request.'), { retryable: false });
}

module.exports = {
  LIST_TIMEOUT_MS, CHAT_TIMEOUT_MS, EXPIRED, KEY_HINT, CLI_MISSING, UNREACHABLE, EMPTY_MODELS,
  cleanKey, findCli, childEnv, redact, runCli, parseModelList, listModels, effortArgs, chat
};
