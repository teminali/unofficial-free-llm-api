'use strict';

// Lens used to give every login a 5-hour life of its own making (an expiresAt exactly 5 hours after the link). DeepSeek's server accepted logins far past
// that (a 15-hour-old one in a test on 2026-10-20), so the only expiry that counts is one DeepSeek itself reported; otherwise the login lives until
// DeepSeek refuses it, and then the app says so and asks for a new sign-in. Returns the expiry in ms, or null when none is known.
const LEGACY_NOMINAL_TTL_MS = 5 * 60 * 60 * 1000;
function sessionExpiry(data) {
  if (!data || !data.expiresAt) return null;
  const exp = Date.parse(data.expiresAt);
  if (Number.isNaN(exp)) return null;
  const linked = Date.parse(data.linkedAt);
  if (!Number.isNaN(linked) && Math.abs(exp - linked - LEGACY_NOMINAL_TTL_MS) < 2000) return null;
  return exp;
}

module.exports = { sessionExpiry, LEGACY_NOMINAL_TTL_MS };
