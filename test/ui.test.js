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

async function open({ hash = '', provider: tweak } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-ui-'));
  const bus = new EventEmitter();
  const fake = createFakeProvider({ dir, bus });
  if (tweak) tweak(fake);
  const config = createConfig({ dataDir: dir });
  const srv = createServer({ config, registry: createRegistry({ providers: [fake], bus }), port: 0 });
  const { port } = await srv.start();
  const base = `http://127.0.0.1:${port}`;
  const token = config.adminToken();
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replace('<script src="app.js"></script>', '');
  const dom = new JSDOM(html, { url: `${base}/${hash}`, pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  window.fetch = (input, init = {}) => fetch(new URL(String(input), base), { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  window.TextDecoder = TextDecoder;
  window.AbortController = AbortController;
  window.matchMedia = () => ({ matches: false });
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); };
  window.confirm = () => true;
  window.eval(fs.readFileSync(path.join(WEB, 'app.js'), 'utf8'));
  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return {
    fake, srv, window, $, $$, click, config, dir, base, token,
    async close() { window.close(); await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

const skip = JSDOM ? false : 'jsdom is not installed';

test('the page loads signed in, lists the models and shows the endpoint', { skip }, async () => {
  const ui = await open();
  try {
    assert.ok(await until(() => ui.$$('select option').length >= 3), 'the model list filled in');
    assert.deepEqual(ui.$$('select optgroup option').map((o) => o.value), ['fake-chat', 'fake-reasoner', 'fake-auto']);
    assert.match(ui.$('.pill').textContent, /\/v1/);
    assert.ok(ui.$('a[href$="DONATE.md"]'), 'the support link is in the header');
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
    // unlink
    ui.click([...ui.$('[data-view="accounts"] article').querySelectorAll('button')].find((b) => b.textContent === 'Unlink'));
    assert.ok(await until(() => /Not linked/.test(ui.$('[data-view="accounts"] article').textContent)));
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
    assert.match(dom.window.document.querySelector('.locked').textContent, /login-url/);
    assert.equal(dom.window.document.querySelector('select'), null);
  } finally { dom.window.close(); await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
