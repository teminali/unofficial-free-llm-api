/**
 * The web interface: a playground to talk to the linked models, the Accounts page (link, usage, limits, open chats), the API page (keys, base URL, copy-ready
 * values for the tools that connect) and the Activity page. Plain JavaScript, no build step, no libraries. Every element is made with DOM calls, never from an
 * HTML string, so nothing that came from a model or from the server can turn into markup. Icons are SVG built with createElementNS.
 */
'use strict';

(function () {
  const REPO = 'https://github.com/teminali/unofficial-free-llm-api';
  const root = document.getElementById('app');
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TITLE = 'Unofficial Free LLM API';

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

  // Icons: stroke icons on a 24 grid, made as SVG elements (never from a string). A part is a path's `d`, or [tag, attributes].
  const ICONS = {
    chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
    users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', ['circle', { cx: 9, cy: 7, r: 4 }], 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
    code: ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6'],
    activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
    sun: [['circle', { cx: 12, cy: 12, r: 4 }], 'M12 2v2', 'M12 20v2', 'M4.93 4.93l1.41 1.41', 'M17.66 17.66l1.41 1.41', 'M2 12h2', 'M20 12h2', 'M6.34 17.66l-1.41 1.41', 'M19.07 4.93l-1.41 1.41'],
    moon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'],
    monitor: [['rect', { x: 2, y: 3, width: 20, height: 14, rx: 2 }], 'M8 21h8', 'M12 17v4'],
    copy: [['rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }], 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
    check: ['M20 6L9 17l-5-5'],
    retry: ['M23 4v6h-6', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10'],
    trash: ['M3 6h18', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6', 'M10 11v6', 'M14 11v6', 'M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2'],
    eye: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z', ['circle', { cx: 12, cy: 12, r: 3 }]],
    eyeOff: ['M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94', 'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19', 'M14.12 14.12a3 3 0 1 1-4.24-4.24', 'M1 1l22 22'],
    send: ['M12 19V5', 'M5 12l7-7 7 7'],
    stop: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }]],
    heart: ['M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z'],
    sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
    plus: ['M12 5v14', 'M5 12h14'],
    terminal: ['M4 17l6-6-6-6', 'M12 19h8'],
    alert: [['circle', { cx: 12, cy: 12, r: 10 }], 'M12 8v4', 'M12 16h.01'],
    key: [['circle', { cx: 7.5, cy: 15.5, r: 4.5 }], 'M10.7 12.3L21 2', 'M16 7l3 3', 'M18.5 4.5l2 2'],
    link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71']
  };

  function icon(name, size = 18) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'icon' })) svg.setAttribute(k, v);
    for (const part of ICONS[name] || []) {
      const [tag, attrs] = typeof part === 'string' ? ['path', { d: part }] : part;
      const node = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    return svg;
  }

  /** A button with an optional icon and a text label (the label is its own span, so a "Copied" flash can swap it). */
  function btn(label, props = {}, iconName = null) {
    const { class: cls = '', ...rest } = props;
    return h('button', { type: 'button', ...rest, class: `btn ${cls}`.trim() }, iconName ? icon(iconName, 16) : null, label ? h('span', { class: 'lbl', text: label }) : null);
  }

  /** A button that is only an icon: it must carry its name. */
  function iconBtn(name, label, props = {}) {
    const { class: cls = '', ...rest } = props;
    return h('button', { type: 'button', 'aria-label': label, title: label, ...rest, class: `btn icon-only ${cls}`.trim() }, icon(name, 16));
  }

  let liveEl = null;
  function announce(text) {
    if (!liveEl) return;
    liveEl.textContent = '';
    setTimeout(() => { liveEl.textContent = text; }, 40);
  }

  function flash(button) {
    if (!button || button.dataset.flashing) return;
    button.dataset.flashing = '1';
    const lbl = button.querySelector('.lbl');
    const svg = button.querySelector('svg');
    const before = lbl ? lbl.textContent : button.textContent;
    const done = icon('check', 16);
    if (lbl) lbl.textContent = 'Copied';
    else if (svg) svg.replaceWith(done);
    else button.textContent = 'Copied';
    button.classList.add('is-done');
    setTimeout(() => {
      if (lbl) lbl.textContent = before;
      else if (svg) { if (done.isConnected) done.replaceWith(svg); } else button.textContent = before;
      button.classList.remove('is-done');
      delete button.dataset.flashing;
    }, 1300);
  }

  async function copyText(text, button) {
    try { await navigator.clipboard.writeText(text); } catch (_) {
      const area = h('textarea', { value: text, 'aria-hidden': 'true', class: 'offscreen' });
      document.body.append(area);
      area.select();
      try { document.execCommand('copy'); } catch (__) { /* nothing more to try */ }
      area.remove();
    }
    announce('Copied to the clipboard');
    flash(button);
  }

  const time = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (_) { return ''; } };
  const day = (iso) => { try { return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }); } catch (_) { return ''; } };
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (!Number.isFinite(s)) return '';
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return day(iso);
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
  const rand = (n) => {
    let bytes;
    try { bytes = crypto.getRandomValues(new Uint8Array(n)); } catch (_) { bytes = Array.from({ length: n }, () => Math.floor(Math.random() * 256)); }
    return Array.from(bytes, (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  };

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

  const VIEWS = [['playground', 'Playground', 'chat'], ['accounts', 'Accounts', 'users'], ['api', 'API', 'code'], ['activity', 'Activity', 'activity']];
  const viewIds = VIEWS.map((v) => v[0]);

  const S = {
    state: null,
    locked: false,
    view: viewIds.includes(location.hash.slice(1)) ? location.hash.slice(1) : store.get('view', 'playground'),
    ui: {},               // per provider: { busy, note, error }
    useKey: null,         // the key put into the examples: { id, name, secret } (kept in memory only; never in the page unless the person reveals it)
    reveal: false,        // whether that key is on show in full
    keyBusy: false,
    tool: store.get('tool', 'openai'),
    snippet: store.get('snippet', 'curl'),
    model: '',            // '' = the recommended model for the example; else a model id
    filter: 'all',        // Activity: all | errors
    shown: {}             // the last JSON each view was built from
  };
  if (!viewIds.includes(S.view)) S.view = 'playground';

  async function admin(method, path, body) {
    const res = await fetch(`/_${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401) { S.locked = true; paint(); throw new Error('Signed out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || res.statusText);
    return data;
  }

  /** The request list lives in the program's memory and starts empty after a restart, so the first request ever seen is saved in this browser. */
  const firstRequestDone = () => store.get('firstRequestDone', false) === true;
  function rememberFirstRequest() { if (!firstRequestDone()) store.set('firstRequestDone', true); }

  async function refresh() {
    try {
      S.state = await admin('GET', '/state');
      S.locked = false;
      if (S.state.requests && S.state.requests.length) rememberFirstRequest();
      paint();
    } catch (_) { /* a locked page paints itself; a server that went away is retried at the next tick */ }
  }

  const modelList = () => (S.state ? S.state.models : []);
  /** The model for plain chat examples: the first one that does not think and is not the tool-escalating one (deepseek-chat), else the first. */
  const plainModel = () => { const ms = modelList(); return (ms.find((m) => !m.thinking && !m.escalate) || ms[0] || { id: 'MODEL' }).id; };
  /** The model for agents that send tools: the one that escalates hard steps (deepseek-auto), else the plain one. */
  const agentModel = () => { const ms = modelList(); return (ms.find((m) => m.escalate) || ms.find((m) => !m.thinking) || ms[0] || { id: 'MODEL' }).id; };
  const exampleModel = (agent) => S.model || (agent ? agentModel() : plainModel());

  // ---- theme ----------------------------------------------------------------------------------------------------------------------------------

  const THEMES = [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']];
  let theme = store.get('theme', 'system');
  if (!THEMES.some((t) => t[0] === theme)) theme = 'system';
  function applyTheme(mode) {
    if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode); else document.documentElement.removeAttribute('data-theme');
  }
  applyTheme(theme);

  function themeControl() {
    const buttons = THEMES.map(([id, label, ic]) => h('button', {
      type: 'button', class: 'seg-btn', 'data-theme-choice': id, 'aria-label': `${label} theme`, title: `${label} theme`, 'aria-pressed': theme === id ? 'true' : 'false',
      onclick: () => {
        theme = id;
        applyTheme(id);
        store.set('theme', id);
        for (const b of buttons) b.setAttribute('aria-pressed', b.dataset.themeChoice === id ? 'true' : 'false');
        announce(`Theme: ${label}${id === 'system' ? ' (follows this device)' : ''}`);
      }
    }, icon(ic, 16), h('span', { class: 'seg-label', text: label })));
    return h('div', { class: 'theme' }, h('span', { class: 'tools-label', id: 'theme-label', text: 'Theme' }), h('div', { class: 'seg', role: 'group', 'aria-labelledby': 'theme-label' }, buttons));
  }

  // ---- the shell ------------------------------------------------------------------------------------------------------------------------------

  const shell = { built: false };

  function logo() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'logo');
    for (const [tag, attrs] of [['rect', { width: 32, height: 32, rx: 8, fill: 'currentColor' }], ['path', { d: 'M9 10h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7l-5 4v-4H9a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', fill: 'none', stroke: '#fff', 'stroke-width': 2, 'stroke-linejoin': 'round' }],
      ['circle', { cx: 12.5, cy: 15.5, r: 1.4, fill: '#fff' }], ['circle', { cx: 16, cy: 15.5, r: 1.4, fill: '#fff' }], ['circle', { cx: 19.5, cy: 15.5, r: 1.4, fill: '#fff' }]]) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    return svg;
  }

  function buildShell() {
    const buttons = {};
    const nav = h('nav', { class: 'nav', 'aria-label': 'Pages' });
    for (const [id, label, ic] of VIEWS) {
      buttons[id] = h('button', { type: 'button', class: 'nav-item', onclick: () => show(id, { focus: true }) }, icon(ic, 20), h('span', { class: 'nav-label', text: label }));
      nav.append(buttons[id]);
    }
    const url = `${location.origin}/v1`;
    const pillCopy = iconBtn('copy', 'Copy the base URL', { class: 'ghost', onclick: (e) => copyText(url, e.currentTarget) });
    const endpoint = h('div', { class: 'endpoint' }, h('span', { class: 'tools-label', text: 'Base URL' }), h('div', { class: 'pill', title: 'The base URL for OpenAI-compatible clients' }, h('span', { class: 'mono' }, location.origin, h('wbr'), '/v1'), pillCopy));
    const rail = h('header', { class: 'rail' }, h('div', { class: 'brand' }, logo(), h('span', { class: 'brand-name', text: TITLE })), nav, h('div', { class: 'rail-tools' }, endpoint, themeControl()));

    const views = { playground: buildPlayground() };
    for (const id of viewIds.slice(1)) views[id] = h('section', { class: 'view', 'data-view': id });
    const main = h('main', { id: 'main', tabindex: '-1' }, views.playground.el, viewIds.slice(1).map((id) => views[id]));
    const foot = h('footer', { class: 'foot' },
      h('p', { class: 'foot-text', text: 'Unofficial: not made, endorsed or supported by DeepSeek, Google or Qwen. It uses your own sessions and can get an account slowed down, muted or signed out.' }),
      h('p', { class: 'foot-links' },
        h('a', { href: `${REPO}/blob/HEAD/DISCLAIMER.md`, target: '_blank', rel: 'noopener noreferrer', text: 'Read the disclaimer' }),
        h('a', { class: 'support', href: `${REPO}/blob/HEAD/DONATE.md`, target: '_blank', rel: 'noopener noreferrer', title: 'This project is free. If it helped, say so.' }, icon('heart', 14), 'Support the project')));
    const skip = h('a', { class: 'skip', href: '#main', text: 'Skip to the page', onclick: (e) => { e.preventDefault(); main.focus(); } });
    const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    const dialogs = h('div', { class: 'dialogs' });
    liveEl = live;
    root.replaceChildren(skip, h('div', { class: 'shell' }, rail, main, foot), dialogs, live);
    Object.assign(shell, { built: true, buttons, views, main, dialogs });
  }

  function show(id, { focus = false } = {}) {
    if (!viewIds.includes(id)) return;
    S.view = id;
    store.set('view', id);
    try { if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`); } catch (_) { /* a page with no history: the view still changes */ }
    paint(true);
    if (shell.main) shell.main.scrollTop = 0;
    if (focus) {
      const head = shell.main && shell.main.querySelector(`[data-view="${id}"] h1`);
      if (head) head.focus({ preventScroll: true });
    }
  }
  window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (viewIds.includes(id) && id !== S.view) show(id); });

  const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  const labelOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40);

  /** Where the keyboard was, so that a page that is built again (its numbers changed) does not drop the person back to the top. */
  function focusSnapshot(view) {
    const a = document.activeElement;
    if (!a || a === view || !view.contains(a)) return null;
    return { i: [...view.querySelectorAll(FOCUSABLE)].indexOf(a), tag: a.tagName, label: labelOf(a) };
  }
  function focusRestore(view, snap) {
    if (!snap) return;
    const list = [...view.querySelectorAll(FOCUSABLE)];
    const target = list.find((el) => el.tagName === snap.tag && labelOf(el) === snap.label) || (snap.i >= 0 && list[snap.i] && list[snap.i].tagName === snap.tag ? list[snap.i] : null) || view.querySelector('h1');
    if (target) target.focus({ preventScroll: true });
  }

  function paint(force) {
    if (S.locked) { shell.built = false; liveEl = null; root.replaceChildren(buildLocked()); return; }
    if (!S.state) return;
    if (!shell.built) { buildShell(); force = true; }
    const label = (VIEWS.find((v) => v[0] === S.view) || VIEWS[0])[1];
    document.title = `${label} · ${TITLE}`;
    for (const [id] of VIEWS) {
      const on = id === S.view;
      shell.buttons[id].removeAttribute('aria-current');
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
      const snap = focusSnapshot(view);
      view.replaceChildren(build());
      focusRestore(view, snap);
    };
    const st = S.state;
    const tick = st.sessions && st.sessions.length ? Math.floor(Date.now() / 30000) : 0;
    rebuild('accounts', buildAccounts, { p: st.providers, s: st.sessions, ui: S.ui, tick });
    rebuild('api', buildApi, { k: st.keys, m: st.models, u: S.useKey && S.useKey.id, r: S.reveal, t: S.tool, s: S.snippet, x: S.model, b: st.requireKey, bz: S.keyBusy });
    rebuild('activity', buildActivity, { r: st.requests, n: st.notices, f: S.filter });
  }

  function buildLocked() {
    const input = h('input', { type: 'password', placeholder: 'Admin token', autocomplete: 'off', 'aria-label': 'Admin token' });
    const go = () => { if (input.value.trim()) location.href = `/_/login?token=${encodeURIComponent(input.value.trim())}`; };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return h('main', { class: 'locked-page' }, h('div', { class: 'locked card stack' },
      h('div', { class: 'brand' }, logo(), h('span', { class: 'brand-name', text: TITLE })),
      h('h1', { class: 'h2', text: 'Sign in' }),
      h('p', { class: 'muted', text: 'This page controls accounts that can be spent, so it asks for the admin token. The terminal printed a link that signs you in; if you closed it, run this and open what it prints:' }),
      h('pre', { class: 'mono' }, h('code', { text: 'unofficial-free-llm-api login-url' })),
      h('p', { class: 'muted small', text: 'Or paste the token (it is the token= part of that link):' }),
      input,
      btn('Sign in', { class: 'primary', onclick: go })));
  }

  // ---- dialogs --------------------------------------------------------------------------------------------------------------------------------

  /**
   * One modal at a time. `build(finish)` returns the dialog's content; `finish(value)` closes it and settles the promise. Escape, a click on the backdrop and the
   * close button all settle it with `false`. Focus goes back to where it was (or, if that thing is gone, to the page heading).
   */
  function modal(label, build, { wide = false } = {}) {
    return new Promise((resolve) => {
      const opener = document.activeElement;
      let settled = false;
      const dialog = h('dialog', { class: `dlg${wide ? ' wide' : ''}`, 'aria-label': label });
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { if (dialog.hasAttribute('open')) dialog.close(); } catch (_) { /* already closed */ }
        dialog.remove();
        if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
        else { const head = shell.main && shell.main.querySelector('.view:not(.hidden) h1'); if (head) head.focus({ preventScroll: true }); }
        resolve(value);
      };
      dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
      dialog.addEventListener('close', () => finish(false));
      dialog.addEventListener('click', (e) => { if (e.target === dialog) finish(false); });
      dialog.append(h('div', { class: 'dlg-body' }, build(finish)));
      (shell.dialogs || document.body).append(dialog);
      dialog.showModal();
    });
  }

  /** An in-app confirmation. The safe choice has the focus. */
  function confirmDialog({ title, body, yes, danger = false }) {
    return modal(title, (finish) => {
      const no = btn('Cancel', { autofocus: true, onclick: () => finish(false) });
      return [h('h2', { class: 'dlg-title', text: title }), h('p', { class: 'muted', text: body }),
        h('div', { class: 'dlg-actions' }, no, btn(yes, { class: danger ? 'danger-fill' : 'primary', onclick: () => finish(true) }))];
    });
  }

  function consent(provider) {
    return modal(`Link ${provider.name}`, (finish) => {
      const ok = h('input', { type: 'checkbox', id: 'consent-ok' });
      const go = btn('Open Chrome and sign in', { class: 'primary', disabled: true, onclick: () => finish(true) });
      ok.addEventListener('change', () => { go.disabled = !ok.checked; });
      return [
        h('h2', { class: 'dlg-title', text: `Link ${provider.name}` }),
        h('ul', { class: 'plain-list' },
          h('li', { text: `You sign in to ${provider.name} yourself. This program never sees your password; it keeps the session it gets on this computer, in your data folder.` }),
          h('li', { text: `${provider.name} does not offer this as an API and has not agreed to it. Using an account this way may break its terms.` }),
          h('li', { text: 'The account can be slowed down, muted or signed out. Requests are paced and capped to lower that risk. They cannot remove it.' }),
          h('li', { text: 'Use an account you can afford to lose. You are responsible for how you use it.' })),
        h('label', { class: 'check', for: 'consent-ok' }, ok, h('span', { class: 'box' }), h('span', { text: 'I understand and accept this.' })),
        h('div', { class: 'dlg-actions' }, btn('Cancel', { onclick: () => finish(false) }), go)];
    });
  }

  // ---- shared widgets -------------------------------------------------------------------------------------------------------------------------

  function pageHead(title, text) {
    return h('div', { class: 'page-head' }, h('h1', { tabindex: '-1', text: title }), text ? h('p', { class: 'muted', text }) : null);
  }

  function emptyState(title, text, ...actions) {
    return h('div', { class: 'empty-state' }, h('strong', { text: title }), text ? h('p', { class: 'muted', text }) : null, actions.length ? h('div', { class: 'row' }, actions) : null);
  }

  function chip(text, kind = '', title = '') {
    return h('span', { class: `chip ${kind}`.trim(), title: title || undefined }, kind && kind !== 'accent' ? h('i', { class: 'dot' }) : null, text);
  }

  /**
   * A table that turns into a list of cards when its box is narrow (a phone), so nothing scrolls sideways. Every cell carries its column's name for the card view.
   * `rows` is an array of arrays of cells (text or nodes); `cols` is [{ label, cls }].
   */
  function dataTable(label, cols, rows, cls = '') {
    return h('div', { class: 'dt-wrap' }, h('table', { class: `dt ${cls}`.trim(), role: 'table', 'aria-label': label },
      h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' }, cols.map((c) => h('th', { role: 'columnheader', scope: 'col', class: c.cls || '', text: c.label })))),
      h('tbody', { role: 'rowgroup' }, rows.map((cells) => h('tr', { role: 'row' }, cells.map((cell, i) => h('td', { role: 'cell', class: cols[i].cls || '', 'data-label': cols[i].label || undefined }, cell)))))));
  }

  /** Tabs with arrow keys. `onSelect` is told the id; the caller builds again. */
  function tabs(label, items, current, onSelect, prefix) {
    const buttons = items.map(([id, text]) => h('button', {
      type: 'button', role: 'tab', id: `${prefix}-tab-${id}`, class: 'tab', 'aria-selected': id === current ? 'true' : 'false', 'aria-controls': `${prefix}-panel`, tabindex: id === current ? '0' : '-1', text,
      onclick: () => onSelect(id),
      onkeydown: (e) => {
        const at = items.findIndex((i) => i[0] === id);
        const next = e.key === 'ArrowRight' ? items[(at + 1) % items.length] : e.key === 'ArrowLeft' ? items[(at - 1 + items.length) % items.length] : e.key === 'Home' ? items[0] : e.key === 'End' ? items[items.length - 1] : null;
        if (next) { e.preventDefault(); onSelect(next[0]); }
      }
    }));
    return h('div', { class: 'tabs', role: 'tablist', 'aria-label': label }, buttons);
  }

  function snippetBlock(display, real, label = 'Copy') {
    const copy = h('button', { class: 'copy', type: 'button', text: label, onclick: (e) => copyText(real, e.currentTarget) });
    return h('div', { class: 'codeblock' }, copy, h('pre', { tabindex: '0', 'aria-label': 'Example code' }, h('code', { text: display })));
  }

  /** "Label: value [copy]" rows, for the values a tool's settings form asks for. `real` is what the copy button copies (the whole key, when `value` is masked). */
  function fieldRows(rows) {
    return h('dl', { class: 'fields' }, rows.map((r) => h('div', { class: 'field-row' },
      h('dt', { text: r.label }),
      h('dd', null, r.muted ? h('span', { class: 'muted', text: r.value }) : h('code', { class: 'val', text: r.value }), r.hint ? h('span', { class: 'hint', text: r.hint }) : null),
      r.muted ? null : iconBtn('copy', `Copy ${r.label}`, { class: 'ghost', onclick: (e) => copyText(r.real === undefined ? r.value : r.real, e.currentTarget) }))));
  }

  // ---- the playground -------------------------------------------------------------------------------------------------------------------------

  const STARTERS = [
    'Explain in two sentences what an OpenAI-compatible API is.',
    'Write a Python function that checks whether a string is a palindrome, with two tests.',
    'Give me five names for a command-line tool that renames photos.',
    'Summarize the trade-offs between SQLite and Postgres for a small app.'
  ];

  const maskKey = (k) => (k.length > 14 ? `${k.slice(0, 7)}${'•'.repeat(8)}${k.slice(-4)}` : '•'.repeat(8));
  const keyShown = () => (S.useKey ? (S.reveal ? S.useKey.secret : maskKey(S.useKey.secret)) : 'YOUR_KEY');
  const keyReal = () => (S.useKey ? S.useKey.secret : 'YOUR_KEY');

  /** What the playground sends, as code in three languages. `k` is the key as it is to be written (masked on screen, whole when copied). */
  function chatCode(req, base, k) {
    // One message to a line, so a long conversation stays readable.
    const lines = (pad) => req.messages.map((m) => `${pad}{"role": ${JSON.stringify(m.role)}, "content": ${JSON.stringify(m.content)}}`).join(',\n');
    const jsonBody = `{\n  "model": ${JSON.stringify(req.model)},\n${req.stream ? '  "stream": true,\n' : ''}${req.reasoning_effort ? `  "reasoning_effort": ${JSON.stringify(req.reasoning_effort)},\n` : ''}  "user": ${JSON.stringify(req.user)},\n  "messages": [\n${lines('    ')}\n  ]\n}`.replace(/'/g, '\'\\\'\'');
    const extraPy = `${req.reasoning_effort ? `    reasoning_effort=${JSON.stringify(req.reasoning_effort)},\n` : ''}    user=${JSON.stringify(req.user)},\n`;
    const extraJs = `${req.reasoning_effort ? `  reasoning_effort: ${JSON.stringify(req.reasoning_effort)},\n` : ''}  user: ${JSON.stringify(req.user)},\n`;
    return {
      curl: `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer ${k}" \\\n  -H "Content-Type: application/json" \\\n${req.stream ? '  -N \\\n' : ''}  -d '${jsonBody}'`,
      python: `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}/v1", api_key="${k}")\n\n${req.stream ? 'for chunk in ' : 'reply = '}client.chat.completions.create(\n    model=${JSON.stringify(req.model)},\n    messages=[\n${lines('        ')}\n    ],\n${extraPy}${req.stream ? '    stream=True,\n):\n    print(chunk.choices[0].delta.content or "", end="", flush=True)' : ')\nprint(reply.choices[0].message.content)'}`,
      node: `import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "${base}/v1", apiKey: "${k}" });\n\n${req.stream ? 'const stream = ' : 'const reply = '}await client.chat.completions.create({\n  model: ${JSON.stringify(req.model)},\n  messages: [\n${lines('    ')}\n  ],\n${extraJs}${req.stream ? '  stream: true,\n});\nfor await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");' : '});\nconsole.log(reply.choices[0].message.content);'}`
    };
  }

  function buildPlayground() {
    const pg = { history: [], busy: false, controller: null, convo: `playground-${rand(6)}`, settingsOpen: false, codeTab: 'curl' };
    const model = h('select', { 'aria-label': 'Model', class: 'model-select' });
    const system = h('textarea', { rows: 3, placeholder: 'Optional. Sets how the model behaves.', 'aria-label': 'System prompt', value: store.get('system', '') });
    const stream = h('input', { type: 'checkbox', checked: store.get('stream', true), id: 'opt-stream' });
    const effort = h('select', { 'aria-label': 'Reasoning effort' },
      h('option', { value: '', text: 'Default' }), h('option', { value: 'low', text: 'Low' }), h('option', { value: 'medium', text: 'Medium' }), h('option', { value: 'high', text: 'High' }));
    const effortField = h('label', { class: 'field' }, h('span', { text: 'Reasoning effort' }), effort, h('span', { class: 'hint', text: 'Gemini only: how long it thinks.' }));
    const messages = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation', tabindex: '0' });
    const errSlot = h('div', { role: 'alert' });
    const input = h('textarea', { rows: 1, placeholder: 'Message the model', 'aria-label': 'Message', enterkeyhint: 'send' });
    const sendBtn = btn('Send', { class: 'primary send' }, 'send');
    const convoEl = h('div', { class: 'convo' });
    const settingsBtn = btn('Settings', { 'aria-expanded': 'false', 'aria-controls': 'pg-settings', 'aria-label': 'Settings', title: 'Settings: system prompt and options' }, 'sliders');
    const codeBtn = btn('View as code', { 'aria-label': 'View this request as code', title: 'See this request as curl, Python or Node' }, 'terminal');
    const clearBtn = btn('New chat', { 'aria-label': 'New chat', title: 'Start a new conversation' }, 'plus');
    const settings = h('div', { class: 'settings hidden', id: 'pg-settings' },
      h('label', { class: 'field' }, h('span', { text: 'System prompt' }), system),
      effortField,
      h('label', { class: 'switch' }, stream, h('span', { class: 'track' }), h('span', { text: 'Stream the answer' })));
    system.addEventListener('input', () => { store.set('system', system.value); updateConvo(); });
    stream.addEventListener('change', () => store.set('stream', stream.checked));

    // ---- the first-run checklist and the starter prompts
    const setupHidden = () => store.get('setupHidden', false);
    function setupSteps() {
      const st = S.state;
      const hasModels = st.models.length > 0;
      const tried = st.requests.length > 0 || firstRequestDone();
      const linkedNames = st.providers.filter((p) => p.linked && !p.expired).map((p) => p.name);
      return [
        { id: 'link', done: hasModels, title: 'Link an account', text: hasModels ? `Linked: ${linkedNames.join(', ') || 'a provider'}.` : 'Sign in to DeepSeek, Gemini or Qwen once, in a Chrome window that opens for you. Nothing here goes to a server of ours.', action: hasModels ? null : btn('Link an account', { class: 'primary', onclick: () => show('accounts', { focus: true }) }, 'link') },
        { id: 'key', done: st.keys.length > 0, title: 'Make or copy an API key', text: st.keys.length ? `${plural(st.keys.length, 'key')} made. Show it again any time on the API page.` : 'Your own code needs a key to call this server. Make one, then copy it.', action: st.keys.length ? btn('Go to API keys', { onclick: () => show('api', { focus: true }) }, 'key') : btn('Go to API keys', { class: hasModels ? 'primary' : '', onclick: () => show('api', { focus: true }) }, 'key') },
        { id: 'try', done: tried, title: 'Try it', text: tried ? 'A request has gone through.' : 'Send a message here, or connect a tool such as Lens Code or Cline.',
          action: h('div', { class: 'row' }, btn('Say hello', { class: hasModels && !tried ? 'primary' : '', disabled: !hasModels, onclick: () => { input.value = 'Say hello in five words.'; autosize(); input.focus(); } }, 'chat'), btn('Connect a tool', { onclick: () => show('api', { focus: true }) }, 'code')) }
      ];
    }
    function empty() {
      const st = S.state;
      const hasModels = Boolean(st && st.models.length);
      const steps = st ? setupSteps() : [];
      const incomplete = steps.some((s) => !s.done);
      const wrap = h('div', { class: 'empty' });
      if (!hasModels || (incomplete && !setupHidden())) {
        const doneCount = steps.filter((s) => s.done).length;
        wrap.append(h('section', { class: 'setup', 'aria-labelledby': 'setup-title' },
          h('div', { class: 'setup-head' }, h('h2', { id: 'setup-title', text: hasModels ? 'Finish setting up' : 'Start here' }), h('span', { class: 'row nowrap' }, h('span', { class: 'muted small num', text: `${doneCount} of ${steps.length} done` }),
            hasModels ? h('button', { class: 'link-btn', type: 'button', text: 'Hide', title: 'Hide this checklist', onclick: () => { store.set('setupHidden', true); renderEmpty(true); } }) : null)),
          h('ol', { class: 'steps' }, steps.map((s, i) => h('li', { class: `step${s.done ? ' done' : ''}`, 'data-step': s.id },
            h('span', { class: 'badge', 'aria-hidden': 'true' }, s.done ? icon('check', 14) : String(i + 1)),
            h('div', { class: 'step-main' }, h('strong', null, s.title, h('span', { class: 'sr-only', text: s.done ? ' (done)' : ' (to do)' })), h('p', { class: 'muted small', text: s.text })),
            s.action ? h('div', { class: 'step-action' }, s.action) : null))),
          null));
      }
      if (hasModels) {
        wrap.append(h('div', { class: 'starters' }, h('h3', { text: 'Talk to your models' }), h('p', { class: 'muted', text: 'Pick a model and write a message, or start from one of these. This page calls the same /v1 endpoint your own code will.' }),
          h('div', { class: 'starter-list' }, STARTERS.map((t) => h('button', { type: 'button', class: 'starter', text: t, onclick: () => { input.value = t; autosize(); input.focus(); } })))));
      }
      return wrap;
    }
    let emptySig = '';
    const emptyShown = () => messages.firstChild && messages.firstChild.classList.contains('empty');
    function renderEmpty(force) {
      if (!S.state) return;
      const blank = !messages.firstChild;
      if (!blank && !emptyShown()) return; // a conversation is on screen
      const st = S.state;
      const sig = JSON.stringify([st.models.length, st.keys.length, st.requests.length > 0 || firstRequestDone(), setupHidden(), st.providers.map((p) => p.linked)]);
      if (!force && !blank && sig === emptySig) return;
      emptySig = sig;
      messages.replaceChildren(empty());
    }
    messages.append(h('div', { class: 'empty' }));

    function updateConvo() {
      const parts = [];
      if (!pg.history.length) parts.push('New conversation');
      else {
        parts.push(`Conversation ${pg.convo}`, plural(pg.history.length, 'message'));
        // Another model is another chat, maybe at another provider, so several chats can hold this one conversation: the one used last comes first.
        const kept = (S.state ? S.state.sessions || [] : []).filter((s) => s.tag === pg.convo).sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')));
        const nameOf = (id) => { const owner = S.state.providers.find((p) => p.id === id); return owner ? owner.name : id; };
        if (kept.length === 1) parts.push(`kept in one ${nameOf(kept[0].provider)} chat (${plural(kept[0].turns, 'turn')})`);
        else if (kept.length > 1) {
          const perProvider = new Map();
          for (const s of kept) perProvider.set(s.provider, (perProvider.get(s.provider) || 0) + 1);
          parts.push(`kept in ${kept.length} chats (${[...perProvider].map(([id, n]) => `${nameOf(id)} ${n}`).join(', ')})`);
        }
      }
      if (system.value.trim()) parts.push('system prompt on');
      convoEl.replaceChildren(h('span', { class: 'convo-text', text: parts.join(' · ') }));
    }

    function setBusy(on) {
      pg.busy = on;
      const lbl = sendBtn.querySelector('.lbl');
      lbl.textContent = on ? 'Stop' : 'Send';
      sendBtn.replaceChild(icon(on ? 'stop' : 'send', 16), sendBtn.querySelector('svg'));
      sendBtn.classList.toggle('primary', !on);
      sendBtn.classList.toggle('stop', on);
      sendBtn.setAttribute('aria-label', on ? 'Stop the answer' : 'Send the message');
      messages.setAttribute('aria-busy', on ? 'true' : 'false');
      if (on) announce('Answering');
    }

    const nearEnd = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 96;
    const toEnd = () => { messages.scrollTop = messages.scrollHeight; };

    function addMessage(role, text) {
      if (emptyShown()) messages.replaceChildren();
      const bubble = h('div', { class: 'bubble' });
      if (text !== undefined) bubble.textContent = text;
      const meta = h('span', { class: 'meta' });
      const acts = h('span', { class: 'acts' });
      const wrap = h('div', { class: `msg ${role}` }, bubble, h('div', { class: 'msg-foot' }, meta, acts));
      messages.append(wrap);
      toEnd();
      return { bubble, meta, acts, wrap };
    }

    function showError(message, code, retry) {
      errSlot.replaceChildren(h('div', { class: 'errbox notice bad' }, icon('alert', 16), h('div', null, h('strong', { text: message }), code ? h('span', { class: 'small', text: `  (${code}${retry ? `, retry in ${retry}s` : ''})` }) : null)));
    }

    function markLast() {
      for (const el of messages.querySelectorAll('.msg.assistant.is-last')) el.classList.remove('is-last');
      const all = [...messages.querySelectorAll('.msg.assistant:not(.hidden)')].filter((el) => el.dataset.done);
      if (all.length) all[all.length - 1].classList.add('is-last');
    }

    /** One round trip: the history ends with a user message, and what comes back is added as the assistant's. */
    async function exchange({ sent = null, text = '', replaces = null } = {}) {
      const chosen = model.value;
      const out = addMessage('assistant');
      // A message the server refused is taken back whole: its bubble goes, and the words return to the box to be sent again (a retried answer comes back as it was).
      const takeBack = () => {
        out.wrap.remove();
        if (sent) { pg.history.pop(); sent.wrap.remove(); input.value = text; autosize(); if (!messages.firstChild) renderEmpty(true); }
        if (replaces) { pg.history.push(replaces.item); replaces.wrap.classList.remove('hidden'); }
        markLast();
        updateConvo();
      };
      let answer = '';
      let thought = '';
      let usage = null;
      let paintQueued = false;
      let finished = false; // this exchange only: a paint that was queued must not turn the caret on again once the next message is under way
      const think = h('details', { class: 'think' }, h('summary', { text: 'Thinking' }), h('div', { class: 'body' }));
      const body = h('div');
      const paintOut = () => {
        paintQueued = false;
        const follow = nearEnd();
        out.bubble.replaceChildren();
        if (thought) { think.querySelector('.body').textContent = thought; out.bubble.append(think); }
        body.replaceChildren(markdown(answer));
        out.bubble.append(body);
        out.bubble.classList.toggle('typing', !finished && !!answer);
        if (follow) toEnd();
      };
      const queue = () => { if (!paintQueued) { paintQueued = true; requestAnimationFrame(paintOut); } };
      out.bubble.classList.add('typing');
      pg.controller = new AbortController();
      setBusy(true);
      updateConvo();
      const started = Date.now();
      const request = { model: chosen, stream: stream.checked, user: pg.convo, messages: [...(system.value.trim() ? [{ role: 'system', content: system.value.trim() }] : []), ...pg.history] };
      if (stream.checked) request.stream_options = { include_usage: true };
      if (effort.value && !effortField.classList.contains('hidden')) request.reasoning_effort = effort.value;
      let ok = false;
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
        ok = true;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          out.meta.textContent = 'Stopped';
          if (answer) { pg.history.push({ role: 'assistant', content: answer }); ok = true; } else takeBack();
        } else {
          showError(String((err && err.message) || err));
          if (!answer) takeBack(); else { pg.history.push({ role: 'assistant', content: answer }); ok = true; }
        }
      } finally {
        finished = true;
        setBusy(false);
        pg.controller = null;
        if (out.wrap.isConnected) {
          paintOut();
          if (ok) {
            out.wrap.dataset.done = '1';
            const final = answer;
            out.acts.append(iconBtn('copy', 'Copy this answer', { class: 'ghost', onclick: (e) => copyText(final, e.currentTarget) }),
              iconBtn('retry', 'Ask again for a new answer', { class: 'ghost act-retry', onclick: () => regenerate(out.wrap) }));
            if (replaces) replaces.wrap.remove();
            markLast();
            announce('Answer ready');
          }
        }
        updateConvo();
        refresh();
      }
    }

    function send() {
      const text = input.value.trim();
      if (!text || pg.busy) return;
      if (!model.value) { showError('No model to send to. Link an account first.'); return; }
      errSlot.replaceChildren();
      input.value = '';
      autosize();
      pg.history.push({ role: 'user', content: text });
      const sent = addMessage('user', text);
      sent.acts.append(iconBtn('copy', 'Copy this message', { class: 'ghost', onclick: (e) => copyText(text, e.currentTarget) }));
      exchange({ sent, text });
    }

    /** Asks again for the last answer. The old one stays (hidden) until the new one is in, and comes back if it fails. */
    function regenerate(wrap) {
      const last = pg.history[pg.history.length - 1];
      if (pg.busy || !last || last.role !== 'assistant' || !wrap.classList.contains('is-last')) return;
      errSlot.replaceChildren();
      pg.history.pop();
      wrap.classList.add('hidden');
      exchange({ replaces: { item: last, wrap } });
    }

    function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; }

    sendBtn.addEventListener('click', () => { if (pg.busy) { if (pg.controller) pg.controller.abort(); } else send(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      if (e.key === 'Escape' && pg.busy && pg.controller) pg.controller.abort();
    });
    input.addEventListener('input', autosize);
    clearBtn.addEventListener('click', () => {
      if (pg.controller) pg.controller.abort();
      pg.history = [];
      pg.convo = `playground-${rand(6)}`;
      errSlot.replaceChildren();
      emptySig = '';
      messages.replaceChildren();
      renderEmpty(true);
      updateConvo();
      input.focus();
    });
    settingsBtn.addEventListener('click', () => {
      pg.settingsOpen = !pg.settingsOpen;
      settings.classList.toggle('hidden', !pg.settingsOpen);
      settingsBtn.setAttribute('aria-expanded', pg.settingsOpen ? 'true' : 'false');
      settingsBtn.classList.toggle('on', pg.settingsOpen);
    });

    function openCode() {
      const draft = input.value.trim();
      const sample = pg.history.length || draft ? [] : [{ role: 'user', content: 'Say hello in five words.' }];
      const req = {
        model: model.value || plainModel(), stream: stream.checked, user: pg.convo,
        messages: [...(system.value.trim() ? [{ role: 'system', content: system.value.trim() }] : []), ...pg.history, ...(draft ? [{ role: 'user', content: draft }] : []), ...sample]
      };
      if (effort.value && !effortField.classList.contains('hidden')) req.reasoning_effort = effort.value;
      modal('This request as code', (finish) => {
        const holder = h('div');
        const draw = () => {
          const shown = chatCode(req, location.origin, keyShown());
          const real = chatCode(req, location.origin, keyReal());
          holder.replaceChildren(
            tabs('Language', [['curl', 'curl'], ['python', 'Python'], ['node', 'Node']], pg.codeTab, (id) => { pg.codeTab = id; draw(); const t = holder.querySelector('[aria-selected="true"]'); if (t) t.focus(); }, 'pgcode'),
            h('div', { role: 'tabpanel', id: 'pgcode-panel', 'aria-labelledby': `pgcode-tab-${pg.codeTab}` }, snippetBlock(shown[pg.codeTab], real[pg.codeTab])));
        };
        draw();
        return [h('h2', { class: 'dlg-title', text: 'This request as code' }),
          h('p', { class: 'muted small', text: `The same call the playground makes, with the current model, system prompt and conversation. The conversation name (${pg.convo}) is sent as "user", which keeps it in one chat on the provider's side.` }),
          holder,
          h('p', { class: 'muted small', text: S.useKey ? 'Your chosen key is in the example, masked here; Copy takes the whole key.' : 'YOUR_KEY stands for a key from the API page.' }),
          h('div', { class: 'dlg-actions' }, btn('Open the API page', { onclick: () => { finish(false); show('api', { focus: true }); } }, 'key'), btn('Close', { class: 'primary', onclick: () => finish(false) }))];
      }, { wide: true });
    }
    codeBtn.addEventListener('click', openCode);

    const bar = h('div', { class: 'play-bar' }, model, h('div', { class: 'bar-actions' }, settingsBtn, codeBtn, clearBtn));
    const chat = h('section', { class: 'chat', 'aria-label': 'Chat' },
      messages, errSlot,
      h('div', { class: 'composer-wrap' },
        h('div', { class: 'composer' }, input, sendBtn),
        h('div', { class: 'composer-foot' }, convoEl, h('span', { class: 'keys-hint', text: 'Enter sends · Shift+Enter for a new line' }))));
    const el = h('section', { class: 'view view-play', 'data-view': 'playground' }, h('h1', { class: 'sr-only', tabindex: '-1', text: 'Playground' }), bar, settings, chat);

    let lastModels = '';
    function update(state) {
      const list = state.models;
      const json = JSON.stringify(list.map((m) => [m.id, m.provider]));
      if (json !== lastModels) {
        lastModels = json;
        const keep = model.value || store.get('model', '');
        model.replaceChildren();
        if (!list.length) model.append(h('option', { value: '', text: 'No model yet' }));
        for (const p of state.providers) {
          const own = list.filter((m) => m.provider === p.id);
          if (!own.length) continue;
          model.append(h('optgroup', { label: p.name }, own.map((m) => h('option', { value: m.id, text: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id }))));
        }
        if (list.some((m) => m.id === keep)) model.value = keep; else if (list[0]) model.value = list[0].id;
      }
      const chosen = list.find((m) => m.id === model.value);
      const owner = chosen ? state.providers.find((p) => p.id === chosen.provider) : null;
      effortField.classList.toggle('hidden', !(owner && owner.capabilities && (owner.capabilities.settings || []).includes('thinkingLevel')));
      const none = !list.length;
      sendBtn.disabled = none && !pg.busy;
      model.disabled = none;
      input.disabled = none && !pg.busy;
      input.placeholder = none ? 'Link an account to start talking' : 'Message the model';
      codeBtn.disabled = none;
      renderEmpty(false);
      if (!messages.firstChild) renderEmpty(true);
      updateConvo();
    }
    model.addEventListener('change', () => { store.set('model', model.value); update(S.state); });
    updateConvo();
    return { el, update };
  }

  // ---- accounts -------------------------------------------------------------------------------------------------------------------------------

  const HOW = {
    deepseek: 'Opens a Chrome window so you can sign in to chat.deepseek.com yourself. The session is kept on this computer and used for each request. Answers come from the same models the website uses.',
    gemini: 'Opens Chrome on a private profile so you can sign in to gemini.google.com yourself. Chat then runs in that Chrome, in the background. Your requests show up in your Gemini activity like any chat you typed.',
    qwen: 'Opens Chrome with a dedicated profile so you can sign in to chat.qwen.ai yourself. Chat requests use Qwen\'s normal message box in that browser, which stays open while the bridge runs. Complete any verification checks yourself. This is unofficial, not Qwen\'s official API.'
  };

  function ui(id) { return (S.ui[id] = S.ui[id] || {}); }

  async function act(id, fn) {
    const u = ui(id);
    u.busy = true;
    u.error = '';
    paint(true);
    try { await fn(); } catch (err) { u.error = String((err && err.message) || err); } finally { u.busy = false; await refresh(); paint(true); }
  }

  function usageBlock(p) {
    const u = p.usage;
    if (!u) return null;
    const pct = Math.min(100, Math.round((u.todayCalls / Math.max(1, u.dailyCap)) * 100));
    const meter = h('div', { class: `meter${pct >= 100 ? ' full' : ''}`, role: 'progressbar', 'aria-valuenow': u.todayCalls, 'aria-valuemin': 0, 'aria-valuemax': u.dailyCap, 'aria-label': 'Calls today' }, h('i'));
    meter.firstChild.style.width = `${pct}%`;
    return h('div', { class: 'usage stack-sm' },
      h('div', { class: 'usage-line' }, h('span', null, h('strong', { class: 'num', text: `${u.todayCalls} of ${u.dailyCap}` }), ' ', h('span', { class: 'muted', text: 'calls today' })),
        h('span', { class: 'muted small num', text: `${u.callsThisMinute} of ${u.perMinute} this minute${u.minGapMs >= 1000 ? ` · at least ${Math.round(u.minGapMs / 1000)} s apart` : ''}${u.queued ? ` · ${u.queued} waiting` : ''}` })),
      meter,
      u.isCooldown ? h('div', { class: 'notice warn row' }, icon('alert', 16), h('span', { class: 'grow', text: `Paused to protect the account: ${u.cooldownReason || 'the provider pushed back'}. Until ${time(u.cooldownUntil)}.` }),
        btn('Clear pause', { class: 'sm', onclick: () => act(p.id, () => admin('POST', `/providers/${p.id}/reset`, {})) })) : null);
  }

  /** The link flow as two steps: sign in at the provider (a Chrome window opens), then say so here. */
  function linkStepper(p, u) {
    const linking = Boolean(p.linking);
    const step = (n, state, title, text, ...actions) => h('li', { class: `step ${state}` },
      h('span', { class: 'badge', 'aria-hidden': 'true' }, state === 'done' ? icon('check', 14) : String(n)),
      h('div', { class: 'step-main' }, h('strong', null, title, h('span', { class: 'sr-only', text: state === 'done' ? ' (done)' : state === 'now' ? ' (now)' : ' (next)' })), h('p', { class: 'muted small', text }), actions.length ? h('div', { class: 'row' }, actions) : null));
    const linkBtn = btn(p.linked ? 'Sign in again' : 'Link account', {
      class: 'primary', disabled: u.busy, onclick: async () => {
        if (!(await consent(p))) return;
        act(p.id, async () => { const r = await admin('POST', `/providers/${p.id}/link`, { consentAcknowledged: true }); if (r.error) throw new Error(r.error); u.note = ''; });
      }
    }, 'link');
    return h('ol', { class: 'steps stepper', 'aria-label': 'How to link' },
      step(1, linking ? 'done' : 'now', 'Sign in at the provider', linking ? (p.linkNote || 'A Chrome window is open. Sign in there.') : 'You are asked to confirm first. Then the window opens and you sign in yourself.', linking ? null : linkBtn),
      step(2, linking ? 'now' : 'next', 'Come back and say you are done', 'Press the button once you can see your chats in that window.',
        btn('I have signed in', { class: linking ? 'primary' : '', disabled: u.busy || !linking, onclick: () => act(p.id, async () => { const r = await admin('POST', `/providers/${p.id}/finish`, {}); u.note = (r.notSignedIn || r.blocked) ? r.note : ''; if (r.error) throw new Error(r.error); }) }, 'check'),
        linking ? btn('Cancel', { disabled: u.busy, onclick: () => act(p.id, () => admin('POST', `/providers/${p.id}/finish`, { cancel: true })) }) : null));
  }

  function sessionLine(s) {
    if (s.enabled) return `On, ${plural(s.open, 'open chat')}`;
    if (s.reason) return `Off: ${s.reason}`;
    return 'Off';
  }

  function providerCard(p) {
    const u = ui(p.id);
    const caps = p.capabilities || {};
    const demo = Boolean(caps.demo);
    const status = p.linking ? ['Waiting for you', 'warn'] : !p.linked ? ['Not linked', ''] : p.expired ? ['Sign-in expired', 'bad'] : [demo ? 'Always on' : 'Linked', 'good'];
    const needsLink = !demo && (!p.linked || p.expired || p.linking);
    const actions = [];
    if (!demo && !needsLink) {
      actions.push(btn('Sign in again', {
        disabled: u.busy, onclick: async () => {
          if (!(await consent(p))) return;
          act(p.id, async () => { const r = await admin('POST', `/providers/${p.id}/link`, { consentAcknowledged: true }); if (r.error) throw new Error(r.error); u.note = ''; });
        }
      }, 'link'));
      actions.push(btn('Unlink', {
        class: 'danger', disabled: u.busy, onclick: async () => {
          const yes = await confirmDialog({ title: `Unlink ${p.name}?`, body: 'The saved session is deleted from this computer, and requests for this account stop working until you link it again. You can link it again any time.', yes: 'Unlink', danger: true });
          if (yes) act(p.id, () => admin('POST', `/providers/${p.id}/unlink`, {}));
        }
      }, 'trash'));
    }
    const cap = h('input', { class: 'narrow', type: 'number', min: 1, max: 100000, value: p.usage ? p.usage.dailyCap : 300, 'aria-label': 'Daily call cap', inputmode: 'numeric', id: `cap-${p.id}` });
    const settings = [];
    settings.push(h('div', { class: 'field' }, h('label', { class: 'field-label', for: `cap-${p.id}`, text: 'Daily call cap' }), h('div', { class: 'row nowrap' }, cap, btn('Save', { onclick: () => act(p.id, () => admin('PUT', `/providers/${p.id}/settings`, { dailyCap: Number(cap.value) })) })),
      h('span', { class: 'hint', text: 'The most calls this account is asked for in one day. It stops there, it does not wait.' })));
    if ((caps.settings || []).includes('thinkingLevel')) {
      const level = h('select', { 'aria-label': 'Thinking level', id: `level-${p.id}` }, ['low', 'medium', 'high'].map((l) => h('option', { value: l, text: l[0].toUpperCase() + l.slice(1), selected: p.thinkingLevel === l })));
      level.addEventListener('change', () => act(p.id, () => admin('PUT', `/providers/${p.id}/settings`, { thinkingLevel: level.value })));
      settings.push(h('div', { class: 'field' }, h('label', { class: 'field-label', for: `level-${p.id}`, text: 'Default thinking level' }), level, p.thinkingNote ? h('span', { class: 'hint', text: p.thinkingNote }) : null));
    }
    if ((caps.settings || []).includes('sessions') && p.sessions) {
      const s = p.sessions;
      const stopped = !s.enabled && Boolean(s.reason); // it switched itself off; the person can switch it on again
      const sw = h('input', { type: 'checkbox', role: 'switch', checked: Boolean(s.enabled), disabled: u.busy, id: `sessions-${p.id}`, 'aria-describedby': `sessions-hint-${p.id}` });
      sw.addEventListener('change', () => act(p.id, () => admin('PUT', `/providers/${p.id}/settings`, { sessions: sw.checked })));
      settings.push(h('div', { class: 'field sessions' },
        h('label', { class: 'switch' }, sw, h('span', { class: 'track' }), h('span', { class: 'switch-text' }, h('strong', { text: 'One chat per conversation' }), h('span', { class: `status-line ${s.enabled ? 'on' : 'off'}`, text: sessionLine(s) }))),
        h('span', { class: 'hint', id: `sessions-hint-${p.id}`, text: stopped
          ? 'It switched itself off so that nothing is spent on a setting that does not work. Switch it on to try again.'
          : p.id === 'qwen'
            ? 'Keeps one Qwen chat for each API conversation. Turning this off removes bridge-created chats; your other chats are not touched.'
            : 'A conversation stays in one chat on the provider\'s side instead of a new chat per message. New, and so far only run against stand-ins, not a real account. It switches itself off if continuing a chat fails twice in a row.' })));
    }
    let tokenBox = null;
    if (caps.token && !demo) {
      const token = h('input', { type: 'password', placeholder: 'Paste the token', autocomplete: 'off', 'aria-label': `${p.name} session token` });
      tokenBox = h('details', { class: 'fold' }, h('summary', { text: 'Advanced: paste a session token instead' }),
        h('div', { class: 'stack' },
          h('p', { class: 'small muted', text: 'For a server with no Chrome. Open the provider\'s website signed in, then in the browser\'s developer tools find the session token in local storage (for DeepSeek: the "value" inside userToken). It is stored like a login.' }),
          token,
          btn('Use this token', { class: 'sm', onclick: () => act(p.id, async () => { const r = await admin('POST', `/providers/${p.id}/token`, { token: token.value, consentAcknowledged: true }); if (r.error) throw new Error(r.error); }) })));
    }
    // Gemini predates the refreshModels capability; keep its picker flow alongside account model-list refreshes.
    let readAgain = null;
    if (p.id === 'gemini' || caps.refreshModels) {
      const gemini = p.id === 'gemini';
      const off = Boolean(p.linking) || !p.linked || Boolean(p.expired);
      const reread = () => {
        u.reading = true;
        u.read = null;
        announce(gemini ? 'Reading the model picker' : `Reading ${p.name} models`);
        return act(p.id, async () => {
          try {
            const r = await admin('POST', `/providers/${p.id}/refresh-models`, {});
            u.read = r.refreshed
              ? { ok: true, text: gemini ? `Models read again: ${plural((r.models || []).length, 'row')}` : `${p.name} account models read again: ${plural((r.models || []).length, 'model')}` }
              : { ok: false, text: gemini ? 'Could not read the picker; the list stays as it was' : `Could not read your ${p.name} account's model list; the list stays as it was` };
            announce(u.read.text);
          } finally { u.reading = false; }
        });
      };
      readAgain = h('div', { class: 'stack-sm' },
        h('div', { class: 'row' }, btn(u.reading ? (gemini ? 'Reading the picker' : `Reading ${p.name} models`) : 'Read models again', { id: `reread-${p.id}`, class: 'sm', disabled: u.busy || off, 'aria-busy': u.reading ? 'true' : undefined, onclick: reread }, 'retry')),
        u.reading ? h('p', { class: 'small muted', role: 'status', text: gemini ? 'Opening Gemini\'s page to read the picker. This can take up to 20 seconds.' : `Reading the model list available to your ${p.name} account.` })
          : u.read ? h('div', { class: u.read.ok ? 'small muted' : 'notice warn', role: 'status', text: u.read.text })
            : h('span', { class: 'hint', text: off ? 'Works once the account is linked and its sign-in is finished.' : gemini ? 'Reads the models from your Gemini account\'s own picker. It does this by itself when the list is 15 minutes old.' : `Reads the model list available to your ${p.name} account using the saved sign-in.` }));
    }
    return h('article', { class: 'card provider stack' },
      h('div', { class: 'row between' }, h('h2', { class: 'h3', text: p.name }), chip(status[0], status[1])),
      demo ? h('p', { class: 'muted', text: 'Answers by describing what it was sent. It needs no account: use it to try the interface and your client.' }) : h('p', { class: 'muted small', text: HOW[p.id] || 'Signs in with your own account in a Chrome window.' }),
      p.expired ? h('div', { class: 'notice bad', text: p.expiredReason || 'The sign-in expired. Sign in again.' }) : null,
      needsLink ? linkStepper(p, u) : null,
      u.note ? h('div', { class: 'notice warn', text: u.note }) : null,
      u.error ? h('div', { class: 'notice bad', role: 'alert', text: u.error }) : null,
      p.linked && !p.expired ? h('div', { class: 'models' }, (p.models || []).map((m) => chip(m.name || m.id, 'accent', m.id))) : null,
      readAgain,
      p.linked && p.linkedAt ? h('dl', { class: 'kv' }, h('dt', { text: 'Linked' }), h('dd', { text: `${day(p.linkedAt)}${p.accountLabel ? ` as ${p.accountLabel}` : ''}` })) : null,
      usageBlock(p),
      actions.length ? h('div', { class: 'row' }, actions) : null,
      h('div', { class: 'settings-group stack' }, settings),
      tokenBox);
  }

  function openChats(st) {
    const kept = st.providers.filter((p) => p.sessions);
    if (!kept.length) return null;
    const rows = st.sessions.map((s) => {
      const owner = st.providers.find((p) => p.id === s.provider);
      const end = btn(s.busy ? 'Answering' : 'End', {
        class: 'sm', disabled: Boolean(s.busy), 'aria-label': `End this ${owner ? owner.name : s.provider} chat`,
        onclick: () => act('sessions', () => admin('DELETE', `/sessions/${encodeURIComponent(s.provider)}/${encodeURIComponent(s.id)}`))
      });
      return [owner ? owner.name : s.provider, h('span', { class: 'mono', text: s.model || '' }), h('span', { class: 'mono trunc', title: s.tag || '', text: s.tag || 'no name' }), h('span', { class: 'num', text: String(s.turns) }), h('span', { class: 'muted', title: `${day(s.lastUsed)} ${time(s.lastUsed)}`, text: ago(s.lastUsed) }), end];
    });
    return h('section', { class: 'card stack', 'aria-labelledby': 'open-chats-title' },
      h('div', null, h('h2', { class: 'h3', id: 'open-chats-title', text: 'Open chats' }),
        h('p', { class: 'muted small', text: 'Chats that are open on the providers\' side right now, because "One chat per conversation" keeps a conversation in one. Only who, which model, how many turns and when: never what was said. A chat closes by itself after 20 minutes without a request; End closes one now.' })),
      ui('sessions').error ? h('div', { class: 'notice bad', role: 'alert', text: ui('sessions').error }) : null,
      rows.length ? dataTable('Open chats', [{ label: 'Provider' }, { label: 'Model' }, { label: 'Name' }, { label: 'Turns', cls: 'r' }, { label: 'Last used' }, { label: '', cls: 'actions' }], rows, 'sessions-table')
        : emptyState('No chats are open', 'One opens when a request goes through a linked account with "One chat per conversation" on.'));
  }

  function buildAccounts() {
    const st = S.state;
    return h('div', { class: 'stack-lg' },
      pageHead('Accounts', 'Link the accounts you want to use. Linking is local: nothing here goes to a server of ours, and there is none.'),
      h('div', { class: 'providers' }, st.providers.map(providerCard)),
      openChats(st));
  }

  // ---- API ------------------------------------------------------------------------------------------------------------------------------------

  function snippets(base, k, model) {
    return {
      curl: `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer ${k}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "${model}",\n    "messages": [{"role": "user", "content": "Say hello in five words."}]\n  }'`,
      python: `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}/v1", api_key="${k}")\n\nreply = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Say hello in five words."}],\n)\nprint(reply.choices[0].message.content)`,
      stream: `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}/v1", api_key="${k}")\n\nfor chunk in client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Write a haiku about rain."}],\n    stream=True,\n):\n    print(chunk.choices[0].delta.content or "", end="", flush=True)`,
      node: `import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "${base}/v1", apiKey: "${k}" });\n\nconst reply = await client.chat.completions.create({\n  model: "${model}",\n  messages: [{ role: "user", content: "Say hello in five words." }],\n});\nconsole.log(reply.choices[0].message.content);`,
      responses: `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}/v1", api_key="${k}")\n\n# OpenAI's Responses API\nreply = client.responses.create(\n    model="${model}",\n    input="Say hello in five words.",\n)\nprint(reply.output_text)`
    };
  }

  function anthropicSnippets(base, k, model) {
    return {
      python: `from anthropic import Anthropic\n\n# No /v1 on the base URL: the SDK adds /v1/messages itself.\nclient = Anthropic(base_url="${base}", api_key="${k}")\n\nreply = client.messages.create(\n    model="${model}",\n    max_tokens=1024,\n    messages=[{"role": "user", "content": "Say hello in five words."}],\n)\nprint(reply.content[0].text)`,
      curl: `curl ${base}/v1/messages \\\n  -H "x-api-key: ${k}" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "${model}",\n    "max_tokens": 1024,\n    "messages": [{"role": "user", "content": "Say hello in five words."}]\n  }'`,
      env: `export ANTHROPIC_BASE_URL=${base}\nexport ANTHROPIC_API_KEY=${k}`
    };
  }

  const goodFor = (m) => (m.escalate ? 'Agents that send tools' : m.thinking ? 'Thinks first (slower)' : 'Plain chat');

  /** A context size as a person reads it: 128000 is 128k, 1000000 is 1M. */
  const sizeLabel = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const hasSize = (m) => Number.isFinite(m.context_length) && m.context_length > 0;
  /** The size is a working size this program chose for the model, not the model's maximum: the exact number and that fact sit in the hover text. */
  const contextCell = (m) => (hasSize(m)
    ? h('span', { class: 'num', title: `${m.context_length} tokens. A working size this program chose, not the model's maximum.`, text: sizeLabel(m.context_length) })
    : h('span', { class: 'muted', text: 'unknown' }));

  const PASTE_KEY = 'paste your key here';
  const STABLE_FIRST = ['gemini', 'gemini-auto'];

  /**
   * The values a plain client's form asks for, one line each. The whole block is copied, so the key is only ever the placeholder: never the real key and never its
   * hidden form. The stable Gemini names come first when they are there; when the models carry different sizes the smallest is the one to plan around.
   */
  function pasteText(base, models) {
    const ids = models.map((m) => m.id);
    const first = STABLE_FIRST.filter((id) => ids.includes(id));
    const list = [...first, ...ids.filter((id) => !first.includes(id))];
    const sizes = models.filter(hasSize).map((m) => m.context_length);
    const lines = [`Name: ${TITLE}`, `Address: ${base}/v1`, `Key: ${PASTE_KEY}`, `Models: ${list.length ? list.join(', ') : 'none yet, link an account first'}`];
    if (sizes.length) lines.push(`Context: ${Math.min(...sizes)} (a working size, not the model's maximum)`);
    return lines.join('\n');
  }

  function pasteBlock(base, models) {
    const text = pasteText(base, models);
    return h('div', { class: 'paste-block stack-sm' },
      h('h3', { class: 'h4', id: 'paste-title', text: 'Copy for Lens Code, Cline and similar' }),
      h('p', { class: 'muted small', text: 'For a client with a form to fill in. Copy this and type the lines into the form, or paste them where it lets you. Your key is left out on purpose: pick or make one above, copy it, and put it where this says paste your key here.' }),
      h('div', { class: 'plainbox' },
        h('button', { class: 'copy', type: 'button', text: 'Copy', 'aria-label': 'Copy the settings for Lens Code, Cline and similar', onclick: (e) => copyText(text, e.currentTarget) }),
        h('pre', { tabindex: '0', 'aria-labelledby': 'paste-title', text })));
  }

  async function useKey(entry, reveal) {
    S.keyBusy = true;
    paint(true);
    try {
      const r = await admin('POST', `/keys/${entry.id}/reveal`);
      S.useKey = { id: entry.id, name: entry.name, secret: r.key };
      S.reveal = reveal;
      ui('keys').error = '';
    } catch (err) { ui('keys').error = String((err && err.message) || err); } finally { S.keyBusy = false; await refresh(); paint(true); }
  }

  function buildApi() {
    const st = S.state;
    const base = location.origin;
    const kui = ui('keys');
    const name = h('input', { type: 'text', id: 'key-name', placeholder: 'Name, for example "laptop script"', 'aria-label': 'Key name', maxLength: 60 });
    const make = () => act('keys', async () => { const r = await admin('POST', '/keys', { name: name.value }); S.useKey = { id: r.entry.id, name: r.entry.name, secret: r.key }; S.reveal = true; });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') make(); });

    // The key in the examples: chosen from the list in one step, masked on screen, copied whole.
    const revealable = st.keys.filter((k) => k.revealable);
    const picker = h('select', { id: 'pick-key', 'aria-label': 'Key to put in the examples', disabled: !st.keys.length || S.keyBusy });
    picker.append(h('option', { value: '', text: 'No key (shows YOUR_KEY)' }));
    for (const k of st.keys) picker.append(h('option', { value: k.id, disabled: !k.revealable, text: k.revealable ? k.name : `${k.name} (start and end only)` }));
    picker.value = S.useKey && st.keys.some((k) => k.id === S.useKey.id) ? S.useKey.id : '';
    picker.addEventListener('change', () => {
      if (!picker.value) { S.useKey = null; S.reveal = false; paint(true); return; }
      useKey(st.keys.find((k) => k.id === picker.value), false);
    });
    const eye = iconBtn(S.reveal ? 'eyeOff' : 'eye', S.reveal ? 'Hide the key' : 'Show the key', { class: 'ghost', 'aria-pressed': S.reveal ? 'true' : 'false', disabled: !S.useKey, onclick: () => { S.reveal = !S.reveal; paint(true); } });
    const copyKey = iconBtn('copy', 'Copy the whole key', { class: 'ghost', disabled: !S.useKey, onclick: (e) => copyText(S.useKey.secret, e.currentTarget) });
    const modelPick = h('select', { id: 'pick-model', 'aria-label': 'Model for the examples' }, h('option', { value: '', text: `Recommended (${plainModel()} for chat, ${agentModel()} for agents)` }), st.models.map((m) => h('option', { value: m.id, text: m.id })));
    modelPick.value = st.models.some((m) => m.id === S.model) ? S.model : '';
    modelPick.addEventListener('change', () => { S.model = modelPick.value; paint(true); });

    const keyCard = S.useKey && S.reveal ? h('div', { class: 'newkey stack-sm' }, h('strong', { text: `Your key${S.useKey.name ? `: ${S.useKey.name}` : ''}. Copy it into your client. You can show it again from the list below.` }), h('code', { text: S.useKey.secret }),
      h('div', { class: 'row' }, btn('Copy key', { class: 'primary sm', onclick: (e) => copyText(S.useKey.secret, e.currentTarget) }, 'copy'), btn('Done', { class: 'sm', onclick: () => { S.reveal = false; paint(true); } }))) : null;

    const connection = h('section', { class: 'card stack', 'aria-labelledby': 'conn-title' },
      h('h2', { class: 'h3', id: 'conn-title', text: 'Connection' }),
      st.requireKey ? null : h('div', { class: 'notice warn', text: 'The server was started with --no-key: /v1 works without one, on this computer only.' }),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Base URL' }), h('div', { class: 'pill wide' }, h('span', { class: 'mono', text: `${base}/v1` }), iconBtn('copy', 'Copy the base URL', { class: 'ghost', onclick: (e) => copyText(`${base}/v1`, e.currentTarget) }))),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'pick-key', text: 'Key in the examples' }), h('div', { class: 'row nowrap' }, h('div', { class: 'grow' }, picker), eye, copyKey),
        h('span', { class: 'hint', text: S.useKey ? `${maskKey(S.useKey.secret)} is in the examples below. It is hidden on screen; Copy takes the whole key.` : st.keys.length ? 'Pick a key to put it in the examples below, hidden on screen. Copy takes the whole key.' : 'No key yet: make one below.' })),
      kui.error ? h('div', { class: 'notice bad', role: 'alert', text: kui.error }) : null,
      keyCard,
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'pick-model', text: 'Model in the examples' }), modelPick,
        h('span', { class: 'hint', text: `${plainModel()} for plain chat, ${agentModel()} for agents that send tools.` })),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'key-name', text: 'New key' }), h('div', { class: 'row nowrap' }, h('div', { class: 'grow' }, name), btn('Make a key', { class: 'primary', onclick: make }, 'plus'))));

    // ---- connect a tool
    const k = keyShown();
    const real = keyReal();
    const noKeyHint = S.useKey ? null : 'Pick a key above';
    const keyRow = (label = 'API key') => (S.useKey ? { label, value: k, real, hint: S.reveal ? '' : 'hidden here, copied whole' } : { label, value: noKeyHint, muted: true });
    const pickTool = (id) => { S.tool = id; store.set('tool', id); paint(true); };
    const toolTabs = tabs('Tool', [['openai', 'OpenAI clients'], ['lens', 'Lens Code'], ['cline', 'Cline'], ['anthropic', 'Anthropic clients']], S.tool, pickTool, 'tool');
    let panel;
    if (S.tool === 'lens') {
      const all = st.models.map((m) => m.id);
      const ordered = all.length ? [agentModel(), ...all.filter((id) => id !== agentModel())] : [];
      panel = h('div', { class: 'stack' },
        h('p', { class: 'muted', text: 'In Lens Code open Settings > Models > Your own providers > Add provider, and fill in:' }),
        fieldRows([{ label: 'Name', value: 'Unofficial Free LLM API', hint: 'any name you like' }, { label: 'Address', value: `${base}/v1`, hint: 'with /v1' }, keyRow(), { label: 'Models', value: ordered.join(', ') || 'Link an account first', muted: !ordered.length, hint: 'the one for agents first' },
          { label: 'Context window', value: '64000', hint: 'a safe start' }]));
    } else if (S.tool === 'cline') {
      panel = h('div', { class: 'stack' },
        h('p', { class: 'muted', text: 'In Cline open the settings, choose the API provider "OpenAI Compatible", and fill in:' }),
        fieldRows([{ label: 'Base URL', value: `${base}/v1`, hint: 'with /v1' }, keyRow(), { label: 'Model ID', value: exampleModel(true), hint: 'agents with tools: deepseek-auto' }, { label: 'Context window', value: '64000', hint: 'under Model Configuration; a safe start' }]),
        h('p', { class: 'muted small', text: 'Leave image support off: this API takes text only. The names of Cline\'s fields can differ a little between versions.' }));
    } else if (S.tool === 'anthropic') {
      const a = anthropicSnippets(base, k, exampleModel(true));
      const ar = anthropicSnippets(base, real, exampleModel(true));
      panel = h('div', { class: 'stack' },
        h('p', { class: 'muted', text: 'For a client that speaks Anthropic\'s Messages API (POST /v1/messages). The base URL has no /v1: the Anthropic SDK adds it. The key goes in the x-api-key header, which the SDK does for you.' }),
        fieldRows([{ label: 'Base URL', value: base, hint: 'no /v1' }, keyRow('API key (x-api-key)'), { label: 'Model', value: exampleModel(true), hint: 'agents with tools: deepseek-auto' }]),
        snippetBlock(a.python, ar.python), snippetBlock(a.curl, ar.curl), snippetBlock(a.env, ar.env));
    } else {
      const c = snippets(base, k, exampleModel(false));
      const cr = snippets(base, real, exampleModel(false));
      const sub = tabs('Language', [['curl', 'curl'], ['python', 'Python'], ['stream', 'Python, streaming'], ['node', 'Node'], ['responses', 'Responses API']], c[S.snippet] ? S.snippet : 'curl', (id) => { S.snippet = id; store.set('snippet', id); paint(true); }, 'snip');
      const cur = c[S.snippet] ? S.snippet : 'curl';
      panel = h('div', { class: 'stack' },
        h('p', { class: 'muted', text: 'Any client that lets you set a base URL and a key: curl, the OpenAI SDKs, and most tools.' }),
        sub, h('div', { role: 'tabpanel', id: 'snip-panel', 'aria-labelledby': `snip-tab-${cur}` }, snippetBlock(c[cur], cr[cur])),
        S.useKey ? null : h('p', { class: 'small muted', text: 'Replace YOUR_KEY with a key from this page: pick one above.' }));
    }
    const tools = h('section', { class: 'card stack', 'aria-labelledby': 'tools-title' },
      h('div', null, h('h2', { class: 'h3', id: 'tools-title', text: 'Connect a tool' }), h('p', { class: 'muted small', text: 'The exact values to paste. Use deepseek-auto for agents that send tools, deepseek-chat for plain chat.' })),
      pasteBlock(base, st.models), toolTabs, h('div', { role: 'tabpanel', id: 'tool-panel', 'aria-labelledby': `tool-tab-${S.tool}` }, panel));

    // ---- keys and models
    const keyRows = st.keys.map((key) => [
      h('strong', { text: key.name }), h('span', { class: 'mono', text: key.hint }), h('span', { class: 'muted', text: day(key.createdAt) }), h('span', { class: 'muted num', text: key.lastUsedAt ? `${day(key.lastUsedAt)} ${time(key.lastUsedAt)}` : 'never' }),
      h('div', { class: 'row nowrap' },
        key.revealable
          ? btn('Show', { class: 'sm', 'aria-label': `Show the key ${key.name}`, onclick: () => useKey(key, true) })
          : h('span', { class: 'small muted', text: 'start and end only', title: 'Made before keys could be shown again. Make a new one to copy it.' }),
        btn('Revoke', {
          class: 'sm danger', 'aria-label': `Revoke the key ${key.name}`, onclick: async () => {
            const yes = await confirmDialog({ title: `Revoke "${key.name}"?`, body: 'Anything that uses this key stops working at once. This cannot be undone; you can make a new key.', yes: 'Revoke key', danger: true });
            if (yes) { if (S.useKey && S.useKey.id === key.id) { S.useKey = null; S.reveal = false; } act('keys', () => admin('DELETE', `/keys/${key.id}`)); }
          }
        }))]);
    const keys = h('section', { class: 'card stack', 'aria-labelledby': 'keys-title' },
      h('h2', { class: 'h3', id: 'keys-title', text: 'API keys' }),
      st.keys.length ? dataTable('API keys', [{ label: 'Name' }, { label: 'Key' }, { label: 'Made' }, { label: 'Last used' }, { label: '', cls: 'actions' }], keyRows, 'keys-table')
        : emptyState('No keys yet', 'Make one above. It starts with sk-ula- and can be shown again here.'));
    const models = h('section', { class: 'card stack', 'aria-labelledby': 'models-title' },
      h('div', null, h('h2', { class: 'h3', id: 'models-title', text: 'Models you can use now' }),
        st.models.some(hasSize) ? h('p', { class: 'muted small', text: 'Context is the size this program plans around for each model: a working size, not the model\'s maximum.' }) : null),
      st.models.length ? dataTable('Models', [{ label: 'Model id' }, { label: 'Provider' }, { label: 'Good for' }, { label: 'Context', cls: 'r' }, { label: '', cls: 'actions' }],
        st.models.map((m) => [h('span', { class: 'mono', text: m.id }), m.provider, h('span', { class: 'muted', text: goodFor(m) }), contextCell(m), iconBtn('copy', `Copy the model id ${m.id}`, { class: 'ghost', onclick: (e) => copyText(m.id, e.currentTarget) })]), 'models-table')
        : emptyState('No models yet', 'Link an account on the Accounts page.', btn('Go to Accounts', { class: 'primary', onclick: () => show('accounts', { focus: true }) }, 'users')));

    return h('div', { class: 'stack-lg' }, pageHead('API', 'An OpenAI-compatible endpoint, and the same engine behind the Responses and Anthropic Messages routes. Routes: GET /v1/models, POST /v1/chat/completions, /v1/responses, /v1/messages.'),
      connection, tools, keys, models);
  }

  // ---- activity -------------------------------------------------------------------------------------------------------------------------------

  const isError = (r) => r.status !== 200 && r.status !== 499;
  const API_NAMES = { chat: 'chat', responses: 'responses', messages: 'messages' };
  const API_PATHS = { chat: 'POST /v1/chat/completions', responses: 'POST /v1/responses', messages: 'POST /v1/messages' };

  function buildActivity() {
    const st = S.state;
    const errors = st.requests.filter(isError);
    const rows = (S.filter === 'errors' ? errors : st.requests).map((r) => [
      h('span', { class: 'muted num', text: time(r.at) }),
      h('span', { class: 'chip', title: API_PATHS[r.api] || '', text: API_NAMES[r.api] || r.api || 'chat' }),
      h('span', { class: 'mono', text: r.model }), r.by,
      chip(r.code && r.status !== 200 ? `${r.status} ${r.code}` : r.status === 499 ? '499 stopped' : String(r.status), r.status === 200 ? 'good' : r.status === 499 ? '' : 'bad'),
      h('span', { class: 'muted num', text: `${(r.ms / 1000).toFixed(1)} s` }), h('span', { class: 'muted', text: [r.stream ? 'stream' : '', r.tools ? `${r.tools} tools` : ''].filter(Boolean).join(', ') || 'none' })]);
    const filter = h('div', { class: 'seg seg-fit', role: 'group', 'aria-label': 'Show' }, [['all', `All (${st.requests.length})`], ['errors', `Errors (${errors.length})`]].map(([id, text]) => h('button', {
      type: 'button', class: 'seg-btn', 'aria-pressed': S.filter === id ? 'true' : 'false', 'data-filter': id, onclick: () => { S.filter = id; paint(true); }, text })));
    let body;
    if (!st.requests.length) body = emptyState('No requests yet', 'Requests from the playground and from your own code show up here as they happen.', btn('Open the playground', { class: 'primary', onclick: () => show('playground', { focus: true }) }, 'chat'), btn('Connect a tool', { onclick: () => show('api', { focus: true }) }, 'code'));
    else if (!rows.length) body = emptyState('No errors', `None of the last ${plural(st.requests.length, 'request')} failed.`);
    else body = dataTable('Requests', [{ label: 'Time' }, { label: 'API' }, { label: 'Model' }, { label: 'By' }, { label: 'Result' }, { label: 'Took', cls: 'r' }, { label: 'Details' }], rows, 'activity-table');
    return h('div', { class: 'stack-lg' },
      pageHead('Activity', 'The last requests, newest first. Only the API used, the model, who asked, the result and the time are kept, in memory: never a prompt or an answer.'),
      st.notices.length ? h('section', { class: 'card stack', 'aria-labelledby': 'notices-title' }, h('h2', { class: 'h3', id: 'notices-title', text: 'Notices' }),
        st.notices.map((n) => h('div', { class: 'notice-row' }, h('span', { class: 'muted small num', text: time(n.at) }), chip(n.provider, n.kind === 'looping' ? 'warn' : 'bad'), h('span', { text: n.short })))) : null,
      h('section', { class: 'card stack', 'aria-labelledby': 'requests-title' }, h('div', { class: 'row between' }, h('h2', { class: 'h3', id: 'requests-title', text: 'Requests' }), st.requests.length ? filter : null), body));
  }

  // ---- start ----------------------------------------------------------------------------------------------------------------------------------

  refresh();
  setInterval(() => {
    if (document.hidden) return;
    if (S.locked) return;
    refresh();
  }, 2500);
})();
