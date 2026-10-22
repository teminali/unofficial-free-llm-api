'use strict';
/**
 * Which DeepSeek account is linked, in words a person can tell apart (they can have two): a masked email or phone, such as "m***@gmail.com" or "+255 ***678".
 * Asked of DeepSeek once, the first time the Accounts page needs it, and kept in the session file; the unmasked address is never stored, shown or logged.
 * Best effort: when DeepSeek answers in a shape this does not know, there is no label and nothing else changes.
 */
const { DEFAULT_BASE } = require('./base');

function maskEmail(email) {
  const m = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/.exec(String(email || '').trim());
  return m ? `${m[1][0]}***@${m[2]}` : '';
}

function maskPhone(area, number) {
  const digits = String(number || '').replace(/\D/g, '');
  if (digits.length < 4) return '';
  const code = String(area || '').replace(/[^\d+]/g, '');
  return `${code ? `${code.startsWith('+') ? code : `+${code}`} ` : ''}***${digits.slice(-3)}`;
}

/** The label from DeepSeek's profile answer ({ data: { biz_data: { email, mobile_number, area_code } } }), or ''. */
function labelFromProfile(body) {
  const biz = body && body.data && body.data.biz_data;
  const profile = biz && (biz.user || biz.profile || biz);
  if (!profile || typeof profile !== 'object') return '';
  return maskEmail(profile.email) || maskPhone(profile.area_code, profile.mobile_number || profile.mobile || profile.phone) || '';
}

/** One read of the profile with the saved login. Resolves the label or ''. */
async function fetchAccountLabel({ token, cookies = [], userAgent, base = DEFAULT_BASE, timeoutMs = 8000 }) {
  const BASE = base;
  if (!token) return '';
  let signal;
  try { signal = AbortSignal.timeout(timeoutMs); } catch (_) { signal = undefined; }
  const cookie = (Array.isArray(cookies) ? cookies : []).map((c) => `${c.name}=${c.value}`).join('; ');
  try {
    const res = await fetch(`${BASE}/api/v0/users/current`, {
      headers: { authorization: `Bearer ${token}`, 'user-agent': userAgent || 'Mozilla/5.0', origin: BASE, referer: `${BASE}/`, ...(cookie ? { cookie } : {}) },
      signal,
      redirect: 'error'
    });
    if (!res.ok) return '';
    return labelFromProfile(await res.json());
  } catch (_) { return ''; }
}

/**
 * Asks DeepSeek whether a login still works, with the same profile call: { valid: true | false | null, label }. `null` means the question could not be
 * answered (no network, a shape this does not know), which is neither a yes nor a no.
 */
async function checkLogin({ token, cookies = [], userAgent, base = DEFAULT_BASE, timeoutMs = 8000 }) {
  if (!token) return { valid: false, label: '' };
  let signal;
  try { signal = AbortSignal.timeout(timeoutMs); } catch (_) { signal = undefined; }
  const cookie = (Array.isArray(cookies) ? cookies : []).map((c) => `${c.name}=${c.value}`).join('; ');
  try {
    const res = await fetch(`${base}/api/v0/users/current`, {
      headers: { authorization: `Bearer ${token}`, 'user-agent': userAgent || 'Mozilla/5.0', origin: base, referer: `${base}/`, ...(cookie ? { cookie } : {}) },
      signal,
      redirect: 'error'
    });
    if (res.status === 401) return { valid: false, label: '' };
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (body && (body.code === 40001 || body.code === 40003)) return { valid: false, label: '' };
    if (res.ok && body && (body.code === 0 || body.code === undefined)) return { valid: true, label: labelFromProfile(body) };
    return { valid: null, label: '' };
  } catch (_) { return { valid: null, label: '' }; }
}

module.exports = { maskEmail, maskPhone, labelFromProfile, fetchAccountLabel, checkLogin };
