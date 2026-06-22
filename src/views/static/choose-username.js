// ABOUTME: Live-sanitises the username field on the choose-username page to the allowed charset.
// ABOUTME: External so the strict app-host CSP (script-src 'self') allows it.
(() => {
  const input = document.getElementById('uname-input');
  if (!input) return;
  input.addEventListener('input', () => {
    const cleaned = input.value.toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 32);
    if (cleaned !== input.value) input.value = cleaned;
  });
})();
