'use strict';

/**
 * What the interface looks like, measured. Two parts:
 *  - the style sheet and the files it is served in: contrast of the text and the controls in both themes, reduced motion, big targets for a finger, nothing loaded
 *    from outside, the server's policy headers on every file;
 *  - the real page in headless Chrome (skipped when there is none): no sideways scroll at 320, 390, 820 and 1280 px, a finger-sized target for every control on a
 *    phone, the chat and its box on the first screen of a phone, tables that turn into cards, a rail on a wide screen and a tab bar on a small one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { createConfig } = require('../src/config');
const { createRegistry } = require('../src/registry');
const { createServer } = require('../src/server');
const { chromeExecutable } = require('../src/providers/chrome');
const { createFakeProvider } = require('./fixtures/fake_provider');

const WEB = path.join(__dirname, '..', 'web');
const CSS = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- colours -----------------------------------------------------------------------------------------------------------------------------------

/** The declarations of the first rule that starts with `selector {` (these rules hold only custom properties, so there is nothing nested to skip). */
function tokens(selector) {
  const at = CSS.indexOf(`${selector} {`);
  assert.ok(at >= 0, `${selector} is in the style sheet`);
  const body = CSS.slice(at + selector.length + 2, CSS.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const rgb = (hex) => { const m = /^#([0-9a-f]{6})$/i.exec(hex); assert.ok(m, `${hex} is a 6-digit colour`); return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255); };
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => { const [r, g, b] = rgb(hex).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

const LIGHT = tokens(':root');
const DARK = tokens(':root[data-theme="dark"]');
const DARK_BY_SYSTEM = tokens(':root:not([data-theme="light"])');

// [text, background, what it is]: words and numbers are held to 4.5:1 (WCAG AA for normal text).
const TEXT_PAIRS = [
  ['--text', '--bg', 'body text on the page'], ['--text', '--surface', 'body text on a card'], ['--text', '--surface-2', 'text on a quiet fill'], ['--text', '--surface-3', 'inline code in an answer'],
  ['--text', '--accent-soft', 'your message'], ['--text', '--good-soft', 'the key just made'],
  ['--text-2', '--bg', 'secondary text on the page'], ['--text-2', '--surface', 'secondary text on a card'], ['--text-2', '--surface-2', 'secondary text on a quiet fill'], ['--text-2', '--surface-3', 'a ghost button under the pointer'],
  ['--accent-ink', '--surface', 'a link'], ['--accent-ink', '--bg', 'a link on the page'], ['--accent-ink', '--accent-soft', 'the chosen tab'], ['--accent-ink', '--surface-2', 'a link on a quiet fill'],
  ['--accent-fg', '--accent', 'the main button'], ['--accent-fg', '--bad', 'the button that deletes'],
  ['--good', '--good-soft', 'a good chip'], ['--good', '--surface', 'a good status line'], ['--warn', '--warn-soft', 'a warning'], ['--bad', '--bad-soft', 'an error'], ['--bad', '--surface', 'a delete button\'s words'],
  ['--code-fg', '--code-bg', 'code']
];
// Edges that must be told apart from what is behind them: 3:1 (WCAG 1.4.11).
const EDGE_PAIRS = [['--line-input', '--surface', 'the border of a field'], ['--line-input', '--bg', 'the border of a field on the page'], ['--focus', '--surface', 'the focus ring'], ['--focus', '--bg', 'the focus ring on the page']];

for (const [name, theme] of [['light', LIGHT], ['dark', DARK]]) {
  test(`${name} theme: every pair of text and background is at least 4.5:1, every edge at least 3:1`, () => {
    const weak = [];
    for (const [fg, bg, what] of TEXT_PAIRS) { const r = ratio(theme[fg], theme[bg]); if (r < 4.5) weak.push(`${what}: ${fg} ${theme[fg]} on ${bg} ${theme[bg]} = ${r.toFixed(2)}`); }
    for (const [fg, bg, what] of EDGE_PAIRS) { const r = ratio(theme[fg], theme[bg]); if (r < 3) weak.push(`${what}: ${fg} ${theme[fg]} on ${bg} ${theme[bg]} = ${r.toFixed(2)}`); }
    assert.deepEqual(weak, []);
  });
}

test('the dark theme chosen by the system and the one chosen by hand are the same colours', () => {
  assert.deepEqual(DARK_BY_SYSTEM, DARK_BY_SYSTEM && Object.fromEntries(Object.keys(DARK_BY_SYSTEM).map((k) => [k, DARK[k]])));
  for (const k of Object.keys(DARK)) if (k.startsWith('--') && /^#/.test(DARK[k])) assert.equal(DARK_BY_SYSTEM[k], DARK[k], k);
});

test('the copy button on a code block (colours written out, not from tokens) is readable too', () => {
  const rule = /\.codeblock \.copy \{[^}]*\}/.exec(CSS)[0];
  const fg = /[^-]color:\s*(#[0-9a-f]{6})/i.exec(rule)[1];
  const bg = /background:\s*(#[0-9a-f]{6})/i.exec(rule)[1];
  assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg} = ${ratio(fg, bg).toFixed(2)}`);
});

// ---- the style sheet's rules ---------------------------------------------------------------------------------------------------------------------

test('the style sheet keeps to its small token set and respects the person\'s settings', () => {
  assert.equal(LIGHT['--s1'], '4px');
  assert.equal(LIGHT['--s2'], '8px');
  assert.equal(LIGHT['--s4'], '16px');
  assert.deepEqual(['--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl', '--fs-2xl'].map((k) => LIGHT[k]), ['12px', '13px', '14px', '15px', '17px', '22px'], 'one type scale');
  assert.deepEqual(['--r-sm', '--r-md'].map((k) => LIGHT[k]), ['6px', '10px'], 'two radii');
  const px = [...CSS.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => m[1]);
  const allowed = new Set(['12', '13', '14', '15', '16', '17', '22', '12.5']); // 16 is the size a phone needs in a field so that it does not zoom
  assert.deepEqual([...new Set(px.filter((v) => !allowed.has(v)))], [], 'font sizes written out all come from the scale');
  assert.ok(!/box-shadow:[^;]*rgba\([^)]*0\.(?:0[5-9]|[1-9])/.test(CSS.replace(/--shadow-pop[^;]*;/g, '').replace(/box-shadow: 0 0 0 1px[^;]*;/g, '').replace(/box-shadow: inset[^;]*;/g, '')), 'no soft card shadows: only the dialog has one');
  assert.match(CSS, /prefers-reduced-motion: reduce\)[\s\S]*animation: none !important[\s\S]*transition: none !important/, 'reduced motion is respected');
  assert.match(CSS, /@media \(pointer: coarse\) \{\s*:root \{ --h: 44px; --h-sm: 44px; \}/, 'a finger gets 44 px controls');
  assert.match(CSS, /font-size: 16px/, 'and fields big enough that a phone does not zoom');
  assert.match(CSS, /:focus-visible \{ outline: 2px solid var\(--focus\)/, 'a visible focus ring');
  assert.match(CSS, /\.num \{ font-variant-numeric: tabular-nums; \}/, 'numbers line up');
  assert.match(CSS, /@container \(max-width: 640px\)[\s\S]*\.dt tr \{ display: grid/, 'a table becomes cards when its box is narrow');
  assert.ok(!/@import|url\(\s*['"]?https?:/.test(CSS), 'the style sheet fetches nothing');
  assert.ok(!/@font-face/.test(CSS), 'and ships no font');
});

test('the page and its files are served with the policy that allows exactly them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-layout-'));
  const bus = new EventEmitter();
  const srv = createServer({ config: createConfig({ dataDir: dir }), registry: createRegistry({ providers: [createFakeProvider({ dir, bus })], bus }), port: 0 });
  const { port } = await srv.start();
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /<script src="theme\.js"><\/script>/);
    assert.match(html, /<script src="app\.js"><\/script>/);
    for (const [file, type] of [['/', /text\/html/], ['/app.js', /javascript/], ['/theme.js', /javascript/], ['/styles.css', /text\/css/], ['/favicon.svg', /svg/]]) {
      const res = await fetch(`http://127.0.0.1:${port}${file}`);
      assert.equal(res.status, 200, file);
      assert.match(res.headers.get('content-type'), type, file);
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'none'/, file);
      assert.match(csp, /script-src 'self'/, file);
      assert.match(csp, /style-src 'self'/, file);
      assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), file);
    }
  } finally { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the real page, in Chrome ------------------------------------------------------------------------------------------------------------------------

const CHROME = process.env.ULA_UI_NO_CHROME ? null : chromeExecutable();
const skipChrome = CHROME ? false : 'no Chrome on this computer';

/** A headless Chrome of its own (its own profile folder and debugging port) and a way to talk to one tab of it. */
async function startChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-layout-chrome-'));
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not say where its debugging port is')), 20000);
    child.stderr.on('data', (c) => { out += c; const m = /DevTools listening on (ws:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited early (${code})`)); });
  });
  const httpBase = `http://${new URL(wsUrl).host}`;
  let list = [];
  for (let i = 0; i < 40 && !list.length; i += 1) { list = (await (await fetch(`${httpBase}/json/list`)).json()).filter((t) => t.type === 'page'); if (!list.length) await wait(100); }
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((resolve) => { id += 1; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable');
  const page = {
    send,
    async eval(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`in the page: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`); return r.result.value; },
    async until(expression, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await page.eval(expression)) return true; } catch (_) { /* the page is still loading */ } await wait(100); } return false; },
    async viewport(width, height, { phone }) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: phone });
      await send('Emulation.setTouchEmulationEnabled', { enabled: phone, maxTouchPoints: phone ? 5 : 1 });
      await send('Emulation.setEmitTouchEventsForMouse', { enabled: phone, configuration: 'mobile' });
    },
    async go(url, ready) { await send('Page.navigate', { url: 'about:blank' }); await wait(100); await send('Page.navigate', { url }); return page.until(ready); }
  };
  return {
    page,
    async stop() {
      try { ws.close(); } catch (_) { /* gone */ }
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), wait(3000)]);
      try { child.kill('SIGKILL'); } catch (_) { /* gone */ }
      fs.rmSync(profile, { recursive: true, force: true });
    }
  };
}

