'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGovernor } = require('../src/governor');

const FAST = { perMinute: 1000, minGapMs: 1, cooldownMs: 1000, smooth: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a caller that leaves while queued gives its place up without breaking the order of those behind it', async () => {
  const gov = createGovernor({ providerName: 'Test', pace: FAST });
  const order = [];
  const first = await gov.acquireSlot();
  const left = new AbortController();
  const gone = gov.acquireSlot(left.signal).then(() => order.push('left ran'), (e) => order.push(e && e.aborted ? 'left aborted' : 'left failed'));
  const next = gov.acquireSlot().then((release) => { order.push('next ran'); return release; });
  assert.equal(gov.queueLength(), 2);
  left.abort();
  await gone;
  assert.deepEqual(order, ['left aborted']);
  assert.equal(gov.queueLength(), 1, 'the one who left no longer counts as waiting');
  await sleep(30);
  assert.deepEqual(order, ['left aborted'], 'the one behind must still wait for the holder, not slip past it');
  first();
  const release = await next;
  assert.deepEqual(order, ['left aborted', 'next ran']);
  release();
});

test('a caller that has already left is refused a place at once, and one that leaves during the pause for the gap holds nothing', async () => {
  const gov = createGovernor({ providerName: 'Test', pace: { perMinute: 1000, minGapMs: 400, cooldownMs: 1000, smooth: true } });
  const gone = new AbortController();
  gone.abort();
  await assert.rejects(gov.acquireSlot(gone.signal), (e) => e && e.aborted === true);
  (await gov.acquireSlot())(); // makes the next one wait out the gap
  const leaving = new AbortController();
  const waiting = gov.acquireSlot(leaving.signal);
  setTimeout(() => leaving.abort(), 50);
  await assert.rejects(waiting, (e) => e && e.aborted === true);
  const started = Date.now();
  (await gov.acquireSlot())();
  assert.ok(Date.now() - started < 600, 'the lock was handed on, not kept by the one who left');
});
