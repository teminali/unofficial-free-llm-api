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
