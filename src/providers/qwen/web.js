'use strict';

const crypto = require('crypto');
const path = require('path');
const { readJson, writeJson } = require('../../config');
const { createSessionStore } = require('../../sessions');
const { setTimeout: delay } = require('timers/promises');
const { CHAT, EXPIRED, accountId, responseError } = require('./api');

const REQUEST_TIMEOUT_MS = 180000;
const CHAT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function browserRequest(page, session, url, { method = 'GET', body, signal, accept = 'application/json' } = {}) {
  if (new URL(url).origin !== CHAT) throw new Error('Qwen chat requests must stay on Qwen.');
  const owner = accountId(session.token);
  if (!owner) throw Object.assign(new Error(EXPIRED), { authExpired: true });
  const key = `__ula_${crypto.randomUUID().replaceAll('-', '')}`;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', abort);
    await page.evaluate((key) => {
      const s = window[key];
      if (s) { s.controller.abort(); clearTimeout(s.timer); delete window[key]; }
    }, key).catch(() => {});
  };
  const abort = () => { void dispose(); };
  const check = (s) => {
    signal?.throwIfAborted();
    if (!s || s.error) throw new Error('Qwen browser request failed. No automatic retry was made.');
    return s;
  };
  try {
    signal?.throwIfAborted();
    const started = await page.evaluate((key, url, method, body, accept, timeout, owner) => {
      if (location.origin !== 'https://chat.qwen.ai' || new URL(url).origin !== location.origin) return false;
      let auth;
      try { auth = JSON.parse(localStorage.getItem('qwen_access_token_state')); } catch (_) {}
      const token = auth?.token || localStorage.getItem('token');
      if (!token) return false;
      let id;
      try { id = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).id; } catch (_) {}
      if (id !== owner) return false;
      const script = Array.from(document.scripts).map((s) => s.src).find((s) => s.includes('/qwen-chat-fe/')) || '';
      const version = /\/qwen-chat-fe\/([^/]+)\//.exec(script)?.[1];
      const headers = { accept, 'content-type': 'application/json', authorization: `Bearer ${token}`, source: 'web', 'x-request-id': crypto.randomUUID() };
      if (version) headers.version = version;
      const s = { controller: new AbortController(), buffer: '', done: false, error: false, meta: null };
      window[key] = s;
      s.timer = setTimeout(() => s.controller.abort(), timeout);
      (async () => {
        let reader;
        try {
          const response = await fetch(url, { method, headers, body: body === null ? undefined : JSON.stringify(body), credentials: 'include', redirect: 'error', signal: s.controller.signal });
          s.meta = { status: response.status, headers: { 'content-type': response.headers.get('content-type') || '', 'retry-after': response.headers.get('retry-after') || '' } };
          if (!response.body) return;
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          const streaming = accept === 'text/event-stream' && response.ok && s.meta.headers['content-type'].includes('text/event-stream');
          let bytes = 0;
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (!streaming && bytes > 2 * 1024 * 1024) { s.controller.abort(); throw new Error('Qwen response too large.'); }
            s.buffer += decoder.decode(chunk.value, { stream: true });
            if (s.buffer.length > 2 * 1024 * 1024) { s.controller.abort(); throw new Error('Browser stream buffer full.'); }
          }
          s.buffer += decoder.decode();
        } catch (_) { s.error = true; }
        finally {
          if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          clearTimeout(s.timer);
          s.done = true;
        }
      })();
      return true;
    }, key, url, method, body === undefined ? null : body, accept, REQUEST_TIMEOUT_MS, owner);
    if (!started) throw Object.assign(new Error(EXPIRED), { authExpired: true });
    signal?.addEventListener('abort', abort, { once: true });
    let meta;
    while (!meta) {
      signal?.throwIfAborted();
      const state = await page.evaluate((key) => {
        const s = window[key];
        return s ? { meta: s.meta, error: s.error } : null;
      }, key);
      if (state?.meta) meta = state.meta;
      else { check(state); await delay(150, undefined, { signal }); }
    }
    if (meta.status === 204) { await dispose(); return new Response(null, meta); }
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            const state = check(await page.evaluate((key) => {
              const s = window[key];
              if (!s) return null;
              const chunk = s.buffer;
              s.buffer = '';
              return { chunk, done: s.done, error: s.error };
            }, key));
            if (state.chunk) { controller.enqueue(new TextEncoder().encode(state.chunk)); return; }
            if (state.done) { await dispose(); controller.close(); return; }
            await delay(150, undefined, { signal });
          }
        } catch (error) { controller.error(error); await dispose(); }
      },
      cancel: dispose
    });
    return new Response(stream, meta);
  } catch (error) { await dispose(); throw error; }
}

