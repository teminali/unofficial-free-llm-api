/**
 * One Bike4Mind completion: the prompt as one user message (with pictures attached), the client's tools offered natively, and the SSE stream turned into the
 * answer the chat engine expects.
 *
 * Bike4Mind's API has no `tool` role, so a tool result cannot be sent back as a tool message. The prompt is the bridge transcript (USER/ASSISTANT/TOOL RESULT),
 * while the tools themselves are offered natively: a native `tool_use` event is written back as a `<tool_call>` block, which parseAnswer already reads, and the
 * next request carries the tool result in the transcript like every other provider's.
 *
 * The stream's `content` events may carry a delta or the whole answer so far, and `thinking` arrives as blocks; both are reduced to what is new. Nothing but
 * statuses is logged: never a prompt, an answer or the key.
 */
'use strict';

const { COMPLETIONS, authHeaders, httpError, streamError, readEvents, resolveBase } = require('./api');

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_B64 = 20 * 1024 * 1024; // the API refuses a body over 25 MB; base64 is a third larger than the bytes
const LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

/** The part of `next` that was not already in `prev`, whether the stream sends deltas or the whole text so far. */
function newText(prev, next) {
  if (!next || next === prev) return '';
  if (next.startsWith(prev)) return next.slice(prev.length);
  if (prev.endsWith(next)) return '';
  return next;
}

function thinkingText(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : '';
  return blocks.map((block) => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return '';
    if (typeof block.thinking === 'string') return block.thinking;
    if (typeof block.text === 'string') return block.text;
    return '';
  }).join('');
}

function toolSchema(fn) {
  const parameters = fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} };
  return {
    toolSchema: {
      name: fn.name,
      description: String(fn.description || ''),
      parameters: parameters.type ? parameters : { type: 'object', ...parameters },
      ...(fn.strict === true ? { strict: true } : {})
    }
  };
}

function argumentText(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value && typeof value === 'object' ? value : {}); } catch (_) { return '{}'; }
}

