#!/usr/bin/env node
'use strict';

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  process.stderr.write(`unofficial-free-llm-api needs Node.js 22 or newer (this is ${process.versions.node}).\n`);
  process.exit(1);
}

require('../src/cli').run(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => { process.stderr.write(`${err && err.friendly ? err.message : ((err && err.stack) || err)}\n`); process.exitCode = 1; }
);
