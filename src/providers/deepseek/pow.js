/**
 * DeepSeek's proof-of-work, in plain JavaScript.
 *
 * Before every completion the web app asks the server for a challenge and answers it with DeepSeekHashV1: SHA3-256 with the first of
 * Keccak-f[1600]'s 24 rounds left out (23 rounds, standard SHA3 padding). The challenge is the hash of "<salt>_<expire_at>_<answer>" for a small
 * integer answer, and the solver finds it by counting up from zero. The web app does this in a wasm module; the same function is written out here so
 * nothing that belongs to DeepSeek has to be shipped, and test/pow.test.js checks it against recorded answers of the real module.
 */
'use strict';

const RATE = 136; // SHA3-256: 1088 bits of the 1600-bit state are read and written per block

// The round constants as 32-bit halves, round 0 first. Round 0 is never run (that is what makes this DeepSeekHashV1 and not SHA3-256).
const RC_LO = new Uint32Array([0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001, 0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009, 0x8000000a, 0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080, 0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008]);
const RC_HI = new Uint32Array([0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000]);
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

const lo = new Uint32Array(25);
const hi = new Uint32Array(25);
const bcLo = new Uint32Array(5);
const bcHi = new Uint32Array(5);

/** Keccak-f[1600] on the shared state, rounds 1 to 23. */
function permute() {
  for (let round = 1; round < 24; round += 1) {
    for (let i = 0; i < 5; i += 1) {
      bcLo[i] = lo[i] ^ lo[i + 5] ^ lo[i + 10] ^ lo[i + 15] ^ lo[i + 20];
      bcHi[i] = hi[i] ^ hi[i + 5] ^ hi[i + 10] ^ hi[i + 15] ^ hi[i + 20];
    }
    for (let i = 0; i < 5; i += 1) {
      const a = (i + 1) % 5;
      const b = (i + 4) % 5;
      const tLo = bcLo[b] ^ ((bcLo[a] << 1) | (bcHi[a] >>> 31));
      const tHi = bcHi[b] ^ ((bcHi[a] << 1) | (bcLo[a] >>> 31));
      for (let j = 0; j < 25; j += 5) { lo[j + i] ^= tLo; hi[j + i] ^= tHi; }
    }
    let tLo = lo[1];
    let tHi = hi[1];
    for (let i = 0; i < 24; i += 1) {
      const j = PILN[i];
      const n = ROTC[i];
      const keepLo = lo[j];
      const keepHi = hi[j];
      let l = tLo;
      let h = tHi;
      let r = n;
      if (r >= 32) { const swap = l; l = h; h = swap; r -= 32; }
      if (r === 0) { lo[j] = l; hi[j] = h; } else {
        lo[j] = (l << r) | (h >>> (32 - r));
        hi[j] = (h << r) | (l >>> (32 - r));
      }
      tLo = keepLo;
      tHi = keepHi;
    }
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i += 1) { bcLo[i] = lo[j + i]; bcHi[i] = hi[j + i]; }
      for (let i = 0; i < 5; i += 1) {
        lo[j + i] ^= ~bcLo[(i + 1) % 5] & bcLo[(i + 2) % 5];
        hi[j + i] ^= ~bcHi[(i + 1) % 5] & bcHi[(i + 2) % 5];
      }
    }
    lo[0] ^= RC_LO[round];
    hi[0] ^= RC_HI[round];
  }
}

/** The DeepSeekHashV1 of a byte string, as 64 lowercase hex characters. */
function deepseekHash(bytes) {
  lo.fill(0);
  hi.fill(0);
  const padded = Buffer.alloc(Math.ceil((bytes.length + 1) / RATE) * RATE);
  padded.set(bytes);
  padded[bytes.length] ^= 0x06;
  padded[padded.length - 1] ^= 0x80;
  for (let at = 0; at < padded.length; at += RATE) {
    for (let i = 0; i < RATE / 8; i += 1) {
      lo[i] ^= padded.readUInt32LE(at + 8 * i);
      hi[i] ^= padded.readUInt32LE(at + 8 * i + 4);
    }
    permute();
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i += 1) { out.writeUInt32LE(lo[i], 8 * i); out.writeUInt32LE(hi[i], 8 * i + 4); }
  return out.toString('hex');
}

/** The first integer in [from, to) whose hash with the prefix is the challenge, or null. */
function solveRange({ challenge, salt, expire_at: expireAt }, from, to) {
  const prefix = Buffer.from(`${salt}_${expireAt}_`, 'utf8');
  for (let answer = from; answer < to; answer += 1) {
    if (deepseekHash(Buffer.concat([prefix, Buffer.from(String(answer), 'utf8')])) === challenge) return answer;
  }
  return null;
}

/**
 * The answer to one challenge: the first integer below `difficulty` whose hash with the prefix is the challenge. Returns it, or null when none is.
 * `challenge` is DeepSeek's `{ challenge, salt, expire_at, difficulty }` object.
 */
function solve(challenge) {
  return solveRange(challenge, 0, challenge.difficulty);
}

/** Like solve(), but hands the event loop a turn every few thousand tries (the worst case is most of a second), so a server is not frozen while one request waits. */
async function solveAsync(challenge, slice = 4000) {
  for (let from = 0; from < challenge.difficulty; from += slice) {
    const answer = solveRange(challenge, from, Math.min(challenge.difficulty, from + slice));
    if (answer !== null) return answer;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return null;
}

function headerFor(challenge, answer) {
  if (answer === null) throw new Error('DeepSeek refused the proof-of-work challenge');
  return Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path
  })).toString('base64');
}

/** The base64 header the completion call carries for one challenge. */
async function powHeader(challenge) {
  return headerFor(challenge, await solveAsync(challenge));
}

module.exports = { deepseekHash, solve, solveAsync, powHeader };
