'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConfig } = require('../src/config');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ula-cfg-'));

test('a config.json that is not valid JSON is never replaced by an empty one: the keys and settings in it are the person\'s', () => {
  for (const text of ['{ "adminToken": "abc", ', '[]', 'null', '"text"']) {
    const dir = scratch();
    try {
      const file = path.join(dir, 'config.json');
      fs.writeFileSync(file, text);
      assert.throws(() => createConfig({ dataDir: dir }), (err) => /not valid/i.test(err.message) && err.friendly === true, `for ${text}`);
      assert.equal(fs.readFileSync(file, 'utf8'), text, 'the file was left exactly as it was');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a config.json that is missing is created with a fresh admin token; a good one is read as it is', () => {
  const dir = scratch();
  try {
    const first = createConfig({ dataDir: dir });
    const { key } = first.createApiKey('one');
    const again = createConfig({ dataDir: dir });
    assert.equal(again.adminToken(), first.adminToken());
    assert.ok(again.findApiKey(key));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file edited into something invalid while the server runs is ignored, and is not overwritten until it is fixed', () => {
  const dir = scratch();
  try {
    const config = createConfig({ dataDir: dir });
    const { key } = config.createApiKey('one');
    const file = path.join(dir, 'config.json');
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(file, '{ half an edit');
    fs.utimesSync(file, later, later);
    assert.ok(config.findApiKey(key), 'the keys already loaded keep working');
    assert.equal(fs.readFileSync(file, 'utf8'), '{ half an edit', 'a read of a key does not rewrite the person\'s half-finished edit');
    assert.throws(() => config.createApiKey('two'), /not valid/i, 'a change that cannot be saved says so instead of pretending');
    fs.writeFileSync(file, JSON.stringify({ adminToken: config.adminToken(), apiKeys: [], providers: {} }));
    const later2 = new Date(Date.now() + 10000);
    fs.utimesSync(file, later2, later2);
    assert.equal(config.findApiKey(key), null, 'once the file is valid again, what it says is what counts');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
