/**
 * A loopback stand-in for Bike4Mind's own API, for tests: the model catalog (with a next page), the credit balance, the account, and the SSE completion stream.
 *
 *   const fake = await startFakeBike4Mind();
 *   fake.base                     // http://127.0.0.1:<port>, what a provider is given in test mode
 *   fake.state.script = () => ({ events: [{ type: 'content', text: 'hi', stopReason: 'end_turn' }] });
 *   fake.requests                 // { method, path, body, auth }
 *
 * A completion script may return { events } for a stream, or { status, json, headers } for a failure before the stream opens. The stand-in never checks that
 * the request key is real beyond matching the one it was made with.
 */
'use strict';

const http = require('http');

const KEY = 'b4m_live_test_key_1234567890';

const MODELS = [
  {
    id: 'claude-sonnet-test', name: 'Claude Sonnet Test', type: 'text', backend: 'anthropic',
    description: 'A thinking model that takes tools and pictures.', context_window: 200000, max_output_tokens: 8192,
    supports_streaming: true, supports_thinking: true, reasons_within_output_budget: false,
    reasoning_efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    supports_tools: true, supports_vision: true,
    credits_per_1m_tokens: { input: 3, output: 15, cached_input: 0.3 }
  },
  {
    id: 'gpt-plain-test', name: 'GPT Plain Test', type: 'text', backend: 'openai',
    description: 'A model without pictures or thinking.', context_window: 128000, max_output_tokens: 4096,
    supports_streaming: true, supports_thinking: false, reasons_within_output_budget: false,
    reasoning_efforts: [], supports_tools: true, supports_vision: false,
    credits_per_1m_tokens: { input: 1, output: 4, cached_input: 0.5 }
  },
  {
    id: 'text-only-test', name: 'Text Only Test', type: 'text', backend: 'gemini',
    description: 'A model that cannot call tools.', context_window: 32000, max_output_tokens: 2048,
    supports_streaming: true, supports_thinking: false, reasons_within_output_budget: false,
    reasoning_efforts: [], supports_tools: false, supports_vision: false,
    credits_per_1m_tokens: null
  },
  {
    id: 'image-maker-test', name: 'Image Maker Test', type: 'image', backend: 'openai',
    description: 'Not a chat model.', image: { sizes: ['1024x1024'] }
  }
];

const defaultScript = () => ({
  events: [
    { type: 'meta', requestId: 'req_test' },
    { type: 'content', text: 'Hello from Bike4Mind.', usage: { inputTokens: 3, outputTokens: 5 }, credits: { used: 1, usdCost: 0.0001 }, stopReason: 'end_turn' }
  ]
});

function startFakeBike4Mind({ key = KEY, balance = 5000, pages = null, meScope = 'ok' } = {}) {
  const state = {
    key,
    balance,
    pages: pages || [MODELS],
    me: { id: 'user_test', name: 'Ada Lovelace', tier: 'pro', subscription: null, credits: { balance, monthly_allowance: null }, entitlements: ['base'] },
    meScope,
    modelsForbidden: false,
    script: defaultScript,
    completions: []
  };
  const requests = [];

  const json = (res, status, data, headers = {}) => {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
    res.end(body);
  };
  const authOk = (req) => req.headers['x-api-key'] === state.key || req.headers.authorization === `Bearer ${state.key}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = null;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
    }
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

    if (url.pathname === '/api/v1/models') {
      if (!authOk(req)) return json(res, 401, { error: 'Missing or invalid credentials.', request_id: 'req_test' });
      if (state.modelsForbidden) return json(res, 403, { error: 'This key has no ai:chat scope.', request_id: 'req_test', required_scopes: ['ai:chat', 'ai:generate'] });
      const page = Number(url.searchParams.get('cursor') || 0) || 0;
      const data = state.pages[page] || [];
      const next = page + 1 < state.pages.length ? String(page + 1) : null;
      return json(res, 200, { data, next_cursor: next });
    }
    if (url.pathname === '/api/v1/credits') {
      if (!authOk(req)) return json(res, 401, { error: 'Missing or invalid credentials.', request_id: 'req_test' });
      return json(res, 200, { balance: state.balance });
    }
    if (url.pathname === '/api/v1/me') {
      if (!authOk(req)) return json(res, 401, { error: 'Missing or invalid credentials.', request_id: 'req_test' });
      if (state.meScope !== 'ok') return json(res, 403, { error: 'This key has no me:read scope.', request_id: 'req_test', required_scopes: ['me:read'] });
      return json(res, 200, state.me);
    }
    if (url.pathname === '/api/ai/v1/completions') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
      if (!authOk(req)) return json(res, 401, { error: 'Missing or invalid credentials.', request_id: 'req_test' });
      state.completions.push(body);
      let out;
      try { out = state.script(body, state); } catch (err) { return json(res, 500, { error: String(err && err.message || err) }); }
      if (out && out.status && out.status !== 200) return json(res, out.status, out.json || { error: 'refused' }, out.headers || {});
      if (out && out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-request-id': 'req_test' });
      for (const event of (out && out.events) || []) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return json(res, 404, { error: 'No API route matches this path', request_id: 'req_test' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        state,
        requests,
        get completions() { return state.completions; },
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

module.exports = { startFakeBike4Mind, KEY, MODELS };
