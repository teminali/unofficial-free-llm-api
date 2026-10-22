/**
 * Where DeepSeek's web service is, and the browser identity its requests carry.
 *
 * The address is always chat.deepseek.com. A loopback stand-in can replace it only when ULA_TEST_MODE=1 is set AND the address is http://127.0.0.1:<port>:
 * the tests use that, and nothing a user can set from a flag or a config file can send a login anywhere else.
 */
'use strict';

const DEFAULT_BASE = 'https://chat.deepseek.com';

// chat.deepseek.com sits behind AWS WAF and hCaptcha, which refuse a client that does not look like a browser. Requests carry the identity of an ordinary Chrome.
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function resolveBase(requested) {
  if (requested && process.env.ULA_TEST_MODE === '1' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(String(requested))) return String(requested);
  return DEFAULT_BASE;
}

module.exports = { DEFAULT_BASE, CHROME_UA, resolveBase };
