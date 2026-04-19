// ABOUTME: Client-side drag-drop + multipart POST for /app/drops/new and edit pages.
// ABOUTME: Walks the dropped entry tree via webkitGetAsEntry for folders; zips are sent as a single file.
(() => {
  const form = document.getElementById('new-drop-form');
  if (!form) return;
  const zone = document.getElementById('drop-zone');
  const filesInput = document.getElementById('drop-files');
  const folderInput = document.getElementById('drop-folder');
  const progressEl = document.getElementById('progress');
  const pctEl = document.getElementById('upload-pct');
  const fillEl = document.getElementById('upload-fill');
  const readyPillEl = document.getElementById('ready-pill');
  const errorEl = document.getElementById('error');
  const nameInput = document.getElementById('drop-name');
  const submitBtn = form.querySelector('button[type=submit]');
  const fixedName = form.dataset.fixedName || null;
  const csrf = form.dataset.csrf;
  let pending = null;

  function setErr(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }
  function setProgress(msg) { if (progressEl) progressEl.textContent = msg; }
  function setPct(pct) {
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (fillEl) fillEl.style.width = `${pct}%`;
  }
  function markReady(label) {
    setPct(0);
    if (readyPillEl) {
      readyPillEl.textContent = label;
      readyPillEl.hidden = false;
    }
    if (submitBtn) submitBtn.disabled = false;
  }

  async function walk(entry, prefix) {
    const out = [];
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ relativePath: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let children = [];
      while (true) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        children.push(...batch);
      }
      for (const c of children) out.push(...await walk(c, prefix + entry.name + '/'));
    }
    return out;
  }

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', () => { zone.classList.remove('is-over'); });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('is-over');
    setErr(''); setProgress('Collecting files…');
    const items = [...e.dataTransfer.items];
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length === 0) return setErr('Please drop files or a folder.');
    if (entries.length === 1 && entries[0].isFile) {
      const file = await new Promise((res, rej) => entries[0].file(res, rej));
      if (file.name.endsWith('.zip')) {
        pending = { kind: 'zip', file };
      } else {
        pending = { kind: 'folder', files: [{ relativePath: file.name, file }] };
      }
      markReady(`Ready: ${file.name}`);
      return;
    }
    let collected;
    if (entries.length === 1 && entries[0].isDirectory) {
      const reader = entries[0].createReader();
      const children = [];
      while (true) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        children.push(...batch);
      }
      collected = (await Promise.all(children.map((c) => walk(c, '')))).flat();
    } else {
      collected = (await Promise.all(entries.map((e) => walk(e, '')))).flat();
    }
    if (collected.length === 0) return setErr('No files found.');
    pending = { kind: 'folder', files: collected };
    markReady(`Ready: ${collected.length} files`);
  });

  function handlePickedFiles(input) {
    const files = [...input.files];
    if (files.length === 0) return;
    if (files.length === 1 && files[0].name.endsWith('.zip')) {
      pending = { kind: 'zip', file: files[0] };
    } else {
      const entries = files.map((f) => ({ raw: f.webkitRelativePath || f.name, file: f }));
      const firstSeg = entries[0]?.raw.split('/')[0] ?? '';
      const shareRoot = firstSeg && entries.every((e) => e.raw.split('/')[0] === firstSeg && e.raw.includes('/'));
      pending = {
        kind: 'folder',
        files: entries.map((e) => ({
          relativePath: shareRoot ? e.raw.split('/').slice(1).join('/') : e.raw,
          file: e.file,
        })),
      };
    }
    markReady(`Ready: ${files.length} file${files.length === 1 ? '' : 's'}`);
  }

  filesInput?.addEventListener('change', () => handlePickedFiles(filesInput));
  folderInput?.addEventListener('change', () => handlePickedFiles(folderInput));

  nameInput?.addEventListener('input', () => {
    const original = nameInput.value;
    const cleaned = original
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]+/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 32);
    if (cleaned !== original) {
      const pos = nameInput.selectionStart ?? cleaned.length;
      nameInput.value = cleaned;
      const newPos = Math.min(pos, cleaned.length);
      nameInput.setSelectionRange(newPos, newPos);
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    setErr('');
    if (!pending) return setErr('Please select files first.');
    const name = fixedName ?? nameInput.value.trim();
    if (!name) return setErr('Please enter a name.');

    const fd = new FormData();
    if (pending.kind === 'zip') {
      fd.append('file', pending.file, pending.file.name);
    } else {
      for (const { relativePath, file } of pending.files) {
        fd.append('files', file, relativePath);
      }
    }

    zone.classList.add('is-uploading');
    setProgress('Uploading…');
    setPct(0);
    if (submitBtn) submitBtn.disabled = true;

    const xhr = new XMLHttpRequest();
    const uploadType = pending.kind === 'zip' ? 'zip' : 'folder';
    xhr.open('POST', `/app/drops/${encodeURIComponent(name)}/upload?upload_type=${uploadType}`);
    xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const pct = Math.round((ev.loaded / ev.total) * 100);
        setProgress(`Uploading…`);
        setPct(pct);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 400) {
        window.location.href = xhr.responseURL || `/app/drops/${encodeURIComponent(name)}`;
      } else {
        zone.classList.remove('is-uploading');
        if (submitBtn) submitBtn.disabled = false;
        setErr(`Upload failed (${xhr.status}): ${xhr.responseText}`);
      }
    };
    xhr.onerror = () => {
      zone.classList.remove('is-uploading');
      if (submitBtn) submitBtn.disabled = false;
      setErr('Network error');
    };
    xhr.send(fd);
  });
})();
