/**
 * The chat engine: one OpenAI-style chat completion, answered by one provider's web chat.
 *
 * The caller (server.js) has already checked the key and chosen the provider and the model. This turns the request into one prompt (bridge.js), asks the
 * provider's web client for the answer, and writes the reply as an OpenAI chat.completion (or as server-sent chunks, with reasoning_content for a model that
 * thinks and tool_calls for a call). A web chat answers one message at a time, so every request is a fresh chat that is given the whole conversation; the
 * provider's client deletes it afterwards where it can.
 *
 * What it adds on top of a plain relay, because a personal account is not an API:
 *  - the governor decides first: a cooldown, the daily cap and a full queue are answered at once with 429 and Retry-After, and nothing goes upstream;
 *  - a provider that refuses (rate limit, mute, human check) or signs out ends the request in one plain error and sets the pause, with no retry;
 *  - a reply that came back empty is asked for once more, a tool call that was cut off is asked for once more in a form that fits, and then it is said;
 *  - a model marked `escalate` can hand ONE hard question to the provider's thinking mode (see THINK_TOOL), only when the request offers tools;
 *  - an agent that repeats the same step is stopped before another call is spent on it.
 * Nothing but metadata is ever logged.
 */
'use strict';

const crypto = require('crypto');
const { sendJson, sendError } = require('./http_util');
const { MAX_QUEUE } = require('./governor');
const B = require('./bridge');
const { createSessionStore } = require('./sessions');
const L = require('./limits');

const EMPTY_ANSWER_ATTEMPTS = 2; // one retry when the chat answers with nothing
const MAX_CALL_MS = 15 * 60 * 1000; // the most one call may take, however much it streams
const MAX_THINKS = 2; // thoughts one TASK (everything an agent does for one message of the person) may use
const MAX_TASKS_KEPT = 24;
const BRIDGE_REFRESH_TURNS = 8; // a continued chat is told how to call tools again this often

/** The request an `escalate` model can make to think hard: the engine answers it itself (the client never sees it). */
const THINK_TOOL = {
  type: 'function',
  function: {
    name: 'think',
    description: 'Hand ONE question to a slower reasoning model and get its answer back (it can take up to two minutes). Use it for design and planning decisions (how to structure a new project, which stack and design direction to take, what to avoid) and for a bug that keeps coming back. Never use it to write files or run commands: do those yourself afterwards. Put everything it needs to know in the question, including every requirement the person gave.',
    parameters: { type: 'object', properties: { question: { type: 'string', description: 'The one question, with the facts it needs.' } }, required: ['question'] }
  }
};
const NO_THOUGHT = 'The reasoning model gave no answer in time (its replies end after about two minutes). Decide with what you know and keep each step small: call a tool now.';
const NO_MORE_THOUGHT = 'No more thinking is available in this step. Decide with what you have and act: call a tool now.';
const SPENT_NOTE = 'No more thinking is available in this task: do not ask for it again. Decide with what you have and act.';
const thinkHint = (question) => `Think carefully about the question below and answer it. Do not call any tool and do not write files: give a clear, concrete answer, in at most 400 words, that the assistant can act on.\n\nQUESTION:\n${question}`;
const REPAIR_NOTE = '\n\nNOTE: your last reply was a tool call that could not be read: it was cut off, or the quotes and line breaks inside it were not escaped. Reply again with only the corrected JSON object, in one fenced code block.';
const CUT_NOTE = '\n\nNOTE: your last reply was a tool call that was cut off before its end (a reply holds about 20,000 characters), so nothing was done. Reply again with the same kind of tool call, but keep it under 15,000 characters: write a big page as several files, or in parts (the first part with write, then the rest with edit calls that add to the end of the file).';

const estimateTokens = (chars) => Math.ceil(Number(chars || 0) / 4);

/** A call counts against the account when its message went out: an answer, a refusal, or a caller who left after the send. Not a refused sign-in, not a caller who left first, not a connection that failed before the send. */
function counts(result) { return !result.authExpired && (result.cancelled ? result.sent === true : result.sent !== false); }

