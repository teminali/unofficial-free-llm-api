/**
 * Other APIs in front of the same engine: Anthropic's Messages API (`POST /v1/messages`, `POST /v1/messages/count_tokens`) and OpenAI's Responses API
 * (`POST /v1/responses`). Each is a translation: the request becomes a chat completion request, the engine answers it as it answers any other (the same
 * governor, the same sessions, the same tool bridge), and what it streams back is written in the shape the caller expects.
 *
 * The engine writes to a response object, so the engine is given a stand-in (`capture`) that reads its server-sent chunks as they come and hands them to the
 * translation. The engine is always asked to stream, whatever the caller asked: a caller that did not ask for a stream gets the finished message.
 *
 * Only what a text chat with tool calls can honour is honoured; the rest is accepted and ignored, as on /v1/chat/completions (docs/api.md).
 */
'use strict';

const crypto = require('crypto');
const B = require('./bridge');

const id = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const estimateTokens = (chars) => Math.ceil(Number(chars || 0) / 4);

// ---- the engine's stand-in for a response ---------------------------------------------------------------------------------------------------------

/**
 * A response object the engine can write to: it reads the chat completion chunks the engine streams and calls `handlers`:
 *   head(status, headers)   the engine answered with this status (a refusal before any stream is a plain JSON error)
 *   delta({ content, reasoning, calls })   calls: [{ id, name, arguments }]
 *   finish(reason)          the model finished (`stop`, `tool_calls`, `length`)
 *   usage(usage)            the usage chunk
 *   error(error)            an error event inside the stream, { message, type, code }
 *   plain(status, body)     a JSON answer that is not a stream (an error), parsed
 * `closed()` tells the stand-in the caller left, so the engine stops. `retryAfter` is the Retry-After the engine put on a refusal.
 */
