'use strict';

/**
 * Static checks on the public site in site/ (GitHub Pages). No network, no browser, no dependency.
 * The site keeps the product's promise: nothing leaves your computer, so it loads nothing from another host, and it says "unofficial" before it shows a command.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const REPO = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
const NPM = `https://www.npmjs.com/package/${pkg.name}`;
const COMMAND = `npx ${pkg.name}@latest`;
const PAGES = ['index.html', '404.html'];

const read = (rel) => fs.readFileSync(path.join(SITE, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(SITE, rel));

/** Every file under site/ as a relative path. */
function walk(dir = SITE, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.posix.join(base, e.name);
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}
const isText = (f) => /\.(html|css|js|svg|txt|json|xml)$/i.test(f);
const body = (html) => html.slice(html.search(/<body[\s>]/i));
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const isAllowedExternal = (u) => u === REPO || u === NPM || [REPO, NPM].some((p) => u.startsWith(p + '/') || u.startsWith(p + '?') || u.startsWith(p + '#'));

/** href / src values of a page, as written. */
function refs(html) {
  const out = [];
  for (const m of html.matchAll(/\b(href|src)\s*=\s*"([^"]*)"/gi)) out.push({ attr: m[1].toLowerCase(), value: m[2] });
  return out;
}

describe('site/ files', () => {
  test('the pages, styles, script, favicon and the four screenshots exist', () => {
    for (const f of ['index.html', '404.html', 'styles.css', 'app.js', 'favicon.svg', 'assets/accounts.png', 'assets/api.png', 'assets/playground-light.png', 'assets/playground-dark.png']) {
      assert.ok(exists(f), `site/${f} is missing`);
    }
  });

  test('site/ without assets is under 120 KB', () => {
    const bytes = walk().filter((f) => !f.startsWith('assets/')).reduce((n, f) => n + fs.statSync(path.join(SITE, f)).size, 0);
    assert.ok(bytes < 120 * 1024, `${bytes} bytes`);
  });
});

describe('install command', () => {
  test('the copyable command is exactly `npx <package name>@latest`', () => {
    const html = read('index.html');
    const m = html.match(/<code[^>]*\bid="cmd"[^>]*>([^<]*)<\/code>/);
    assert.ok(m, 'no <code id="cmd"> holding the command');
    assert.equal(m[1].trim(), COMMAND);
    assert.match(html, /data-copy="cmd"/, 'the copy button must point at the command');
  });

  test('every `npx` on the page names this package at @latest', () => {
    const found = [...body(read('index.html')).matchAll(/\bnpx\s+([^\s<]+)/g)].map((m) => m[1]);
    assert.ok(found.length >= 1);
    for (const f of found) assert.equal(f, `${pkg.name}@latest`);
  });
});

describe('notice before command', () => {
  test('the unofficial / risk notice comes before the first command in the document', () => {
    const html = body(read('index.html'));
    const noticeAt = html.search(/\bid="notice"/);
    const cmdAt = html.search(/\bnpx\s/);
    assert.ok(noticeAt >= 0, 'no element with id="notice"');
    assert.ok(cmdAt >= 0, 'no command');
    assert.ok(noticeAt < cmdAt, 'the notice must precede the command');
  });

  test('the notice says what matters and links the DISCLAIMER', () => {
    const html = read('index.html');
    const m = html.match(/<(aside|section|div)[^>]*\bid="notice"[^>]*>([\s\S]*?)<\/\1>/);
    assert.ok(m, 'notice element not found');
    const t = textOf(m[2]);
    assert.match(t, /unofficial/i);
    assert.match(t, /not (made or )?endorsed/i);
    assert.match(t, /DeepSeek/);
    assert.match(t, /Qoder/);
    assert.match(t, /break/i);
    assert.match(t, /account/i);
    assert.match(t, /risk/i);
    assert.ok(m[2].includes(`href="${REPO}/blob/HEAD/DISCLAIMER.md"`), 'the notice must link DISCLAIMER.md');
  });

  test('the DISCLAIMER link is on the page', () => {
    assert.ok(read('index.html').includes(`${REPO}/blob/HEAD/DISCLAIMER.md`));
  });

  test('the footer carries the licence, repo, npm, DONATE, SECURITY and the not-affiliated line', () => {
    const html = read('index.html');
    const footer = html.slice(html.indexOf('<footer'));
    for (const u of [`${REPO}/blob/HEAD/LICENSE`, REPO, NPM, `${REPO}/blob/HEAD/DONATE.md`, `${REPO}/blob/HEAD/SECURITY.md`, `${REPO}/blob/HEAD/DISCLAIMER.md`]) {
      assert.ok(footer.includes(`href="${u}"`), `footer lacks ${u}`);
    }
    assert.match(textOf(footer), /MIT/);
    assert.match(textOf(footer), /Not affiliated with DeepSeek or Qoder/);
  });
});

