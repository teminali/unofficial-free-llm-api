'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchChrome } = require('../src/providers/chrome_cdp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

test('a Chrome that never says where its debugging port is gets stopped, not left running on the profile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-cdp-'));
  const pidFile = path.join(dir, 'pid');
  const exe = path.join(dir, 'chrome-that-says-nothing');
  fs.writeFileSync(exe, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`, { mode: 0o755 });
  let pid = 0;
  try {
    await assert.rejects(launchChrome({ executablePath: exe, userDataDir: path.join(dir, 'profile'), startTimeoutMs: 3000 }), /did not give this program a way in/); // long enough for macOS to scan a script it has not run before
    assert.ok(fs.existsSync(pidFile), 'the stand-in Chrome did start');
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    for (let i = 0; i < 40 && alive(pid); i += 1) await sleep(50);
    assert.equal(alive(pid), false, 'the Chrome that never answered is no longer running');
  } finally {
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a profile that another Chrome is using is named as that (Chrome leaves with code 21, or hands over with code 0), not as a bare exit code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-cdp-'));
  try {
    for (const code of [0, 21]) {
      const exe = path.join(dir, `chrome-exits-${code}`);
      fs.writeFileSync(exe, `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
      await assert.rejects(
        launchChrome({ executablePath: exe, userDataDir: path.join(dir, 'profile'), startTimeoutMs: 3000 }),
        (err) => /another Chrome|still running/i.test(err.message) && /Quit that Chrome/.test(err.message) && !/\(code \d+\)/.test(err.message),
        `exit code ${code}`
      );
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a minimal start passes only what is needed to drive Chrome: the debugging port, the profile folder and the two first-run switches', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-cdp-'));
  const argsFile = path.join(dir, 'args');
  const exe = path.join(dir, 'chrome-that-lists-its-flags');
  fs.writeFileSync(exe, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexec sleep 30\n`, { mode: 0o755 });
  const flags = async (opts) => {
    await assert.rejects(launchChrome({ executablePath: exe, userDataDir: path.join(dir, 'profile'), startTimeoutMs: 1500, ...opts }), /did not give this program a way in/);
    return fs.readFileSync(argsFile, 'utf8').trim().split('\n');
  };
  try {
    const usual = await flags({ args: ['--some-extra'] });
    assert.ok(usual.includes('--disable-restore-session-state') && usual.includes('--some-extra'));
    const minimal = await flags({ minimal: true });
    assert.deepEqual(minimal.filter((a) => a.startsWith('--')).sort(), ['--no-default-browser-check', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`].sort());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a click can be made as a real mouse event at the middle of the element, not only by the page calling element.click()', async () => {
  const { chromeExecutable } = require('../src/providers/chrome');
  if (!chromeExecutable()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-cdp-'));
  const browser = await launchChrome({ executablePath: chromeExecutable(), userDataDir: path.join(dir, 'profile'), args: ['--headless=new'] });
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<body style="margin:0"><button id="b" style="margin:40px;width:120px;height:40px">go</button><script>window.last=null;window.clicks=0;document.getElementById("b").addEventListener("click",function(e){window.last=e.isTrusted;window.clicks+=1;});</script></body>');
    const button = await page.$('#b');
    await button.click();
    assert.deepEqual(await page.evaluate(() => [window.last, window.clicks]), [false, 1], 'element.click() is the page\'s own call');
    await button.mouseClick();
    assert.deepEqual(await page.evaluate(() => [window.last, window.clicks]), [true, 2], 'a mouse event from the browser, once');
  } finally { await browser.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the request list shows every kind of request that can carry an answer (fetch, XHR, an event stream), leaves out files a page only loads, and counts the ads and analytics it does not list', async () => {
  const { chromeExecutable } = require('../src/providers/chrome');
  if (!chromeExecutable()) return;
  const http = require('http');
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<img src="/pic.png"><script src="/lib.js"></script>'); }
    if (req.url === '/lib.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('window.libLoaded = true;'); }
    if (req.url === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.alloc(8)); }
    if (req.url === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write('data: hi\n\n'); } // the stream stays open, as an answer that is still coming does
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-cdp-'));
  const browser = await launchChrome({ executablePath: chromeExecutable(), userDataDir: path.join(dir, 'profile'), args: ['--headless=new'] });
  try {
    const page = await browser.newPage();
    const net = await page.watchRequests({ quiet: /\/noise\// });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(() => { fetch('/answer', { method: 'POST' }); fetch('/noise/1'); fetch('/noise/2'); window.stream = new EventSource('/events'); return true; });
    const end = Date.now() + 8000;
    while (!/\/events/.test(net.summary()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    const text = net.summary();
    assert.match(text, /POST 127\.0\.0\.1:\d+\/answer 200/, text);
    assert.match(text, /GET 127\.0\.0\.1:\d+\/events 200/, 'an event stream that is still open is listed: ' + text);
    assert.ok(!/lib\.js|pic\.png/.test(text), 'a script and a picture the page loads are not requests that carry an answer: ' + text);
    assert.ok(!/noise/.test(text), 'the ads and analytics are not listed: ' + text);
    assert.match(text, /2 ad and analytics requests not listed/, text);
    await net.stop();
  } finally { await browser.close().catch(() => {}); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
