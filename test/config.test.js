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

test('a key made now can be shown again, also after a restart; the list never carries it; an older hash-only key still works but cannot be shown', () => {
  const dir = scratch();
  try {
    const first = createConfig({ dataDir: dir });
    const { key, entry } = first.createApiKey('cline');
    assert.equal(entry.revealable, true);
    assert.equal(first.revealApiKey(entry.id), key);
    assert.ok(!JSON.stringify(first.listApiKeys()).includes(key), 'the list is metadata only');
    assert.ok(!JSON.stringify(entry).includes(key), 'so is the entry handed back');
    const again = createConfig({ dataDir: dir });
    assert.equal(again.revealApiKey(entry.id), key, 'the same key is there after the program is started again');
    assert.ok(again.findApiKey(key));
    // a key made by version 0.1.0 holds a hash and no key
    const file = path.join(dir, 'config.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const old = 'sk-ula-oldoldoldoldoldoldoldoldoldoldol';
    data.apiKeys.push({ id: 'aaaaaaaaaaaa', name: 'old', hash: require('crypto').createHash('sha256').update(old).digest('hex'), hint: 'sk-ula-oldo...ldol', createdAt: new Date().toISOString(), lastUsedAt: null });
    fs.writeFileSync(file, JSON.stringify(data));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    assert.ok(again.findApiKey(old), 'an older key keeps working');
    assert.equal(again.revealApiKey('aaaaaaaaaaaa'), null, 'but it was stored as a hash only, so it cannot be shown');
    assert.equal(again.listApiKeys().find((k) => k.id === 'aaaaaaaaaaaa').revealable, false);
    assert.equal(again.revealApiKey('ffffffffffff'), null);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the file that holds the keys stays private');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the data folder keeps its place across the rename: a 0.1.x folder in use stays in use, a fresh computer gets the new name, ULA_HOME wins over both', () => {
  const { defaultDataDir } = require('../src/config');
  const home = scratch();
  try {
    const oldDir = path.join(home, '.unofficial-llm-api');
    const newDir = path.join(home, '.unofficial-free-llm-api');
    assert.equal(defaultDataDir({ home, env: {} }), newDir, 'nothing there yet: the new name');
    fs.mkdirSync(oldDir);
    assert.equal(defaultDataDir({ home, env: {} }), oldDir, 'the old folder holds the keys and logins, so it stays the one in use');
    fs.mkdirSync(newDir);
    assert.equal(defaultDataDir({ home, env: {} }), newDir, 'once the new one exists it is the one in use');
    assert.equal(defaultDataDir({ home, env: { ULA_HOME: path.join(home, 'elsewhere') } }), path.join(home, 'elsewhere'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
