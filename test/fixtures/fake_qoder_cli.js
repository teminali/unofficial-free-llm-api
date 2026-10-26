#!/usr/bin/env node
/**
 * A stand-in for the official Qoder CLI, for tests only. It answers `--list-models` and `--print` in both modes the provider uses: one shot (the whole prompt
 * on stdin, one answer, exit) and warm (`--input-format stream-json`: one line per turn, one answer per turn, the process stays until its input ends). It can
 * fail in each way the real CLI does. Its control state lives in the JSON file FAKE_QODER_STATE names; a JSONL event log next to it
 * (FAKE_QODER_STATE.events) records every run, every turn, every stdin body and every interrupt, so a test can see what was started and what each turn carried.
 */
'use strict';

const fs = require('fs');

const statePath = process.env.FAKE_QODER_STATE;
if (!statePath) {
  process.stderr.write('FAKE_QODER_STATE is not set.\n');
  process.exit(2);
}
const eventsPath = `${statePath}.events`;

function load() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { return {}; }
}

function save(state) {
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

function logEvent(entry) {
  try { fs.appendFileSync(eventsPath, `${JSON.stringify(entry)}\n`); } catch (_) { /* a test that did not ask for events */ }
}

const state = load();
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const has = (name) => args.includes(name);

const warmInput = flag('--input-format') === 'stream-json';
const format = String(flag('--output-format') || 'json');

const write = (line) => { try { fs.writeSync(1, `${line}\n`); } catch (_) { process.exit(3); } };
const writeErr = (line) => { try { fs.writeSync(2, `${line}\n`); } catch (_) { /* gone */ } };
const fail = (line, code = 1) => { writeErr(line); process.exit(code); };

const REJECTED = 'The QODER_PERSONAL_ACCESS_TOKEN environment variable contains a token that was rejected. It overrides any saved login, so unset it or set a valid token, then restart.';

state.runs = Array.isArray(state.runs) ? state.runs : [];
state.runs.push({
  args,
  stdin: null,
  cwd: process.cwd(),
  pat: process.env.QODER_PERSONAL_ACCESS_TOKEN || null,
  sdkEntrypoint: process.env.QODER_AGENT_SDK_ENTRYPOINT || null,
  at: Date.now(),
  pid: process.pid
});
save(state);
logEvent({
  event: 'run',
  pid: process.pid,
  args,
  warm: warmInput,
  cwd: process.cwd(),
  pat: process.env.QODER_PERSONAL_ACCESS_TOKEN || null,
  sdkEntrypoint: process.env.QODER_AGENT_SDK_ENTRYPOINT || null,
  at: Date.now()
});

if (state.slowMs) {
  const end = Date.now() + state.slowMs;
  while (Date.now() < end) { /* a slow first run, for a caller that leaves */ }
}

// The CLI parses its arguments and refuses an unknown one before it reads anything.
if (has('--include-partial-messages') && state.refusePartial) {
  fail("error: unknown option '--include-partial-messages'");
}
if (warmInput && state.refuseInputStream) {
  fail("error: unknown option '--input-format'");
}
if (format === 'stream-json' && state.refuseStreamJson) {
  fail("error: option '--output-format <format>' argument 'stream-json' is invalid. Allowed choices are text, json.");
}

if (has('--list-models')) {
  if (process.env.QODER_PERSONAL_ACCESS_TOKEN !== state.pat) fail(`Failed to fetch model list: ${REJECTED}`);
  if (state.listError === 'network') fail('Failed to fetch model list: fetch failed');
  if (state.listError === 'refused') fail('Failed to fetch model list: permission denied');
  const models = state.listError === 'empty' ? [] : (Array.isArray(state.models) ? state.models : []);
  write('MODEL');
  for (const model of models) {
    if (!model || !model.name) continue;
    write(model.system || !model.key ? model.name : `${model.name} (${model.key})`);
  }
  process.exit(0);
}

if (process.env.QODER_PERSONAL_ACCESS_TOKEN !== state.pat) {
  fail(`An unexpected critical error occurred:QoderAuthError: ${REJECTED}`);
}

const error = state.chatError;
if (error === 'auth') fail(`An unexpected critical error occurred:QoderAuthError: ${REJECTED}`);
if (error === 'rate') fail('Error: 429 Too Many Requests: rate limit exceeded');
if (error === 'billing') fail('Error: billing_error: the account is out of credits');
if (error === 'invalid-model') fail(`Error: Invalid model "${flag('--model')}". Available models: Qoder Max`);
if (error === 'network') fail('Error: fetch failed');
if (error === 'crash') fail('Error: something broke');

/** The answer of turn `n` (1 based): `state.answers`, or the single `state.answer`. */
function answerFor(n) {
  if (Array.isArray(state.answers)) {
    const answer = state.answers[n - 1];
    return typeof answer === 'string' ? answer : String(state.answers[state.answers.length - 1] ?? 'Hello from Qoder.');
  }
  return typeof state.answer === 'string' ? state.answer : 'Hello from Qoder.';
}

/** The streamed parts of turn `n`: `state.streams[n-1]`, or the one `state.stream`, or the whole answer as one part. */
function partsFor(n) {
  if (Array.isArray(state.streams) && Array.isArray(state.streams[n - 1])) return state.streams[n - 1];
  if (Array.isArray(state.stream)) return state.stream;
  return [{ text: answerFor(n) }];
}

function baseResult(n) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: n,
    duration_ms: 5,
    duration_api_ms: 4,
    result: '',
    stop_reason: state.stopReason || 'end_turn',
    session_id: 'sess_fake',
    total_cost_usd: 0,
    total_credits: 1,
    usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    permission_denials: []
  };
}