async function readStream(response, onDelta) {
  let text = '';
  let thinking = '';
  let summary = '';
  let lastId = null;
  let terminal = false;
  let buffer = '';
  let lines = [];
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const take = (type, value) => {
    if (typeof value !== 'string' || !value) return;
    if (type === 'answer') text += value; else thinking += value;
    onDelta({ type, text: value });
  };
  function event() {
    const raw = lines.join('\n');
    lines = [];
    if (!raw) return;
    if (raw === '[DONE]') { terminal = true; return; }
    let value;
    try { value = JSON.parse(raw); } catch (_) { throw new Error('Qwen sent an unreadable stream event. The incomplete answer was not accepted.'); }
    if (['The request is ended!', 'The request is finished!'].includes(value.error?.details)) { terminal = true; return; }
    const error = responseError(200, value);
    if (error) throw error;
    if (value['response.stopped']) throw new Error('Qwen stopped before finishing its answer.');
    const id = value.response_id || value['response.created']?.response_id || value['response.info']?.response_id;
    if (typeof id === 'string' && id) lastId = id;
    const choice = value.choices?.[0];
    const delta = choice?.delta;
    if (delta?.role !== 'function') {
      if (delta?.phase === 'think') take('think', delta.content);
      else if (delta?.phase === 'thinking_summary') {
        const part = delta.extra?.summary_thought?.content;
        const next = Array.isArray(part) ? part.filter((p) => typeof p === 'string').join('\n') : typeof part === 'string' ? part : '';
        if (next.startsWith(summary)) take('think', next.slice(summary.length));
        summary = next || summary;
      } else if (delta && (!delta.phase || delta.phase === 'answer')) take('answer', delta.content);
    }
    if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error('Qwen ended the answer early. The incomplete answer was not accepted.');
    if (value.done === true || delta?.phase === 'finished' || choice?.finish_reason === 'stop' || (delta?.phase === 'answer' && delta.status === 'finished')) terminal = true;
  }
  function line(value) {
    if (!value) event();
    else if (value.startsWith('data:')) lines.push(value.slice(5).replace(/^ /, ''));
  }
  try {
    while (!terminal) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 2 * 1024 * 1024) throw new Error('Qwen sent a stream event too large to read.');
      let at;
      while (!terminal && (at = buffer.indexOf('\n')) !== -1) {
        line(buffer.slice(0, at).replace(/\r$/, ''));
        buffer = buffer.slice(at + 1);
      }
    }
    if (!terminal) {
      buffer += decoder.decode();
      if (buffer) line(buffer.replace(/\r$/, ''));
      event();
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!terminal) throw new Error('Qwen disconnected before its completion marker. The incomplete answer was not accepted.');
  if (!text.trim()) throw new Error('Qwen finished without an answer. No automatic retry was made.');
  return { text, thinking, lastId };
}