describe('links and hosts', () => {
  for (const page of PAGES) {
    test(`${page}: every relative link and src resolves to a file, with no leading slash`, () => {
      const html = read(page);
      const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
      for (const { attr, value } of refs(html)) {
        if (/^https?:\/\//i.test(value)) continue; // checked by the hosts test
        assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(value), `${attr}="${value}": only relative links and https to the allowed addresses`);
        assert.ok(!value.startsWith('//'), `${attr}="${value}": protocol-relative`);
        assert.ok(!value.startsWith('/'), `${attr}="${value}": a leading slash breaks under /<repo>/`);
        if (value.startsWith('#')) {
          assert.ok(ids.has(value.slice(1)), `${attr}="${value}": no element with that id`);
          continue;
        }
        const rel = value.split(/[?#]/)[0] || '.';
        const target = path.join(SITE, rel);
        assert.ok(target.startsWith(SITE), `${value} leaves site/`);
        assert.ok(fs.existsSync(target), `${attr}="${value}" does not exist in site/`);
        if (fs.statSync(target).isDirectory()) assert.ok(fs.existsSync(path.join(target, 'index.html')), `${value} is a folder without index.html`);
      }
    });

    test(`${page}: external links go only to this repo or this package on npm`, () => {
      for (const { attr, value } of refs(read(page))) {
        if (!/^https?:\/\//i.test(value)) continue;
        assert.ok(isAllowedExternal(value), `${attr}="${value}" is not allowed`);
        assert.ok(value.startsWith('https://'), `${value} is not https`);
      }
    });

    test(`${page}: no script or stylesheet comes from another host`, () => {
      const html = read(page);
      for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
        const src = (m[0].match(/\bsrc\s*=\s*"([^"]*)"/i) || [])[1];
        assert.ok(src, `an inline <script> in ${page}`);
        assert.ok(!/^([a-z]+:)?\/\//i.test(src), `script from ${src}`);
      }
      for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
        const href = (m[0].match(/\bhref\s*=\s*"([^"]*)"/i) || [])[1];
        assert.ok(href && !/^([a-z]+:)?\/\//i.test(href), `link to ${href}`);
      }
      assert.ok(!/<style[\s>]/i.test(html), 'inline <style>');
      assert.ok(!/\sstyle\s*=/i.test(html), 'inline style attribute');
    });
  }

  test('the only absolute addresses anywhere in site/ are this repo, this npm page and the localhost address shown as text', () => {
    const files = walk().filter(isText);
    assert.ok(files.length >= 5);
    for (const f of files) {
      // an SVG namespace is a name, not a request
      const txt = read(f).replace(/xmlns(:\w+)?\s*=\s*"[^"]*"/g, '');
      for (const m of txt.matchAll(/(?:https?:)?\/\/[a-z0-9][a-z0-9.-]*(?::\d+)?(?:\/[^\s"'<>)`]*)?/gi)) {
        const u = m[0];
        const ok = isAllowedExternal(u) || /^http:\/\/localhost:8420(\/|$)/.test(u);
        assert.ok(ok, `${f}: ${u}`);
      }
    }
  });

  test('the localhost address is only ever text, never a link, source or style url', () => {
    for (const page of PAGES) for (const { value } of refs(read(page))) assert.ok(!/localhost/i.test(value), value);
    assert.ok(!/localhost/i.test(read('styles.css')));
    assert.ok(!/localhost/i.test(read('app.js')));
  });

  test('a Content-Security-Policy meta allows only this site itself', () => {
    for (const page of PAGES) {
      const m = read(page).match(/<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/i);
      assert.ok(m, `${page}: no CSP meta`);
      assert.match(m[1], /default-src 'none'/);
      assert.ok(!/https?:|\*|unsafe-/.test(m[1]), m[1]);
    }
  });

  test('app.js makes no request and builds no markup from strings', () => {
    const js = read('app.js');
    for (const bad of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'import(', 'eval(', 'innerHTML', 'document.write', 'document.cookie']) {
      assert.ok(!js.includes(bad), `app.js uses ${bad}`);
    }
  });

  test('localStorage is only touched inside try/catch', () => {
    const js = read('app.js');
    const uses = [...js.matchAll(/localStorage/g)].length;
    assert.ok(uses >= 2, 'the theme choice should be remembered');
    const tries = [...js.matchAll(/\btry\s*\{[\s\S]*?\}\s*catch/g)];
    for (const m of js.matchAll(/localStorage/g)) {
      assert.ok(tries.some((t) => m.index > t.index && m.index < t.index + t[0].length), `localStorage at ${m.index} is outside try/catch`);
    }
  });
});

describe('document basics', () => {
  for (const page of PAGES) {
    test(`${page}: lang, title, description, viewport, one h1`, () => {
      const html = read(page);
      assert.match(html, /^<!doctype html>/i);
      assert.match(html, /<html[^>]*\slang="[a-z]{2}/i);
      assert.match(html, /<meta[^>]*charset="utf-8"/i);
      assert.match(html, /<title>[^<]{3,}<\/title>/i);
      assert.match(html, /<meta[^>]*name="description"[^>]*content="[^"]{20,}"/i);
      assert.match(html, /<meta[^>]*name="viewport"[^>]*content="[^"]*width=device-width/i);
      assert.equal((html.match(/<h1[\s>]/gi) || []).length, 1, 'exactly one h1');
    });

    test(`${page}: every image has alt`, () => {
      for (const m of read(page).matchAll(/<img\b[^>]*>/gi)) assert.match(m[0], /\salt="[^"]*"/, m[0].slice(0, 80));
    });
  }

  test('index.html: screenshots carry a description and their size, so the page does not jump while loading', () => {
    for (const m of read('index.html').matchAll(/<img\b[^>]*assets\/[^>]*>/gi)) {
      assert.match(m[0], /\salt="[^"]{12,}"/, 'a screenshot needs a real alt text');
      assert.match(m[0], /\swidth="\d+"/);
      assert.match(m[0], /\sheight="\d+"/);
    }
  });

  test('the light and the dark playground screenshot swap with the theme (the selector must out-rank `.shot img`)', () => {
    const html = read('index.html');
    assert.match(html, /<img class="shot-light"[^>]*playground-light\.png/);
    assert.match(html, /<img class="shot-dark"[^>]*playground-dark\.png/);
    const css = read('styles.css');
    assert.match(css, /\.shot \.shot-light\s*\{\s*display:\s*var\(--show-light\)/);
    assert.match(css, /\.shot \.shot-dark\s*\{\s*display:\s*var\(--show-dark\)/);
    const t = tokens(block(css.replace(/\/\*[\s\S]*?\*\//g, ''), ':root {'));
    assert.deepEqual([t['show-light'], t['show-dark']], ['block', 'none']);
  });

  test('index.html: Open Graph and Twitter tags carry text only (no image, no address)', () => {
    const html = read('index.html');
    for (const k of ['og:title', 'og:description', 'og:type', 'twitter:card', 'twitter:title', 'twitter:description']) {
      assert.match(html, new RegExp(`<meta[^>]*(property|name)="${k}"[^>]*content="[^"]+"`), k);
    }
    assert.ok(!/og:image|twitter:image|og:url/.test(html), 'an image or url tag needs an absolute address, which this site does not carry');
  });

  test('index.html: the FAQ is <details> (works with JavaScript off) and every control button is hidden until JavaScript runs', () => {
    const html = read('index.html');
    assert.ok((html.match(/<details[\s>]/g) || []).length >= 6, 'six FAQ questions');
    assert.ok((html.match(/<summary[\s>]/g) || []).length >= 6);
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length >= 4, 'copy and theme buttons');
    for (const b of buttons) assert.match(b, /class="[^"]*\bjs-only\b/, `a button that does nothing without JavaScript must be js-only: ${b}`);
    const css = read('styles.css');
    assert.match(css, /\.js-only\s*\{[^}]*display:\s*none/);
    assert.match(read('app.js'), /classList\.add\('js'\)/);
  });

  test('index.html: the content sections are all there, in order', () => {
    const html = read('index.html');
    const ids = ['notice', 'how', 'features', 'privacy', 'use', 'faq'];
    let at = -1;
    for (const id of ids) {
      const i = html.search(new RegExp(`\\bid="${id}"`));
      assert.ok(i > at, `section #${id} missing or out of order`);
      at = i;
    }
    assert.ok(html.indexOf('<footer') > at);
  });

  test('index.html: says Alpha, and that one chat per conversation is new and still being checked against real accounts', () => {
    const t = textOf(read('index.html'));
    assert.match(t, /Alpha/);
    assert.match(t, /one chat per conversation/i);
    assert.match(t, /new/i);
    assert.match(t, /real accounts?/i);
  });

  test('index.html: shows the base URL and the doctor and selftest commands', () => {
    const t = textOf(read('index.html'));
    assert.ok(t.includes('http://localhost:8420/v1'));
    assert.match(t, /doctor/);
    assert.match(t, /selftest/);
  });

  test('404.html is short and links home and to the repo', () => {
    const html = read('404.html');
    assert.ok(html.length < 3000, 'a 404 page should be short');
    assert.match(html, /href="\.\/"/);
    assert.ok(html.includes(`href="${REPO}"`));
  });

  test('provider names appear only in sentences: not in the title, the h1, the styles, the script or the favicon', () => {
    const re = /deepseek|qoder|google|gemini|qwen/i;
    for (const page of PAGES) {
      const html = read(page);
      assert.ok(!re.test(html.match(/<title>([^<]*)<\/title>/)[1]), `${page} title`);
      assert.ok(!re.test(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1]), `${page} h1`);
    }
    for (const f of ['styles.css', 'app.js', 'favicon.svg']) assert.ok(!re.test(read(f)), f);
  });

  test('words a page like this must never use appear nowhere in site/', () => {
    const banned = ['undetectable', 'undetected', 'bypass', 'unlimited', 'anonymous', 'evade', 'stealth', 'circumvent'];
    for (const f of walk().filter(isText)) {
      const txt = read(f).toLowerCase();
      for (const w of banned) assert.ok(!txt.includes(w), `"${w}" in ${f}`);
    }
  });
});

describe('pages workflow', () => {
  const wf = () => fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8');

  test('deploys site/ on a push to main that touches site/ or the workflow, or by hand, and on nothing else', () => {
    const y = wf();
    assert.match(y, /^on:\n {2}push:\n {4}branches: \[main\]\n {4}paths:\n {6}- 'site\/\*\*'\n {6}- '\.github\/workflows\/pages\.yml'\n {2}workflow_dispatch:/m);
    assert.ok(!/pull_request/.test(y), 'a pull request must not deploy');
  });

  test('asks for the three permissions Pages needs and no more, and uses the github-pages environment', () => {
    const y = wf();
    assert.match(y, /^permissions:\n {2}contents: read\n {2}pages: write\n {2}id-token: write\n/m);
    assert.match(y, /environment:\n {6}name: github-pages\n/);
  });

  test('uses the official actions at pinned majors and uploads site/', () => {
    const y = wf();
    assert.match(y, /uses: actions\/configure-pages@v5/);
    assert.match(y, /uses: actions\/upload-pages-artifact@v3\n\s+with:\n\s+path: site\n/);
    assert.match(y, /uses: actions\/deploy-pages@v4/);
    assert.match(y, /uses: actions\/checkout@v4/, 'without a checkout the workspace has no site/ to pack');
    for (const m of y.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /^actions\/[\w-]+@v\d+$/, `${m[1]} is not an official action at a pinned major`);
  });
});

/* ---------------------------------- contrast ---------------------------------- */

function block(css, opener) {
  const i = css.indexOf(opener);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  return css.slice(open + 1, css.indexOf('}', open));
}
function tokens(src) {
  const t = {};
  for (const m of src.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) t[m[1]] = m[2].trim();
  return t;
}
function rgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  assert.match(h, /^[0-9a-f]{6}$/i, `not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('styles.css', () => {
  const css = () => read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const light = () => tokens(block(css(), ':root {'));
  const darkMedia = () => {
    const c = css();
    const m = c.indexOf('@media (prefers-color-scheme: dark)');
    const o = c.indexOf(':root:not([data-theme="light"]) {');
    assert.ok(m >= 0 && o > m, 'the system-dark block must sit in a prefers-color-scheme: dark media query');
    return tokens(block(c, ':root:not([data-theme="light"]) {'));
  };
  const darkAttr = () => tokens(block(css(), ':root[data-theme="dark"] {'));

  // text pairs need 4.5:1 (body text); large text and the borders and rings of controls need 3:1
  const TEXT = [['text', 'bg'], ['text', 'surface'], ['text', 'surface-2'], ['text', 'surface-3'], ['accent-hover', 'bg'], ['accent-hover', 'surface'], ['text-2', 'bg'], ['text-2', 'surface'], ['accent-ink', 'bg'], ['accent-ink', 'surface'], ['accent-ink', 'accent-soft'],
    ['accent-fg', 'accent'], ['accent-fg', 'accent-hover'], ['warn', 'warn-soft'], ['text', 'warn-soft'], ['code-fg', 'code-bg'], ['code-dim', 'code-bg']];
  const UI = [['line-input', 'bg'], ['line-input', 'surface'], ['focus', 'bg'], ['focus', 'surface'], ['accent', 'bg'], ['warn', 'bg']];

  for (const [name, get] of [['light', light], ['dark (system)', darkMedia], ['dark (chosen)', darkAttr]]) {
    test(`${name} theme: text pairs reach 4.5:1`, () => {
      const t = get();
      for (const [fg, bg] of TEXT) {
        assert.ok(t[fg] && t[bg], `--${fg} or --${bg} is not defined in the ${name} theme`);
        const r = ratio(t[fg], t[bg]);
        assert.ok(r >= 4.5, `--${fg} on --${bg}: ${r.toFixed(2)}:1 (${t[fg]} on ${t[bg]})`);
      }
    });
    test(`${name} theme: large text, borders and focus rings reach 3:1`, () => {
      const t = get();
      for (const [fg, bg] of UI) {
        assert.ok(t[fg] && t[bg], `--${fg} or --${bg} is not defined in the ${name} theme`);
        const r = ratio(t[fg], t[bg]);
        assert.ok(r >= 3, `--${fg} on --${bg}: ${r.toFixed(2)}:1 (${t[fg]} on ${t[bg]})`);
      }
    });
  }

  test('the two dark blocks are the same, and the dark theme defines every token the light one does', () => {
    assert.deepEqual(darkMedia(), darkAttr());
    const missing = Object.keys(light()).filter((k) => /^(bg|surface|line|text|accent|focus|warn|code|show)/.test(k) && !(k in darkAttr()));
    assert.deepEqual(missing, []);
  });

  test('every var(--token) in use is defined', () => {
    const defined = new Set(Object.keys(light()));
    const used = new Set([...css().matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]));
    for (const u of used) assert.ok(defined.has(u), `--${u} is used but not defined`);
  });

  test('keyboard focus is visible, tap targets are 44px, motion is optional, text is a system font stack', () => {
    const c = css();
    assert.match(c, /:focus-visible/);
    assert.match(c, /--tap:\s*44px/);
    assert.match(c, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(c, /--font:\s*system-ui/);
    assert.ok(!/@font-face|@import|url\(\s*["']?https?:/i.test(c));
  });
});
