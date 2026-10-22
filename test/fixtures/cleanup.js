'use strict';
const { execFileSync } = require('child_process');
const { removeTree } = require('../../src/config');

/**
 * Removes a test's folder. A folder that will not go (Chrome still writing into its profile) does not fail the test that finished fine: it is reported,
 * with the Chrome processes still running at that moment, so a Chrome left alive can be told from a slow exit.
 */
async function cleanupDir(dir) {
  try { await removeTree(dir); } catch (err) {
    let running = '';
    try { running = execFileSync('ps', ['-eo', 'pid,ppid,etime,args'], { encoding: 'utf8' }).split('\n').filter((l) => /chrom/i.test(l)).slice(0, 12).join('\n'); } catch (_) { /* no ps */ }
    process.stderr.write(`cleanup of ${dir} failed (${err && err.code}); Chrome processes running now:\n${running || '(none)'}\n`);
  }
}

module.exports = { cleanupDir };