function capture(handlers) {
  const listeners = [];
  const shim = {
    statusCode: 200,
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    setHeader() {},
    writeHead(status, headers = {}) {
      shim.statusCode = status;
      shim.headersSent = true;
      shim.type = String(headers['Content-Type'] || headers['content-type'] || '');
      shim.retryAfter = headers['Retry-After'] || headers['retry-after'] || null;
    },
    on(event, fn) { if (event === 'close') listeners.push(fn); return shim; },
    off(event, fn) { const at = listeners.indexOf(fn); if (event === 'close' && at >= 0) listeners.splice(at, 1); return shim; },
    closed() { shim.destroyed = true; for (const fn of listeners.slice()) fn(); }
  };
  let buffer = '';
  let plain = '';
  const frame = (text) => {
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    if (!line) return;
    const data = line.slice(6);
    if (data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch (_) { return; }
    if (event.error) { handlers.error(event.error); return; }
    if (event.usage) handlers.usage(event.usage);
    const choice = event.choices && event.choices[0];
    if (!choice) return;
    const d = choice.delta || {};
    const calls = (d.tool_calls || []).map((c) => ({ id: c.id, name: c.function && c.function.name, arguments: (c.function && c.function.arguments) || '' }));
    if (d.content || d.reasoning_content || calls.length) handlers.delta({ content: d.content || '', reasoning: d.reasoning_content || '', calls });
    if (choice.finish_reason) handlers.finish(choice.finish_reason);
  };
  shim.write = (chunk) => {
    if (!/text\/event-stream/.test(shim.type)) { plain += String(chunk); return true; }
    buffer += String(chunk);
    let at;
    while ((at = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, at); buffer = buffer.slice(at + 2); frame(block); }
    return true;
  };
  shim.end = (chunk) => {
    if (chunk) shim.write(chunk);
    shim.writableEnded = true;
    if (!/text\/event-stream/.test(shim.type)) {
      let body = null;
      try { body = JSON.parse(plain); } catch (_) { body = null; }
      handlers.plain(shim.statusCode, body);
    } else if (buffer.trim()) { frame(buffer); buffer = ''; }
    handlers.end();
  };
  return shim;
}

/**
 * Runs the engine on a chat completion body and gives the caller what came back as one object (for a caller that wants a finished message) while telling
 * `live` about every delta as it arrives (for one that wants a stream). Resolves { status, error, message: { content, reasoning, calls, finish, usage }, result }.
 */
function runEngine({ provider, chatBody, entry, meta, clientRes, live = {} }) {
  return new Promise((resolve) => {
    const message = { content: '', reasoning: '', calls: [], finish: null, usage: null };
    let failure = null;
    let status = 200;
    let started = false;
    const begin = () => { if (!started) { started = true; if (live.start) live.start(); } };
    const shim = capture({
      delta: (d) => {
        begin();
        message.content += d.content;
        message.reasoning += d.reasoning;
        for (const c of d.calls) message.calls.push(c);
        if (live.delta) live.delta(d);
      },
      finish: (reason) => { message.finish = reason; },
      usage: (u) => { message.usage = u; },
      error: (e) => { failure = { status: 502, message: e.message || 'The provider could not answer.', type: e.type, code: e.code }; },
      plain: (code, body) => {
        status = code;
        if (code !== 200) { const e = (body && body.error) || {}; failure = { status: code, message: e.message || `The server answered ${code}.`, type: e.type, code: e.code }; }
      },
      end: () => {}
    });
    if (clientRes) clientRes.on('close', () => { if (!shim.writableEnded) shim.closed(); });
    // The first chunk of a stream carries only the role: the stream is open from then on, even before the first word.
    const body = { ...chatBody, stream: true, stream_options: { include_usage: true } };
    provider.engine.chat(shim, body, entry, meta).then((result) => {
      begin();
      resolve({ status: failure ? failure.status : status, failure, message, result, retryAfter: shim.retryAfter });
    });
  });
}

// ---- Anthropic Messages ---------------------------------------------------------------------------------------------------------------------------

const textOf = (blocks) => (typeof blocks === 'string' ? blocks : (Array.isArray(blocks) ? blocks : []).map((b) => (b && typeof b === 'object' ? (b.type === 'text' ? b.text : (b.type === 'image' ? '[image omitted by the bridge]' : '')) : String(b || ''))).filter(Boolean).join('\n'));

/** The chat completion request an Anthropic Messages request means, or { error }. */
function anthropicToChat(body) {
  if (!Array.isArray(body.messages) || !body.messages.length) return { error: { status: 400, message: '"messages" must be a non-empty array.' } };
  const messages = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const [i, m] of body.messages.entries()) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return { error: { status: 400, message: `messages.${i}.role must be "user" or "assistant".` } };
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const calls = blocks.filter((b) => b && b.type === 'tool_use').map((b) => ({ id: String(b.id || id('toolu')), type: 'function', function: { name: String(b.name || ''), arguments: JSON.stringify(b.input && typeof b.input === 'object' ? b.input : {}) } }));
      messages.push({ role: 'assistant', content: textOf(blocks.filter((b) => b && b.type === 'text')) || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn that answers tool calls: the results come first, each as a tool message, then whatever else the person said.
    for (const b of blocks) if (b && b.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: String(b.tool_use_id || ''), content: (b.is_error ? 'Error: ' : '') + textOf(b.content) });
    const rest = textOf(blocks.filter((b) => b && b.type !== 'tool_result'));
    if (rest) messages.push({ role: 'user', content: rest });
  }
  const tools = Array.isArray(body.tools) ? body.tools.filter((t) => t && t.name).map((t) => ({ type: 'function', function: { name: String(t.name), description: String(t.description || ''), parameters: t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : { type: 'object', properties: {} } } })) : [];
  const budget = body.thinking && body.thinking.type === 'enabled' ? Number(body.thinking.budget_tokens) || 0 : 0;
  const chat = {
    model: body.model,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(body.tool_choice && body.tool_choice.type === 'none' ? { tool_choice: 'none' } : {}),
    ...(budget ? { reasoning_effort: budget <= 2000 ? 'low' : (budget <= 8000 ? 'medium' : 'high') } : (body.thinking && body.thinking.type === 'disabled' ? { reasoning_effort: 'none' } : {})),
    ...(Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? { max_tokens: body.max_tokens } : {}),
    ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length ? { stop: body.stop_sequences.map(String).slice(0, 4) } : {})
  };
  return { chat, tag: body.metadata && typeof body.metadata.user_id === 'string' ? body.metadata.user_id : '' };
}

