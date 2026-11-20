// ABOUTME: Dashboard behaviour: auto-submit the "mine only" filter and sort order, and confirm folder deletes.
// ABOUTME: External so the strict app-host CSP (script-src 'self') allows it; replaces inline on* handlers.
(() => {
  document.querySelectorAll('[data-autosubmit]').forEach((control) => {
    if (control.form) control.addEventListener('change', () => control.form.submit());
  });

  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
  });
})();