/**
 * Everything wrong with the page as it is on the screen right now, as sentences (an empty list is a page with nothing wrong). `width` is the width the screen was
 * asked to be: a phone's browser zooms out to fit a page that is too wide, so the width it reports back can hide the very problem that is being looked for.
 */
const INSPECT = (width) => `(() => {
  const problems = [];
  const vw = ${width};
  if (innerWidth !== vw) problems.push('the browser had to zoom out to fit the page: it is wider than the ' + vw + ' px screen (' + innerWidth + ')');
  const visible = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && !el.closest('.sr-only, .offscreen, .skip'); };
  if (document.documentElement.scrollWidth > vw) problems.push('the page scrolls sideways: ' + document.documentElement.scrollWidth + ' wide in ' + vw);
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || getComputedStyle(el).position === 'fixed') continue;
    const b = el.getBoundingClientRect();
    if (b.right <= vw + 1 && b.left >= -1) continue;
    let clipped = false;
    for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if ((o === 'auto' || o === 'scroll' || o === 'hidden') && p.getBoundingClientRect().right <= vw + 1) { clipped = true; break; } }
    if (!clipped) problems.push('sticks out of the screen: <' + el.tagName.toLowerCase() + ' class="' + (el.getAttribute('class') || '') + '"> ' + (el.textContent || '').trim().slice(0, 30) + ' right=' + Math.round(b.right));
  }
  if (vw < 700) {
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue;
      const o = getComputedStyle(el).overflowX;
      if ((o === 'auto' || o === 'scroll') && el.scrollWidth > el.clientWidth + 1) problems.push('hides content behind a sideways scroll: <' + el.tagName.toLowerCase() + ' class="' + (el.getAttribute('class') || '') + '"> ' + (el.textContent || '').trim().slice(0, 30));
    }
  }
  if (matchMedia('(pointer: coarse)').matches) {
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=tab]')) {
      if (!visible(el)) continue;
      if (el.matches('a') && el.closest('p, li') && !el.closest('.foot')) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 43.5 || b.height < 43.5) problems.push('too small to tap: ' + (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
    }
  }
  return problems;
})()`;

