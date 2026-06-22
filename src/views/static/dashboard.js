// ABOUTME: Dashboard behaviour: auto-submit the "mine only" filter and confirm folder deletes.
// ABOUTME: External so the strict app-host CSP (script-src 'self') allows it; replaces inline on* handlers.
(() => {
  const mine = document.querySelector('input[name="mine"][data-autosubmit]');
  if (mine && mine.form) mine.addEventListener('change', () => mine.form.submit());

  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
  });
})();
