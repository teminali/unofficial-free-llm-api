/**
 * A driver for a real Chrome, over the DevTools protocol.
 *
 * Google refuses sign-in inside an embedded browser view, so the account lanes open a real Chrome instead of a window of their own.
 * Driving it needs no library: Chrome is started with a debugging port and the protocol is JSON over one WebSocket per tab, which
 * Node's own fetch and WebSocket already speak. This program has no runtime dependencies, and this driver is why it needs none for Chrome.
 *
 * Two things make this safe to do. The window is a profile folder of this program's, never the person's everyday profile, and Chrome
 * refuses remote debugging on the default profile anyway. The port is 0, so Chrome picks a free one on loopback and only this
 * process learns it, from Chrome's own stderr.
 *
 * The surface is the small part of a browser driver the lanes use: newPage, goto, url, evaluate, $, cookies, keyboard.insertText,
 * keyboard.press, close. Nothing here knows about any provider.
 */
'use strict';

const { spawn } = require('child_process');

const START_TIMEOUT_MS = 20000;
const COMMAND_TIMEOUT_MS = 30000;
const NAV_TIMEOUT_MS = 30000;

// Only the keys this lane presses. A key that is not here is a mistake in the caller, not something to guess at.
const KEYS = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }
};

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Chrome's own sentence on stderr, carrying the address of the protocol. */
function wsUrlFrom(text) {
  const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(text || ''));
  return m ? m[1] : null;
}

function httpBaseOf(wsUrl) {
  const m = /^ws:\/\/([^/]+)\//.exec(wsUrl);
  return m ? `http://${m[1]}` : null;
}

function describeException(details) {
  const exception = details && details.exception;
  const raw = (exception && (exception.description || exception.value)) || (details && details.text) || 'the page refused the call';
  return String(raw).split('\n')[0];
}

/** One WebSocket to one tab: commands by id, events to whoever is listening. */
function openSession(wsUrl) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (err) { reject(err); return; }
    let nextId = 1;
    const pending = new Map();
    const listeners = new Set();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      reject(err);
    };
    const openTimer = setTimeout(() => fail(new Error('Chrome did not answer its debugging port.')), START_TIMEOUT_MS);

    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      resolve(session);
    });
    ws.addEventListener('error', () => fail(new Error('The connection to Chrome broke.')));
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch (_) { return; }
      if (message.id !== undefined) {
        const waiting = pending.get(message.id);
        if (!waiting) return;
        pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(message.error.message || 'Chrome refused the command.'));
        else waiting.resolve(message.result || {});
        return;
      }
      if (!message.method) return;
      for (const listener of [...listeners]) {
        try { listener(message.method, message.params || {}); } catch (_) { /* one bad listener must not blind the rest */ }
      }
    });
    ws.addEventListener('close', () => {
      for (const [, waiting] of pending) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error('Chrome closed the tab mid-command.'));
      }
      pending.clear();
      for (const listener of [...listeners]) {
        try { listener('__closed', {}); } catch (_) {}
      }
      listeners.clear();
    });

    const session = {
      send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
        return new Promise((resolveCommand, rejectCommand) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectCommand(new Error(`Chrome did not answer ${method} in time.`));
          }, timeoutMs);
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
          try { ws.send(JSON.stringify({ id, method, params })); } catch (err) {
            clearTimeout(timer);
            pending.delete(id);
            rejectCommand(err);
          }
        });
      },
      /** Listens for protocol events. Returns the way to stop listening. */
      on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
  });
}

/** A found element: enough to click it and to ask it something. `this` inside the function is the element. */
function createElement(session, objectId) {
  const call = async (fn, args) => {
    const result = await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `(function () { const f = (${fn.toString()}); return f.apply(this, [this].concat(${JSON.stringify(args || [])})); })`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (result.exceptionDetails) throw new Error(describeException(result.exceptionDetails));
    return result.result ? result.result.value : undefined;
  };
  return {
    click: () => call(function () { this.scrollIntoView({ block: 'center', inline: 'nearest' }); this.click(); return true; }),
    evaluate: (fn, ...args) => call(fn, args)
  };
}

