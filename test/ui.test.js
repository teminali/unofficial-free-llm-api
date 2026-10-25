'use strict';

/**
 * The web interface, run for real: web/index.html and web/app.js loaded in jsdom against a real server (the fake provider behind it). jsdom has no fetch and
 * no dialog, so the test hands the page Node's fetch (signed in with the admin token, which the server accepts the same way as its cookie) and a small dialog.
 * Skipped when jsdom is not installed (it is a dev dependency).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createConfig } = require('../src/config');
const { createRegistry } = require('../src/registry');
const { createServer } = require('../src/server');
const { createFakeProvider } = require('./fixtures/fake_provider');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (_) { JSDOM = null; }

const WEB = path.join(__dirname, '..', 'web');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test_, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test_()) return true; await wait(25); }
  return false;
}

async function open({ hash = '', provider: tweak, setup, local = {}, keyLink = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-ui-'));
  const bus = new EventEmitter();
  const fake = createFakeProvider({ dir, bus, keyLink });
  if (tweak) tweak(fake);
  const config = createConfig({ dataDir: dir });
  if (setup) setup({ fake, config, dir });
  const srv = createServer({ config, registry: createRegistry({ providers: [fake], bus }), port: 0 });
  const { port } = await srv.start();
  const base = `http://127.0.0.1:${port}`;
  const token = config.adminToken();
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replace('<script src="app.js"></script>', '');
  const dom = new JSDOM(html, { url: `${base}/${hash}`, pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  const sent = []; // every request the page made: { method, path, body }
  window.fetch = (input, init = {}) => {
    sent.push({ method: init.method || 'GET', path: String(input), body: init.body ? JSON.parse(init.body) : undefined });
    return fetch(new URL(String(input), base), { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  };
  const copied = []; // what the page put on the clipboard
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { copied.push(text); } } });
  window.TextDecoder = TextDecoder;
  window.AbortController = AbortController;
  window.matchMedia = () => ({ matches: false });
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); };
  const nativeConfirms = []; // the browser's own confirm() box must never be used: the page has its own dialogs
  window.confirm = (text) => { nativeConfirms.push(text); return false; };
  for (const [k, v] of Object.entries(local)) window.localStorage.setItem(k, v); // what the browser kept from an earlier visit
  window.eval(fs.readFileSync(path.join(WEB, 'app.js'), 'utf8'));
  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return {
    fake, srv, window, $, $$, click, config, dir, base, token, sent, copied, nativeConfirms,
    async close() { await wait(120); window.close(); await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); } // the short wait lets a refresh that is in flight land before the page goes
  };
}

const skip = JSDOM ? false : 'jsdom is not installed';

test('the page loads signed in, lists the models and shows the endpoint', { skip }, async () => {
  const ui = await open();
  try {
    assert.ok(await until(() => ui.$$('select option').length >= 3), 'the model list filled in');
    assert.deepEqual(ui.$$('select optgroup option').map((o) => o.value), ['fake-chat', 'fake-reasoner', 'fake-auto']);
    assert.match(ui.$('.pill').textContent, /\/v1/);
    assert.ok(ui.$('footer a[href$="DONATE.md"]'), 'the support link is in the footer');
    assert.equal(ui.$('header a[href$="DONATE.md"]'), null, 'and not in the main bar');
    assert.ok(ui.$('footer a[href$="DISCLAIMER.md"]'), 'the disclaimer is linked from every page');
  } finally { await ui.close(); }
});

test('the playground sends a message through /v1 and streams the answer in, with the thinking apart', { skip }, async () => {
  const ui = await open();
  try {
    ui.fake.script.reply = (_p, { thinking }) => ({ ok: true, text: 'Here is **bold** and `code`:\n\n```js\nconsole.log(1)\n```', thinking: thinking ? 'Pondering.' : '' });
    await until(() => ui.$$('select option').length >= 3);
    ui.$('select[aria-label="Model"]').value = 'fake-reasoner';
    ui.$('select[aria-label="Model"]').dispatchEvent(new ui.window.Event('change'));
    const box = ui.$('textarea[aria-label="Message"]');
    box.value = 'say something';
    ui.click([...ui.$$('button')].find((b) => b.textContent === 'Send'));
    assert.ok(await until(() => ui.$('.msg.assistant .bubble strong')), 'the answer was rendered with its markup as elements');
    assert.equal(ui.$('.msg.assistant .bubble strong').textContent, 'bold');
    assert.equal(ui.$('.msg.assistant .bubble code').textContent, 'code');
    assert.equal(ui.$('.msg.assistant pre code').textContent, 'console.log(1)');
    assert.equal(ui.$('.msg.user .bubble').textContent, 'say something');
    assert.ok(await until(() => ui.$('details.think .body') && ui.$('details.think .body').textContent === 'Pondering.'), 'the reasoning is in its own fold');
    assert.ok(await until(() => /fake-reasoner/.test(ui.$('.msg.assistant .meta').textContent)), 'the model and time are shown when it is done');
    assert.equal(ui.fake.calls[0].thinking, true);
    // the second message carries the whole conversation
    box.value = 'and again';
    ui.click([...ui.$$('button')].find((b) => b.textContent === 'Send'));
    assert.ok(await until(() => ui.fake.calls.length === 2));
    assert.match(ui.fake.calls[1].prompt, /USER:\nsay something/);
    assert.match(ui.fake.calls[1].prompt, /USER:\nand again/);
  } finally { await ui.close(); }
});

test('nothing a model says can become markup in the page', { skip }, async () => {
  const ui = await open();
  try {
    ui.fake.script.reply = () => ({ ok: true, text: '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>\n\n[click](javascript:alert(1)) and [ok](https://example.com)' });
    await until(() => ui.$$('select option').length >= 3);
    ui.$('textarea[aria-label="Message"]').value = 'hi';
    ui.click([...ui.$$('button')].find((b) => b.textContent === 'Send'));
    assert.ok(await until(() => ui.$('.msg.assistant .bubble p')));
    await wait(100);
    assert.equal(ui.$('.msg.assistant img'), null);
    assert.equal(ui.$('.msg.assistant script'), null);
    assert.equal(ui.window.pwned, undefined);
    assert.ok(ui.$('.msg.assistant .bubble').textContent.includes('<img src=x'), 'the text is shown as text');
    const links = ui.$$('.msg.assistant a').map((a) => a.getAttribute('href'));
    assert.deepEqual(links, ['https://example.com'], 'only http(s) links become links');
  } finally { await ui.close(); }
});

test('an answer made of nothing but unbalanced brackets is shown at once: the markdown reader has no input it takes quadratic time on', { skip, timeout: 60000 }, async () => {
  const ui = await open();
  try {
    ui.fake.script.chunk = 1000000;
    ui.fake.script.reply = () => ({ ok: true, text: `${'['.repeat(200000)} the end` });
    await until(() => ui.$$('select option').length >= 3);
    ui.$('textarea[aria-label="Message"]').value = 'hi';
    const started = Date.now();
    ui.click([...ui.$$('button')].find((b) => b.textContent === 'Send'));
    assert.ok(await until(() => ui.$('.msg.assistant .bubble p'), 20000));
    assert.ok(Date.now() - started < 4000, `rendering took ${Date.now() - started} ms`);
    assert.ok(ui.$('.msg.assistant .bubble').textContent.endsWith('the end'));
  } finally { await ui.close(); }
});

test('an API error is shown in words, with its code and when to retry', { skip }, async () => {
  const ui = await open({ provider: (f) => f.governor.setCooldown(120000, 'testing') });
  try {
    await until(() => ui.$$('select option').length >= 3);
    ui.$('textarea[aria-label="Message"]').value = 'hi';
    ui.click([...ui.$$('button')].find((b) => b.textContent === 'Send'));
    assert.ok(await until(() => ui.$('.errbox')));
    assert.match(ui.$('.errbox').textContent, /cooling down/);
    assert.match(ui.$('.errbox').textContent, /fake_cooldown/);
    assert.match(ui.$('.errbox').textContent, /retry in \d+s/);
    assert.equal(ui.$('.msg.user'), null, 'a message that was refused is taken back');
  } finally { await ui.close(); }
});

test('the Accounts page shows state and usage, the consent gate guards linking, and Unlink works', { skip }, async () => {
  const ui = await open({ hash: '#accounts' });
  try {
    assert.ok(await until(() => ui.$('[data-view="accounts"] article')));
    const card = ui.$('[data-view="accounts"] article');
    assert.match(card.textContent, /Fake/);
    assert.match(card.textContent, /Linked/);
    assert.match(card.textContent, /0 of 300/);
    // linking asks first
    ui.click([...card.querySelectorAll('button')].find((b) => b.textContent === 'Sign in again'));
    const dialog = ui.$('dialog');
    assert.ok(dialog.hasAttribute('open'));
    const go = [...dialog.querySelectorAll('button')].find((b) => /Open Chrome/.test(b.textContent));
    assert.equal(go.disabled, true, 'the button stays off until the box is ticked');
    const tick = dialog.querySelector('input[type="checkbox"]');
    tick.checked = true;
    tick.dispatchEvent(new ui.window.Event('change'));
    assert.equal(go.disabled, false);
    assert.match(dialog.textContent, /may break its terms/);
    assert.match(dialog.textContent, /muted or signed out/);
    ui.click(go);
    assert.ok(await until(() => !dialog.hasAttribute('open')));
    // unlink: the page asks in its own dialog (not the browser's confirm box) and only then does it
    ui.click([...ui.$('[data-view="accounts"] article').querySelectorAll('button')].find((b) => b.textContent === 'Unlink'));
    const sure = ui.$('dialog');
    assert.ok(sure && sure.hasAttribute('open'), 'the page asks first, in a dialog');
    assert.match(sure.textContent, /Unlink Fake\?/);
    ui.click([...sure.querySelectorAll('button')].find((b) => b.textContent === 'Unlink'));
    assert.ok(await until(() => /Not linked/.test(ui.$('[data-view="accounts"] article').textContent)));
    assert.deepEqual(ui.nativeConfirms, [], 'the browser\'s own confirm box was not used');
  } finally { await ui.close(); }
});

test('a key provider links with a pasted key, folds the field away, and shows its credits', { skip }, async () => {
  const ui = await open({
    hash: '#accounts',
    keyLink: true,
    setup: ({ fake }) => { fake.script.linked = false; fake.script.credits = null; }
  });
  try {
    assert.ok(await until(() => ui.$('[data-view="accounts"] article')));
    const card = () => ui.$('[data-view="accounts"] article');
    assert.match(card().textContent, /Not linked/);
    assert.match(card().textContent, /b4m_/);
    assert.ok(ui.$('#key-fake'), 'the key field is shown instead of a Chrome stepper');
    assert.equal([...card().querySelectorAll('button')].some((b) => b.textContent === 'Sign in again'), false);
    ui.$('#key-fake').value = 'b4m_live_ui_test_123456';
    ui.click([...card().querySelectorAll('button')].find((b) => b.textContent === 'Link account'));
    const dialog = ui.$('dialog');
    assert.ok(dialog.hasAttribute('open'));
    assert.match(dialog.textContent, /billed in credits/);
    const go = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Use this API key');
    assert.equal(go.disabled, true, 'the button stays off until the box is ticked');
    const tick = dialog.querySelector('input[type="checkbox"]');
    tick.checked = true;
    tick.dispatchEvent(new ui.window.Event('change'));
    assert.equal(go.disabled, false);
    ui.click(go);
    assert.ok(await until(() => /Linked/.test(card().textContent)), 'the key linked the account');
    assert.ok(await until(() => /5[,.]?000/.test(card().textContent)), 'the credit balance is shown');
    const tokenCall = ui.sent.find((r) => r.path.endsWith('/providers/fake/token'));
    assert.equal(tokenCall.body.token, 'b4m_live_ui_test_123456');
    assert.equal(tokenCall.body.consentAcknowledged, true);
    assert.ok(ui.$('#key-fake').closest('details'), 'once linked, the key field is folded away');
  } finally { await ui.close(); }
});

test('the daily cap is changed from the Accounts page', { skip }, async () => {
  const ui = await open({ hash: '#accounts' });
  try {
    assert.ok(await until(() => ui.$('input[aria-label="Daily call cap"]')));
    const cap = ui.$('input[aria-label="Daily call cap"]');
    cap.value = '12';
    ui.click([...ui.$('[data-view="accounts"] article').querySelectorAll('button')].find((b) => b.textContent === 'Save'));
    assert.ok(await until(() => ui.fake.governor.getStats().dailyCap === 12));
    assert.ok(await until(() => /0 of 12/.test(ui.$('[data-view="accounts"]').textContent)));
  } finally { await ui.close(); }
});

test('the API page shows a key again from the list', { skip }, async () => {
  const ui = await open({ hash: '#api' });
  try {
    assert.ok(await until(() => ui.$('input[aria-label="Key name"]')));
    ui.$('input[aria-label="Key name"]').value = 'cline';
    ui.click([...ui.$$('button')].find((b) => b.textContent === 'Make a key'));
    assert.ok(await until(() => ui.$('.newkey code')));
    const key = ui.$('.newkey code').textContent;
    ui.click([...ui.$$('button')].find((b) => b.textContent === 'Done'));
    assert.ok(await until(() => !ui.$('.newkey')));
    assert.ok(!ui.$('[data-view="api"]').textContent.includes(key), 'a key that is not being shown is not on the page');
    ui.click([...ui.$$('button')].find((b) => b.textContent === 'Show' && b.closest('tr').textContent.includes('cline')));
    assert.ok(await until(() => ui.$('.newkey code')));
    assert.equal(ui.$('.newkey code').textContent, key, 'the list shows the same key again');
    assert.ok(ui.$('[data-view="api"] pre code').textContent.includes(key), 'and the snippet carries it');
  } finally { await ui.close(); }
});

test('the API page makes a key once, uses it in the snippets, and revokes it', { skip }, async () => {
  const ui = await open({ hash: '#api' });
  try {
    assert.ok(await until(() => ui.$('input[aria-label="Key name"]')));
    ui.$('input[aria-label="Key name"]').value = 'my script';
    ui.click([...ui.$$('button')].find((b) => b.textContent === 'Make a key'));
    assert.ok(await until(() => ui.$('.newkey code')));
    const key = ui.$('.newkey code').textContent;
    assert.match(key, /^sk-ula-/);
    assert.ok(ui.$('[data-view="api"] pre code').textContent.includes(key), 'the snippet carries the new key');
    assert.ok(ui.$('[data-view="api"] pre code').textContent.includes('fake-chat'), 'and the first model');
    assert.equal((await fetch(`${ui.base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).status, 200);
    ui.click([...ui.$$('button')].find((b) => b.textContent === 'Done'));
    assert.ok(await until(() => !ui.$('.newkey')));
    assert.ok(!ui.$('[data-view="api"]').textContent.includes(key), 'a key is shown once');
    assert.match(ui.$('[data-view="api"] table').textContent, /my script/);
    ui.click([...ui.$$('button')].find((b) => b.textContent === 'Revoke' && b.closest('tr').textContent.includes('my script')));
    const sure = ui.$('dialog');
    assert.ok(sure && sure.hasAttribute('open'), 'the page asks first, in a dialog');
    ui.click([...sure.querySelectorAll('button')].find((b) => b.textContent === 'Revoke key'));
    assert.deepEqual(ui.nativeConfirms, [], 'the browser\'s own confirm box was not used');
    assert.ok(await until(async () => (await fetch(`${ui.base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).status === 401));
    assert.ok(await until(() => !/my script/.test(ui.$('[data-view="api"]').textContent)), 'the row leaves the table');
  } finally { await ui.close(); }
});

test('the Activity page lists requests without their content, and notices', { skip }, async () => {
  const ui = await open({ hash: '#activity' });
  try {
    ui.fake.script.reply = () => ({ ok: true, text: 'ACTIVITY-ANSWER-SECRET' });
    await fetch(`${ui.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ui.token}` }, body: JSON.stringify({ model: 'fake-chat', messages: [{ role: 'user', content: 'ACTIVITY-PROMPT-SECRET' }] }) });
    assert.ok(await until(() => /fake-chat/.test(ui.$('[data-view="activity"]').textContent)));
    const text = ui.$('[data-view="activity"]').textContent;
    assert.ok(!text.includes('SECRET'));
    assert.match(text, /web interface|200/);
  } finally { await ui.close(); }
});

test('a page with no sign-in shows the sign-in card and no data', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-ui-'));
  const bus = new EventEmitter();
  const config = createConfig({ dataDir: dir });
  const srv = createServer({ config, registry: createRegistry({ providers: [createFakeProvider({ dir, bus })], bus }), port: 0 });
  const { port } = await srv.start();
  const base = `http://127.0.0.1:${port}`;
  const dom = new JSDOM(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replace('<script src="app.js"></script>', ''), { url: `${base}/`, pretendToBeVisual: true, runScripts: 'outside-only' });
  dom.window.fetch = (input, init) => fetch(new URL(String(input), base), init);
  dom.window.matchMedia = () => ({ matches: false });
  try {
    dom.window.eval(fs.readFileSync(path.join(WEB, 'app.js'), 'utf8'));
    assert.ok(await until(() => dom.window.document.querySelector('.locked')));
    assert.match(dom.window.document.querySelector('.locked').textContent, /unofficial-free-llm-api login-url/);
    assert.equal(dom.window.document.querySelector('select'), null);
  } finally { dom.window.close(); await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});


// ---- the redone interface: what each part does for the person ---------------------------------------------------------------------------------

const buttonNamed = (ui, text, within) => [...(within || ui.window.document).querySelectorAll('button')].find((b) => b.textContent === text);
const send = async (ui, text) => {
  ui.$('textarea[aria-label="Message"]').value = text;
  ui.click(buttonNamed(ui, 'Send'));
  const before = ui.$$('.msg.assistant .meta').length;
  assert.ok(await until(() => ui.$$('.msg.assistant .meta').filter((m) => m.textContent).length > before - 1 && !ui.$('.msg.assistant .bubble.typing') && ui.$$('.msg.assistant .meta').every((m) => m.textContent)), 'the answer came in');
};
const sessionsFor = (f, { enabled = true, reason = null, open = 2, list = [] } = {}) => {
  f.capabilities = { ...f.capabilities, settings: ['dailyCap', 'sessions'] };
  const status = f.status;
  f.sessionState = { enabled, reason, open, continued: 0, started: open, diverged: 0, failed: 0 };
  f.sessionPuts = [];
  f.ended = [];
  f.status = async () => ({ ...(await status()), sessions: f.sessionState });
  f.setSettings = async (patch) => {
    if (patch.dailyCap) f.governor.setDailyCap(patch.dailyCap);
    if (patch.sessions !== undefined) { f.sessionPuts.push(patch.sessions); f.sessionState = { ...f.sessionState, enabled: patch.sessions === true, reason: patch.sessions === true ? null : f.sessionState.reason, failed: patch.sessions === true ? 0 : f.sessionState.failed, open: patch.sessions ? f.sessionState.open : 0 }; }
    return f.status();
  };
  f.engine.sessionList = () => list;
  f.engine.endSession = (id) => { f.ended.push(id); return true; };
};

test('with nothing linked the playground shows a first-run checklist that follows the real state, and its buttons go to the right page', { skip }, async () => {
  const ui = await open({ provider: (f) => { f.script.linked = false; } });
  try {
    assert.ok(await until(() => ui.$('.setup')));
    const steps = () => ui.$$('.setup .step').map((li) => [li.dataset.step, li.classList.contains('done')]);
    assert.deepEqual(steps(), [['link', false], ['key', false], ['try', false]]);
    assert.match(ui.$('.setup').textContent, /0 of 3 done/);
    assert.ok(!/No account is linked yet/.test(ui.$('[data-view="playground"]').textContent), 'no longer one plain sentence');
    assert.equal(buttonNamed(ui, 'Send').disabled, true, 'nothing to send to yet');
    assert.equal(ui.$('textarea[aria-label="Message"]').disabled, true);
    // the first step's button goes to the Accounts page
    ui.click(buttonNamed(ui, 'Link an account', ui.$('.setup')));
    assert.ok(!ui.$('[data-view="accounts"]').classList.contains('hidden'));
    assert.ok(ui.$('[data-view="playground"]').classList.contains('hidden'));
    ui.click([...ui.$$('nav button')].find((b) => /Playground/.test(b.textContent)));
    // the account is linked, a key is made: two steps are done at the next refresh; a first request finishes the third
    ui.fake.script.linked = true;
    ui.config.createApiKey('first');
    assert.ok(await until(() => steps().filter((s) => s[1]).length === 2, 7000), JSON.stringify(steps()));
    assert.deepEqual(steps(), [['link', true], ['key', true], ['try', false]]);
    assert.match(ui.$('.setup').textContent, /2 of 3 done/);
    await send(ui, 'hello');
    assert.ok(await until(() => !ui.$('.setup'), 3000), 'the checklist is gone once a message went through');
  } finally { await ui.close(); }
});

test('the checklist remembers that a first request went through, so it does not un-tick when the program restarts', { skip }, async () => {
  const steps = (ui) => ui.$$('.setup .step').map((li) => [li.dataset.step, li.classList.contains('done')]);
  // 1. the first request seen is written down in the browser
  const first = await open({ provider: (f) => { f.script.linked = true; } });
  try {
    assert.ok(await until(() => first.$('.setup')));
    assert.equal(first.window.localStorage.getItem('ula.firstRequestDone'), null, 'nothing has gone through yet');
    assert.deepEqual(steps(first).map((s) => s[1]), [true, false, false]);
    await send(first, 'hello');
    assert.ok(await until(() => first.window.localStorage.getItem('ula.firstRequestDone') === 'true'), 'the flag is saved');
  } finally { await first.close(); }
  // 2. a restarted program has an empty request list; the saved flag keeps the step ticked
  const again = await open({ provider: (f) => { f.script.linked = true; }, local: { 'ula.firstRequestDone': 'true' } });
  try {
    assert.ok(await until(() => again.$('.setup')));
    assert.deepEqual(steps(again), [['link', true], ['key', false], ['try', true]], 'step 3 stays ticked with no request in memory');
    assert.match(again.$('.setup').textContent, /2 of 3 done/);
    // Hide is a separate saved choice and still works
    again.click(buttonNamed(again, 'Hide', again.$('.setup')));
    assert.ok(await until(() => !again.$('.setup')));
    assert.equal(again.window.localStorage.getItem('ula.setupHidden'), 'true');
  } finally { await again.close(); }
});

test('the empty chat offers starter prompts that fill the box', { skip }, async () => {
  const ui = await open();
  try {
    assert.ok(await until(() => ui.$$('.starter').length === 4));
    const first = ui.$$('.starter')[0];
    ui.click(first);
    assert.equal(ui.$('textarea[aria-label="Message"]').value, first.textContent);
    assert.equal(ui.window.document.activeElement, ui.$('textarea[aria-label="Message"]'), 'and the cursor is in the box, ready to send');
    assert.equal(ui.fake.calls.length, 0, 'nothing was sent: a call is spent only when the person presses Send');
  } finally { await ui.close(); }
});

test('a message can be copied, an answer can be asked for again, and a failed retry brings the old answer back', { skip }, async () => {
  const ui = await open();
  try {
    await until(() => ui.$$('select option').length >= 3);
    ui.fake.script.reply = (_p, { call }) => ({ ok: true, text: `answer number ${call}` });
    await send(ui, 'say something');
    assert.equal(ui.$('.msg.assistant .bubble').textContent, 'answer number 1');
    ui.click(ui.$('.msg.assistant [aria-label="Copy this answer"]'));
    ui.click(ui.$('.msg.user [aria-label="Copy this message"]'));
    assert.deepEqual(ui.copied, ['answer number 1', 'say something']);
    // ask again: the old answer steps aside while the new one is on its way, then the new one replaces it, and the conversation is not asked with the old answer in it
    ui.fake.script.delayMs = 300;
    ui.click(ui.$('.msg.assistant [aria-label="Ask again for a new answer"]'));
    assert.equal(ui.$$('.msg.assistant.hidden').length, 1, 'the old answer is out of the way while the new one is coming');
    assert.equal(ui.$$('.msg.assistant:not(.hidden)').length, 1, 'and only the new one is on show');
    assert.ok(await until(() => ui.fake.calls.length === 2 && ui.$$('.msg.assistant:not(.hidden)').length === 1 && /answer number 2/.test(ui.$('.msg.assistant:not(.hidden) .bubble').textContent)));
    assert.equal(ui.$$('.msg.user').length, 1, 'the question is not asked twice on the page');
    assert.ok(!ui.fake.calls[1].prompt.includes('answer number 1'));
    assert.equal((ui.fake.calls[1].prompt.match(/say something/g) || []).length, 1, 'and not twice in what was sent');
    assert.ok(await until(() => ui.$$('.msg.assistant').length === 1), 'the old answer is gone from the page');
    ui.fake.script.delayMs = 0;
    // only the last answer can be asked for again
    await send(ui, 'and another');
    const answers = ui.$$('.msg.assistant');
    assert.equal(answers.length, 2);
    assert.deepEqual(answers.map((a) => a.classList.contains('is-last')), [false, true]);
    // a retry that is refused leaves the answer that was there
    ui.fake.governor.setCooldown(120000, 'testing');
    ui.click(answers[1].querySelector('[aria-label="Ask again for a new answer"]'));
    assert.ok(await until(() => ui.$('.errbox')));
    assert.ok(await until(() => ui.$$('.msg.assistant:not(.hidden)').length === 2 && /answer number 3/.test(ui.$$('.msg.assistant:not(.hidden)')[1].textContent)), 'the answer is back');
  } finally { await ui.close(); }
});

test('Stop (and Escape in the box) ends an answer that is on its way, keeps what had arrived, and the log is marked busy only while it streams', { skip }, async () => {
  const ui = await open();
  try {
    await until(() => ui.$$('select option').length >= 3);
    ui.fake.script.delayMs = 150;
    ui.fake.script.chunk = 2;
    ui.fake.script.reply = () => ({ ok: true, text: 'A long answer that keeps coming for a good while, word after word, so that it can be stopped.' });
    const log = ui.$('[role="log"]');
    assert.equal(log.getAttribute('aria-busy') || 'false', 'false');
    ui.$('textarea[aria-label="Message"]').value = 'go on';
    ui.click(buttonNamed(ui, 'Send'));
    assert.ok(await until(() => buttonNamed(ui, 'Stop') && ui.$('.msg.assistant .bubble').textContent.length > 0), 'the button became Stop and the answer started');
    assert.equal(log.getAttribute('aria-busy'), 'true', 'a screen reader is told to wait while the answer streams');
    assert.ok(ui.$('.bubble.typing'), 'a caret shows');
    ui.click(buttonNamed(ui, 'Stop'));
    assert.ok(await until(() => /Stopped/.test(ui.$('.msg.assistant .meta').textContent)));
    assert.ok(buttonNamed(ui, 'Send'), 'Send is back');
    assert.equal(log.getAttribute('aria-busy'), 'false');
    assert.ok(!ui.$('.bubble.typing'), 'the caret is gone');
    const kept = ui.$('.msg.assistant .bubble').textContent;
    assert.ok(kept.length > 0 && kept.length < 90, `what had arrived stays (${kept.length} characters)`);
    // Escape in the box does the same
    ui.$('textarea[aria-label="Message"]').value = 'again';
    ui.click(buttonNamed(ui, 'Send'));
    assert.ok(await until(() => buttonNamed(ui, 'Stop') && ui.$$('.msg.assistant .bubble')[1].textContent.length > 0));
    ui.$('textarea[aria-label="Message"]').dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(await until(() => ui.$$('.msg.assistant .meta').every((m) => /Stopped|fake-chat/.test(m.textContent)) && buttonNamed(ui, 'Send')));
    ui.fake.script.delayMs = 0;
  } finally { await ui.close(); }
});

test('a conversation has a stable name, sent as "user", that changes with a new chat and is shown on the page', { skip }, async () => {
  const ui = await open();
  try {
    await until(() => ui.$$('select option').length >= 3);
    const names = () => ui.sent.filter((r) => r.path === '/v1/chat/completions').map((r) => r.body.user);
    assert.match(ui.$('.convo').textContent, /New conversation/);
    await send(ui, 'one');
    await send(ui, 'two');
    const [a, b] = names();
    assert.match(a, /^playground-[a-z0-9]{6}$/);
    assert.equal(a, b, 'the same conversation keeps its name');
    assert.ok(ui.$('.convo').textContent.includes(a));
    assert.match(ui.$('.convo').textContent, /4 messages/);
    ui.click(buttonNamed(ui, 'New chat'));
    assert.match(ui.$('.convo').textContent, /New conversation/);
    await send(ui, 'three');
    const c = names()[2];
    assert.match(c, /^playground-[a-z0-9]{6}$/);
    assert.notEqual(c, a, 'a new chat starts a new name');
  } finally { await ui.close(); }
});

test('"View as code" shows the request the playground makes, and that request works', { skip }, async () => {
  const ui = await open();
  try {
    await until(() => ui.$$('select option').length >= 3);
    ui.$('select[aria-label="Model"]').value = 'fake-reasoner';
    ui.$('select[aria-label="Model"]').dispatchEvent(new ui.window.Event('change'));
    ui.$('textarea[aria-label="System prompt"]').value = 'Be brief.';
    ui.$('textarea[aria-label="System prompt"]').dispatchEvent(new ui.window.Event('input'));
    await send(ui, 'say something');
    const opener = buttonNamed(ui, 'View as code');
    opener.focus();
    ui.click(opener);
    const dialog = ui.$('dialog');
    assert.ok(dialog && dialog.hasAttribute('open'));
    const code = dialog.querySelector('pre code').textContent;
    assert.match(code, /curl .*\/v1\/chat\/completions/);
    assert.match(code, /"model": "fake-reasoner"/);
    assert.match(code, /"role": "system", "content": "Be brief\."/);
    assert.match(code, /"content": "say something"/);
    assert.match(code, /"user": "playground-[a-z0-9]{6}"/);
    assert.match(code, /Bearer YOUR_KEY/);
    // the other languages carry the same call
    ui.click([...dialog.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Python'));
    assert.match(ui.$('dialog pre code').textContent, /client\.chat\.completions\.create\([\s\S]*model="fake-reasoner"/);
    ui.click([...ui.$('dialog').querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Node'));
    assert.match(ui.$('dialog pre code').textContent, /model: "fake-reasoner"/);
    // what the curl command sends is accepted by the server
    ui.click([...ui.$('dialog').querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'curl'));
    const body = /-d '([\s\S]*)'$/.exec(ui.$('dialog pre code').textContent)[1].replace(/'\\''/g, '\'');
    const res = await fetch(`${ui.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ui.token}` }, body: body.replace('"stream": true,', '') });
    assert.equal(res.status, 200);
    // Escape closes it, and the keyboard is back on the button that opened it
    ui.$('dialog').dispatchEvent(new ui.window.Event('cancel', { cancelable: true }));
    assert.equal(ui.$('dialog'), null);
    assert.equal(ui.window.document.activeElement, opener);
  } finally { await ui.close(); }
});

test('Unlink and Revoke ask in the page\'s own dialog: Cancel and Escape change nothing, the answer comes back to where the keyboard was', { skip }, async () => {
  const ui = await open({ hash: '#accounts' });
  try {
    assert.ok(await until(() => ui.$('[data-view="accounts"] article')));
    const unlink = buttonNamed(ui, 'Unlink', ui.$('[data-view="accounts"] article'));
    unlink.focus();
    ui.click(unlink);
    let dialog = ui.$('dialog');
    assert.ok(dialog.hasAttribute('open'));
    assert.equal(dialog.querySelector('button[autofocus]').textContent, 'Cancel', 'the safe choice has the focus');
    ui.click(buttonNamed(ui, 'Cancel', dialog));
    assert.equal(ui.$('dialog'), null);
    assert.equal(ui.window.document.activeElement, unlink, 'focus returned to Unlink');
    ui.click(unlink);
    ui.$('dialog').dispatchEvent(new ui.window.Event('cancel', { cancelable: true }));
    assert.equal(ui.$('dialog'), null, 'Escape closes it');
    await wait(150);
    assert.match(ui.$('[data-view="accounts"] article').textContent, /Linked/);
    assert.ok(!ui.sent.some((r) => /unlink/.test(r.path)), 'nothing was unlinked');
    // a key
    ui.config.createApiKey('keep me');
    ui.click([...ui.$$('nav button')].find((b) => b.textContent === 'API'));
    assert.ok(await until(() => ui.$('[data-view="api"] table') && /keep me/.test(ui.$('[data-view="api"] table').textContent), 7000));
    const key = ui.config.listApiKeys()[0];
    ui.click([...ui.$$('button')].find((b) => b.textContent === 'Revoke'));
    dialog = ui.$('dialog');
    assert.match(dialog.textContent, /Revoke "keep me"\?/);
    ui.click(buttonNamed(ui, 'Cancel', dialog));
    await wait(150);
    assert.equal(ui.config.listApiKeys().length, 1, 'Cancel keeps the key');
    assert.ok(key);
    assert.deepEqual(ui.nativeConfirms, []);
  } finally { await ui.close(); }
});

test('the API page puts a chosen key into the examples in one step: hidden on screen, whole when copied, and a key that cannot be shown cannot be chosen', { skip }, async () => {
  let secrets = {};
  const ui = await open({
    hash: '#api',
    setup: ({ config, dir }) => {
      secrets = { alpha: config.createApiKey('alpha').key };
      config.createApiKey('legacy');
      // a key from the first version: only its hash is kept
      const file = path.join(dir, 'config.json');
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete json.apiKeys.find((k) => k.name === 'legacy').secret;
      fs.writeFileSync(file, JSON.stringify(json), { mode: 0o600 });
    }
  });
  try {
    assert.ok(await until(() => ui.$('select[aria-label="Key to put in the examples"]')));
    const picker = ui.$('select[aria-label="Key to put in the examples"]');
    assert.deepEqual([...picker.options].map((o) => [o.textContent, o.disabled]), [['No key (shows YOUR_KEY)', false], ['alpha', false], ['legacy (start and end only)', true]]);
    assert.match(ui.$('[data-view="api"] pre code').textContent, /Bearer YOUR_KEY/);
    picker.value = [...picker.options].find((o) => o.textContent === 'alpha').value;
    picker.dispatchEvent(new ui.window.Event('change'));
    assert.ok(await until(() => /Bearer sk-ula-•+/.test(ui.$('[data-view="api"] pre code').textContent)));
    const shown = ui.$('[data-view="api"] pre code').textContent;
    assert.ok(!shown.includes(secrets.alpha), 'the key is masked on screen');
    assert.ok(!ui.$('[data-view="api"]').textContent.includes(secrets.alpha), 'and nowhere else on the page');
    assert.ok(shown.includes(secrets.alpha.slice(-4)), 'with its end showing, so it can be told apart');
    ui.click(ui.$('[data-view="api"] .codeblock .copy'));
    await wait(50);
    assert.ok(ui.copied[ui.copied.length - 1].includes(secrets.alpha), 'Copy takes the whole key');
    // reveal on demand, and hide again
    ui.click(ui.$('[aria-label="Show the key"]'));
    assert.ok(await until(() => ui.$('[data-view="api"] pre code').textContent.includes(secrets.alpha)));
    ui.click(ui.$('[aria-label="Hide the key"]'));
    assert.ok(await until(() => !ui.$('[data-view="api"] pre code').textContent.includes(secrets.alpha)));
    ui.click(ui.$('[aria-label="Copy the whole key"]'));
    assert.equal(ui.copied[ui.copied.length - 1], secrets.alpha);
    // back to the placeholder
    picker.value = '';
    picker.dispatchEvent(new ui.window.Event('change'));
    assert.ok(await until(() => /Bearer YOUR_KEY/.test(ui.$('[data-view="api"] pre code').textContent)));
  } finally { await ui.close(); }
});

test('"Connect a tool" gives the exact values for Lens Code, Cline, OpenAI clients and Anthropic clients', { skip }, async () => {
  const ui = await open({ hash: '#api', setup: ({ config }) => { config.createApiKey('tool key'); } });
  try {
    assert.ok(await until(() => ui.$('[role="tablist"][aria-label="Tool"]')));
    const tab = (name) => [...ui.$$('[role="tab"]')].find((t) => t.textContent === name);
    const rows = () => Object.fromEntries(ui.$$('[data-view="api"] .field-row').map((r) => [r.querySelector('dt').textContent, (r.querySelector('.val') || r.querySelector('dd')).textContent]));
    const key = ui.config.listApiKeys();
    const picker = ui.$('select[aria-label="Key to put in the examples"]');
    picker.value = key[0].id;
    picker.dispatchEvent(new ui.window.Event('change'));
    assert.ok(await until(() => /sk-ula-•/.test(ui.$('[data-view="api"]').textContent)));
    // the first, default tab: any OpenAI client
    assert.equal(tab('OpenAI clients').getAttribute('aria-selected'), 'true');
    for (const [name, needle] of [['Python', 'OpenAI(base_url='], ['Node', 'new OpenAI('], ['Python, streaming', 'stream=True'], ['Responses API', 'client.responses.create'], ['curl', 'curl ']]) {
      ui.click(tab(name));
      assert.ok(await until(() => ui.$('[data-view="api"] pre code').textContent.includes(needle)), name);
    }
    // Lens Code
    ui.click(tab('Lens Code'));
    assert.ok(await until(() => ui.$('[data-view="api"] .field-row')));
    let r = rows();
    assert.match(ui.$('[data-view="api"] [role="tabpanel"]').textContent, /Settings > Models > Your own providers > Add provider/);
    assert.match(r.Name, /^Unofficial Free LLM API/);
    assert.match(r.Address, new RegExp(`^${ui.base.replace(/[.]/g, '\\.')}/v1`));
    assert.match(r['API key'], /^sk-ula-•+/);
    assert.match(r.Models, /^fake-auto, fake-chat, fake-reasoner/, 'the one for agents first');
    assert.match(r['Context window'], /^64000/);
    // the copy button of the key row takes the whole key
    const keyRow = ui.$$('[data-view="api"] .field-row').find((row) => row.querySelector('dt').textContent === 'API key');
    ui.click(keyRow.querySelector('button'));
    assert.equal(ui.copied[ui.copied.length - 1], ui.config.revealApiKey(key[0].id));
    // Cline
    ui.click(tab('Cline'));
    assert.ok(await until(() => rows()['Model ID']));
    r = rows();
    assert.match(ui.$('[data-view="api"] [role="tabpanel"]').textContent, /OpenAI Compatible/);
    assert.match(r['Base URL'], /\/v1/);
    assert.match(r['Model ID'], /^fake-auto/);
    assert.match(r['Context window'], /^64000/);
    // Anthropic: no /v1 on the base URL, the key in x-api-key
    ui.click(tab('Anthropic clients'));
    assert.ok(await until(() => rows()['Base URL'] && !/\/v1/.test(rows()['Base URL'])));
    assert.ok(rows()['Base URL'].startsWith(ui.base));
    assert.ok(rows()['API key (x-api-key)']);
    const codes = ui.$$('[data-view="api"] pre code').map((c) => c.textContent).join('\n');
    assert.match(codes, /Anthropic\(base_url="http:\/\/127\.0\.0\.1:\d+", api_key=/);
    assert.match(codes, /x-api-key: sk-ula-•/);
    assert.match(codes, /ANTHROPIC_BASE_URL=/);
    // the tab chosen is remembered
    assert.equal(JSON.parse(ui.window.localStorage.getItem('ula.tool')), 'anthropic');
  } finally { await ui.close(); }
});

test('the theme is a labelled three-state control that is announced and remembered', { skip }, async () => {
  const ui = await open();
  try {
    assert.ok(await until(() => ui.$('[aria-label="Theme"], [role="group"][aria-labelledby="theme-label"]')));
    const group = ui.$('[aria-labelledby="theme-label"]');
    assert.equal(ui.$('#theme-label').textContent, 'Theme');
    const buttons = [...group.querySelectorAll('button')];
    assert.deepEqual(buttons.map((b) => b.textContent), ['System', 'Light', 'Dark'], 'each state has a visible name');
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-label')), ['System theme', 'Light theme', 'Dark theme']);
    assert.ok(buttons.every((b) => b.querySelector('svg')), 'and an icon');
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
    ui.click(buttons[2]);
    assert.equal(ui.window.document.documentElement.getAttribute('data-theme'), 'dark');
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
    assert.ok(await until(() => /Theme: Dark/.test(ui.$('[role="status"]').textContent)), 'announced to a screen reader');
    assert.equal(JSON.parse(ui.window.localStorage.getItem('ula.theme')), 'dark');
    ui.click(buttons[1]);
    assert.equal(ui.window.document.documentElement.getAttribute('data-theme'), 'light');
    ui.click(buttons[0]);
    assert.equal(ui.window.document.documentElement.getAttribute('data-theme'), null, 'System follows the device');
    assert.ok(await until(() => /Theme: System/.test(ui.$('[role="status"]').textContent)));
  } finally { await ui.close(); }
});

test('a saved theme is applied before the page paints', { skip }, async () => {
  const theme = fs.readFileSync(path.join(WEB, 'theme.js'), 'utf8');
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  assert.ok(/<script src="theme\.js"><\/script>/.test(html.split('</head>')[0]), 'theme.js runs from the head, before the body exists');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:1/', runScripts: 'outside-only' });
  dom.window.localStorage.setItem('ula.theme', '"dark"');
  dom.window.eval(theme);
  assert.equal(dom.window.document.documentElement.getAttribute('data-theme'), 'dark');
  dom.window.localStorage.setItem('ula.theme', '"system"');
  dom.window.document.documentElement.removeAttribute('data-theme');
  dom.window.eval(theme);
  assert.equal(dom.window.document.documentElement.getAttribute('data-theme'), null);
  dom.window.close();
});

test('Accounts: "One chat per conversation" is a switch with an honest hint and a status line, and the open chats can be ended', { skip }, async () => {
  const chats = [
    { id: 'sAAA1', provider: 'fake', model: 'fake-chat', tag: 'lens-code-7f3a', turns: 3, chars: 9000, createdAt: new Date(Date.now() - 600000).toISOString(), lastUsed: new Date(Date.now() - 120000).toISOString(), busy: false },
    { id: 'sBBB2', provider: 'fake', model: 'fake-auto', tag: null, turns: 1, chars: 100, createdAt: new Date().toISOString(), lastUsed: new Date().toISOString(), busy: true }
  ];
  const ui = await open({ hash: '#accounts', provider: (f) => sessionsFor(f, { open: 2, list: chats }) });
  try {
    assert.ok(await until(() => ui.$('input[role="switch"]')));
    const card = ui.$('[data-view="accounts"] article');
    const sw = card.querySelector('input[role="switch"]');
    assert.equal(sw.checked, true);
    assert.equal(card.querySelector('.switch').textContent.includes('One chat per conversation'), true);
    assert.match(card.querySelector('.status-line').textContent, /^On, 2 open chats$/);
    const hint = card.querySelector(`#${sw.getAttribute('aria-describedby')}`).textContent;
    assert.match(hint, /new/i);
    assert.match(hint, /stand-ins/);
    assert.match(hint, /not a real account/);
    assert.match(hint, /fails twice in a row/);
    // switching it off sends the setting and the status line follows
    sw.checked = false;
    sw.dispatchEvent(new ui.window.Event('change'));
    assert.ok(await until(() => ui.fake.sessionPuts.length === 1));
    assert.deepEqual(ui.fake.sessionPuts, [false]);
    assert.ok(await until(() => /^Off$/.test(ui.$('[data-view="accounts"] .status-line').textContent)));
    // the open chats: who, which model, turns, when; End; and never a word of what was said
    ui.fake.sessionState = { ...ui.fake.sessionState, enabled: true, open: 2 };
    ui.window.eval('0');
    assert.ok(await until(() => ui.$('.sessions-table'), 5000));
    const rows = ui.$$('.sessions-table tbody tr');
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /Fake/);
    assert.match(rows[0].textContent, /fake-chat/);
    assert.match(rows[0].textContent, /lens-code-7f3a/);
    assert.match(rows[0].textContent, /2 min ago/);
    assert.equal(rows[0].querySelectorAll('td')[3].textContent, '3', 'turns');
    const ends = ui.$$('.sessions-table button');
    assert.deepEqual(ends.map((b) => b.disabled), [false, true], 'a chat that is answering right now cannot be ended');
    assert.equal(ends[1].textContent, 'Answering');
    ui.click(ends[0]);
    assert.ok(await until(() => ui.fake.ended.length === 1));
    assert.deepEqual(ui.fake.ended, ['sAAA1']);
    assert.deepEqual(ui.sent.filter((r) => r.method === 'DELETE').map((r) => r.path), ['/_/sessions/fake/sAAA1']);
    assert.ok(!/chars|9000/.test(ui.$('.sessions-table').textContent), 'sizes and text are not shown');
  } finally { await ui.close(); }
});

test('Accounts: a chat reuse that switched itself off says why, and its switch can be turned back on', { skip }, async () => {
  const ui = await open({ hash: '#accounts', provider: (f) => sessionsFor(f, { enabled: false, reason: 'continuing a chat failed twice in a row', open: 0 }) });
  try {
    assert.ok(await until(() => ui.$('input[role="switch"]')));
    const sw = () => ui.$('input[role="switch"]');
    assert.equal(sw().checked, false);
    assert.equal(sw().disabled, false, 'the person can switch it on again');
    assert.equal(ui.$('.status-line').textContent, 'Off: continuing a chat failed twice in a row');
    const hint = ui.$(`#${sw().getAttribute('aria-describedby')}`).textContent;
    assert.ok(!/restart/i.test(hint), 'it no longer says it stays off until the program is restarted');
    assert.match(hint, /switched itself off/);
    assert.match(ui.$('[data-view="accounts"]').textContent, /No chats are open/, 'an empty list says so');
    // switching it on sends sessions:true and the status line follows (the reason is gone)
    sw().checked = true;
    sw().dispatchEvent(new ui.window.Event('change'));
    assert.ok(await until(() => ui.fake.sessionPuts.length === 1));
    assert.deepEqual(ui.fake.sessionPuts, [true]);
    assert.deepEqual(ui.sent.filter((r) => r.method === 'PUT' && r.path.endsWith('/settings')).map((r) => r.body), [{ sessions: true }]);
    assert.ok(await until(() => /^On, 0 open chats$/.test(ui.$('[data-view="accounts"] .status-line').textContent)), ui.$('[data-view="accounts"] .status-line').textContent);
    assert.equal(sw().checked, true);
    assert.equal(sw().disabled, false);
    assert.match(ui.$(`#${sw().getAttribute('aria-describedby')}`).textContent, /fails twice in a row/, 'the usual hint is back');
  } finally { await ui.close(); }
});

test('Accounts: linking is a two-step flow, and the second step waits until a window is open', { skip }, async () => {
  const ui = await open({
    hash: '#accounts',
    provider: (f) => {
      const status = f.status;
      f.linking = false;
      f.status = async () => ({ ...(await status()), linked: f.linking ? false : f.script.linked, linking: f.linking, linkNote: f.linking ? 'A Chrome window is open on the provider. Sign in there.' : undefined });
      f.startLink = async () => { f.linking = true; return { ok: true }; };
      f.finishLink = async ({ cancel }) => { f.linking = false; if (!cancel) f.script.linked = true; return { ok: true }; };
      f.script.linked = false;
    }
  });
  try {
    assert.ok(await until(() => ui.$('.stepper')));
    const steps = () => ui.$$('.stepper .step').map((s) => s.className.replace('step ', ''));
    assert.deepEqual(steps(), ['now', 'next']);
    assert.equal(buttonNamed(ui, 'I have signed in').disabled, true, 'nothing to finish yet');
    assert.equal(buttonNamed(ui, 'Cancel'), undefined);
    ui.click(buttonNamed(ui, 'Link account'));
    const dialog = ui.$('dialog');
    ui.$('dialog input[type="checkbox"]').checked = true;
    ui.$('dialog input[type="checkbox"]').dispatchEvent(new ui.window.Event('change'));
    ui.click(buttonNamed(ui, 'Open Chrome and sign in', dialog));
    assert.ok(await until(() => steps()[0] === 'done'));
    assert.deepEqual(steps(), ['done', 'now']);
    assert.match(ui.$('.stepper').textContent, /A Chrome window is open/);
    assert.equal(buttonNamed(ui, 'I have signed in').disabled, false);
    assert.match(ui.$('article .chip').textContent, /Waiting for you/);
    ui.click(buttonNamed(ui, 'I have signed in'));
    assert.ok(await until(() => /Linked/.test(ui.$('article').textContent) && !ui.$('.stepper')));
  } finally { await ui.close(); }
});

test('Accounts: when the provider refuses the sign-in check, the note is shown as a warning and the person can try again', { skip }, async () => {
  const ui = await open({
    hash: '#accounts',
    provider: (f) => {
      const status = f.status;
      f.linking = true;
      f.script.linked = false;
      f.status = async () => ({ ...(await status()), linked: false, linking: f.linking });
      f.finishLink = async () => ({ ok: false, blocked: true, note: 'DeepSeek asked for a human check. Pass it in the Chrome window, then press the button again.' });
    }
  });
  try {
    assert.ok(await until(() => ui.$('.stepper') && buttonNamed(ui, 'I have signed in') && !buttonNamed(ui, 'I have signed in').disabled));
    ui.click(buttonNamed(ui, 'I have signed in'));
    assert.ok(await until(() => ui.$('article .notice.warn')));
    assert.match(ui.$('article .notice.warn').textContent, /human check/);
    assert.equal(buttonNamed(ui, 'I have signed in').disabled, false, 'and the window is still open to try again');
  } finally { await ui.close(); }
});

test('Escape on the consent dialog closes it without linking anything', { skip }, async () => {
  const ui = await open({ hash: '#accounts' });
  try {
    assert.ok(await until(() => ui.$('[data-view="accounts"] article')));
    ui.click(buttonNamed(ui, 'Sign in again'));
    assert.ok(ui.$('dialog').hasAttribute('open'));
    ui.$('dialog').dispatchEvent(new ui.window.Event('cancel', { cancelable: true }));
    assert.equal(ui.$('dialog'), null);
    await wait(100);
    assert.ok(!ui.sent.some((r) => /\/link$/.test(r.path)));
  } finally { await ui.close(); }
});

test('Activity shows which API each request used, filters to errors, and says so when there is nothing', { skip }, async () => {
  const ui = await open({ hash: '#activity' });
  try {
    assert.ok(await until(() => ui.$('[data-view="activity"]') && /No requests yet/.test(ui.$('[data-view="activity"]').textContent)), 'a clear empty state');
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${ui.token}` };
    await fetch(`${ui.base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'fake-chat', messages: [{ role: 'user', content: 'a' }] }) });
    await fetch(`${ui.base}/v1/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'fake-chat', max_tokens: 10, messages: [{ role: 'user', content: 'b' }] }) });
    await fetch(`${ui.base}/v1/responses`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'fake-chat', input: 'c' }) });
    ui.fake.governor.setCooldown(120000, 'testing');
    const refused = await fetch(`${ui.base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'fake-chat', messages: [{ role: 'user', content: 'd' }] }) });
    assert.equal(refused.status, 429);
    assert.ok(await until(() => ui.$$('.activity-table tbody tr').length === 4, 6000));
    const rows = ui.$$('.activity-table tbody tr').map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
    assert.deepEqual(rows.map((r) => r[1]).sort(), ['chat', 'chat', 'messages', 'responses'], 'the API each request used');
    assert.match(ui.$('.activity-table').textContent, /429 fake_cooldown/, 'a result says what happened in words, not only a colour');
    const filter = ui.$('[role="group"][aria-label="Show"]');
    assert.match(filter.textContent, /All \(4\)/);
    assert.match(filter.textContent, /Errors \(1\)/);
    ui.click([...filter.querySelectorAll('button')].find((b) => /^Errors/.test(b.textContent)));
    assert.equal(ui.$$('.activity-table tbody tr').length, 1);
    assert.match(ui.$('.activity-table tbody tr').textContent, /429/);
    assert.equal(ui.$('[data-filter="errors"]').getAttribute('aria-pressed'), 'true');
    ui.click(ui.$('[data-filter="all"]'));
    assert.equal(ui.$$('.activity-table tbody tr').length, 4);
  } finally { await ui.close(); }
});

test('Activity: the errors filter with no errors says so', { skip }, async () => {
  const ui = await open({ hash: '#activity' });
  try {
    await fetch(`${ui.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ui.token}` }, body: JSON.stringify({ model: 'fake-chat', messages: [{ role: 'user', content: 'a' }] }) });
    assert.ok(await until(() => ui.$('[data-filter="errors"]'), 6000));
    ui.click(ui.$('[data-filter="errors"]'));
    assert.match(ui.$('[data-view="activity"]').textContent, /No errors/);
  } finally { await ui.close(); }
});

test('the page has landmarks, a skip link, live regions, and every control has a name', { skip }, async () => {
  const ui = await open({ provider: (f) => sessionsFor(f, { list: [] }), setup: ({ config }) => { config.createApiKey('k'); } });
  try {
    assert.ok(await until(() => ui.$('main')));
    assert.ok(ui.$('header nav[aria-label="Pages"]'), 'a labelled navigation inside the banner');
    assert.equal(ui.$$('main').length, 1);
    assert.ok(ui.$('footer'), 'a footer');
    assert.equal(ui.$('a.skip').getAttribute('href'), '#main');
    assert.equal(ui.$('main').id, 'main');
    assert.ok(ui.$('[role="status"][aria-live="polite"]'), 'a polite live region for announcements');
    assert.equal(ui.$('[role="log"]').getAttribute('aria-live'), 'polite', 'the conversation is a live log');
    assert.equal(ui.$('[role="alert"]') !== null, true, 'errors have an alert region');
    assert.deepEqual(ui.$$('nav button[aria-current="page"]').map((b) => b.textContent), ['Playground']);
    // every view has a heading, and every control a name
    const named = (el) => Boolean(el.getAttribute('aria-label') || el.textContent.trim() || (el.id && ui.window.document.querySelector(`label[for="${el.id}"]`)) || el.closest('label'));
    for (const view of ['playground', 'accounts', 'api', 'activity']) {
      ui.click([...ui.$$('nav button')].find((b) => b.textContent.toLowerCase() === view));
      await wait(150);
      const root = ui.$(`[data-view="${view}"]`);
      assert.ok(await until(() => root.querySelector('h1')), view);
      assert.ok(root.querySelector('h1').textContent.length > 0);
      assert.equal(ui.$$('h1').filter((h) => !h.closest('.hidden') && !h.closest('[hidden]')).length, 1, `one visible h1 in ${view}`);
      const unnamed = [...root.querySelectorAll('button, input:not([type="hidden"]), select, textarea')].filter((el) => !named(el));
      assert.deepEqual(unnamed.map((el) => el.outerHTML.slice(0, 80)), [], `unnamed controls in ${view}`);
    }
    assert.equal(ui.window.document.title, 'Activity · Unofficial Free LLM API');
  } finally { await ui.close(); }
});

test('the page never builds markup from strings and loads nothing from outside', { skip }, () => {
  const js = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  for (const bad of ['innerHTML', 'insertAdjacentHTML', 'outerHTML', 'document.write', 'createContextualFragment', 'DOMParser', 'eval(', 'new Function', 'setAttribute(\'style\'', 'setAttribute("style"']) assert.ok(!js.includes(bad), `app.js must not use ${bad}`);
  assert.deepEqual([...new Set(js.match(/https?:\/\/[^\s'"`)]+/g) || [])].filter((u) => !/^https:\/\/github\.com\/teminali\/unofficial-free-llm-api/.test(u)).sort(), ['http://www.w3.org/2000/svg', 'https://github.com/teminali/unofficial-free-llm-api'].filter((u) => u.startsWith('http://')), 'only the SVG namespace and the project\'s own links');
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  assert.ok(!/<style|style=|<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html), 'no inline style or script');
  assert.ok(!/(href|src)="https?:/.test(html), 'no external files');
});

// ---- a Gemini-shaped provider: stable names, a working context size, and a model list that can be read again ----------------------------------------

const PICKER_ROWS = () => [ // deliberately not in the order the page must show them
  { id: 'gemini-3-5-flash-lite', name: '3.5 Flash-Lite', thinking: true, escalate: false, context_length: 128000 },
  { id: 'gemini-auto', name: 'Gemini Auto (account default)', thinking: true, escalate: false, context_length: 128000 },
  { id: 'gemini', name: 'Gemini (account default)', thinking: true, escalate: false, context_length: 128000 }
];
const geminiLike = (f, rows = PICKER_ROWS()) => {
  f.id = 'gemini';
  f.name = 'Gemini';
  f.rows = rows;
  f.rereads = 0;
  f.reread = { refreshed: true, add: [], delayMs: 0, linking: false };
  f.models = () => (f.script.linked && !f.script.expired ? f.rows : []);
  const status = f.status;
  f.status = async () => ({ ...(await status()), linking: f.reread.linking });
  f.refreshModels = async () => { f.rereads++; await wait(f.reread.delayMs); if (f.reread.refreshed) f.rows = [...f.rows, ...f.reread.add]; return f.reread.refreshed; };
};
const NOT_A_KEY = /sk-ula|•/; // the start of every key this program makes, and the dots that hide the middle of one on screen
const blockOf = (ui) => ui.$('[data-view="api"] .paste-block');
const blockText = (ui) => blockOf(ui).querySelector('pre').textContent;

test('API page: "Copy for Lens Code, Cline and similar" is one box of plain words with the models in state, the stable names first, and never a key', { skip }, async () => {
  const ui = await open({ hash: '#api', provider: (f) => geminiLike(f), setup: ({ config }) => { config.createApiKey('block key'); } });
  try {
    assert.ok(await until(() => blockOf(ui) && /gemini/.test(blockText(ui))));
    assert.equal(blockOf(ui).querySelector('h3').textContent, 'Copy for Lens Code, Cline and similar');
    const expected = ['Name: Unofficial Free LLM API', `Address: ${ui.base}/v1`, 'Key: paste your key here',
      'Models: gemini, gemini-auto, gemini-3-5-flash-lite', 'Context: 128000 (a working size, not the model\'s maximum)'].join('\n');
    assert.equal(blockText(ui), expected, 'the stable names come first, then the picker\'s own rows in their order');
    assert.equal(blockOf(ui).querySelectorAll('button').length, 1, 'one Copy button for the whole block');
    assert.equal(blockOf(ui).querySelector('button').textContent, 'Copy');
    // the key is picked and shown in full elsewhere on the page: it is in none of the block, and not in what Copy takes
    const entry = ui.config.listApiKeys()[0];
    const secret = ui.config.revealApiKey(entry.id);
    const picker = ui.$('select[aria-label="Key to put in the examples"]');
    picker.value = entry.id;
    picker.dispatchEvent(new ui.window.Event('change'));
    assert.ok(await until(() => NOT_A_KEY.test(ui.$('[data-view="api"] pre code').textContent)), 'the key is in the examples (hidden)');
    ui.click([...ui.$$('button')].find((b) => b.textContent === 'Show' && b.closest('tr').textContent.includes('block key')));
    assert.ok(await until(() => ui.$('.newkey code') && ui.$('.newkey code').textContent === secret), 'and shown in full in its own card');
    assert.equal(blockText(ui), expected, 'the block did not change');
    assert.ok(!blockOf(ui).outerHTML.includes(secret) && !NOT_A_KEY.test(blockOf(ui).outerHTML), 'no key, whole or hidden, anywhere in the block');
    // Copy takes exactly the words that are shown
    ui.click(blockOf(ui).querySelector('button'));
    assert.ok(await until(() => ui.copied.length >= 1));
    assert.equal(ui.copied[ui.copied.length - 1], blockText(ui));
    assert.ok(!ui.copied[ui.copied.length - 1].includes(secret) && !NOT_A_KEY.test(ui.copied[ui.copied.length - 1]));
    // the tabs under it are still there, and the OpenAI tab is still the one that opens
    assert.deepEqual(ui.$$('[role="tablist"][aria-label="Tool"] [role="tab"]').map((t) => t.textContent), ['OpenAI clients', 'Lens Code', 'Cline', 'Anthropic clients']);
    assert.equal(ui.$('[role="tab"][aria-selected="true"]').textContent, 'OpenAI clients');
  } finally { await ui.close(); }
});

test('API page: the Context line of the copy block is left out when no model has a size, and is the smallest one when they differ', { skip }, async () => {
  const bare = await open({ hash: '#api' }); // the plain fake models carry no context_length
  try {
    assert.ok(await until(() => blockOf(bare) && /fake-chat/.test(blockText(bare))));
    assert.deepEqual(blockText(bare).split('\n').map((l) => l.split(':')[0]), ['Name', 'Address', 'Key', 'Models']);
    assert.match(blockText(bare), /\nModels: fake-chat, fake-reasoner, fake-auto$/);
  } finally { await bare.close(); }
  const mixed = await open({ hash: '#api', provider: (f) => geminiLike(f, [
    { id: 'gemini', name: 'G', thinking: true, escalate: false, context_length: 200000 },
    { id: 'gemini-auto', name: 'A', thinking: true, escalate: false, context_length: 64000 },
    { id: 'gemini-x', name: 'X', thinking: true, escalate: false }
  ]) });
  try {
    assert.ok(await until(() => blockOf(mixed) && /gemini-x/.test(blockText(mixed))));
    assert.match(blockText(mixed), /\nContext: 64000 \(a working size, not the model's maximum\)$/);
  } finally { await mixed.close(); }
});

test('API page: the models table has a Context column that stays a labelled card on a phone', { skip }, async () => {
  const ui = await open({ hash: '#api', provider: (f) => geminiLike(f, [
    { id: 'gemini', name: 'G', thinking: true, escalate: false, context_length: 128000 },
    { id: 'gemini-big', name: 'B', thinking: true, escalate: false, context_length: 1000000 },
    { id: 'gemini-none', name: 'N', thinking: true, escalate: false }
  ]) });
  try {
    assert.ok(await until(() => ui.$('.models-table')));
    assert.deepEqual([...ui.$$('.models-table thead th')].map((th) => th.textContent), ['Model id', 'Provider', 'Good for', 'Context', '']);
    const cell = (id) => [...ui.$$('.models-table tbody tr')].find((tr) => tr.textContent.includes(id)).querySelector('td[data-label="Context"]');
    assert.equal(cell('gemini-big').textContent, '1M');
    assert.equal(cell('gemini-none').textContent, 'unknown');
    const c = cell('gemini').textContent;
    assert.equal(c, '128k');
    assert.match(cell('gemini').querySelector('[title]').getAttribute('title'), /128000/, 'the exact number is one hover or one long press away');
    assert.equal(cell('gemini').classList.contains('r'), true, 'numbers line up on the right');
  } finally { await ui.close(); }
});

test('Accounts: a Gemini card can read its models again, shows that it is busy, says the result in words and the API page follows', { skip }, async () => {
  const ui = await open({ hash: '#accounts', provider: (f) => geminiLike(f) });
  try {
    const live = () => ui.$('[role="status"][aria-live="polite"]').textContent;
    const readBtn = () => ui.$('#reread-gemini');
    assert.ok(await until(() => readBtn()));
    assert.equal(readBtn().textContent, 'Read models again');
    assert.equal(readBtn().disabled, false);
    assert.ok(readBtn().classList.contains('sm'), 'a small button, like the others');
    // it can take a while (it opens Gemini's page): the button says it is busy until the answer is back
    ui.fake.reread.delayMs = 300;
    ui.fake.reread.add = [{ id: 'gemini-3-5-flash', name: '3.5 Flash', thinking: true, escalate: false, context_length: 128000 }];
    ui.click(readBtn());
    assert.equal(readBtn().disabled, true);
    assert.equal(readBtn().getAttribute('aria-busy'), 'true');
    assert.match(readBtn().textContent, /^Reading/);
    assert.match(ui.$('[data-view="accounts"] article').textContent, /can take up to 20 seconds/);
    assert.ok(await until(() => /Models read again: 4 rows/.test(ui.$('[data-view="accounts"] article').textContent)), `the result is on the card: ${ui.$('[data-view="accounts"] article').textContent}`);
    assert.ok(await until(() => /Models read again: 4 rows/.test(live())), 'and in the live region');
    assert.deepEqual(ui.sent.filter((r) => r.method === 'POST' && /refresh-models/.test(r.path)).map((r) => [r.path, r.body]), [['/_/providers/gemini/refresh-models', {}]]);
    assert.equal(ui.fake.rereads, 1);
    assert.equal(readBtn().disabled, false);
    assert.equal(readBtn().getAttribute('aria-busy'), null);
    assert.equal(readBtn().textContent, 'Read models again');
    assert.ok(await until(() => ui.$$('.models .chip').length === 4), 'the new row is among the model chips');
    // the API page's block follows the models that are now in state
    ui.click([...ui.$$('nav button')].find((b) => /^API/.test(b.textContent)));
    assert.ok(await until(() => blockOf(ui) && /gemini-3-5-flash/.test(blockText(ui))));
    assert.match(blockText(ui), /\nModels: gemini, gemini-auto, gemini-3-5-flash-lite, gemini-3-5-flash\n/);
    assert.ok([...ui.$$('.models-table tbody tr')].some((tr) => /gemini-3-5-flash(?!-)/.test(tr.textContent)), 'and so is the models table');
    // the other outcome: the picker could not be read and the list stays as it was
    ui.click([...ui.$$('nav button')].find((b) => /^Accounts/.test(b.textContent)));
    ui.fake.reread.refreshed = false;
    ui.fake.reread.add = [];
    ui.click(readBtn());
    assert.ok(await until(() => /Could not read the picker; the list stays as it was/.test(ui.$('[data-view="accounts"] article').textContent)));
    assert.ok(await until(() => /Could not read the picker; the list stays as it was/.test(live())));
    assert.ok(!/Models read again/.test(ui.$('[data-view="accounts"] article').textContent), 'the old good result is not left beside the new bad one');
    assert.equal(ui.fake.rereads, 2);
    assert.equal(ui.$$('.models .chip').length, 4, 'the list is as it was');
    assert.equal(readBtn().disabled, false, 'and it can be tried again');
  } finally { await ui.close(); }
});

test('Accounts: "Read models again" is off while linking and when not linked, and only a provider that can read its picker has it', { skip }, async () => {
  const unlinked = await open({ hash: '#accounts', provider: (f) => { geminiLike(f); f.script.linked = false; } });
  try {
    assert.ok(await until(() => unlinked.$('#reread-gemini')));
    assert.equal(unlinked.$('#reread-gemini').disabled, true, 'not linked');
  } finally { await unlinked.close(); }
  const linking = await open({ hash: '#accounts', provider: (f) => { geminiLike(f); f.reread.linking = true; } });
  try {
    assert.ok(await until(() => linking.$('#reread-gemini')));
    assert.equal(linking.$('#reread-gemini').disabled, true, 'a window is open for sign-in');
  } finally { await linking.close(); }
  const other = await open({ hash: '#accounts' });
  try {
    assert.ok(await until(() => other.$('[data-view="accounts"] article')));
    assert.ok(![...other.$$('button')].some((b) => /Read models again/.test(b.textContent)), 'the demo-like fake provider cannot, so it has no button');
  } finally { await other.close(); }
});

test('Accounts: when the read fails outright the error is shown in words and the button comes back', { skip }, async () => {
  const ui = await open({ hash: '#accounts', provider: (f) => geminiLike(f) });
  const real = ui.window.fetch;
  ui.window.fetch = async (input, init = {}) => (String(input).endsWith('/refresh-models')
    ? new Response(JSON.stringify({ error: { message: 'Gemini\'s page did not open.' } }), { status: 502, headers: { 'content-type': 'application/json' } })
    : real(input, init));
  try {
    assert.ok(await until(() => ui.$('#reread-gemini')));
    ui.click(ui.$('#reread-gemini'));
    assert.ok(await until(() => ui.$('[data-view="accounts"] article [role="alert"]') && /Gemini's page did not open/.test(ui.$('[data-view="accounts"] article [role="alert"]').textContent)));
    assert.equal(ui.$('#reread-gemini').disabled, false);
    assert.equal(ui.$('#reread-gemini').textContent, 'Read models again');
    assert.ok(!/Models read again/.test(ui.$('[data-view="accounts"] article').textContent));
  } finally { await ui.close(); }
});

test('the real server answers POST /_/providers/gemini/refresh-models with { ok, refreshed, models } and says not_supported for a provider that cannot', { skip }, async () => {
  const ui = await open({ provider: (f) => geminiLike(f) });
  try {
    const ask = async (id) => { const res = await ui.window.fetch(`/_/providers/${id}/refresh-models`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: res.status, body: await res.json() }; };
    const ok = await ask('gemini');
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.ok, ok.body.refreshed, ok.body.models.map((m) => m.id)], [true, true, ['gemini-3-5-flash-lite', 'gemini-auto', 'gemini']]);
  } finally { await ui.close(); }
  const plain = await open();
  try {
    const res = await plain.window.fetch('/_/providers/fake/refresh-models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'not_supported');
  } finally { await plain.close(); }
});

// The playground's own conversation: when the model changes the conversation goes on in another chat (maybe at another provider), so more than one chat holds it.
const withKeptChats = (ui, build) => {
  const real = ui.window.fetch;
  ui.window.fetch = async (input, init = {}) => {
    const res = await real(input, init);
    if (String(input) !== '/_/state') return res;
    const data = await res.json();
    const tag = ui.sent.filter((r) => r.path === '/v1/chat/completions').map((r) => r.body.user)[0] || null;
    data.providers = [...data.providers, { id: 'deepseek', name: 'DeepSeek' }, { id: 'gemini', name: 'Gemini' }];
    data.sessions = tag ? build(tag) : [];
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
};

test('the footer says which chats hold the conversation: one chat by its provider, several chats with how many each provider holds, and never another conversation\'s', { skip }, async () => {
  const several = await open();
  try {
    withKeptChats(several, (tag) => [
      { id: 'g1', tag, turns: 1, provider: 'gemini' }, { id: 'd1', tag, turns: 2, provider: 'deepseek' }, { id: 'd2', tag, turns: 1, provider: 'deepseek' },
      { id: 'x1', tag: 'playground-other', turns: 9, provider: 'gemini' }
    ]);
    await until(() => several.$$('select option').length >= 3);
    await send(several, 'hello');
    assert.ok(await until(() => /kept in/.test(several.$('.convo').textContent)), several.$('.convo').textContent);
    const text = several.$('.convo').textContent;
    assert.match(text, /kept in 3 chats \(Gemini 1, DeepSeek 2\)/, 'the chats of this conversation, by provider, the one used last first: ' + text);
    assert.ok(!/one DeepSeek chat/.test(text), 'it no longer names only the first chat it finds: ' + text);
  } finally { await several.close(); }
  const one = await open();
  try {
    withKeptChats(one, (tag) => [{ id: 'd1', tag, turns: 2, provider: 'deepseek' }, { id: 'x1', tag: 'playground-other', turns: 9, provider: 'gemini' }]);
    await until(() => one.$$('select option').length >= 3);
    await send(one, 'hello');
    assert.ok(await until(() => /kept in/.test(one.$('.convo').textContent)));
    assert.match(one.$('.convo').textContent, /kept in one DeepSeek chat \(2 turns\)/);
  } finally { await one.close(); }
});