/**
 * createChatEngine({ provider, governor, log, onNotice, sessions })
 * `provider`: { id, name, web: { completeOnce({ prompt, thinking, signal, model, thinkingLevel, onDelta, keep, remote }) }, bridge(tools), formatCall(call), continueHint,
 *   noToolsHint, repeatLimit, hold: 'marker' | 'leading-json', timeoutMs }.
 *   chat(res, body, entry, meta) -> Promise<{ status, ... }>   `entry` is the chosen model: { id, thinking, escalate, ref }; `meta.sessionTag` names a session
 *
 * Sessions (sessions.js): when `sessions` is given and the provider's web client says it can keep a chat (`web.sessions === true`, `web.closeSession(remote)`), a request
 * that continues the conversation of an earlier one is sent into the same chat with only its new messages (`keep: true, remote`), and every other request starts a chat
 * that is kept for the next one. `sessions`: { options, persist(ids), orphans: [ids an earlier run left] }. Without it every request is a fresh chat, as it always was.
 */
function createChatEngine({ provider, governor = null, log = () => {}, onNotice = () => {}, sessions = null }) {
  const p = { hold: 'marker', timeoutMs: 180000, idPrefix: provider.id.slice(0, 2), ...provider };
  const gov = governor;
  const web = p.web;
  const inflight = new Set();
  // What the reasoning mode said during a task, kept for the task's later steps and counted against its limit of MAX_THINKS. An agent makes a new request for
  // every step and never sees a `think` step, so without this the plan from step 1 would be gone at step 2 and the model would ask for it again.
  // task key -> { entries: [{ at, messages }], left, asks }
  const taskThoughts = new Map();
  const log_ = (text) => log(`${p.id}: ${text}`);
  const notice = (n) => { try { onNotice({ provider: p.id, ...n }); } catch (_) { /* a listener never stops the engine */ } };
  const sessionStore = sessions && web.sessions === true && typeof web.closeSession === 'function'
    ? createSessionStore({ close: (remote) => web.closeSession(remote), persist: sessions.persist, log: log_, options: sessions.options })
    : null;
  let sessionsOn = Boolean(sessionStore) && sessions.enabled !== false; // the person can switch them off, and on again
  if (sessionStore) {
    sessionStore.start();
    if (sessions.orphans && sessions.orphans.length) sessionStore.adopt(sessions.orphans);
  }

  async function chat(res, body, entry, meta = {}) {
    const store = sessionsOn ? sessionStore : null; // what this request does with sessions is decided once, here
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const clientTools = Array.isArray(body.tools) ? body.tools.filter((t) => t && (t.function || t.name)) : [];
    const tools = body.tool_choice === 'none' ? [] : clientTools;
    // A model that escalates is offered the `think` request next to the client's own tools; the client never sees it.
    const canThink = Boolean(entry.escalate) && tools.length > 0;
    let task = null; // the thoughts of this task so far (what came back, as messages the prompt shows like any tool result) and how many are left
    if (canThink) {
      const key = B.taskKeyOf(messages);
      task = key ? taskThoughts.get(key) : null;
      if (!task) {
        task = { entries: [], left: MAX_THINKS, asks: 0 };
        if (key) {
          taskThoughts.set(key, task);
          while (taskThoughts.size > MAX_TASKS_KEPT) taskThoughts.delete(taskThoughts.keys().next().value);
        }
      }
    }
    // A task that has used its thoughts is no longer offered the request (nor the rule about it): there is nothing left to ask.
    const offerThink = canThink && task.left > 0;
    const toolsAll = offerThink ? tools.concat([THINK_TOOL]) : tools;
    const conversation = () => (task && task.entries.length ? B.withThoughts(messages, task.entries) : messages);
    const promptOptions = { bridge: p.bridge, noToolsHint: p.noToolsHint, formatCall: p.formatCall, continueHint: p.continueHint, jsonMode: body.response_format };
    const promptFor = () => B.buildPrompt(conversation(), toolsAll, promptOptions);
    const basePrompt0 = promptFor();
    let basePrompt = basePrompt0;
    let prompt = basePrompt0;
    const level = ['low', 'medium', 'high'].includes(String(body.reasoning_effort || '').toLowerCase()) ? String(body.reasoning_effort).toLowerCase() : (String(body.reasoning_effort || '').toLowerCase() === 'minimal' ? 'low' : undefined);

    // Sessions: what this request says about its conversation, and the kind of chat it needs (a chat that was opened for other tools or another model is no use).
    const fp = store ? B.conversationFingerprints(messages) : null;
    const sessionKey = store ? [entry.ref || entry.id, level || '', entry.escalate ? 'think' : '', B.toolsKey(tools)].join('|') : '';
    const sessionTag = store ? String((meta && meta.sessionTag) || '').trim().slice(0, 80) : '';
    let sess = null; // the session this request continues, once its turn comes
    let sessFrom = 0; // how many messages of the conversation that chat already holds
    let out;

    const controller = new AbortController();
    // The time limit is for a call that went quiet (nothing streamed for p.timeoutMs), not for one that is still thinking: a thinking model can spend
    // minutes on one step and the work would be thrown away at the flat limit. A call that streams is cut only at MAX_CALL_MS.
    // While the request waits in the governor's queue only the flat cap applies; the quiet-call limit starts when it gets its turn.
    let timer = setTimeout(() => controller.abort(), MAX_CALL_MS);
    let clientGone = false;
    const onClose = () => { if (!res.writableEnded) { clientGone = true; controller.abort(); } };
    res.on('close', onClose);
    inflight.add(controller);
    const started = Date.now();
    let queueMs = 0; // how long the request waited for its turn
    let slotAt = 0; // when it got its turn
    let firstAt = 0; // when the first word (or thought) came back
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(p.timeoutMs, started + MAX_CALL_MS - Date.now())));
    };

    const id = `chatcmpl-${p.idPrefix}-${crypto.randomBytes(8).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const model = typeof body.model === 'string' && body.model ? body.model : entry.id;
    const live = body.stream === true;
    const wantUsage = live && Boolean(body.stream_options && body.stream_options.include_usage);
    const thinkingMode = Boolean(entry.thinking) && !entry.escalate;
    const base = { id, object: 'chat.completion.chunk', created, model };
    let opened = false;
    let held = '';
    // A request with no tools has no call to hold back: its answer streams straight through, whatever it looks like.
    const passThrough = toolsAll.length === 0;
    // max_tokens and stop are done here, for an answer that has no tool call in it (limits.js). While streaming, the provider is told to stop sending once the cut is reached.
    const lim = passThrough && (L.maxChars(body) || L.stopList(body.stop).length) ? L.createLimiter({ maxChars: L.maxChars(body), stops: L.stopList(body.stop) }) : null;
    let limitedEarly = false;
    let limitReason = null; // 'stop' | 'length' | null
    let holdMode = p.hold === 'leading-json' ? 'undecided' : 'marker';
    const resetHold = () => { held = ''; holdMode = p.hold === 'leading-json' ? 'undecided' : 'marker'; };
    const write = (delta, finish = null) => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    };
    const openStream = () => {
      if (opened || !live) return;
      opened = true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      write({ role: 'assistant', content: '' });
    };
    const emit = (delta) => {
      if (!live) return;
      openStream();
      write(delta);
    };
    const feed = (text) => {
      if (passThrough) {
        if (!lim) { emit({ content: text }); return; }
        const r = lim.push(text);
        if (r.out) emit({ content: r.out });
        if (r.done && !limitedEarly) { limitedEarly = true; controller.abort(); }
        return;
      }
      held += text;
      if (holdMode === 'all') return;
      if (holdMode === 'undecided') {
        const trimmed = held.replace(/^\s+/, '');
        if (!trimmed) return;
        // An answer that starts with JSON is a tool call (or a code fence around one): hold every token until the answer is complete, because a half
        // streamed call is not valid to parse.
        if (/^[{<`]/.test(trimmed)) { holdMode = 'all'; return; }
        holdMode = 'marker';
      }
      const at = B.bodyHold(held, p.hold === 'leading-json');
      if (at < 0) {
        const out = held;
        held = '';
        if (out) emit({ content: out });
      } else if (at > 0) {
        const out = held.slice(0, at);
        held = held.slice(at);
        if (out) emit({ content: out });
      }
    };
    const endStream = (usage) => {
      if (res.destroyed || res.writableEnded) return;
      if (wantUsage && usage) res.write(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    };
    const cleanup = () => {
      clearTimeout(timer);
      res.off('close', onClose);
      inflight.delete(controller);
    };
    const completionBody = (message, finish, usage) => ({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], usage });
    // A chat this request opened or continued and will not hand on: removed on the provider's side, and the session it belonged to is forgotten.
    const leaveSession = () => {
      if (!store) return;
      if (out && out.remote) { store.closeRemote(out.remote); out.remote = null; }
      if (sess) { store.drop(sess); sess = null; }
    };
    /** One error answer: a plain JSON error before the stream opened, an error event inside it after. */
    const fail = (status, code, message, headers = {}) => {
      cleanup();
      leaveSession();
      log_(`request failed (${status} ${code})`);
      if (clientGone) return { ok: false, status: 499, code: 'client_closed' };
      if (opened) {
        if (!res.destroyed && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: { message, type: status === 429 ? 'rate_limit_error' : 'api_error', code } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } else sendError(res, status, code, message, headers);
      return { ok: false, status, code, message, queueMs };
    };

    // A loop is ended before another call is spent on it.
    if (p.repeatLimit) {
      const repeat = B.trailingRepeat(messages);
      if (repeat.count >= p.repeatLimit) {
        const note = `${p.name} kept repeating the same step (${repeat.label}, ${repeat.count} times in a row), so the bridge stopped it to protect your account. What it wrote is kept. Tell it what to change, or ask for a different next step.`;
        log_(`stopped a repeating step: ${repeat.label} x${repeat.count}`);
        notice({ kind: 'looping', short: `${p.name} kept repeating the same step` });
        cleanup();
        const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        if (!live) sendJson(res, 200, completionBody({ role: 'assistant', content: note }, 'stop', usage));
        else { openStream(); emit({ content: note }); write({}, 'stop'); endStream(usage); }
        return { ok: true, status: 200, kind: 'stopped-loop', ms: Date.now() - started };
      }
    }

    const limit = gov ? gov.checkLimit() : { allowed: true };
    if (!limit.allowed) {
      log_(`governor stopped a request: ${limit.reason}`);
      notice({ kind: 'paused', short: `${p.name} requests are paused to protect your account (${limit.reason})` });
      return fail(429, `${p.id}_${limit.reason}`, limit.message, { 'Retry-After': String(limit.retryAfterSec || 60) });
    }
    if (gov && gov.queueLength() >= MAX_QUEUE) {
      return fail(429, `${p.id}_queue_full`, `${p.name} is busy: ${MAX_QUEUE} requests are already waiting. Account-backed models answer one request at a time; try again shortly.`, { 'Retry-After': '10' });
    }

    let releaseSlot = null;
    let emptyAnswers = 0;
    let unreadable = 0;
    let thinkAsks = 0; // in this request
    // One question to the reasoning mode, on a fresh chat, with the conversation so far (without the system prompt and the tool protocol: this call answers a
    // question, it does not act). What it thinks is streamed as the model's reasoning. Returns { answer } or { fatal } (a refusal, an expired sign-in or a
    // stop, which end the whole request like any other call's).
    const deliberate = async (question) => {
      if (gov && !gov.checkLimit().allowed) return { answer: NO_THOUGHT };
      const asked = Date.now();
      const context = B.buildPrompt(conversation().filter((m) => m && m.role !== 'system'), [], { closing: thinkHint(question), formatCall: p.formatCall });
      const r = await web.completeOnce({
        prompt: context,
        thinking: true,
        signal: controller.signal,
        model: entry.ref || entry.id,
        onDelta: (d) => {
          arm();
          if (live && d.type === 'think' && d.text) emit({ reasoning_content: d.text });
        }
      });
      if (gov && counts(r)) gov.recordCall();
      log_(`thought about a question (${r.ok ? `${String(r.text || '').length} chars` : 'no answer'}, ${Date.now() - asked}ms)`);
      if (!r.ok && (r.authExpired || r.rateLimited || r.cancelled)) return { fatal: r };
      const text = r.ok ? String(r.text || '').trim() : '';
      if (text) return { answer: text.slice(0, 8000) };
      const notes = r.ok ? String(r.thinking || '').trim().slice(-2000) : '';
      return { answer: notes ? `${NO_THOUGHT}\n\nIts unfinished notes, for what they are worth:\n${notes}` : NO_THOUGHT };
    };
    try {
      try { releaseSlot = gov ? await gov.acquireSlot(controller.signal) : null; } catch (err) {
        // The caller left (or the flat time cap ran out) while this request waited for its turn: nothing was sent, so nothing is sent now.
        if (err && err.aborted) return fail(504, `${p.id}_timeout`, `${p.name} took too long to answer.`);
        throw err;
      }
      slotAt = Date.now();
      queueMs = slotAt - started;
      arm(); // the time a call waited in the queue is not time the provider kept it
      // A call can wait for its slot behind one that found the provider refusing (a rate limit, a human check) and so set a pause. That pause is this
      // call's too: without this look each queued call walked into the same refusal and set the pause again.
      const waited = gov ? gov.checkLimit() : { allowed: true };
      if (!waited.allowed) {
        out = { ok: false, rateLimited: true, error: waited.message, retryAfterSec: waited.retryAfterSec, noticeKind: 'paused', noticeShort: `${p.name} requests are paused to protect your account` };
        log_(`governor stopped a queued request: ${waited.reason}`);
      }
      // The turn has come: this is the first moment the sessions are in the state this request will find them (the request before it may just have ended).
      if (store && !(out && out.noticeKind)) {
        const hit = store.match({ key: sessionKey, tag: sessionTag, hashes: [fp.system, ...fp.talk] });
        if (hit.session) {
          sess = hit.session;
          sessFrom = hit.from;
          const refresh = sess.turns % BRIDGE_REFRESH_TURNS === BRIDGE_REFRESH_TURNS - 1;
          prompt = B.buildPrompt(messages, toolsAll, { ...promptOptions, continuation: { from: sessFrom, refreshBridge: refresh } }) + (canThink && !offerThink ? `\n\n${SPENT_NOTE}` : '');
          log_(`continuing a chat: ${messages.length - 1 - sessFrom} new message(s) after ${sessFrom} (turn ${sess.turns + 1})`);
        } else if (hit.reason === 'diverged') log_('the conversation no longer matches the open chat (a message was changed or dropped): starting a new chat');
        else if (hit.reason === 'full') log_('the open chat is long enough: starting a new chat');
      }
      // An answer with neither words nor a step is the web chat giving up after its thinking. The caller would read an empty stop as "finished", so ask once more.
      let repairing = false; // the second ask after a call that could not be read: no thinking, so the whole reply is the call
      for (let attempt = 1; !(out && out.noticeKind) && attempt <= EMPTY_ANSWER_ATTEMPTS; attempt += 1) {
        const continued = Boolean(sess);
        out = await web.completeOnce({
          prompt,
          thinking: repairing ? false : thinkingMode,
          signal: controller.signal,
          model: entry.ref || entry.id,
          thinkingLevel: level,
          keep: Boolean(store) && !store.disabledReason(),
          remote: sess ? sess.remote : null,
          onDelta: (d) => {
            arm();
            if (!firstAt) firstAt = Date.now();
            if (!live) return;
            if (d.type === 'think') { if (d.text) emit({ reasoning_content: d.text }); }
            else if (d.type === 'answer') feed(d.text);
          }
        });
        if (gov && counts(out)) gov.recordCall();
        // A continued chat that failed cannot be trusted any more. If it failed for a reason that says nothing about the account, and nothing of the answer has gone to the
        // caller yet, the request is asked once more on a new chat with the whole conversation: what a request did before sessions.
        if (!out.ok && continued) {
          const general = !out.authExpired && !out.rateLimited && !out.cancelled;
          store.drop(sess, { general });
          sess = null;
          if (general && !opened && attempt < EMPTY_ANSWER_ATTEMPTS && !(gov && !gov.checkLimit().allowed)) {
            log_(`continuing the chat failed (${String(out.error || '').slice(0, 120)}): asking again on a new chat`);
            prompt = basePrompt;
            resetHold();
            continue;
          }
        }
        if (out.ok && B.unreadableCall(out.text, toolsAll)) {
          unreadable += 1;
          log_(`the tool call in the answer could not be read (attempt ${attempt} of ${EMPTY_ANSWER_ATTEMPTS}, ${String(out.text || '').length} chars)`);
          if (attempt < EMPTY_ANSWER_ATTEMPTS && !(gov && !gov.checkLimit().allowed)) {
            leaveSession();
            resetHold();
            prompt = basePrompt + (B.opensCall(String(out.text || '')) ? CUT_NOTE : REPAIR_NOTE);
            repairing = true;
            continue;
          }
          break;
        }
        // The plain chat asked to think: the reasoning model gets that one question, its answer goes back to the plain chat, and the plain chat carries on.
        if (out.ok && offerThink && thinkAsks <= MAX_THINKS) {
          const asked = B.thinkRequest(out.text, toolsAll);
          if (asked) {
            leaveSession(); // the chat now holds a question that was put to another model: the next request starts clean
            thinkAsks += 1;
            task.asks += 1;
            let answer = NO_MORE_THOUGHT;
            if (task.left > 0) {
              task.left -= 1;
              const thought = await deliberate(asked.question);
              if (thought.fatal) { out = thought.fatal; break; }
              answer = thought.answer;
            }
            const callId = `think_${task.asks}`;
            task.entries.push({
              at: messages.length,
              messages: [
                { role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name: 'think', arguments: JSON.stringify({ question: asked.question }) } }] },
                { role: 'tool', tool_call_id: callId, content: answer }
              ]
            });
            basePrompt = promptFor();
            prompt = basePrompt;
            resetHold();
            repairing = false;
            attempt -= 1; // asking again after a thought is not a retry of anything
            continue;
          }
        }
        if (!out.ok || String(out.text || '').trim()) break;
        emptyAnswers += 1;
        log_(`the answer came back empty after ${Date.now() - started}ms (attempt ${attempt} of ${EMPTY_ANSWER_ATTEMPTS})`);
        if (gov && !gov.checkLimit().allowed) break;
        if (continued) prompt = basePrompt; // the retry starts a new chat, which holds nothing yet
        leaveSession();
      }
    } finally {
      if (releaseSlot) releaseSlot();
      cleanup();
    }

    // The limit was reached while streaming and the provider was told to stop: what it had sent by then is the answer.
    if (lim && limitedEarly && !out.ok && out.cancelled && !clientGone) out = { ok: true, text: lim.seen(), thinking: out.thinking };

    if (!out.ok) {
      if (out.cancelled && clientGone) return fail(499, 'client_closed', 'The client closed the connection.');
      const message = out.cancelled ? `${p.name} took too long to answer.` : (out.error || `${p.name} could not answer.`);
      if (out.authExpired) {
        log_('the sign-in was refused, ending the request cleanly');
        notice({ kind: 'expired', short: `the ${p.name} sign-in expired` });
        return fail(401, `${p.id}_session_expired`, message);
      }
      if (out.rateLimited) {
        log_('the provider\'s own limit was reached, ending the request cleanly');
        notice({ kind: out.noticeKind || 'limit', short: out.noticeShort || `${p.name}'s own limit was reached` });
        const retry = (gov && gov.checkLimit().retryAfterSec) || out.retryAfterSec || 300;
        return fail(429, `${p.id}_${out.noticeKind === 'muted' ? 'muted' : 'rate_limited'}`, message, { 'Retry-After': String(retry) });
      }
      if (out.cancelled) return fail(504, `${p.id}_timeout`, message);
      // A permanent condition (a security check on the page, say) must not look like a server hiccup: a 4xx tells a retrying client to stop.
      log_('request failed: ' + String(out.error || '').slice(0, 200));
      return fail(out.retryable === false ? 400 : 502, `${p.id}_error`, message);
    }

    let answerText = out.text;
    if (lim) { const cut = L.cutText(answerText, { maxChars: L.maxChars(body), stops: L.stopList(body.stop) }); answerText = cut.text; limitReason = cut.finish; }
    const parsed = B.parseAnswer(answerText, toolsAll);
    const calls = parsed.calls.filter((c) => c.name !== 'think').map((call) => ({ ...call, id: `call_${crypto.randomBytes(8).toString('hex')}` }));
    log_(`${messages.length} messages, ${tools.length} tools, ${out.text.length} chars, ${calls.length} calls, ${Date.now() - started}ms`);
    // Still unreadable after the second try: the damaged call is not shown as the answer (a page's mangled copy of a file).
    if (unreadable > 0 && !calls.length && B.unreadableCall(out.text, toolsAll)) {
      notice({ kind: 'unreadable', short: `${p.name} sent a tool call that could not be read` });
      return fail(502, `${p.id}_unreadable_tool_call`, `${p.name} answered with a tool call that could not be read (it was cut off or damaged), so nothing was done. If it was a long file, ask for it in smaller parts.`);
    }
    if (!String(out.text || '').trim()) {
      notice({ kind: 'empty', short: `${p.name} sent no answer` });
      return fail(502, `${p.id}_empty_answer`, `${p.name} sent no answer${emptyAnswers > 1 ? `, ${emptyAnswers} times` : ''} (after ${Math.round((Date.now() - started) / 1000)} s). Try the request again.`);
    }
    // The answer is good: the chat that gave it now holds this conversation, and the next request can carry on in it.
    if (store && out.remote) {
      const answered = B.fingerprint({ role: 'assistant', content: parsed.content || null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) });
      if (sess) store.worked();
      store.commit({ session: sess, key: sessionKey, tag: sessionTag, hashes: [fp.system, ...fp.talk, answered], remote: out.remote, chars: prompt.length + out.text.length, meta: { provider: p.id, model: entry.id } });
      sess = null;
      out.remote = null;
    } else leaveSession();
    // The count is for the whole conversation, as the caller would be billed by any other API, whatever part of it the chat had to be told.
    const usage = {
      prompt_tokens: estimateTokens(basePrompt.length),
      completion_tokens: estimateTokens(answerText.length) + estimateTokens((out.thinking || '').length),
      total_tokens: 0,
      ...(out.thinking ? { completion_tokens_details: { reasoning_tokens: estimateTokens(out.thinking.length) } } : {})
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    cleanup();
    const finishFor = () => (calls.length ? 'tool_calls' : (limitReason === 'length' ? 'length' : 'stop'));
    const summary = { ok: true, status: 200, calls: calls.length, ms: Date.now() - started, chars: out.text.length, queueMs, firstMs: firstAt && slotAt ? firstAt - slotAt : 0 };

    if (!live) {
      sendJson(res, 200, completionBody({
        role: 'assistant',
        content: parsed.content || null,
        ...(out.thinking ? { reasoning_content: out.thinking } : {}),
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {})
      }, finishFor(), usage));
      return summary;
    }
    // Text went out as it arrived. What a stop string might have been the start of is released now, unless a limit was reached.
    if (lim) {
      if (!lim.done()) { const tail = lim.flush(); if (tail) emit({ content: tail }); }
      limitReason = lim.done() || limitReason;
    }
    // A held tail is either the tool-call markup (dropped) or ordinary text that only looked like the start of one (released).
    if (held && !calls.length) emit({ content: held });
    openStream();
    calls.forEach((call, index) => {
      write({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] });
    });
    write({}, finishFor());
    endStream(usage);
    return summary;
  }

  function stop() {
    for (const controller of inflight) { try { controller.abort(); } catch (_) { /* gone */ } }
    inflight.clear();
  }

  return {
    chat,
    stop,
    /** The chats that are open on the provider's side, for the web interface. */
    sessionList: () => (sessionStore ? sessionStore.list() : []),
    /** Ends one session and removes its chat. */
    endSession: (id) => (sessionStore ? sessionStore.endById(id) : false),
    /** null when this provider cannot keep chats; otherwise whether it does now, and what it has done so far. */
    sessionInfo: () => (sessionStore ? { enabled: sessionsOn && !sessionStore.disabledReason(), reason: sessionStore.disabledReason(), open: sessionStore.size(), ...sessionStore.stats } : null),
    /** Switches the use of sessions on or off; off removes the open chats. */
    setSessions: async (on) => {
      if (!sessionStore) return;
      sessionsOn = Boolean(on);
      if (!sessionsOn) await sessionStore.closeAll();
      else { sessionStore.reset(); sessionStore.start(); }
    },
    /** Removes every open chat, for as long as `timeoutMs` allows: the program is stopping. */
    closeSessions: (timeoutMs) => (sessionStore ? sessionStore.closeAll(timeoutMs) : Promise.resolve())
  };
}

module.exports = { createChatEngine, THINK_TOOL, estimateTokens };