function createPage({ session, targetId, base }) {
  let currentUrl = 'about:blank';
  let closed = false;
  const closeListeners = [];

  session.on((method, params) => {
    if (method === '__closed') { closed = true; for (const l of closeListeners) l(); return; }
    // The top frame's address, so a redirect to the Google sign-in can be recognised without asking the page.
    if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId && params.frame.url) currentUrl = params.frame.url;
  });

  const page = {
    get closed() { return closed; },
    url: () => currentUrl,
    onClose(listener) { closeListeners.push(listener); },

    async goto(url, { timeout = NAV_TIMEOUT_MS } = {}) {
      const deadline = Date.now() + timeout;
      let frameId = null;
      try {
        const started = await session.send('Page.navigate', { url });
        frameId = started && started.frameId;
      } catch (_) { /* a tab that went away reports it here; the caller polls the page for what it needed */ }
      // A tab is created on about:blank, and that load's own events can reach us after Page.enable: the address leaving
      // about:blank is what tells them apart from the page asked for. Every main-frame navigation (a redirect to the Google
      // sign-in, say) resets the wait, so the answer is the last document, not a page on the way to it.
      let stopped = false;
      const stopListening = session.on((method, params) => {
        if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) { stopped = false; return; }
        if (method === 'Page.loadEventFired') stopped = true;
        if (method === 'Page.frameStoppedLoading' && (!frameId || params.frameId === frameId)) stopped = true;
      });
      while (!(stopped && currentUrl !== 'about:blank') && Date.now() < deadline) await sleep(80);
      stopListening();
    },

    async evaluate(fn, ...args) {
      const expression = `(function () { const f = (${fn.toString()}); return f.apply(null, ${JSON.stringify(args)}); })()`;
      const result = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(describeException(result.exceptionDetails));
      return result.result ? result.result.value : undefined;
    },

    async $(selector) {
      const result = await session.send('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(String(selector))})`,
        returnByValue: false
      });
      const remote = result.result;
      if (!remote || !remote.objectId || remote.subtype === 'null' || remote.type === 'undefined') return null;
      return createElement(session, remote.objectId);
    },

    /** The cookies the browser holds for these addresses, HttpOnly ones included: [{ name, value, domain, path, expires }]. */
    async cookies(urls) {
      const result = await session.send('Network.getCookies', { urls });
      return (result.cookies || []).map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires }));
    },

    /** The cookies the browser holds for these addresses, HttpOnly ones included: [{ name, value, domain, path, expires }]. */
    async cookies(urls) {
      const result = await session.send('Network.getCookies', { urls });
      return (result.cookies || []).map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires }));
    },

    keyboard: {
      insertText: (text) => session.send('Input.insertText', { text: String(text) }),
      async press(key) {
        const spec = KEYS[key];
        if (!spec) throw new Error('chrome driver: no mapping for the key ' + key);
        const common = { key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, nativeVirtualKeyCode: spec.nativeVirtualKeyCode };
        await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(spec.text ? { text: spec.text } : {}) });
        await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
      }
    },

    /** Brings the tab to the front of its window: for a page that waits for the person (a cookie question, a human check). */
    async bringToFront() {
      if (closed) return;
      try { await fetch(`${base}/json/activate/${encodeURIComponent(targetId)}`); } catch (_) { /* the person finds the tab themselves */ }
    },

    async close() {
      if (closed) return;
      closed = true;
      try { await fetch(`${base}/json/close/${encodeURIComponent(targetId)}`); } catch (_) { /* the tab is gone either way */ }
      for (const l of closeListeners) l();
    }
  };
  return page;
}

/**
 * Starts Chrome on a profile folder of the caller's and returns the browser. `close()` ends every tab and then Chrome.
 */
