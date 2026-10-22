/**
 * Finds a Chromium-based browser to drive. Chrome first (Google's sign-in is happiest in it), then Chromium and Edge. ULA_CHROME_PATH names one explicitly.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function candidates() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
  }
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap((r) => [path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]);
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  const dirs = String(process.env.PATH || '').split(path.delimiter).concat(['/usr/bin', '/usr/local/bin', '/snap/bin']);
  return names.flatMap((n) => dirs.map((d) => path.join(d, n)));
}

/** The path of a browser to drive, or null when there is none. */
function chromeExecutable() {
  const forced = process.env.ULA_CHROME_PATH;
  if (forced) return fs.existsSync(forced) ? forced : null;
  for (const c of candidates()) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* keep looking */ }
  }
  return null;
}

const NO_CHROME = 'Google Chrome was not found on this computer. Install it (or set ULA_CHROME_PATH to a Chromium-based browser) to link an account.';

module.exports = { chromeExecutable, NO_CHROME };