test('the real page at 320, 390, 820 and 1280 px: nothing scrolls sideways, nothing is too small to tap on a phone, tables turn into cards, the chat is on the first screen', { skip: skipChrome, timeout: 240000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-layout-'));
  const bus = new EventEmitter();
  const fake = createFakeProvider({ dir, bus });
  // models carry their working context size, and a Gemini-shaped provider brings its "Read models again" button and the stable names into the pages measured
  const fakeModels = fake.models;
  fake.models = () => fakeModels().map((m) => ({ ...m, context_length: 128000 }));
  const gem = createFakeProvider({ dir, bus, id: 'gemini', name: 'Gemini' });
  gem.models = () => ['gemini', 'gemini-auto', 'gemini-3-5-flash-lite'].map((id) => ({ id, name: id, thinking: true, escalate: false, context_length: 128000 }));
  fake.capabilities = { ...fake.capabilities, settings: ['dailyCap', 'sessions'] };
  const baseStatus = fake.status;
  fake.status = async () => ({ ...(await baseStatus()), sessions: { enabled: true, reason: null, open: 2, continued: 1, started: 2, diverged: 0, failed: 0 } });
  fake.engine.sessionList = () => [
    { id: 'sAAA1', provider: 'fake', model: 'fake-chat', tag: 'lens-code-7f3a-with-a-long-name-that-must-not-push-the-page-wider', turns: 3, chars: 100, createdAt: new Date().toISOString(), lastUsed: new Date(Date.now() - 90000).toISOString(), busy: false },
    { id: 'sBBB2', provider: 'fake', model: 'fake-auto', tag: null, turns: 1, chars: 10, createdAt: new Date().toISOString(), lastUsed: new Date().toISOString(), busy: true }
  ];
  const config = createConfig({ dataDir: dir });
  const srv = createServer({ config, registry: createRegistry({ providers: [fake, gem], bus }), port: 0 });
  const { port } = await srv.start();
  const base = `http://127.0.0.1:${port}`;
  config.createApiKey('lens code');
  config.createApiKey('a key with a rather long name to see what it does to a card');
  const call = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken()}` }, body: JSON.stringify(body) });
  await call('/v1/chat/completions', { model: 'fake-chat', messages: [{ role: 'user', content: 'a' }] });
  await call('/v1/messages', { model: 'fake-auto', max_tokens: 5, messages: [{ role: 'user', content: 'b' }] });
  const chrome = await startChrome();
  const { page } = chrome;
  try {
    await page.viewport(1280, 860, { phone: false });
    assert.ok(await page.go(`${base}/_/login?token=${encodeURIComponent(config.adminToken())}`, '!!document.querySelector(".shell")'), 'signed in');
    const all = [];
    for (const [width, height, phone] of [[1280, 860, false], [820, 1000, false], [390, 844, true], [320, 640, true]]) {
      await page.viewport(width, height, { phone });
      for (const view of ['playground', 'accounts', 'api', 'activity']) {
        assert.ok(await page.go(`${base}/#${view}`, `!!document.querySelector('[data-view="${view}"] h1') && !document.querySelector('[data-view="${view}"]').classList.contains('hidden') && ${view === 'playground' ? 'true' : `!!document.querySelector('[data-view="${view}"] .card')`}`), `${view} loaded at ${width}`);
        await wait(250);
        const problems = await page.eval(INSPECT(width));
        for (const p of problems) all.push(`${view} at ${width}px: ${p}`);
        if (phone && view === 'playground') {
          const box = await page.eval(`(() => { const t = document.querySelector('textarea[aria-label="Message"]').getBoundingClientRect(); const m = document.querySelector('.messages').getBoundingClientRect(); const s = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send').getBoundingClientRect(); return { boxTop: t.top, boxBottom: t.bottom, chatTop: m.top, sendBottom: s.bottom, vh: innerHeight }; })()`);
          if (!(box.boxBottom <= box.vh && box.boxTop >= 0 && box.sendBottom <= box.vh)) all.push(`playground at ${width}px: the message box is not on the first screen (${JSON.stringify(box)})`);
          if (!(box.chatTop < (width < 360 ? 175 : 150))) all.push(`playground at ${width}px: the chat starts ${Math.round(box.chatTop)} px down, below the settings`);
        }
        if (view === 'api') {
          const blk = await page.eval(`(() => { const pre = document.querySelector('.paste-block pre'); const copy = document.querySelector('.paste-block .copy'); const cells = [...document.querySelectorAll('.models-table td[data-label="Context"]')]; const inView = cells.every((c) => { const b = c.getBoundingClientRect(); return b.width > 0 && b.left >= 0 && b.right <= ${width} + 1; }); return { wraps: pre.scrollWidth <= pre.clientWidth + 1, lines: pre.textContent.split('\\n').length, copyH: Math.round(copy.getBoundingClientRect().height), copyOnPre: copy.getBoundingClientRect().right <= pre.getBoundingClientRect().right + 1, cells: cells.length, inView }; })()`);
          if (!blk.wraps) all.push(`api at ${width}px: the copy block scrolls sideways instead of wrapping`);
          if (blk.lines !== 5) all.push(`api at ${width}px: the copy block has ${blk.lines} lines, expected 5`);
          if (!blk.copyOnPre) all.push(`api at ${width}px: the Copy button sticks out of its box`);
          if (phone && blk.copyH < 44) all.push(`api at ${width}px: the Copy button is ${blk.copyH} px tall`);
          if (blk.cells < 2 || !blk.inView) all.push(`api at ${width}px: the Context cells are missing or out of view (${JSON.stringify(blk)})`);
        }
        if (view === 'accounts') {
          const re = await page.eval(`(() => { const b = document.querySelector('#reread-gemini'); if (!b) return null; const r = b.getBoundingClientRect(); return { h: Math.round(r.height), disabled: b.disabled, inView: r.left >= 0 && r.right <= ${width} + 1 }; })()`);
          if (!re || re.disabled || !re.inView || (phone && re.h < 44)) all.push(`accounts at ${width}px: the Read models again button is missing, off, out of view or too small (${JSON.stringify(re)})`);
        }
        // a table is a table while its card is wide (over 640 px of room) and a list of cards when it is narrow
        const tables = { api: '.keys-table', accounts: '.sessions-table', activity: '.activity-table' };
        if (tables[view]) {
          const mode = await page.eval(`(() => { const t = document.querySelector('${tables[view]}'); const card = t.closest('.card'); const cs = getComputedStyle(card); const room = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); return { row: getComputedStyle(t.querySelector('tbody tr')).display, room }; })()`);
          const wantCards = mode.room <= 640;
          if (wantCards ? mode.row !== 'grid' : mode.row !== 'table-row') all.push(`${view} at ${width}px: its table is ${mode.row} in a card with ${Math.round(mode.room)} px of room, expected ${wantCards ? 'cards' : 'a table'}`);
          if (view === 'api' && width <= 390 && mode.row !== 'grid') all.push('the keys are not cards on a phone');
          if (view === 'api' && width >= 1280 && mode.row !== 'table-row') all.push('the keys are not a table on a wide screen');
        }
      }
      const frame = await page.eval(`(() => { const n = document.querySelector('nav[aria-label="Pages"]').getBoundingClientRect(); return { left: n.left, bottom: n.bottom, top: n.top, width: n.width, vh: innerHeight, vw: innerWidth }; })()`);
      if (width >= 800 && !(frame.left < 20 && frame.width < 300)) all.push(`at ${width}px the pages are not a rail on the left: ${JSON.stringify(frame)}`);
      if (width < 800 && !(Math.abs(frame.bottom - frame.vh) < 2 && frame.width === frame.vw)) all.push(`at ${width}px the pages are not a tab bar at the bottom: ${JSON.stringify(frame)}`);
    }
    // controls have one height on a desktop (36 px) and a finger's 44 px on a phone
    await page.viewport(1280, 860, { phone: false });
    await page.go(`${base}/#accounts`, '!!document.querySelector(\'[data-view="accounts"] .card\')');
    const desktop = await page.eval(`[...document.querySelectorAll('.btn:not(.sm):not(.icon-only), input[type=number], select')].filter((e) => e.getBoundingClientRect().height).map((e) => Math.round(e.getBoundingClientRect().height))`);
    assert.ok(desktop.length > 2 && desktop.every((h) => h === 36), `desktop controls are 36 px: ${desktop}`);
    await page.viewport(390, 844, { phone: true });
    await page.go(`${base}/#accounts`, '!!document.querySelector(\'[data-view="accounts"] .card\')');
    const phone = await page.eval(`[...document.querySelectorAll('.btn:not(.icon-only), input[type=number], select')].filter((e) => e.getBoundingClientRect().height).map((e) => Math.round(e.getBoundingClientRect().height))`);
    assert.ok(phone.length > 2 && phone.every((h) => h === 44), `phone controls are 44 px: ${phone}`);
    assert.deepEqual(all, []);
  } finally { await chrome.stop(); await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the real page with nothing linked: the checklist is the first thing on a phone, with its buttons in reach', { skip: skipChrome, timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-layout-'));
  const bus = new EventEmitter();
  const fake = createFakeProvider({ dir, bus });
  fake.script.linked = false;
  const config = createConfig({ dataDir: dir });
  const srv = createServer({ config, registry: createRegistry({ providers: [fake], bus }), port: 0 });
  const { port } = await srv.start();
  const base = `http://127.0.0.1:${port}`;
  const chrome = await startChrome();
  const { page } = chrome;
  try {
    await page.viewport(390, 844, { phone: true });
    assert.ok(await page.go(`${base}/_/login?token=${encodeURIComponent(config.adminToken())}`, '!!document.querySelector(".shell")'));
    assert.ok(await page.until('!!document.querySelector(".setup")'));
    await wait(200);
    assert.deepEqual(await page.eval(INSPECT(390)), []);
    const r = await page.eval(`(() => { const s = document.querySelector('.setup').getBoundingClientRect(); const b = [...document.querySelectorAll('.setup button')].find((x) => x.textContent === 'Link an account').getBoundingClientRect(); return { setupTop: s.top, linkBottom: b.bottom, vh: innerHeight }; })()`);
    assert.ok(r.setupTop < 200 && r.linkBottom < r.vh, JSON.stringify(r));
  } finally { await chrome.stop(); await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the narrowest phones (320 and 390): the brand name is readable, the model name has room, the Activity filter does not squeeze its words, a link is a finger wide', { skip: skipChrome, timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-layout-'));
  const bus = new EventEmitter();
  const fake = createFakeProvider({ dir, bus });
  const config = createConfig({ dataDir: dir });
  const srv = createServer({ config, registry: createRegistry({ providers: [fake], bus }), port: 0 });
  const { port } = await srv.start();
  const base = `http://127.0.0.1:${port}`;
  const call = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken()}` }, body: JSON.stringify(body) });
  await call('/v1/chat/completions', { model: 'fake-chat', messages: [{ role: 'user', content: 'a' }] }); // a request, but no key made: the checklist is unfinished and shows "Hide"
  const chrome = await startChrome();
  const { page } = chrome;
  const found = [];
  try {
    await page.viewport(1280, 860, { phone: false });
    assert.ok(await page.go(`${base}/_/login?token=${encodeURIComponent(config.adminToken())}`, '!!document.querySelector(".shell")'), 'signed in');
    for (const width of [320, 390]) {
      await page.viewport(width, 700, { phone: true });
      assert.ok(await page.go(`${base}/#playground`, '!!document.querySelector(".play-bar select") && !!document.querySelector(".setup")'));
      await wait(250);
      for (const p of await page.eval(INSPECT(width))) found.push(`playground at ${width}px: ${p}`);
      const bar = await page.eval(`(() => {
        const name = document.querySelector('.rail .brand-name'); const logo = document.querySelector('.rail .brand svg, .rail .brand img'); const cs = getComputedStyle(name); const b = name.getBoundingClientRect(); const rail = document.querySelector('.rail').getBoundingClientRect();
        const sel = document.querySelector('.play-bar select').getBoundingClientRect(); const hide = [...document.querySelectorAll('.setup .link-btn')].find((x) => x.textContent === 'Hide'); const hb = hide && hide.getBoundingClientRect();
        const tools = document.querySelector('.rail-tools').getBoundingClientRect();
        return { nameShown: cs.display !== 'none' && b.width > 0, nameClipped: name.scrollWidth > name.clientWidth + 1 || name.scrollHeight > name.clientHeight + 1, nameInsideBar: b.top >= rail.top - 0.5 && b.bottom <= rail.bottom + 0.5, nameLeftOfTools: b.right <= tools.left + 0.5, selectWidth: sel.width, hideWidth: hb && hb.width };
      })()`);
      if (!bar.nameShown) found.push(`at ${width}px the brand name is hidden`);
      if (bar.nameClipped) found.push(`at ${width}px the brand name is cut off`);
      if (!bar.nameInsideBar) found.push(`at ${width}px the brand name sticks out of the top bar`);
      if (!bar.nameLeftOfTools) found.push(`at ${width}px the brand name runs into the theme control`);
      const wantSelect = width < 360 ? width - 40 : 190; // under 360 px the toolbar takes two rows and the list gets a row of its own
      if (!(bar.selectWidth >= wantSelect)) found.push(`at ${width}px the model list is only ${Math.round(bar.selectWidth)} px wide (want ${wantSelect}): its names are cut`);
      if (!(bar.hideWidth >= 43.5)) found.push(`at ${width}px "Hide" is ${Math.round(bar.hideWidth)} px wide`);
      assert.ok(await page.go(`${base}/#activity`, '!!document.querySelector(\'[data-view="activity"] .seg-btn\')'));
      await wait(250);
      for (const p of await page.eval(INSPECT(width))) found.push(`activity at ${width}px: ${p}`);
      const fit = await page.eval(`[...document.querySelectorAll('[data-view="activity"] .seg-btn')].map((b) => { const r = document.createRange(); r.selectNodeContents(b); const cs = getComputedStyle(b); return { text: b.textContent, room: b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - r.getBoundingClientRect().width }; })`);
      for (const f of fit) if (f.room < -0.5) found.push(`at ${width}px "${f.text}" is wider than the room inside its button (${f.room.toFixed(1)} px)`);
    }
    assert.deepEqual(found, []);
  } finally { await chrome.stop(); await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
