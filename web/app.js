/**
 * The web interface: a playground to talk to the linked models, the Accounts page (link, usage, limits), the API page (keys, base URL, copy-ready snippets)
 * and the Activity page. Plain JavaScript, no build step, no libraries. Every element is made with DOM calls, never from an HTML string, so nothing that came
 * from a model or from the server can turn into markup.
 */
'use strict';

(function () {
  const REPO = 'https://github.com/teminali/unofficial-llm-api';
  const root = document.getElementById('app');

  // ---- small helpers --------------------------------------------------------------------------------------------------------------------------

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'for') el.htmlFor = v;
      else if ((k in el) && typeof v !== 'object' && !k.includes('-')) { try { el[k] = v; } catch (_) { el.setAttribute(k, v); } } else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(`ula.${key}`); return v === null ? fallback : JSON.parse(v); } catch (_) { return fallback; } },
    set(key, value) { try { localStorage.setItem(`ula.${key}`, JSON.stringify(value)); } catch (_) { /* private mode: the page works without it */ } }
  };

  async function copyText(text, button) {
    try { await navigator.clipboard.writeText(text); } catch (_) {
      const area = h('textarea', { value: text });
      document.body.append(area);
      area.select();
      try { document.execCommand('copy'); } catch (__) { /* nothing more to try */ }
      area.remove();
    }
    if (button) { const before = button.textContent; button.textContent = 'Copied'; setTimeout(() => { button.textContent = before; }, 1200); }
  }

  const time = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (_) { return ''; } };
  const day = (iso) => { try { return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }); } catch (_) { return ''; } };

  // ---- markdown, as DOM -----------------------------------------------------------------------------------------------------------------------

  function inline(text) {
    const out = [];
    // A link's text and address are short: each "[" looks ahead a bounded distance, so a long run of brackets with no closing one costs linear time, not quadratic
    // (the page re-reads the whole answer while it streams, and an unbounded look-ahead from every "[" froze the tab on a degenerate one).
    const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\s][^*\n]*)\*|\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2000})\)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[1] !== undefined) out.push(h('code', { text: m[1] }));
      else if (m[2] !== undefined) out.push(h('strong', { text: m[2] }));
      else if (m[3] !== undefined) out.push(h('em', { text: m[3] }));
      else out.push(h('a', { href: m[5], target: '_blank', rel: 'noopener noreferrer', text: m[4] }));
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function codeBlock(code) {
    const copy = h('button', { class: 'copy', type: 'button', text: 'Copy' });
    copy.addEventListener('click', () => copyText(code, copy));
    return h('div', { class: 'codeblock' }, copy, h('pre', null, h('code', { text: code })));
  }

  function markdown(source) {
    const frag = document.createDocumentFragment();
    const lines = String(source).replace(/\r\n/g, '\n').split('\n');
    const blockStart = (l) => /^\s*```/.test(l) || /^#{1,3}\s/.test(l) || /^\s*>/.test(l) || /^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const body = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
        i += 1; // the closing fence (an unfinished block, while streaming, is just shown as far as it has come)
        frag.append(codeBlock(body.join('\n')));
        continue;
      }
      if (!line.trim()) { i += 1; continue; }
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) { frag.append(h(`h${heading[1].length}`, null, inline(heading[2]))); i += 1; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { frag.append(h('hr')); i += 1; continue; }
      if (/^\s*>/.test(line)) {
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
        frag.append(h('blockquote', null, inline(body.join(' '))));
        continue;
      }
      const unordered = /^\s*[-*+]\s+/.test(line);
      if (unordered || /^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        const pattern = unordered ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
        while (i < lines.length && pattern.test(lines[i])) { items.push(h('li', null, inline(pattern.exec(lines[i])[1]))); i += 1; }
        frag.append(h(unordered ? 'ul' : 'ol', null, items));
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && (para.length === 0 || !blockStart(lines[i]))) { para.push(lines[i]); i += 1; }
      const nodes = [];
      para.forEach((l, n) => { if (n) nodes.push(h('br')); nodes.push(...inline(l)); });
      frag.append(h('p', null, nodes));
    }
    return frag;
  }

  // ---- talking to the server ------------------------------------------------------------------------------------------------------------------

  const S = {
    state: null,
    locked: false,
    view: ['playground', 'accounts', 'api', 'activity'].includes(location.hash.slice(1)) ? location.hash.slice(1) : store.get('view', 'playground'),
    ui: {},          // per provider: { busy, note, error }
    newKey: null,    // a key just made, shown once
    snippet: store.get('snippet', 'curl'),
    shown: {}        // the last JSON each view was built from
  };

  async function admin(method, path, body) {
    const res = await fetch(`/_${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401) { S.locked = true; paint(); throw new Error('Signed out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || res.statusText);
    return data;
  }

  async function refresh() {
    try {
      S.state = await admin('GET', '/state');
      S.locked = false;
      paint();
    } catch (_) { /* a locked page paints itself; a server that went away is retried at the next tick */ }
  }

  const providerOf = (id) => (S.state ? S.state.providers.find((p) => p.id === id) : null);
  const firstModel = () => (S.state && S.state.models[0] ? S.state.models[0].id : 'MODEL');

  // ---- the shell ------------------------------------------------------------------------------------------------------------------------------

  const VIEWS = [['playground', 'Playground'], ['accounts', 'Accounts'], ['api', 'API'], ['activity', 'Activity']];
  const shell = { built: false };

  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute('data-theme', theme); else document.documentElement.removeAttribute('data-theme');
  }
  applyTheme(store.get('theme', null));

  function logo() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of [['rect', { width: 32, height: 32, rx: 8, fill: '#3a63e0' }], ['path', { d: 'M9 10h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7l-5 4v-4H9a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', fill: 'none', stroke: '#fff', 'stroke-width': 2, 'stroke-linejoin': 'round' }]]) {
      const node = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    return svg;
  }

  function buildShell() {
    const nav = h('nav', { class: 'nav', 'aria-label': 'Pages' });
    const buttons = {};
    for (const [id, label] of VIEWS) {
      buttons[id] = h('button', { type: 'button', text: label, onclick: () => show(id) });
      nav.append(buttons[id]);
    }
    const pillText = h('span', { text: `${location.origin}/v1` });
    const pillCopy = h('button', { class: 'btn small', type: 'button', text: 'Copy', onclick: (e) => copyText(`${location.origin}/v1`, e.currentTarget) });
    const theme = h('button', {
      class: 'icon-btn', type: 'button', title: 'Switch light and dark', 'aria-label': 'Switch light and dark', text: '◐',
      onclick: () => {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
        const next = dark ? 'light' : 'dark';
        applyTheme(next);
        store.set('theme', next);
      }
    });
    const top = h('header', { class: 'top' }, h('div', { class: 'top-inner' },
      h('div', { class: 'brand' }, logo(), 'Unofficial LLM API'),
      nav,
      h('div', { class: 'grow' }),
      h('div', { class: 'pill', title: 'The base URL for OpenAI-compatible clients' }, pillText, pillCopy),
      h('a', { class: 'btn small', href: `${REPO}/blob/HEAD/DONATE.md`, target: '_blank', rel: 'noopener noreferrer', title: 'This project is free. If it helped, say so.', text: '♥ Support' }),
      theme));
    const views = { playground: buildPlayground(), accounts: h('section', { 'data-view': 'accounts' }), api: h('section', { 'data-view': 'api' }), activity: h('section', { 'data-view': 'activity' }) };
    const main = h('main', null, views.playground.el, views.accounts, views.api, views.activity);
    const foot = h('footer', null, 'Unofficial: not made, endorsed or supported by DeepSeek or Google. It uses your own sessions and can get an account slowed down, muted or signed out. ',
      h('a', { href: `${REPO}/blob/HEAD/DISCLAIMER.md`, target: '_blank', rel: 'noopener noreferrer', text: 'Read the disclaimer' }), '.');
    const dialog = h('dialog', { id: 'consent' });
    root.replaceChildren(top, main, foot, dialog);
    Object.assign(shell, { built: true, buttons, views, main, dialog });
  }

  function show(id) {
    S.view = id;
    store.set('view', id);
    paint(true);
  }

  function paint(force) {
    if (S.locked) { shell.built = false; root.replaceChildren(buildLocked()); return; }
    if (!S.state) return;
    if (!shell.built) { buildShell(); force = true; }
    for (const [id] of VIEWS) {
      const on = id === S.view;
      shell.buttons[id].toggleAttribute('aria-current', on);
      if (on) shell.buttons[id].setAttribute('aria-current', 'page');
      const el = id === 'playground' ? shell.views.playground.el : shell.views[id];
      el.classList.toggle('hidden', !on);
    }
    shell.views.playground.update(S.state);
    const rebuild = (id, build, slice) => {
      const json = JSON.stringify(slice);
      const view = shell.views[id];
      const typing = view.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (S.view !== id || (!force && (S.shown[id] === json || typing))) return;
      S.shown[id] = json;
      view.replaceChildren(build());
    };
    const st = S.state;
    rebuild('accounts', buildAccounts, { p: st.providers, ui: S.ui });
    rebuild('api', buildApi, { k: st.keys, m: st.models, n: S.newKey, s: S.snippet, b: st.requireKey });
    rebuild('activity', buildActivity, { r: st.requests, n: st.notices });
  }

  function buildLocked() {
    const input = h('input', { type: 'password', placeholder: 'Admin token', autocomplete: 'off', 'aria-label': 'Admin token' });
    const go = () => { if (input.value.trim()) location.href = `/_/login?token=${encodeURIComponent(input.value.trim())}`; };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return h('div', { class: 'locked card stack' },
      h('div', { class: 'brand' }, logo(), 'Unofficial LLM API'),
      h('h2', { text: 'Sign in' }),
      h('p', { class: 'muted', text: 'This page controls accounts that can be spent, so it asks for the admin token. The terminal printed a link that signs you in; if you closed it, run this and open what it prints:' }),
      h('pre', { class: 'mono' }, h('code', { text: 'unofficial-llm-api login-url' })),
      h('p', { class: 'muted small', text: 'Or paste the token (it is the token= part of that link):' }),
      input,
      h('button', { class: 'btn primary', type: 'button', text: 'Sign in', onclick: go }));
  }

  // ---- the playground -------------------------------------------------------------------------------------------------------------------------

  function buildPlayground() {
    const pg = { history: [], busy: false, controller: null };
    const model = h('select', { 'aria-label': 'Model' });
    const system = h('textarea', { rows: 3, placeholder: 'Optional. Sets how the model behaves.', 'aria-label': 'System prompt', value: store.get('system', '') });
    system.addEventListener('input', () => store.set('system', system.value));
    const stream = h('input', { type: 'checkbox', checked: store.get('stream', true), id: 'opt-stream' });
    stream.addEventListener('change', () => store.set('stream', stream.checked));
    const effort = h('select', { 'aria-label': 'Reasoning effort' },
      h('option', { value: '', text: 'Default' }), h('option', { value: 'low', text: 'Low' }), h('option', { value: 'medium', text: 'Medium' }), h('option', { value: 'high', text: 'High' }));
    const effortField = h('label', { class: 'field' }, 'Reasoning effort', effort, h('span', { class: 'small muted', text: 'Gemini only: how long it thinks.' }));
    const messages = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite' });
    const errSlot = h('div');
    const input = h('textarea', { rows: 1, placeholder: 'Message the model (Enter sends, Shift+Enter for a new line)', 'aria-label': 'Message' });
    const sendBtn = h('button', { class: 'btn primary', type: 'button', text: 'Send' });
    const clearBtn = h('button', { class: 'btn', type: 'button', text: 'New chat' });

    const empty = () => h('div', { class: 'empty' }, h('h3', { text: 'Talk to your models' }),
      h('p', { text: S.state && S.state.models.length ? 'Pick a model and write a message. This page calls the same /v1 endpoint your own code will.' : 'No account is linked yet. Link DeepSeek or Gemini on the Accounts page, then come back.' }));
    messages.append(empty());

    function setBusy(on) {
      pg.busy = on;
      sendBtn.textContent = on ? 'Stop' : 'Send';
      sendBtn.classList.toggle('primary', !on);
      input.disabled = false;
    }

    function addMessage(role) {
      if (messages.firstChild && messages.firstChild.classList.contains('empty')) messages.replaceChildren();
      const bubble = h('div', { class: 'bubble' });
      const meta = h('div', { class: 'meta' });
      const wrap = h('div', { class: `msg ${role}` }, bubble, meta);
      messages.append(wrap);
      messages.scrollTop = messages.scrollHeight;
      return { bubble, meta, wrap };
    }

    function showError(message, code, retry) {
      errSlot.replaceChildren(h('div', { class: 'errbox notice bad' }, h('strong', { text: message }), code ? h('span', { class: 'small', text: `  (${code}${retry ? `, retry in ${retry}s` : ''})` }) : null));
    }

    async function send() {
      const text = input.value.trim();
      if (!text || pg.busy) return;
      const chosen = model.value;
      if (!chosen) { showError('No model to send to. Link an account first.'); return; }
      errSlot.replaceChildren();
      input.value = '';
      input.style.height = '';
      pg.history.push({ role: 'user', content: text });
      const sent = addMessage('user');
      sent.bubble.textContent = text;
      const out = addMessage('assistant');
      // A message the server refused is taken back whole: its bubble goes, and the words return to the box to be sent again.
      const takeBack = () => {
        pg.history.pop();
        sent.wrap.remove();
        out.wrap.remove();
        input.value = text;
        if (!messages.firstChild) messages.replaceChildren(empty());
      };
      let answer = '';
      let thought = '';
      let usage = null;
      let paintQueued = false;
      const think = h('details', { class: 'think' }, h('summary', { text: 'Thinking' }), h('div', { class: 'body' }));
      const body = h('div');
      const paintOut = () => {
        paintQueued = false;
        out.bubble.replaceChildren();
        if (thought) { think.querySelector('.body').textContent = thought; out.bubble.append(think); }
        body.replaceChildren(markdown(answer));
        out.bubble.append(body);
        out.bubble.classList.toggle('typing', pg.busy && !!answer);
        messages.scrollTop = messages.scrollHeight;
      };
      const queue = () => { if (!paintQueued) { paintQueued = true; requestAnimationFrame(paintOut); } };
      out.bubble.classList.add('typing');
      pg.controller = new AbortController();
      setBusy(true);
      const started = Date.now();
      const request = { model: chosen, stream: stream.checked, messages: [...(system.value.trim() ? [{ role: 'system', content: system.value.trim() }] : []), ...pg.history] };
      if (stream.checked) request.stream_options = { include_usage: true };
      if (effort.value && !effortField.classList.contains('hidden')) request.reasoning_effort = effort.value;
      try {
        const res = await fetch('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: pg.controller.signal });
        if (!res.ok) {
          const err = ((await res.json().catch(() => ({}))).error) || {};
          showError(err.message || `The server answered ${res.status}.`, err.code, res.headers.get('retry-after'));
          takeBack();
          return;
        }
        if (!stream.checked) {
          const data = await res.json();
          const msg = data.choices[0].message;
          answer = msg.content || '';
          thought = msg.reasoning_content || '';
          usage = data.usage;
        } else {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let at;
            while ((at = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, at);
              buffer = buffer.slice(at + 2);
              const line = block.split('\n').find((l) => l.startsWith('data: '));
              if (!line || line.slice(6) === '[DONE]') continue;
              const event = JSON.parse(line.slice(6));
              if (event.error) { showError(event.error.message, event.error.code); continue; }
              if (event.usage) usage = event.usage;
              const delta = event.choices && event.choices[0] && event.choices[0].delta;
              if (!delta) continue;
              if (delta.reasoning_content) thought += delta.reasoning_content;
              if (delta.content) answer += delta.content;
              queue();
            }
          }
        }
        pg.history.push({ role: 'assistant', content: answer });
        out.meta.textContent = `${chosen} · ${((Date.now() - started) / 1000).toFixed(1)} s${usage ? ` · ~${usage.total_tokens} tokens (estimated)` : ''}`;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          out.meta.textContent = 'Stopped';
          if (answer) pg.history.push({ role: 'assistant', content: answer }); else takeBack();
        } else {
          showError(String((err && err.message) || err));
          if (!answer) takeBack();
        }
      } finally {
        setBusy(false);
        pg.controller = null;
        paintOut();
        refresh();
      }
    }

    sendBtn.addEventListener('click', () => { if (pg.busy) { if (pg.controller) pg.controller.abort(); } else send(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; });
    clearBtn.addEventListener('click', () => { if (pg.controller) pg.controller.abort(); pg.history = []; errSlot.replaceChildren(); messages.replaceChildren(empty()); });

    const side = h('aside', { class: 'side' },
      h('div', { class: 'card stack' },
        h('label', { class: 'field' }, 'Model', model),
        effortField,
        h('label', { class: 'field' }, 'System prompt', system),
        h('label', { class: 'row small' }, stream, 'Stream the answer'),
        clearBtn),
      h('p', { class: 'small muted', text: 'Each message is sent with the whole conversation, like any API call: the accounts behind this answer one message at a time and keep no memory of their own.' }));
    const chat = h('section', { class: 'chat card' }, messages, errSlot, h('div', { class: 'composer' }, input, sendBtn));
    const el = h('div', { class: 'play' }, side, chat);

    let lastModels = '';
    function update(state) {
      const list = state.models;
      const json = JSON.stringify(list.map((m) => [m.id, m.provider]));
      if (json !== lastModels) {
        lastModels = json;
        const keep = model.value || store.get('model', '');
        model.replaceChildren();
        for (const p of state.providers) {
          const own = list.filter((m) => m.provider === p.id);
          if (!own.length) continue;
          model.append(h('optgroup', { label: p.name }, own.map((m) => h('option', { value: m.id, text: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id }))));
        }
        if (list.some((m) => m.id === keep)) model.value = keep; else if (list[0]) model.value = list[0].id;
        if (messages.firstChild && messages.firstChild.classList.contains('empty')) messages.replaceChildren(empty());
      }
      const chosen = list.find((m) => m.id === model.value);
      const owner = chosen ? state.providers.find((p) => p.id === chosen.provider) : null;
      effortField.classList.toggle('hidden', !(owner && owner.capabilities && (owner.capabilities.settings || []).includes('thinkingLevel')));
      sendBtn.disabled = !list.length && !pg.busy;
    }
    model.addEventListener('change', () => { store.set('model', model.value); update(S.state); });
    return { el, update };
  }

  // ---- accounts -------------------------------------------------------------------------------------------------------------------------------

  const HOW = {
    deepseek: 'Opens a Chrome window so you can sign in to chat.deepseek.com yourself. The session is kept on this computer and used for each request. Answers come from the same models the website uses.',
    gemini: 'Opens Chrome on a private profile so you can sign in to gemini.google.com yourself. Chat then runs in that Chrome, in the background. Your requests show up in your Gemini activity like any chat you typed.'
  };

  function ui(id) { return (S.ui[id] = S.ui[id] || {}); }

  async function act(id, fn) {
    const u = ui(id);
    u.busy = true;
    u.error = '';
    paint(true);
    try { await fn(); } catch (err) { u.error = String((err && err.message) || err); } finally { u.busy = false; await refresh(); paint(true); }
  }

  function consent(provider) {
    return new Promise((resolve) => {
      const ok = h('input', { type: 'checkbox', id: 'consent-ok' });
      const go = h('button', { class: 'btn primary', type: 'button', text: 'Open Chrome and sign in', disabled: true });
      const no = h('button', { class: 'btn', type: 'button', text: 'Cancel' });
      ok.addEventListener('change', () => { go.disabled = !ok.checked; });
      const dialog = shell.dialog;
      const done = (value) => { dialog.close(); resolve(value); };
      go.addEventListener('click', () => done(true));
      no.addEventListener('click', () => done(false));
      dialog.addEventListener('cancel', () => resolve(false), { once: true });
      dialog.replaceChildren(
        h('h2', { text: `Link ${provider.name}` }),
        h('ul', null,
          h('li', { text: `You sign in to ${provider.name} yourself. This program never sees your password; it keeps the session it gets on this computer, in your data folder.` }),
          h('li', { text: `${provider.name} does not offer this as an API and has not agreed to it. Using an account this way may break its terms.` }),
          h('li', { text: 'The account can be slowed down, muted or signed out. Requests are paced and capped to lower that risk. They cannot remove it.' }),
          h('li', { text: 'Use an account you can afford to lose. You are responsible for how you use it.' })),
        h('label', { class: 'row', for: 'consent-ok' }, ok, 'I understand and accept this.'),
        h('div', { class: 'row' }, go, no));
      dialog.showModal();
    });
  }

  function usageBlock(p) {
    const u = p.usage;
    if (!u) return null;
    const pct = Math.min(100, Math.round((u.todayCalls / Math.max(1, u.dailyCap)) * 100));
    const meter = h('div', { class: `meter${pct >= 100 ? ' full' : ''}`, role: 'progressbar', 'aria-valuenow': u.todayCalls, 'aria-valuemin': 0, 'aria-valuemax': u.dailyCap, 'aria-label': 'Calls today' }, h('i'));
    meter.firstChild.style.width = `${pct}%`;
    return h('div', { class: 'stack' },
      h('div', { class: 'row small' }, h('strong', { text: `${u.todayCalls} of ${u.dailyCap}` }), h('span', { class: 'muted', text: 'calls today' }), h('span', { class: 'grow' }),
        h('span', { class: 'muted', text: `${u.callsThisMinute} of ${u.perMinute} this minute${u.minGapMs >= 1000 ? ` · at least ${Math.round(u.minGapMs / 1000)} s apart` : ''}${u.queued ? ` · ${u.queued} waiting` : ''}` })),
      meter,
      u.isCooldown ? h('div', { class: 'notice warn row' }, h('span', { class: 'grow', text: `Paused to protect the account: ${u.cooldownReason || 'the provider pushed back'}. Until ${time(u.cooldownUntil)}.` }),
        h('button', { class: 'btn small', type: 'button', text: 'Clear pause', onclick: () => act(p.id, () => admin('POST', `/providers/${p.id}/reset`, {})) })) : null);
  }

  function providerCard(p) {
    const u = ui(p.id);
    const caps = p.capabilities || {};
    const demo = Boolean(caps.demo);
    const status = !p.linked ? ['Not linked', ''] : p.expired ? ['Sign-in expired', 'bad'] : p.linking ? ['Waiting for you', 'warn'] : [demo ? 'Always on' : 'Linked', 'good'];
    const actions = [];
    if (!demo) {
      if (p.linking) {
        actions.push(h('button', { class: 'btn primary', type: 'button', text: 'I have signed in', disabled: u.busy, onclick: () => act(p.id, async () => { const r = await admin('POST', `/providers/${p.id}/finish`, {}); u.note = r.notSignedIn ? r.note : ''; if (r.error) throw new Error(r.error); }) }));
        actions.push(h('button', { class: 'btn', type: 'button', text: 'Cancel', disabled: u.busy, onclick: () => act(p.id, () => admin('POST', `/providers/${p.id}/finish`, { cancel: true })) }));
      } else {
        actions.push(h('button', { class: `btn${p.linked && !p.expired ? '' : ' primary'}`, type: 'button', text: p.linked ? 'Sign in again' : 'Link account', disabled: u.busy, onclick: async () => {
          if (!(await consent(p))) return;
          act(p.id, async () => { const r = await admin('POST', `/providers/${p.id}/link`, { consentAcknowledged: true }); if (r.error) throw new Error(r.error); u.note = ''; });
        } }));
        if (p.linked) actions.push(h('button', { class: 'btn danger', type: 'button', text: 'Unlink', disabled: u.busy, onclick: () => { if (confirm(`Unlink ${p.name}? The saved session is deleted from this computer.`)) act(p.id, () => admin('POST', `/providers/${p.id}/unlink`, {})); } }));
      }
    }
    const cap = h('input', { class: 'narrow', type: 'number', min: 1, max: 100000, value: p.usage ? p.usage.dailyCap : 300, 'aria-label': 'Daily call cap' });
    const settings = [];
    settings.push(h('label', { class: 'field' }, 'Daily call cap', h('div', { class: 'row' }, cap, h('button', { class: 'btn small', type: 'button', text: 'Save', onclick: () => act(p.id, () => admin('PUT', `/providers/${p.id}/settings`, { dailyCap: Number(cap.value) })) }))));
    if ((caps.settings || []).includes('thinkingLevel')) {
      const level = h('select', { 'aria-label': 'Thinking level' }, ['low', 'medium', 'high'].map((l) => h('option', { value: l, text: l[0].toUpperCase() + l.slice(1), selected: p.thinkingLevel === l })));
      level.addEventListener('change', () => act(p.id, () => admin('PUT', `/providers/${p.id}/settings`, { thinkingLevel: level.value })));
      settings.push(h('label', { class: 'field' }, 'Default thinking level', level, p.thinkingNote ? h('span', { class: 'small', text: p.thinkingNote }) : null));
    }
    let tokenBox = null;
    if (caps.token && !demo) {
      const token = h('input', { type: 'password', placeholder: 'Paste the token', autocomplete: 'off', 'aria-label': `${p.name} session token` });
      tokenBox = h('details', { class: 'fold' }, h('summary', { text: 'Advanced: paste a session token instead' }),
        h('div', { class: 'stack' },
          h('p', { class: 'small muted', text: 'For a server with no Chrome. Open the provider\'s website signed in, then in the browser\'s developer tools find the session token in local storage (for DeepSeek: the "value" inside userToken). It is stored like a login.' }),
          token,
          h('button', { class: 'btn small', type: 'button', text: 'Use this token', onclick: () => act(p.id, async () => { const r = await admin('POST', `/providers/${p.id}/token`, { token: token.value, consentAcknowledged: true }); if (r.error) throw new Error(r.error); }) })));
    }
    return h('article', { class: 'card stack' },
      h('div', { class: 'row' }, h('h2', { class: 'grow', text: p.name }), h('span', { class: `chip ${status[1]}` }, h('i', { class: 'dot' }), status[0])),
      demo ? h('p', { class: 'muted', text: 'Answers by describing what it was sent. It needs no account: use it to try the interface and your client.' }) : h('p', { class: 'muted small', text: HOW[p.id] || 'Signs in with your own account in a Chrome window.' }),
      p.expired ? h('div', { class: 'notice bad', text: p.expiredReason || 'The sign-in expired. Sign in again.' }) : null,
      p.linking ? h('div', { class: 'notice', text: p.linkNote || 'A Chrome window is open. Sign in there, then press "I have signed in".' }) : null,
      u.note ? h('div', { class: 'notice warn', text: u.note }) : null,
      u.error ? h('div', { class: 'notice bad', text: u.error }) : null,
      p.linked && !p.expired ? h('div', { class: 'models' }, (p.models || []).map((m) => h('span', { class: 'chip accent', title: m.id, text: m.name || m.id }))) : null,
      p.linked && p.linkedAt ? h('dl', { class: 'kv' }, h('dt', { text: 'Linked' }), h('dd', { text: `${day(p.linkedAt)}${p.accountLabel ? ` as ${p.accountLabel}` : ''}` })) : null,
      usageBlock(p),
      h('div', { class: 'row' }, actions),
      h('div', { class: 'stack' }, settings),
      tokenBox);
  }

  function buildAccounts() {
    return h('div', { class: 'stack' },
      h('div', null, h('h2', { text: 'Accounts' }), h('p', { class: 'muted', text: 'Link the accounts you want to use. Linking is local: nothing here goes to a server of ours, and there is none.' })),
      h('div', { class: 'providers' }, S.state.providers.map(providerCard)));
  }

  // ---- API ------------------------------------------------------------------------------------------------------------------------------------

  function snippets(base, key, model) {
    const k = key || 'YOUR_KEY';
    return {
      curl: `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer ${k}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "${model}",\n    "messages": [{"role": "user", "content": "Say hello in five words."}]\n  }'`,
      python: `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}/v1", api_key="${k}")\n\nreply = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Say hello in five words."}],\n)\nprint(reply.choices[0].message.content)`,
      stream: `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}/v1", api_key="${k}")\n\nfor chunk in client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Write a haiku about rain."}],\n    stream=True,\n):\n    print(chunk.choices[0].delta.content or "", end="", flush=True)`,
      node: `import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "${base}/v1", apiKey: "${k}" });\n\nconst reply = await client.chat.completions.create({\n  model: "${model}",\n  messages: [{ role: "user", content: "Say hello in five words." }],\n});\nconsole.log(reply.choices[0].message.content);`
    };
  }

  function buildApi() {
    const st = S.state;
    const base = location.origin;
    const name = h('input', { type: 'text', placeholder: 'Name, for example "laptop script"', 'aria-label': 'Key name', maxLength: 60 });
    const make = () => act('keys', async () => { const r = await admin('POST', '/keys', { name: name.value }); S.newKey = r.key; });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') make(); });
    const keyRows = st.keys.map((k) => h('tr', null,
      h('td', null, k.name), h('td', { class: 'mono', text: k.hint }), h('td', { class: 'muted', text: day(k.createdAt) }), h('td', { class: 'muted', text: k.lastUsedAt ? `${day(k.lastUsedAt)} ${time(k.lastUsedAt)}` : 'never' }),
      h('td', null, h('button', { class: 'btn small danger', type: 'button', text: 'Revoke', onclick: () => { if (confirm(`Revoke "${k.name}"? Anything using it stops working.`)) act('keys', () => admin('DELETE', `/keys/${k.id}`)); } }))));
    const code = snippets(base, S.newKey, firstModel());
    const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Example language' },
      [['curl', 'curl'], ['python', 'Python'], ['stream', 'Python, streaming'], ['node', 'Node']].map(([id, label]) => h('button', { type: 'button', 'aria-pressed': S.snippet === id ? 'true' : 'false', text: label, onclick: () => { S.snippet = id; store.set('snippet', id); paint(true); } })));
    return h('div', { class: 'stack' },
      h('div', null, h('h2', { text: 'API' }), h('p', { class: 'muted', text: 'An OpenAI-compatible endpoint. Point any client that lets you set a base URL and a key at it.' })),
      h('div', { class: 'cols' },
        h('div', { class: 'stack' },
          h('section', { class: 'card stack' },
            h('h3', { text: 'Base URL' }),
            h('div', { class: 'pill' }, h('span', { text: `${base}/v1` }), h('button', { class: 'btn small', type: 'button', text: 'Copy', onclick: (e) => copyText(`${base}/v1`, e.currentTarget) })),
            h('p', { class: 'small muted', text: 'Routes: GET /v1/models and POST /v1/chat/completions (streaming, tool calls, JSON mode, reasoning_content).' })),
          h('section', { class: 'card stack' },
            h('h3', { text: 'API keys' }),
            st.requireKey ? null : h('div', { class: 'notice warn', text: 'The server was started with --no-key: /v1 works without one, on this computer only.' }),
            S.newKey ? h('div', { class: 'newkey stack' }, h('strong', { text: 'Your new key. Copy it now: it is not shown again.' }), h('code', { text: S.newKey }),
              h('div', { class: 'row' }, h('button', { class: 'btn small primary', type: 'button', text: 'Copy key', onclick: (e) => copyText(S.newKey, e.currentTarget) }), h('button', { class: 'btn small', type: 'button', text: 'Done', onclick: () => { S.newKey = null; paint(true); } }))) : null,
            h('div', { class: 'row' }, h('div', { class: 'grow' }, name), h('button', { class: 'btn primary', type: 'button', text: 'Make a key', onclick: make })),
            st.keys.length ? h('div', { class: 'scroll-x' }, h('table', null, h('thead', null, h('tr', null, ['Name', 'Key', 'Made', 'Last used', ''].map((c) => h('th', { text: c })))), h('tbody', null, keyRows))) : h('p', { class: 'small muted', text: 'No keys yet.' }))),
        h('div', { class: 'stack' },
          h('section', { class: 'card stack' }, h('h3', { text: 'Try it' }), tabs,
            h('div', { class: 'codeblock' }, h('button', { class: 'copy', type: 'button', text: 'Copy', onclick: (e) => copyText(code[S.snippet], e.currentTarget) }), h('pre', null, h('code', { text: code[S.snippet] }))),
            S.newKey ? h('p', { class: 'small muted', text: 'The snippet has your new key in it.' }) : h('p', { class: 'small muted', text: 'Replace YOUR_KEY with a key from this page.' })),
          h('section', { class: 'card stack' }, h('h3', { text: 'Models you can use now' }),
            st.models.length ? h('div', { class: 'scroll-x' }, h('table', null, h('thead', null, h('tr', null, ['Model id', 'Provider', ''].map((c) => h('th', { text: c })))),
              h('tbody', null, st.models.map((m) => h('tr', null, h('td', { class: 'mono', text: m.id }), h('td', { text: m.provider }), h('td', { class: 'muted small', text: m.thinking ? 'thinks' : m.escalate ? 'thinks on hard steps (with tools)' : '' })))))) : h('p', { class: 'small muted', text: 'None yet: link an account on the Accounts page.' })))));
  }

  // ---- activity -------------------------------------------------------------------------------------------------------------------------------

  function buildActivity() {
    const st = S.state;
    const rows = st.requests.map((r) => h('tr', null,
      h('td', { class: 'muted', text: time(r.at) }), h('td', { class: 'mono', text: r.model }), h('td', { text: r.by }),
      h('td', null, h('span', { class: `chip ${r.status === 200 ? 'good' : r.status === 499 ? '' : 'bad'}`, text: r.code && r.status !== 200 ? `${r.status} ${r.code}` : String(r.status) })),
      h('td', { class: 'muted', text: `${(r.ms / 1000).toFixed(1)} s` }), h('td', { class: 'muted', text: [r.stream ? 'stream' : '', r.tools ? `${r.tools} tools` : ''].filter(Boolean).join(', ') })));
    return h('div', { class: 'stack' },
      h('div', null, h('h2', { text: 'Activity' }), h('p', { class: 'muted', text: 'The last requests, newest first. Only the model, who asked, the result and the time are kept, in memory: never a prompt or an answer.' })),
      st.notices.length ? h('section', { class: 'card stack' }, h('h3', { text: 'Notices' }), st.notices.map((n) => h('div', { class: 'row small' }, h('span', { class: 'muted', text: time(n.at) }), h('span', { class: `chip ${n.kind === 'looping' ? 'warn' : 'bad'}`, text: n.provider }), h('span', { text: n.short })))) : null,
      h('section', { class: 'card' }, rows.length ? h('div', { class: 'scroll-x' }, h('table', null, h('thead', null, h('tr', null, ['Time', 'Model', 'By', 'Result', 'Took', ''].map((c) => h('th', { text: c })))), h('tbody', null, rows))) : h('p', { class: 'muted', text: 'Nothing yet.' })));
  }

  // ---- start ----------------------------------------------------------------------------------------------------------------------------------

  refresh();
  setInterval(() => {
    if (document.hidden) return;
    if (S.locked) return;
    refresh();
  }, 2500);
})();
