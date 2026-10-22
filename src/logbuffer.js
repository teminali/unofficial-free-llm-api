/**
 * The last lines the providers logged, kept in memory only (never written to disk), so a person can show what happened without having started the
 * program in debug mode. The lines are the ones the providers already write (sizes, steps, the shape of a page, no prompts and no answers); keys and
 * tokens are scrubbed once more here in case a line ever carries one.
 */
'use strict';

const SCRUBS = [
  [/sk-ula-[A-Za-z0-9_-]{6,}/g, 'sk-ula-...'],
  [/(token|authorization|cookie|bearer)(["']?\s*[:=]?\s*)[A-Za-z0-9._~+/=-]{16,}/gi, '$1$2...']
];

function scrub(line) {
  let out = String(line);
  for (const [pattern, to] of SCRUBS) out = out.replace(pattern, to);
  return out;
}

function createLogBuffer(max = 300) {
  const lines = [];
  return {
    push(line) {
      lines.push({ at: new Date().toISOString(), line: scrub(line) });
      if (lines.length > max) lines.splice(0, lines.length - max);
    },
    /** The last `count` lines, oldest first. */
    list(count = 100) {
      const n = Math.max(1, Math.min(Number(count) || 100, max));
      return lines.slice(-n);
    }
  };
}

module.exports = { createLogBuffer, scrub };
