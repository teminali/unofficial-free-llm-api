'use strict';

/*
 * The whole script. The page is complete without it: this only adds copy buttons and a light / dark / system switch.
 * It makes no request of any kind. The one thing it remembers is the theme choice, in this browser's own storage.
 */
(function () {
  var root = document.documentElement;
  var KEY = 'ula-site-theme';
  var mode = 'system';

  root.classList.add('js');

  try {
    var saved = window.localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') mode = saved;
  } catch (e) { /* storage blocked: the system setting applies and the choice lasts until the page closes */ }

  function apply(next) {
    mode = next;
    if (next === 'light' || next === 'dark') root.setAttribute('data-theme', next);
    else root.removeAttribute('data-theme');
  }
  apply(mode);

  function remember(next) {
    try {
      if (next === 'system') window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, next);
    } catch (e) { /* not remembered: nothing else depends on it */ }
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  /** Copies a string. Tries the clipboard API, then the old selection route; resolves true when one of them worked. */
  function copyText(text, source) {
    function selectionRoute() {
      try {
        var range = document.createRange();
        range.selectNodeContents(source);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return document.execCommand('copy');
      } catch (e) { return false; }
    }
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return selectionRoute(); });
    }
    return Promise.resolve(selectionRoute());
  }

  ready(function () {
    var live = document.getElementById('live');
    var themeButtons = document.querySelectorAll('[data-theme-set]');

    function mark() {
      for (var i = 0; i < themeButtons.length; i++) {
        themeButtons[i].setAttribute('aria-pressed', themeButtons[i].getAttribute('data-theme-set') === mode ? 'true' : 'false');
      }
    }
    mark();
    for (var i = 0; i < themeButtons.length; i++) {
      themeButtons[i].addEventListener('click', function (ev) {
        var next = ev.currentTarget.getAttribute('data-theme-set');
        apply(next);
        remember(next);
        mark();
      });
    }

    var copyButtons = document.querySelectorAll('[data-copy]');
    for (var j = 0; j < copyButtons.length; j++) {
      copyButtons[j].addEventListener('click', function (ev) {
        var btn = ev.currentTarget;
        var source = document.getElementById(btn.getAttribute('data-copy'));
        var label = btn.querySelector('.copy-label');
        if (!source) return;
        var original = label ? label.getAttribute('data-label') || label.textContent : '';
        copyText(source.textContent.replace(/\s+$/, ''), source).then(function (ok) {
          if (label) label.textContent = ok ? 'Copied' : 'Press Ctrl+C';
          if (live) live.textContent = ok ? 'Copied to the clipboard.' : 'Could not copy. The text is selected: press Ctrl+C or Cmd+C.';
          window.setTimeout(function () {
            if (label) label.textContent = original;
            if (live) live.textContent = '';
          }, 2200);
        });
      });
    }
  });
})();