async function launchChrome({ executablePath, userDataDir, args = [], log = () => {}, startTimeoutMs = START_TIMEOUT_MS }) {
  const child = spawn(executablePath, [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-restore-session-state',
    ...args,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let wsUrl;
  try {
    wsUrl = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(
        'Chrome opened but did not give this program a way in. Close the Chrome window it opened and try again.'
      )), startTimeoutMs);
      const finish = (fn, value) => { clearTimeout(timer); fn(value); };
      const onStderr = (chunk) => {
        output = (output + String(chunk)).slice(-65536);
        const found = wsUrlFrom(output);
        if (!found) return;
        // The line was all that was wanted from this stream. It stays read (a full pipe would stall Chrome) but is no longer kept or searched.
        child.stderr.off('data', onStderr);
        child.stderr.resume();
        finish(resolve, found);
      };
      child.stderr.on('data', onStderr);
      child.stdout.on('data', () => {});
      child.on('error', (err) => finish(reject, new Error('Chrome could not start: ' + (err.message || err))));
      // Chrome started on a profile that another Chrome already holds hands over to it and exits at once with code 0: an earlier Chrome of
      // this program (after a crash or a forced quit) is still running there, and the person can see it.
      child.on('exit', (code) => finish(reject, new Error(code === 0
        ? 'A Chrome window that this program opened earlier is still running. Quit that Chrome (Chrome menu, Quit) and try again.'
        : `Chrome closed before this program could reach it (code ${code}).`)));
    });
  } catch (err) {
    // A Chrome that started but never answered would stay running on the profile folder and block every later start with "quit that Chrome".
    try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
    throw err;
  }

  const base = httpBaseOf(wsUrl);
  let connected = true;
  const pages = new Set();
  const disconnectListeners = [];
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.on('exit', () => {
    if (!connected) return;
    connected = false;
    log('chrome driver: the window closed');
    for (const l of disconnectListeners) { try { l(); } catch (_) {} }
  });

  return {
    get connected() { return connected; },
    onDisconnect(listener) { disconnectListeners.push(listener); },

    async newPage(url = 'about:blank') {
      if (!connected) throw new Error('Chrome is not running any more.');
      let target;
      try {
        const response = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
        if (!response.ok) throw new Error(`Chrome refused to open a tab (${response.status}).`);
        target = await response.json();
      } catch (err) {
        throw new Error('Could not open a Chrome tab: ' + String((err && err.message) || err));
      }
      const session = await openSession(target.webSocketDebuggerUrl);
      await session.send('Page.enable').catch(() => {});
      const page = createPage({ session, targetId: target.id, base });
      pages.add(page);
      page.onClose(() => pages.delete(page));
      // A tab opened while another is the active one starts in the background, and Chrome runs a background page's timers once a second and then barely at all
      // (measured: an answer that grew every 120 ms grew every second, then stopped). The tab is made the active one at once.
      await page.bringToFront();
      return page;
    },

    async close() {
      connected = false;
      for (const page of [...pages]) {
        try { await page.close(); } catch (_) { /* going down anyway */ }
      }
      pages.clear();
      try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
      // The Gemini lane deletes its profile folder right after this returns, and that folder is the session: Chrome must really
      // be gone first, or it writes back into a folder that is meant to be gone.
      await Promise.race([exited, sleep(3000)]);
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch (_) {}
      await Promise.race([exited, sleep(1500)]);
    }
  };
}

/**
 * Starts Chrome on a profile folder with NO debugging port, for the one thing a driven Chrome cannot do: let the person sign in to Google.
 * With a debugging port Chrome sets navigator.webdriver to true on every page (measured 2026-10-20, Chrome 155, a throwaway profile), and
 * Google answers a sign-in from such a browser with "Couldn't sign you in: this browser or app may not be secure". This Chrome is an ordinary
 * one: nothing can be driven in it, and the app learns the person is done only because they say so. `close()` asks it to quit (SIGTERM is a
 * normal quit for Chrome, which writes the cookies it still holds) and only then, after a wait, ends it.
 */
function launchPlainChrome({ executablePath, userDataDir, url = 'about:blank', args = [] }) {
  const child = spawn(executablePath, [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...args,
    url
  ], { stdio: 'ignore' });
  let exited = false;
  const done = new Promise((resolve) => {
    child.once('exit', () => { exited = true; resolve(); });
    child.once('error', () => { exited = true; resolve(); });
  });
  return {
    get running() { return !exited; },
    exited: done,
    async close() {
      if (exited) return;
      try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
      await Promise.race([done, sleep(8000)]);
      if (!exited) {
        try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
        await Promise.race([done, sleep(2000)]);
      }
    }
  };
}

module.exports = { launchChrome, launchPlainChrome, KEYS };