/** The refusals the real CLI reports inside a result envelope. */
function applyError(result) {
  if (error === 'result-auth') {
    result.is_error = true;
    result.result = REJECTED;
    result.error_code = 'authentication_failed';
  } else if (error === 'result-rate') {
    result.is_error = true;
    result.result = '429 Too Many Requests';
    result.error_code = 'rate_limit';
  } else if (error === 'result-billing') {
    result.is_error = true;
    result.result = 'billing_error: the account is out of credits';
    result.error_code = 'billing_error';
  } else if (error === 'result-truncated') {
    result.stop_reason = 'max_tokens';
  } else if (error === 'result-empty') {
    result.result = '';
  }
}

const systemEvent = () => JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess_fake', uuid: 'uuid_fake', model: flag('--model') || null, capabilities: {} });
const thinkingEvent = (text) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } } });
const textEvent = (text) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } } });
const assistantEvent = (thinking, text, stopReason) => JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      ...(thinking ? [{ type: 'thinking', thinking }] : []),
      ...(text ? [{ type: 'text', text }] : [])
    ],
    stop_reason: stopReason || 'end_turn'
  }
});

if (warmInput) warm();
else oneShot();

function oneShot() {
  const stdin = (() => { try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; } })();
  const now = load();
  const mine = now.runs.find((run) => run.pid === process.pid);
  if (mine) { mine.stdin = stdin; save(now); }
  logEvent({ event: 'stdin', pid: process.pid, text: stdin, at: Date.now() });

  const parts = partsFor(1);
  const thinking = parts.filter((part) => typeof part.think === 'string').map((part) => part.think).join('');
  const text = parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join('');
  const result = baseResult(1);
  result.result = text || answerFor(1);
  applyError(result);

  if (format === 'stream-json') {
    write(systemEvent());
    for (const part of parts) {
      if (typeof part.think === 'string') write(thinkingEvent(part.think));
      if (typeof part.text === 'string') write(textEvent(part.text));
    }
    write(assistantEvent(thinking, text, result.stop_reason));
  }
  write(JSON.stringify(result));
  process.exit(0);
}

function warm() {
  let turns = 0;
  let inflight = null; // { n, timer }
  if (format === 'stream-json') write(systemEvent());

  const interrupt = (requestId) => {
    logEvent({ event: 'interrupt', pid: process.pid, request_id: requestId, at: Date.now() });
    write(JSON.stringify({ type: 'control_response', subtype: 'success', request_id: requestId, response: { still_queued: [] } }));
    if (!inflight) return; // a turn that already ended is not ended again, like the real CLI
    const n = inflight.n;
    clearTimeout(inflight.timer);
    inflight = null;
    const result = baseResult(n);
    result.is_error = true;
    result.subtype = 'error_during_execution';
    result.result = '';
    write(JSON.stringify(result));
  };

  const emit = (n) => {
    const parts = partsFor(n);
    const thinking = parts.filter((part) => typeof part.think === 'string').map((part) => part.think).join('');
    const text = parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join('');
    const result = baseResult(n);
    result.result = text || answerFor(n);
    applyError(result);
    if (format !== 'stream-json') {
      write(JSON.stringify(result));
      return;
    }
    inflight = { n, timer: null };
    let i = 0;
    const delay = Math.max(0, Number(state.partDelayMs) || 0);
    const dieAfter = Number(state.dieAfterParts) || 0;
    const dieOn = Number(state.dieAfterPartsOnTurn) || 0;
    const step = () => {
      if (!inflight || inflight.n !== n) return;
      if (dieAfter && (!dieOn || dieOn === n) && i >= dieAfter) process.exit(9);
      if (i >= parts.length) {
        write(assistantEvent(thinking, text, result.stop_reason));
        inflight = null;
        write(JSON.stringify(result));
        if (state.exitAfterTurn) setTimeout(() => process.exit(0), Number(state.exitAfterTurn)).unref();
        return;
      }
      const part = parts[i];
      i += 1;
      if (typeof part.think === 'string') write(thinkingEvent(part.think));
      else if (typeof part.text === 'string') write(textEvent(part.text));
      if (delay > 0) inflight.timer = setTimeout(step, delay);
      else step();
    };
    step();
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (_) { continue; }
      if (message && message.type === 'control_request' && message.request && message.request.subtype === 'interrupt') {
        interrupt(message.request_id);
        continue;
      }
      if (!message || message.type !== 'user') continue;
      turns += 1;
      const content = message.message && message.message.content;
      const prompt = typeof content === 'string'
        ? content
        : (Array.isArray(content) ? content.filter((block) => block && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('') : '');
      logEvent({ event: 'turn', pid: process.pid, n: turns, text: prompt, at: Date.now() });
      if (state.dieOnTurn === turns) process.exit(9);
      emit(turns);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
}
