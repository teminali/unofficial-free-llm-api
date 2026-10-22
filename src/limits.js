/**
 * `max_tokens` and `stop`, which a web chat has no controls for, done here: the answer is cut where the caller asked, and the provider is told to stop sending
 * when the cut is reached while streaming. Only for a request with no tools (a cut through a tool call is a broken call). The size is an estimate: a token is four
 * characters, as everywhere in this program. Pure: no network, no engine.
 */
'use strict';

const CHARS_PER_TOKEN = 4;
const MAX_STOPS = 4;

/** The stop strings of a request: `stop` is a string or a list of up to four, the empty ones are not stops. */
function stopList(stop) {
  const list = Array.isArray(stop) ? stop : (typeof stop === 'string' ? [stop] : []);
  return list.filter((s) => typeof s === 'string' && s.length > 0).slice(0, MAX_STOPS);
}

/** How many characters the caller allows (0: no limit), from `max_completion_tokens` or `max_tokens`. */
function maxChars(body) {
  const n = Number(body.max_completion_tokens ?? body.max_tokens);
  return Number.isInteger(n) && n > 0 ? n * CHARS_PER_TOKEN : 0;
}

/**
 * Takes the answer in pieces. push(text) -> { out, done }: `out` is what may be sent on now, `done` is 'stop' or 'length' once a limit was reached (nothing more
 * is accepted after that). A stop string can arrive split over two pieces, so the end of what was seen is held back until it cannot be the start of one;
 * flush() gives that tail back when the answer ended without a limit.
 */
function createLimiter({ maxChars: cap = 0, stops = [] } = {}) {
  const hold = stops.length ? Math.max(...stops.map((s) => s.length)) - 1 : 0;
  let held = '';
  let emitted = 0;
  let seen = '';
  let done = null;

  function release(text) {
    let out = text;
    let reason = null;
    if (cap && emitted + out.length > cap) { out = out.slice(0, Math.max(0, cap - emitted)); reason = 'length'; }
    emitted += out.length;
    if (reason) done = reason;
    return out;
  }

  return {
    push(text) {
      if (done) return { out: '', done };
      seen += text;
      let buf = held + text;
      held = '';
      let at = -1;
      for (const s of stops) { const i = buf.indexOf(s); if (i >= 0 && (at < 0 || i < at)) at = i; }
      if (at >= 0) {
        const out = release(buf.slice(0, at));
        if (!done) done = 'stop';
        return { out, done };
      }
      if (hold) {
        held = buf.slice(Math.max(0, buf.length - hold));
        buf = buf.slice(0, buf.length - held.length);
      }
      return { out: release(buf), done };
    },
    flush() {
      if (done) return '';
      const rest = held;
      held = '';
      return release(rest);
    },
    /** Everything the provider sent so far, cut or not. */
    seen: () => seen,
    done: () => done
  };
}

/** The same for a whole answer at once: { text, finish } with finish `null`, 'stop' or 'length'. */
function cutText(text, opts) {
  const lim = createLimiter(opts);
  const first = lim.push(text);
  const out = first.out + (lim.done() ? '' : lim.flush());
  return { text: out, finish: lim.done() };
}

module.exports = { stopList, maxChars, createLimiter, cutText, CHARS_PER_TOKEN };
