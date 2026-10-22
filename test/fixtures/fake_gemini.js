/**
 * A local page shaped like gemini.google.com, for driving with a real Chrome in tests: a mode picker menu (gem-menu rows, locked rows with a lock icon,
 * a "Thinking level" submenu), a rich-textarea composer, a user-query node for the message that was sent, and a model-response that shows thinking dots,
 * then thinking text, then the answer growing inside message-content > div.markdown-main-panel.
 *
 * Like the real page, an answer that is not a fenced code block goes through "markdown" that drops anything that looks like a tag and the backslash in
 * front of punctuation, so a bare tool call comes back damaged; a fenced block shows its text as written.
 *
 * Conversations are kept like the real page keeps them: after the first answer the page's address becomes /app/<id>, the turns are stored (POST /turn), and
 * opening /app/<id> shows the earlier turns above an empty composer; an unknown id is sent back to /app, as the real page does. `state.convs` is id -> [{ prompt, answer }].
 *
 * Control: POST /control { signedOut, plan: 'free' | 'pro', blocked, sorry, stall, pickerDelayMs, errorAnswer, chip, chipTag } ; GET /state -> { sent: [{ mode, level, prompt, conv }], ... }.
 */
'use strict';

const http = require('http');

function pageScript(cfg) {
  const chat = document.getElementById('chat');
  const composer = document.getElementById('composer');
  const conv = location.pathname.split('/')[2] || ('c' + Math.random().toString(36).slice(2, 12));
  for (const turn of cfg.history) {
    const q = document.createElement('user-query');
    q.textContent = turn.prompt;
    chat.appendChild(q);
    const r = document.createElement('model-response');
    const c = document.createElement('message-content');
    const a = document.createElement('div');
    a.className = 'markdown markdown-main-panel';
    a.textContent = turn.answer;
    c.appendChild(a);
    r.appendChild(c);
    chat.appendChild(r);
  }
  const menu = document.getElementById('menu');
  const modeButton = document.getElementById('mode');
  let mode = localStorage.getItem('mode') || cfg.current;
  let level = localStorage.getItem('level') || 'Low';
  const FENCE = '`'.repeat(3);
  modeButton.textContent = mode;
  modeButton.setAttribute('aria-label', 'Open mode picker, currently ' + mode);
  const levelRows = [...menu.querySelectorAll('gem-menu-item gem-menu gem-menu-item')];
  const paintLevels = () => { for (const r of levelRows) r.setAttribute('aria-checked', String(r.querySelector('div > div').textContent.trim() === level)); };
  paintLevels();
  for (const r of levelRows) {
    r.addEventListener('click', () => { level = r.querySelector('div > div').textContent.trim(); localStorage.setItem('level', level); paintLevels(); menu.hidden = true; });
  }
  modeButton.addEventListener('click', () => { menu.hidden = !menu.hidden; });
  for (const item of menu.querySelectorAll(':scope > gem-menu-item')) {
    if (item.getAttribute('aria-haspopup')) continue;
    item.addEventListener('click', () => {
      if (item.querySelector('mat-icon')) return; // a locked row does nothing, like the page's
      mode = item.querySelector('div > div').textContent.trim();
      localStorage.setItem('mode', mode);
      modeButton.textContent = mode;
      modeButton.setAttribute('aria-label', 'Open mode picker, currently ' + mode);
      menu.hidden = true;
    });
  }
  if (cfg.pickerDelayMs) {
    // like a signed-in page that draws its model picker a moment after the message box: absent from the page until then
    const anchor = document.querySelector('rich-textarea');
    modeButton.remove(); menu.remove();
    setTimeout(() => { anchor.parentNode.insertBefore(modeButton, anchor); anchor.parentNode.insertBefore(menu, anchor); }, cfg.pickerDelayMs);
  }
  function answerFor(prompt) {
    if (cfg.errorAnswer) return typeof cfg.errorAnswer === 'string' ? cfg.errorAnswer : 'Sorry, something went wrong. Please try your request again.'; // the page's own error, shown where an answer goes
    if (/# Tool bridge/.test(prompt)) {
      if (/^TOOL RESULT \(/m.test(prompt)) return 'It is sunny. TOOL_DONE';
      const tool = prompt.split('\n### ').slice(1).map((b) => b.split('\n')).find((lines) => lines[0]);
      if (tool) {
        const wantsSnippet = /send the snippet/i.test(prompt);
        const args = wantsSnippet ? { text: cfg.snippet } : { city: 'Dar es Salaam' };
        const call = JSON.stringify({ name: tool[0], arguments: args });
        return FENCE + 'json\n' + call + '\n' + FENCE;
      }
    }
    if (/3 \+ 4/.test(prompt)) return '7';
    if (/long answer/i.test(prompt)) return 'word '.repeat(60).trim();
    return 'The page answers: ' + prompt.slice(0, 60);
  }
  function render(target, acc) {
    target.textContent = '';
    if (acc.startsWith(FENCE)) {
      const cb = document.createElement('code-block');
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = acc.replace(new RegExp('^' + FENCE + '(?:json)?\\n?'), '').replace(new RegExp('\\n?' + FENCE + '$'), '');
      pre.appendChild(code);
      cb.appendChild(pre);
      target.appendChild(cb);
      return;
    }
    target.textContent = acc.replace(/<[^>]*>/g, '').replace(/\\([!-/:-@[-`{-~])/g, '$1');
  }
  composer.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const prompt = composer.innerText;
    composer.innerText = '';
    fetch('/sent', { method: 'POST', body: JSON.stringify({ mode, level, prompt: prompt.slice(0, 400), conv }) }).catch(() => {});
    history.replaceState(null, '', '/app/' + conv);
    const asked = document.createElement('user-query');
    asked.textContent = prompt;
    chat.appendChild(asked);
    const response = document.createElement('model-response');
    const dots = document.createElement('div');
    dots.className = 'thinking-dots-animation';
    const thought = document.createElement('div');
    thought.className = 'thought-summary';
    const content = document.createElement('message-content');
    const answer = document.createElement('div');
    answer.className = 'markdown markdown-main-panel';
    content.appendChild(answer);
    response.appendChild(dots);
    response.appendChild(thought);
    response.appendChild(content);
    chat.appendChild(response);
    if (cfg.stall) { dots.style.cssText = 'display:block;width:24px;height:8px'; return; } // the working dots stay and no word ever comes (a page waiting on something the program cannot see)
    const thoughts = ['Reading the request.', 'Choosing the shape of the answer.'];
    const text = answerFor(prompt);
    const pieces = [];
    for (let i = 0; i < text.length; i += 24) pieces.push(text.slice(i, i + 24));
    let said = '';
    let i = 0;
    let acc = '';
    const thinkTimer = setInterval(() => {
      if (i < thoughts.length) { said += (said ? ' ' : '') + thoughts[i++]; thought.textContent = said; return; }
      clearInterval(thinkTimer);
      // like the real page, the working indicator stays until the answer is finished
      let j = 0;
      const answerTimer = setInterval(() => {
        if (j < pieces.length) { acc += pieces[j++]; render(answer, acc); return; }
        clearInterval(answerTimer);
        if (cfg.chip) { // a quick-reply the page draws inside the answer after a question: a control, not words of the model
          const chip = document.createElement(cfg.chipTag === 'div' ? 'div' : 'button');
          chip.className = 'suggestion-chip';
          if (cfg.chipTag === 'div') chip.setAttribute('role', 'button');
          chip.textContent = cfg.chip;
          answer.appendChild(chip);
        }
        dots.remove();
        fetch('/turn', { method: 'POST', body: JSON.stringify({ conv, prompt: prompt.slice(0, 400), answer: acc }) }).catch(() => {});
      }, 120);
    }, 120);
  });
}

function html(state, history = []) {
  const free = state.plan === 'free';
  const rows = free
    ? [['Auto', 'Gemini 3 models', false], ['3.1 Pro', 'Advanced reasoning', true], ['4 Argon', 'Complex tasks', true]]
    : [['3.5 Flash-Lite', 'Fastest answers', false], ['3.8 Flash', 'All-around help', false], ['3.1 Pro', 'Advanced reasoning', false], ['4 Argon', 'Complex tasks', false]];
  const current = free ? 'Gemini Auto' : 'Argon';
  const row = (r) => `<gem-menu-item role="menuitem">${r[2] ? '<mat-icon fonticon="lock"></mat-icon>' : ''}<div><div>${r[0]}</div><div>${r[1]}</div></div></gem-menu-item>`;
  const levels = [['Low', 'Quick and efficient'], ['Medium', 'Balanced depth'], ['High', 'Extra thorough']]
    .map((r) => `<gem-menu-item role="menuitem"><div><div>${r[0]}</div><div>${r[1]}</div></div></gem-menu-item>`).join('');
  const cfg = { chip: state.chip || false, chipTag: state.chipTag || 'button', errorAnswer: state.errorAnswer || false, stall: Boolean(state.stall), pickerDelayMs: Number(state.pickerDelayMs) || 0, current, history, snippet: '<h1 class="title">Hello & "welcome"</h1>\n<p>line two \\ backslash</p>' };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gemini</title></head>
<body>
<nav><button aria-label="New chat">New chat</button>${state.signedOut ? '<button aria-label="Sign in">Sign in</button>' : ''}</nav>
${state.blocked ? '<div role="dialog"><p>Our systems have detected unusual traffic from your computer network. Please verify you are not a robot.</p></div>' : ''}
<div id="chat"></div>
<button aria-label="Open mode picker, currently ${current}" id="mode">${current}</button>
<gem-menu role="menu" id="menu" hidden>
  ${rows.map(row).join('\n  ')}
  <gem-menu-item role="menuitem" aria-haspopup="menu"><div>Thinking level</div><gem-menu role="menu">${levels}</gem-menu></gem-menu-item>
</gem-menu>
<rich-textarea><div class="ql-editor" contenteditable="true" id="composer"></div></rich-textarea>
<script>(${pageScript.toString()})(${JSON.stringify(cfg)});</script>
</body></html>`;
}

function startFakeGemini() {
  const state = { signedOut: false, plan: 'pro', blocked: false, sorry: false, sent: [], visits: 0, convs: new Map(), conversationAddresses: [] };
  const server = http.createServer((req, res) => {
    const body = (done) => { let text = ''; req.on('data', (c) => { text += c; }); req.on('end', () => { let json = {}; try { json = JSON.parse(text || '{}'); } catch (_) { /* keep what was there */ } done(json); }); };
    const reply = (code, type, text) => { res.writeHead(code, { 'content-type': type }); res.end(text); };
    if (req.method === 'POST' && req.url === '/control') return body((json) => { Object.assign(state, json); reply(200, 'application/json', JSON.stringify(state)); });
    if (req.method === 'POST' && req.url === '/sent') return body((json) => { state.sent.push(json); reply(200, 'application/json', '{}'); });
    if (req.method === 'POST' && req.url === '/turn') return body((json) => { const list = state.convs.get(json.conv) || []; list.push({ prompt: json.prompt, answer: json.answer }); state.convs.set(json.conv, list); reply(200, 'application/json', '{}'); });
    if (req.method === 'GET' && req.url === '/state') return reply(200, 'application/json', JSON.stringify({ ...state, convs: Object.fromEntries(state.convs) }));
    if (req.url.startsWith('/sorry/')) return reply(200, 'text/html; charset=utf-8', '<!doctype html><title>Sorry</title><body><h1>About this page</h1><p>Our systems have detected unusual traffic from your computer network.</p></body>');
    if (state.sorry && req.url.startsWith('/app')) { res.writeHead(302, { location: `/sorry/index?continue=${encodeURIComponent(req.url)}` }); return res.end(); }
    if (req.url.startsWith('/app')) state.visits += 1;
    const address = /^\/app\/([^/?#]+)/.exec(req.url);
    if (address) {
      state.conversationAddresses.push(address[1]);
      if (!state.convs.has(address[1])) { res.writeHead(302, { location: '/app' }); return res.end(); }
      return reply(200, 'text/html; charset=utf-8', html(state, state.convs.get(address[1])));
    }
    return reply(200, 'text/html; charset=utf-8', html(state));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server, state, port,
        url: `http://127.0.0.1:${port}/app`,
        control: (patch) => { Object.assign(state, patch); },
        close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => r()); })
      });
    });
  });
}

module.exports = { startFakeGemini };