/** One native tool call as the bridge text parseAnswer reads. Arguments stay a JSON string, as the engine's own calls do. */
function callBlock(name, args) {
  return `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
}

/**
 * The pictures the model can take, as OpenAI image parts. A picture the API would refuse (too many, too large, or a model without vision) is left out and
 * said so in the prompt, never silently dropped.
 */
function pictureParts(images, supportsVision, note) {
  if (!Array.isArray(images) || !images.length) return [];
  if (supportsVision === false) {
    note.push(`This model does not take pictures, so ${images.length === 1 ? 'the picture was' : `${images.length} pictures were`} left out.`);
    return [];
  }
  const parts = [];
  let b64 = 0;
  let left = 0;
  for (const pic of images) {
    const base64 = pic && pic.bytes ? pic.bytes.toString('base64') : '';
    if (!base64) continue;
    if (parts.length >= MAX_IMAGES || pic.bytes.length > MAX_IMAGE_BYTES || b64 + base64.length > MAX_IMAGES_B64) { left += 1; continue; }
    b64 += base64.length;
    parts.push({ type: 'image_url', image_url: { url: `data:${pic.mime || 'image/png'};base64,${base64}` } });
  }
  if (left) note.push(`${left} picture${left === 1 ? ' was' : 's were'} left out because of the size limit.`);
  return parts;
}

function createBike4MindWeb({ base = resolveBase(), account, log = () => {} } = {}) {
  async function completeOnce({ prompt, images, tools, temperature, thinking, thinkingLevel, signal, model, onDelta = () => {} }) {
    let key;
    try { key = account.getKey().key; } catch (error) {
      return { ok: false, sent: false, retryable: false, error: error.message, ...(error.authExpired ? { authExpired: true } : {}) };
    }
    const info = account.modelInfo(model);
    const offered = Array.isArray(tools) ? tools.map((t) => (t && t.function ? t.function : t)).filter((f) => f && typeof f.name === 'string' && f.name) : [];
    if (offered.length && info && info.supportsTools === false) {
      return { ok: false, sent: false, retryable: false, error: `The Bike4Mind model "${model}" does not call tools. Choose a model on the Accounts page that does.` };
    }

    const note = [];
    const parts = pictureParts(images, info ? info.supportsVision : undefined, note);
    const text = note.length ? `${prompt}\n\nNOTE: ${note.join(' ')}` : prompt;
    const options = {};
    const level = String(thinkingLevel || '').toLowerCase();
    if (LEVELS.has(level)) options.reasoningEffort = level;
    if (thinking === true) options.thinking = { enabled: true };
    const temp = Number(temperature);
    if (Number.isFinite(temp) && temp >= 0 && temp <= 2) options.temperature = temp;

    const body = {
      model,
      messages: [{ role: 'user', content: parts.length ? [{ type: 'text', text }, ...parts] : text }],
      ...(offered.length ? { tools: offered.map(toolSchema) } : {}),
      ...(Object.keys(options).length ? { options } : {})
    };

    let sent = false;
    let answer = '';
    let thoughts = '';
    let stopReason = '';
    let usage = null;
    let credits = null;
    const calls = new Map();
    const takeEvent = (event) => {
      if (event && typeof event.stopReason === 'string' && event.stopReason) stopReason = event.stopReason;
      if (event && event.usage && typeof event.usage === 'object') usage = event.usage;
      if (event && event.credits && typeof event.credits === 'object') credits = event.credits;
      const thought = thinkingText(event && event.thinking);
      if (thought) {
        const added = newText(thoughts, thought);
        if (added) { thoughts += added; onDelta({ type: 'think', text: added }); }
      }
      if (event && typeof event.text === 'string' && event.text) {
        const added = newText(answer, event.text);
        if (added) { answer += added; onDelta({ type: 'answer', text: added }); }
      }
      if (event && Array.isArray(event.tools)) {
        for (const tool of event.tools) {
          if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
          const args = argumentText(tool.arguments);
          const id = typeof tool.id === 'string' && tool.id ? tool.id : `${tool.name}\u0000${args}`;
          const before = calls.get(id);
          // A tool event may repeat the whole call or add to its arguments; either way the map keeps one call per id, in first-seen order.
          calls.set(id, { name: tool.name, arguments: before ? before.arguments + newText(before.arguments, args) : args });
        }
      }
    };

    const fail = (error) => {
      account.failure(error);
      log(`bike4mind: ${error.status ? `HTTP ${error.status}` : 'request failed'}${error.code ? ` (${error.code})` : ''}`);
      return {
        ok: false, sent, cancelled: Boolean(error.cancelled),
        error: error.message || 'Bike4Mind could not answer.',
        retryable: error.retryable,
        ...(error.authExpired ? { authExpired: true } : {}),
        ...(error.rateLimited ? { rateLimited: true, cooldownMs: error.cooldownMs, retryAfterSec: Math.ceil((error.cooldownMs || 0) / 1000) } : {}),
        ...(error.verificationRequired ? { verificationRequired: true } : {}),
        thinking: thoughts
      };
    };

    try {
      sent = true;
      const response = await fetch(`${base}${COMPLETIONS}`, {
        method: 'POST',
        headers: authHeaders(key, { accept: 'text/event-stream' }),
        body: JSON.stringify(body),
        signal,
        redirect: 'error'
      });
      if (!response.ok) {
        const raw = await response.text();
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
        return fail(httpError(response.status, data, response.headers.get('retry-after')));
      }
      for await (const data of readEvents(response)) {
        if (data === '[DONE]') break;
        let event;
        try { event = JSON.parse(data); } catch (_) { continue; }
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'error') return fail(streamError(event));
        if (event.type === 'content' || event.type === 'tool_use' || event.stopReason || event.usage || event.credits) takeEvent(event);
      }
    } catch (error) {
      if ((signal && signal.aborted) || (error && error.name === 'AbortError')) {
        return { ok: false, sent, cancelled: true, thinking: thoughts };
      }
      return fail(error);
    }

    if (credits && Number.isFinite(credits.used) && credits.used > 0) account.spendCredits(credits.used);
    const blocks = [...calls.values()].map((call) => callBlock(call.name, call.arguments));
    const out = blocks.length ? `${answer}${answer ? '\n\n' : ''}${blocks.join('\n')}` : answer;
    return {
      ok: true, sent: true, text: out, thinking: thoughts,
      truncated: stopReason === 'max_tokens' || stopReason === 'length',
      stopReason: stopReason || null, usage, credits
    };
  }

  return { images: true, completeOnce };
}

module.exports = { createBike4MindWeb, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_IMAGES_B64, newText, thinkingText };