const ANTHROPIC_ERROR = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 502: 'api_error', 504: 'api_error' };
function anthropicError(status, message) {
  return { type: 'error', error: { type: ANTHROPIC_ERROR[status] || 'api_error', message } };
}
const stopReason = (finish) => (finish === 'tool_calls' ? 'tool_use' : (finish === 'length' ? 'max_tokens' : 'end_turn'));

function parseArguments(text) {
  const parsed = B.parseArgs(text);
  if (parsed) return parsed;
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (_) { return {}; }
}

/** The finished Anthropic message for what the engine answered. */
function anthropicMessage({ model, message, inputTokens }) {
  const content = [];
  if (message.reasoning) content.push({ type: 'thinking', thinking: message.reasoning, signature: '' });
  if (message.content) content.push({ type: 'text', text: message.content });
  for (const c of message.calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: parseArguments(c.arguments) });
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: id('msg'), type: 'message', role: 'assistant', model, content,
    stop_reason: stopReason(message.finish), stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: (message.usage && message.usage.completion_tokens) || estimateTokens(message.content.length + message.reasoning.length) }
  };
}

/** Writes the events of an Anthropic stream as the engine's chunks arrive. */
function anthropicStream(res, { model, inputTokens }) {
  const messageId = id('msg');
  let index = -1;
  let open = null; // 'text' | 'thinking' | 'tool'
  const send = (event, data) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`); };
  const close = () => { if (open) { send('content_block_stop', { index }); open = null; } };
  const begin = (kind, block) => { close(); index += 1; open = kind; send('content_block_start', { index, content_block: block }); };
  return {
    start() {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      send('message_start', { message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } });
    },
    delta(d) {
      if (d.reasoning) { if (open !== 'thinking') begin('thinking', { type: 'thinking', thinking: '', signature: '' }); send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: d.reasoning } }); }
      if (d.content) { if (open !== 'text') begin('text', { type: 'text', text: '' }); send('content_block_delta', { index, delta: { type: 'text_delta', text: d.content } }); }
      for (const c of d.calls) {
        begin('tool', { type: 'tool_use', id: c.id, name: c.name, input: {} });
        send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: c.arguments || '{}' } });
        close();
      }
    },
    finish(message) {
      close();
      send('message_delta', { delta: { stop_reason: stopReason(message.finish), stop_sequence: null }, usage: { output_tokens: (message.usage && message.usage.completion_tokens) || estimateTokens(message.content.length + message.reasoning.length) } });
      send('message_stop', {});
      res.end();
    },
    error(status, message) {
      if (res.destroyed || res.writableEnded) return;
      send('error', anthropicError(status, message));
      res.end();
    }
  };
}

// ---- OpenAI Responses -----------------------------------------------------------------------------------------------------------------------------

const MAX_STORED_RESPONSES = 64;
const STORED_RESPONSE_MS = 30 * 60 * 1000;

/** Responses kept in memory so a caller can send `previous_response_id` and only the new input. Never written anywhere. */
function createResponseStore({ now = Date.now } = {}) {
  const items = new Map();
  return {
    get(responseId) {
      const e = items.get(responseId);
      if (!e) return null;
      if (now() - e.at > STORED_RESPONSE_MS) { items.delete(responseId); return null; }
      return e;
    },
    set(responseId, messages, model) {
      items.set(responseId, { messages, model, at: now() });
      while (items.size > MAX_STORED_RESPONSES) items.delete(items.keys().next().value);
    },
    size: () => items.size
  };
}

const partsText = (content) => (typeof content === 'string' ? content : (Array.isArray(content) ? content : []).map((p) => (p && typeof p === 'object' ? (typeof p.text === 'string' ? p.text : (/image/.test(String(p.type)) ? '[image omitted by the bridge]' : '')) : String(p || ''))).filter(Boolean).join('\n'));

/** The chat completion request an OpenAI Responses request means (with the conversation it continues, when it names one), or { error }. */
function responsesToChat(body, store) {
  const messages = [];
  let base = null;
  if (body.previous_response_id) {
    base = store.get(String(body.previous_response_id));
    if (!base) return { error: { status: 404, code: 'previous_response_not_found', message: 'previous_response_id is not known here (responses are kept in memory for a short while only). Send the whole conversation as "input" instead.' } };
    messages.push(...base.messages);
  }
  if (body.instructions && !base) messages.push({ role: 'system', content: String(body.instructions) });
  const input = body.input;
  if (typeof input === 'string') messages.push({ role: 'user', content: input });
  else if (Array.isArray(input)) {
    let pending = null; // an assistant message that function calls attach to
    const flush = () => { if (pending) { messages.push(pending); pending = null; } };
    for (const item of input) {
      if (typeof item === 'string') { flush(); messages.push({ role: 'user', content: item }); continue; }
      if (!item || typeof item !== 'object') continue;
      const type = item.type || (item.role ? 'message' : '');
      if (type === 'message') {
        flush();
        const role = item.role === 'developer' ? 'system' : item.role;
        if (!['system', 'user', 'assistant'].includes(role)) return { error: { status: 400, code: 'invalid_messages', message: `input item with role "${item.role}" is not supported.` } };
        messages.push({ role, content: partsText(item.content) });
      } else if (type === 'function_call') {
        if (!pending) pending = { role: 'assistant', content: null, tool_calls: [] };
        pending.tool_calls.push({ id: String(item.call_id || item.id || id('call')), type: 'function', function: { name: String(item.name || ''), arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) } });
      } else if (type === 'function_call_output') {
        flush();
        messages.push({ role: 'tool', tool_call_id: String(item.call_id || ''), content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') });
      } // a reasoning item, a web search call and the rest have no place in a text chat
    }
    flush();
  } else return { error: { status: 400, code: 'invalid_messages', message: '"input" must be a string or an array.' } };
  if (!messages.some((m) => m.role !== 'system')) return { error: { status: 400, code: 'invalid_messages', message: '"input" must hold at least one message.' } };
  const tools = Array.isArray(body.tools) ? body.tools.filter((t) => t && t.type === 'function' && t.name).map((t) => ({ type: 'function', function: { name: String(t.name), description: String(t.description || ''), parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} } } })) : [];
  const effort = body.reasoning && body.reasoning.effort;
  const chat = {
    model: body.model,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(body.tool_choice === 'none' ? { tool_choice: 'none' } : {}),
    ...(['none', 'low', 'medium', 'high', 'minimal'].includes(effort) ? { reasoning_effort: effort } : {}),
    ...(Number.isInteger(body.max_output_tokens) && body.max_output_tokens > 0 ? { max_tokens: body.max_output_tokens } : {}),
    ...(body.text && body.text.format && body.text.format.type && body.text.format.type !== 'text' ? { response_format: { type: body.text.format.type, ...(body.text.format.type === 'json_schema' ? { json_schema: { name: body.text.format.name, schema: body.text.format.schema } } : {}) } } : {})
  };
  return { chat, tag: typeof body.user === 'string' ? body.user : '' };
}

function responseObject({ responseId, model, message, status = 'completed', createdAt, inputTokens }) {
  const output = [];
  if (message.reasoning) output.push({ type: 'reasoning', id: id('rs'), summary: [{ type: 'summary_text', text: message.reasoning }] });
  if (message.content || !message.calls.length) output.push({ type: 'message', id: id('msg'), status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: message.content, annotations: [] }] });
  for (const c of message.calls) output.push({ type: 'function_call', id: id('fc'), call_id: c.id, name: c.name, arguments: c.arguments || '{}', status: 'completed' });
  const out = (message.usage && message.usage.completion_tokens) || estimateTokens(message.content.length + message.reasoning.length);
  const reasoningTokens = estimateTokens(message.reasoning.length);
  return {
    id: responseId, object: 'response', created_at: createdAt, status, model, output, parallel_tool_calls: true, tool_choice: 'auto', tools: [],
    usage: { input_tokens: inputTokens, output_tokens: out, total_tokens: inputTokens + out, output_tokens_details: { reasoning_tokens: reasoningTokens }, input_tokens_details: { cached_tokens: 0 } }
  };
}

/** Writes the events of a Responses stream as the engine's chunks arrive. */
function responsesStream(res, { model, responseId, createdAt }) {
  let seq = 0;
  let outputIndex = -1;
  let item = null; // { kind, id, text, outputIndex, callId, name }
  const send = (type, data) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`); };
  const closeItem = () => {
    if (!item) return;
    const i = item;
    item = null;
    if (i.kind === 'reasoning') {
      send('response.reasoning_summary_text.done', { item_id: i.id, output_index: i.outputIndex, summary_index: 0, text: i.text });
      send('response.reasoning_summary_part.done', { item_id: i.id, output_index: i.outputIndex, summary_index: 0, part: { type: 'summary_text', text: i.text } });
      send('response.output_item.done', { output_index: i.outputIndex, item: { type: 'reasoning', id: i.id, summary: [{ type: 'summary_text', text: i.text }] } });
    } else if (i.kind === 'message') {
      send('response.output_text.done', { item_id: i.id, output_index: i.outputIndex, content_index: 0, text: i.text });
      send('response.content_part.done', { item_id: i.id, output_index: i.outputIndex, content_index: 0, part: { type: 'output_text', text: i.text, annotations: [] } });
      send('response.output_item.done', { output_index: i.outputIndex, item: { type: 'message', id: i.id, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: i.text, annotations: [] }] } });
    }
  };
  const base = (status) => ({ id: responseId, object: 'response', created_at: createdAt, status, model, output: [] });
  return {
    start() {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      send('response.created', { response: base('in_progress') });
      send('response.in_progress', { response: base('in_progress') });
    },
    delta(d) {
      if (d.reasoning) {
        if (!item || item.kind !== 'reasoning') {
          closeItem();
          outputIndex += 1;
          item = { kind: 'reasoning', id: id('rs'), text: '', outputIndex };
          send('response.output_item.added', { output_index: outputIndex, item: { type: 'reasoning', id: item.id, summary: [] } });
          send('response.reasoning_summary_part.added', { item_id: item.id, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
        }
        item.text += d.reasoning;
        send('response.reasoning_summary_text.delta', { item_id: item.id, output_index: item.outputIndex, summary_index: 0, delta: d.reasoning });
      }
      if (d.content) {
        if (!item || item.kind !== 'message') {
          closeItem();
          outputIndex += 1;
          item = { kind: 'message', id: id('msg'), text: '', outputIndex };
          send('response.output_item.added', { output_index: outputIndex, item: { type: 'message', id: item.id, status: 'in_progress', role: 'assistant', content: [] } });
          send('response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        item.text += d.content;
        send('response.output_text.delta', { item_id: item.id, output_index: item.outputIndex, content_index: 0, delta: d.content });
      }
      for (const c of d.calls) {
        closeItem();
        outputIndex += 1;
        const itemId = id('fc');
        const args = c.arguments || '{}';
        send('response.output_item.added', { output_index: outputIndex, item: { type: 'function_call', id: itemId, call_id: c.id, name: c.name, arguments: '', status: 'in_progress' } });
        send('response.function_call_arguments.delta', { item_id: itemId, output_index: outputIndex, delta: args });
        send('response.function_call_arguments.done', { item_id: itemId, output_index: outputIndex, arguments: args });
        send('response.output_item.done', { output_index: outputIndex, item: { type: 'function_call', id: itemId, call_id: c.id, name: c.name, arguments: args, status: 'completed' } });
      }
    },
    finish(message, inputTokens) {
      closeItem();
      send('response.completed', { response: responseObject({ responseId, model, message, createdAt, inputTokens }) });
      res.end();
    },
    error(status, message, code) {
      if (res.destroyed || res.writableEnded) return;
      send('error', { code: code || 'server_error', message, param: null });
      res.end();
    }
  };
}

module.exports = {
  capture, runEngine, anthropicToChat, anthropicMessage, anthropicStream, anthropicError, responsesToChat, responseObject, responsesStream, createResponseStore,
  stopReason, id, estimateTokens
};