function createQwenWeb({ dataDir, account, governor, log = () => {} }) {
  const idsFile = path.join(dataDir, 'chats-qwen.json');
  const saved = readJson(idsFile);
  const owned = new Map((Array.isArray(saved?.chats) ? saved.chats : []).filter((c) => CHAT_ID.test(c?.id) && typeof c.linkId === 'string').map((c) => [c.id, c.linkId]));
  const persist = () => writeJson(idsFile, { chats: [...owned].map(([id, linkId]) => ({ id, linkId })) });
  const orphans = [...owned].filter(([, owner]) => owner === account.readSession()?.linkId).map(([id]) => id);
  let queue = Promise.resolve();
  let active = 0;
  let lastCloseAt = 0;
  const cleanup = createSessionStore({ close: closeSession, log });
  const serial = (run) => {
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  };

  function closeSession(remote) {
    const close = async () => {
      if (!remote?.id || !owned.has(remote.id)) return;
      if (owned.get(remote.id) !== account.readSession()?.linkId) return;
      const limit = governor.checkLimit();
      if (!limit.allowed && limit.reason === 'cooldown') return { retryAfterMs: Math.max(60000, (limit.retryAfterSec || 60) * 1000) };
      let session;
      try {
        const wait = 1500 - (Date.now() - lastCloseAt);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        const opened = await account.openChat();
        session = opened.session;
        if (owned.get(remote.id) !== session.linkId) return;
        const inUse = await opened.page.evaluate((id) => location.pathname === `/c/${id}` && (Boolean(document.querySelector('textarea.message-input-textarea')?.value) || Boolean(document.querySelector('button[aria-label="Stop"]')?.checkVisibility({ visibilityProperty: true }))), remote.id);
        if (inUse) {
          log('qwen: chat cleanup deferred while its composer is in use');
          return { retryAfterMs: 60000 };
        }
        lastCloseAt = Date.now();
        const response = await browserRequest(opened.page, session, `${CHAT}/api/v2/chats/${encodeURIComponent(remote.id)}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) });
        const data = await response.json().catch(() => null);
        const error = responseError(response.status, data, response.headers.get('retry-after'));
        if (error && response.status !== 404) throw error;
        if (response.status !== 404 && data?.success !== true) throw new Error('Qwen did not confirm chat removal.');
        owned.delete(remote.id);
        persist();
      } catch (error) {
        account.failure(error, session);
        log('qwen: chat cleanup deferred; only bridge-created chats are on the cleanup list');
        return { retryAfterMs: error.cooldownMs || 60000 };
      }
    };
    return serial(close);
  }

  async function completeOnce({ prompt, model, signal, onDelta = () => {}, keep = false, remote = null }) {
    active += 1;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try { return await serial(run); }
    finally { active -= 1; }

    async function run() {
      let sent = false;
      let submitted = false;
      let drafted = false;
      let documentTimeOrigin;
      let session;
      let page;
      let id;
      let retained = false;
      let observer;
      let guard;
      let confirmBy = 0;
      let delivering = true;
      let stage = 'browser initialization';
      let status;
      const started = Date.now();
      const watching = new AbortController();
      const stopDelivery = () => {
        delivering = false;
        if (!sent || submitted) observer?.stop();
      };
      combined.addEventListener('abort', stopDelivery, { once: true });
      const state = async () => {
        combined.throwIfAborted();
        const value = await page.evaluate((owner) => {
          let auth;
          try { auth = JSON.parse(localStorage.getItem('qwen_access_token_state')); } catch (_) {}
          const token = auth?.token || localStorage.getItem('token');
          let user;
          try { user = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).id; } catch (_) {}
          const input = document.querySelector('textarea.message-input-textarea');
          const picker = document.querySelector('[aria-label="Select Model"]');
          const verify = document.querySelector('#baxia-dialog-content');
          return {
            signedIn: location.origin === 'https://chat.qwen.ai' && user === owner,
            verification: Boolean(verify?.getClientRects().length),
            path: location.pathname, timeOrigin: performance.timeOrigin,
            ready: Boolean(!document.getElementById('splash-screen') && input && !input.disabled && !input.readOnly && input.getClientRects().length && picker?.getClientRects().length),
            // Qwen keeps its model menu mounted after a choice with no aria-expanded on the picker and the listbox still in the
            // document, so only a listbox that is actually on screen and can take a click counts as open. Reading a missing
            // attribute as "open" left selection stuck on a menu that was already closed.
            selecting: [...document.querySelectorAll('[role="listbox"]')].some((e) => {
              if (e.closest('[aria-hidden="true"]')) return false;
              const r = e.getBoundingClientRect();
              const style = getComputedStyle(e);
              return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && style.pointerEvents !== 'none';
            }),
            empty: input ? input.value === '' : null,
            busy: Boolean(document.querySelector('button[aria-label="Stop"]')?.checkVisibility({ visibilityProperty: true })),
            send: (() => { const b = document.querySelector('button[aria-label="Send"]'); return Boolean(b && !b.disabled); })(),
            model: picker?.innerText.trim()
          };
        }, accountId(session.token));
        if (value.verification) throw Object.assign(new Error('Qwen requested browser verification. Complete any checks in its window yourself; nothing was retried.'), { verificationRequired: true, rateLimited: true, cooldownMs: 20 * 60000, retryable: false });
        if (!value.signedIn || account.readSession()?.linkId !== session.linkId) throw Object.assign(new Error(EXPIRED), { authExpired: true });
        return value;
      };
      const waitFor = async (accept, message, ms = 15000) => {
        for (const until = Date.now() + ms; Date.now() < until;) {
          const value = await state();
          if (accept(value)) return value;
          await delay(250, undefined, { signal: combined });
        }
        throw new Error(message);
      };
      // A person closes Qwen's model menu with Escape or by clicking the picker again; either is used before anything is typed.
      const closeModelMenu = async () => {
        if (!(await state()).selecting) return true;
        await page.keyboard.press('Escape');
        for (const end = Date.now() + 1200; Date.now() < end;) {
          if (!(await state()).selecting) return true;
          await delay(150, undefined, { signal: combined });
        }
        const picker = await page.$('[aria-label="Select Model"]');
        if (picker) await picker.mouseClick();
        for (const end = Date.now() + 1200; Date.now() < end;) {
          if (!(await state()).selecting) return true;
          await delay(150, undefined, { signal: combined });
        }
        return false;
      };
      const selectModel = async (name) => {
        for (const until = Date.now() + 15000; Date.now() < until;) {
          combined.throwIfAborted();
          const current = await state();
          if (!current.ready) { await delay(250, undefined, { signal: combined }); continue; }
          // Qwen can already hold the requested model when the lane reaches it (a new chat keeps the last choice), and a click on
          // its option can leave the menu mounted; the label it shows is the answer, not whether the menu happens to be open.
          if (current.model === name) {
            if (!(await closeModelMenu())) log('qwen: the model menu stayed open after the model was already set; continuing');
            return;
          }
          if (!current.selecting) {
            const picker = await page.$('[aria-label="Select Model"]');
            if (!picker) { await delay(250, undefined, { signal: combined }); continue; }
            await picker.click();
            await delay(300, undefined, { signal: combined });
            if (!(await state()).selecting) await picker.mouseClick();
            await delay(300, undefined, { signal: combined });
          }
          const clicked = await page.evaluate((wanted) => {
            const option = [...document.querySelectorAll('[role="option"]')].find((e) => e.checkVisibility({ visibilityProperty: true }) && e.innerText.trim().split('\n')[0] === wanted);
            if (!option) return false;
            option.click();
            return true;
          }, name);
          if (clicked) {
            for (const end = Date.now() + 4000; Date.now() < end;) {
              const selected = await state();
              if (selected.ready && selected.model === name) {
                if (!(await closeModelMenu())) log('qwen: the model menu stayed open after selecting; continuing');
                return;
              }
              await delay(200, undefined, { signal: combined });
            }
          }
          await delay(250, undefined, { signal: combined });
        }
        const current = await state();
        const options = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].map((e) => ({ name: e.innerText.trim().split('\n')[0], selected: e.getAttribute('aria-selected'), visible: Boolean(e.getClientRects().length) })));
        log(`qwen: model selection timed out (model ${current.model || 'unknown'}, ready ${current.ready}, menu ${current.selecting}, options ${JSON.stringify(options)})`);
        throw new Error('Qwen did not select the requested model.');
      };
      try {
        combined.throwIfAborted();
        const opened = await account.openChat();
        session = opened.session;
        page = opened.page;
        const entry = session.models?.find((m) => m.ref === model);
        if (!entry) throw new Error('That model is not in the linked Qwen account model list. Read models again on the Accounts page.');
        if (remote) {
          if (!CHAT_ID.test(remote.id) || owned.get(remote.id) !== session.linkId) throw new Error('This Qwen conversation no longer belongs to the linked session. Start a new conversation.');
          id = remote.id;
        }
        stage = 'composer preparation';
        const target = id ? `/c/${id}` : '/';
        let before = await state();
        if (before.empty === false) throw new Error('The Qwen message box contains an unsent draft. Clear it in the dedicated window before trying again.');
        if (before.busy) throw new Error('Qwen is already answering in its dedicated window. Wait for it to finish before trying again.');
        const navigated = before.path !== target;
        if (navigated) {
          await page.goto(`${CHAT}${target}`, { timeout: 15000 });
          before = await waitFor((s) => s.path === target && s.timeOrigin !== before.timeOrigin && s.ready, 'Qwen did not open the requested conversation.');
        } else before = await waitFor((s) => s.path === target && s.ready, 'Qwen is not ready for another message.');
        if (!before.empty || before.busy) throw new Error('The Qwen composer is already in use. No message was inserted.');
        documentTimeOrigin = before.timeOrigin;
        log(`qwen: composer model ${before.model || 'unknown'} (asked ${entry.name})`);
        await selectModel(entry.name);
        const input = await page.$('textarea.message-input-textarea');
        if (!input) throw new Error('Qwen did not show its message box.');
        await input.mouseClick();
        const current = await state();
        if (current.path !== target || current.timeOrigin !== documentTimeOrigin || !current.empty || current.busy) throw new Error('The Qwen composer changed before typing. No message was inserted.');
        const focused = await input.evaluate((e) => { if (!e.isConnected || e.value !== '') return false; e.focus(); return document.activeElement === e; });
        if (!focused) throw new Error('Qwen could not focus an empty message box. No message was inserted.');
        combined.throwIfAborted();
        drafted = true;
        await page.keyboard.insertText(prompt);
        const afterType = await waitFor((s) => s.path === target && s.ready && !s.selecting && s.send, 'Qwen did not enable its Send button.', 5000);
        if (afterType.model !== entry.name) {
          log(`qwen: the composer changed its model after typing (now ${afterType.model || 'no model label'}, ${afterType.ready ? 'composer ready' : 'composer not ready'}, at ${afterType.path}); selecting the requested model again`);
          await selectModel(entry.name);
          await waitFor((s) => s.path === target && s.ready && !s.selecting && s.send && s.model === entry.name, 'Qwen did not keep the requested model ready to send.', 5000);
        }
        observer = await page.watchResponse({
          url: `${CHAT}/api/v2/chat/completions`,
          onRequest: ({ url, postData, headers }) => {
            let payload;
            try { payload = JSON.parse(postData); } catch (_) {}
            if (!payload) throw Object.assign(new Error('Qwen did not expose verifiable request metadata. The answer was not accepted.'), { requestMismatch: true });
            const token = new Headers(headers).get('authorization')?.replace(/^Bearer\s+/i, '');
            const message = Array.isArray(payload.messages) && payload.messages.length === 1 ? payload.messages[0] : null;
            const requestId = new URL(url).searchParams.get('chat_id');
            if (!sent || account.readSession()?.linkId !== session.linkId || accountId(token) !== accountId(session.token) || message?.role !== 'user' || message.content !== prompt || !CHAT_ID.test(requestId) || payload.chat_id !== requestId || (payload.chatId !== undefined && payload.chatId !== requestId) || (id && id !== requestId)) {
              throw Object.assign(new Error('The Qwen request did not match this message, account or conversation. The answer was not accepted.'), { requestMismatch: true });
            }
            submitted = true;
            if (!id) { id = requestId; owned.set(id, session.linkId); persist(); }
            if (payload.model !== entry.ref || !Array.isArray(message.models) || message.models.length !== 1 || message.models[0] !== entry.ref) {
              throw Object.assign(new Error('Qwen did not submit exactly the requested model. The answer was not accepted.'), { modelMismatch: true });
            }
            log(`qwen: request confirmed (${Date.now() - started}ms, model ${entry.ref}, one Send click)`);
            combined.throwIfAborted();
            if (!delivering) throw new Error('Qwen request was stopped before its response.');
          }
        });
        const prepared = await page.evaluate((prompt, model, target, owner, timeOrigin) => {
          let token;
          try { token = JSON.parse(localStorage.getItem('qwen_access_token_state'))?.token || localStorage.getItem('token'); } catch (_) {}
          let user;
          try { user = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).id; } catch (_) {}
          const send = document.querySelector('button[aria-label="Send"]');
          const picker = document.querySelector('[aria-label="Select Model"]');
          const menu = [...document.querySelectorAll('[role="listbox"]')].some((e) => {
            if (e.closest('[aria-hidden="true"]')) return false;
            const r = e.getBoundingClientRect();
            const style = getComputedStyle(e);
            return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && style.pointerEvents !== 'none';
          });
          return location.origin === 'https://chat.qwen.ai' && user === owner && performance.timeOrigin === timeOrigin && location.pathname === target && !document.getElementById('splash-screen') && document.querySelector('textarea.message-input-textarea')?.value === prompt && picker?.innerText.trim() === model && !menu && send && !send.disabled;
        }, prompt, entry.name, target, accountId(session.token), documentTimeOrigin);
        if (!prepared) {
          const now = await state();
          if (now.path !== target) throw new Error('Qwen left the requested conversation. No request was sent.');
          if (now.empty) throw new Error('Qwen cleared the message before sending. No request was sent.');
          if (now.selecting) throw new Error('Qwen kept its model menu open. No request was sent.');
          if (!now.send) throw new Error('Qwen did not keep its Send button enabled. No request was sent.');
          if (now.model !== entry.name) throw new Error(`Qwen switched its model back to ${now.model || 'an unknown one'}. No request was sent.`);
          throw new Error('Qwen could not prepare this message. No request was sent.');
        }
        const send = await page.$('button[aria-label="Send"]');
        if (!send) throw new Error('Qwen did not show its Send button.');
        await state();
        combined.throwIfAborted();
        log(`qwen: composer prepared (${Date.now() - started}ms, ${navigated ? 'navigated' : 'reused page'})`);
        stage = 'composer submission';
        confirmBy = Date.now() + 15000;
        let enteredChat = Boolean(remote);
        guard = (async () => {
          while (!watching.signal.aborted) {
            const value = await state();
            if (id && value.path === `/c/${id}`) enteredChat = true;
            const openingChat = !remote && !enteredChat && (value.path === target || value.path === '/c/new-chat' || (!id && value.path.startsWith('/c/') && CHAT_ID.test(value.path.slice(3))));
            if (value.timeOrigin !== documentTimeOrigin || (!openingChat && (!id || value.path !== `/c/${id}`))) throw new Error('The Qwen conversation changed while answering.');
            if (!submitted && Date.now() >= confirmBy) throw new Error('Qwen did not confirm this submission. No automatic retry was made.');
            await delay(250, undefined, { signal: watching.signal });
          }
        })().catch((error) => { delivering = false; throw error; });
        guard.catch(() => {});
        sent = true;
        await send.mouseClick();
        const observed = await Promise.race([observer.response, guard]);
        await state();
        const response = observed.response;
        status = response.status;
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
          const data = await Promise.race([response.json().catch(() => null), guard]);
          throw responseError(status, data, response.headers.get('retry-after')) || new Error('Qwen did not return an answer stream.');
        }
        stage = 'answer stream';
        let firstDeltaAt = 0;
        const out = await Promise.race([readStream(response, (d) => { if (!delivering || combined.aborted) return; if (!firstDeltaAt) firstDeltaAt = Date.now(); onDelta(d); }), guard]);
        await waitFor((s) => s.path === `/c/${id}` && s.ready && s.empty, 'Qwen did not finish updating its message box.');
        retained = keep;
        log(`qwen: composer answer finished (HTTP ${status}, ${Date.now() - started}ms, first word at ${firstDeltaAt ? firstDeltaAt - started : 'none'}ms, ${out.text.length} chars, model ${entry.ref}, ${remote ? 'continued' : 'new'} chat)`);
        return { ok: true, text: out.text, thinking: out.thinking, ...(retained ? { remote: { id } } : {}) };
      } catch (error) {
        stopDelivery();
        watching.abort();
        if (sent && !submitted && observer) {
          // A dispatched click can still create a chat after client cancellation.
          const waiting = new AbortController();
          try { await Promise.race([observer.response, delay(Math.max(0, confirmBy - Date.now()), undefined, { signal: waiting.signal })]); }
          catch (_) {} finally { waiting.abort(); }
        }
        observer?.stop();
        if (!error.verificationRequired && page && session && !page.closed) {
          const verification = await page.evaluate(() => Boolean(document.querySelector('#baxia-dialog-content')?.getClientRects().length)).catch(() => false);
          if (verification) Object.assign(error, { verificationRequired: true, rateLimited: true, cooldownMs: 20 * 60000, retryable: false });
        }
        account.failure(error, session);
        log(`qwen: ${stage} ${combined.aborted ? 'cancelled' : 'failed'}${Number.isInteger(error.status || status) ? ` (HTTP ${error.status || status})` : ''}${error.verificationRequired ? '; browser verification required' : ''}; no retry; ${String(error.message).replace(/\s+/g, ' ').slice(0, 160)}`);
        if ((sent || drafted) && page && !page.closed && account.readSession()?.linkId === session.linkId) {
          await page.evaluate((owner, id, submitted, prompt, timeOrigin) => {
            let token;
            try { token = JSON.parse(localStorage.getItem('qwen_access_token_state'))?.token || localStorage.getItem('token'); } catch (_) {}
            let user;
            try { user = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).id; } catch (_) {}
            if (location.origin !== 'https://chat.qwen.ai' || user !== owner || performance.timeOrigin !== timeOrigin) return;
            if (submitted) {
              if (id && location.pathname === `/c/${id}`) document.querySelector('button[aria-label="Stop"]')?.click();
              return;
            }
            const input = document.querySelector('textarea.message-input-textarea');
            if (location.pathname !== (id ? `/c/${id}` : '/') || input?.value !== prompt || document.querySelector('button[aria-label="Stop"]')?.checkVisibility({ visibilityProperty: true })) return;
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }, accountId(session.token), id, submitted, prompt, documentTimeOrigin).catch(() => {});
        }
        if (combined.aborted) return { ok: false, cancelled: true, sent, retryable: false };
        return { ok: false, sent, error: error.authExpired || error.rateLimited || error.modelMismatch || error.requestMismatch ? error.message : 'Qwen could not finish this request. The incomplete answer was not accepted and the request was not retried.', authExpired: Boolean(error.authExpired), verificationRequired: Boolean(error.verificationRequired), rateLimited: Boolean(error.rateLimited), retryable: false };
      } finally {
        combined.removeEventListener('abort', stopDelivery);
        watching.abort();
        await guard?.catch(() => {});
        observer?.stop();
        if (id && !retained && !remote) cleanup.closeRemote({ id });
      }
    }
  }

  return { token: account.token, completeOnce, closeSession, closePending: () => cleanup.closeAll(), sessions: true, orphans, busy: () => active > 0 };
}

module.exports = { createQwenWeb, REQUEST_TIMEOUT_MS };
