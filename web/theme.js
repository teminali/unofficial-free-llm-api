/* Runs before the page paints, so a chosen light or dark theme does not flash the other one first. The page itself (app.js) owns the choice. */
(function () {
  try {
    var t = JSON.parse(localStorage.getItem('ula.theme'));
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* no storage: the system setting applies */ }
})();
