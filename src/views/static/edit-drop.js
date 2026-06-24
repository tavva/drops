// ABOUTME: Edit-drop page behaviour: the delete-confirmation modal and the domain-access
// ABOUTME: checkbox auto-submit. External so the strict app-host CSP (script-src 'self') allows it.
(() => {
  const delForm = document.getElementById('delete-form');
  const dropName = delForm ? delForm.dataset.dropName : undefined;
  const bg = document.getElementById('delete-modal');
  const openBtn = document.getElementById('delete-btn');
  const cancelBtn = document.getElementById('delete-cancel');
  const confirmInput = document.getElementById('delete-confirm');
  const submitBtn = document.getElementById('delete-submit');
  if (bg && openBtn && cancelBtn && confirmInput && submitBtn) {
    openBtn.addEventListener('click', () => { bg.hidden = false; confirmInput.focus(); });
    cancelBtn.addEventListener('click', () => { bg.hidden = true; });
    bg.addEventListener('click', (e) => { if (e.target === bg) bg.hidden = true; });
    confirmInput.addEventListener('input', () => {
      submitBtn.disabled = confirmInput.value !== dropName;
    });
  }

  const entrySel = document.getElementById('entry-select');
  const entryPrev = document.getElementById('entry-preview');
  if (entrySel && entryPrev) {
    const sync = () => {
      const opt = entrySel.options[entrySel.selectedIndex];
      const url = opt && opt.dataset.preview;
      if (url) { entryPrev.href = url; entryPrev.hidden = false; }
      else { entryPrev.hidden = true; }
    };
    entrySel.addEventListener('change', sync);
    sync();
  }

  const toggle = document.querySelector('.domain-access input[name="include"]');
  if (toggle && toggle.form) {
    // With JS the toggle applies on change, so the no-JS Save fallback is redundant.
    const save = toggle.form.querySelector('button[type="submit"]');
    if (save) save.hidden = true;
    toggle.addEventListener('change', () => {
      const f = toggle.form;
      if (f.requestSubmit) f.requestSubmit(); else f.submit();
    });
  }
})();
