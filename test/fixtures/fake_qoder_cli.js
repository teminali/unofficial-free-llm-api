#!/usr/bin/env node
/**
 * A stand-in for the official Qoder CLI, for tests only. It answers the two calls the provider makes (`--list-models` and `--print`), records every run
 * (arguments, stdin, working folder, the token it was given), and can fail in each way the real CLI does. Its state lives in the JSON file FAKE_QODER_STATE
 * names, so a test writes the next answer before the next run and reads what happened after it.
 */
'use strict';

const fs = require('fs');

const statePath = process.env.FAKE_QODER_STATE;
if (!statePath) {
  process.stderr.write('FAKE_QODER_STATE is not set.\n');
  process.exit(2);
}

function load() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { return {}; }
}

function save(state) {
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

const state = load();
const args = process.argv.slice(2);
const stdin = (() => { try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; } })();
state.runs = Array.isArray(state.runs) ? state.runs : [];
state.runs.push({
  args,
  stdin,
  cwd: process.cwd(),
  pat: process.env.QODER_PERSONAL_ACCESS_TOKEN || null,
  sdkEntrypoint: process.env.QODER_AGENT_SDK_ENTRYPOINT || null,
  at: Date.now()
});
save(state);

const write = (line) => { try { fs.writeSync(1, `${line}\n`); } catch (_) { process.exit(3); } };
const writeErr = (line) => { try { fs.writeSync(2, `${line}\n`); } catch (_) { /* gone */ } };
const fail = (line, code = 1) => { writeErr(line); process.exit(code); };
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const has = (name) => args.includes(name);

const REJECTED = 'The QODER_PERSONAL_ACCESS_TOKEN environment variable contains a token that was rejected. It overrides any saved login, so unset it or set a valid token, then restart.';

if (state.slowMs) {
  const end = Date.now() + state.slowMs;
  while (Date.now() < end) { /* a slow first run, for a caller that leaves */ }
}

if (has('--include-partial-messages') && state.refusePartial) {
  fail("error: unknown option '--include-partial-messages'");
}

if (flag('--output-format') === 'stream-json' && state.refuseStreamJson) {
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

const format = String(flag('--output-format') || 'json');
const answer = typeof state.answer === 'string' ? state.answer : 'Hello from Qoder.';
const stream = Array.isArray(state.stream) ? state.stream : [{ text: answer }];
const thinking = stream.filter((part) => typeof part.think === 'string').map((part) => part.think).join('');
const text = stream.filter((part) => typeof part.text === 'string').map((part) => part.text).join('');
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  duration_ms: 5,
  duration_api_ms: 4,
  result: text || answer,
  stop_reason: state.stopReason || 'end_turn',
  session_id: 'sess_fake',
  total_cost_usd: 0,
  total_credits: 1,
  usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: {},
  permission_denials: []
};

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

if (format === 'stream-json') {
  write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess_fake' }));
  for (const part of stream) {
    if (typeof part.think === 'string') {
      write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: part.think } } }));
    }
    if (typeof part.text === 'string') {
      write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: part.text } } }));
    }
  }
  write(JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        ...(thinking ? [{ type: 'thinking', thinking }] : []),
        ...(text ? [{ type: 'text', text }] : [])
      ],
      stop_reason: result.stop_reason
    }
  }));
}

write(JSON.stringify(result));
process.exit(0);
