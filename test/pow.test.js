'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deepseekHash, solve, solveAsync, powHeader } = require('../src/providers/deepseek/pow');
const vectors = require('./fixtures/pow_vectors.json');

// The vectors were recorded from the real proof-of-work module (400 random inputs and 8 whole challenges agreed with it when this was written): the
// repository carries the answers, not the module.

test('DeepSeekHashV1 gives the recorded hashes (empty, short, a stand-in challenge, two blocks long)', () => {
  for (const { input, hash } of vectors.hashes) assert.equal(deepseekHash(Buffer.from(input, 'utf8')), hash, `input of ${input.length} bytes`);
});

test('it is not SHA3-256: the first round is skipped', () => {
  const sha3OfAbc = '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532';
  assert.notEqual(deepseekHash(Buffer.from('abc')), sha3OfAbc);
});

test('the solver finds the recorded answers, from 0 up to the last one below the difficulty', () => {
  for (const c of vectors.challenges) {
    const full = { algorithm: 'DeepSeekHashV1', signature: 's', target_path: '/p', ...c };
    assert.equal(solve(full), c.answer);
  }
});

test('the async solver gives the same answer and lets the event loop run meanwhile', async () => {
  const c = vectors.challenges.reduce((a, b) => (b.answer > a.answer ? b : a));
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  const answer = await solveAsync({ algorithm: 'DeepSeekHashV1', signature: 's', target_path: '/p', ...c }, 1000);
  clearInterval(timer);
  assert.equal(answer, c.answer);
  if (c.answer > 20000) assert.ok(ticks > 0, 'a timer fired while the solver worked');
});

test('a challenge with no answer below the difficulty is refused, not looped on', async () => {
  const c = { algorithm: 'DeepSeekHashV1', challenge: 'f'.repeat(64), salt: 'x', expire_at: 1, difficulty: 200, signature: 's', target_path: '/p' };
  assert.equal(solve(c), null);
  await assert.rejects(powHeader(c), /could not solve DeepSeek's proof-of-work/);
});

test('the header is the base64 of the answer with the challenge\'s own fields', async () => {
  const c = { algorithm: 'DeepSeekHashV1', signature: 'sig-1', target_path: '/api/v0/chat/completion', ...vectors.challenges[3] };
  const header = JSON.parse(Buffer.from(await powHeader(c), 'base64').toString('utf8'));
  assert.deepEqual(header, { algorithm: 'DeepSeekHashV1', challenge: c.challenge, salt: c.salt, answer: c.answer, signature: 'sig-1', target_path: '/api/v0/chat/completion' });
});
