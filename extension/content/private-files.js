// Runs in Chrome's isolated world. Original file bytes never reach the page.
let replaying = false;
let privateBrowserSwap = false;
const supported = /\.(?:pdf|docx|txt|md|csv|html)$/iu;
const image = /\.(?:png|jpe?g|webp|gif|heic|tiff?)$/iu;
const message = (payload) => chrome.runtime.sendMessage(payload);
void message({ type: 'swap-context' }).then((context) => { privateBrowserSwap = context?.private === true && context?.swap?.active === true; });
const privateThread = () => document.querySelector('#private-thread')?.getAttribute('aria-pressed') === 'true';
const notice = (text) => {
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.className = 'route-card';
  box.textContent = text;
  (document.querySelector('#messages') || document.body).append(box);
};
function offerLocalVision(file) {
  notice('Images stay on this computer in private mode — a local model can read them.');
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = 'Try local vision model';
  (document.querySelector('#messages') || document.body).append(button);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const result = await message({ type: 'swap-local-vision', dataUrl });
      notice(result?.text || result?.error || 'No local vision model is available on this machine. Nothing was uploaded.');
    } catch { notice('No local vision model is available on this machine. Nothing was uploaded.'); }
    finally { button.remove(); }
  }, { once: true });
}

async function extract(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (extension === 'pdf') {
    const pdfjs = await import(chrome.runtime.getURL('vendor/pdf.mjs'));
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.mjs');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    try {
      const pages = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const content = await (await pdf.getPage(number)).getTextContent();
        pages.push(content.items.map((item) => item.str || '').join(' '));
      }
      return pages.join('\n\n');
    } finally { await pdf.destroy(); }
  }
  if (extension === 'docx') {
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  return file.text();
}

async function prepare(files) {
  const safe = [];
  const perFileReplacements = [];
  let replacements = 0;
  let characters = 0;
  const counts = {};
  for (const file of files) {
    if (image.test(file.name) || file.type.startsWith('image/')) {
      offerLocalVision(file);
      continue;
    }
    if (!supported.test(file.name)) { notice('This file type cannot be scrubbed locally. Nothing was uploaded.'); continue; }
    try {
      const original = await extract(file);
      if (!original.trim()) throw new Error('No extractable text was found.');
      const result = await message({ type: 'swap-scrub-document', text: original });
      if (result?.error || !result?.text) throw new Error(result?.error || 'Privacy scrubbing is unavailable.');
      safe.push(new File([result.text], `document-${safe.length + 1}.scrubbed.txt`, { type: 'text/plain' }));
      perFileReplacements.push(result.replaced);
      replacements += result.replaced;
      characters += original.length;
      for (const [key, value] of Object.entries(result.counts)) counts[key] = (counts[key] || 0) + value;
    } catch (error) { notice(`Document could not be scrubbed: ${error.message} Nothing was uploaded.`); }
  }
  if (safe.length && (replacements >= 10 || characters > 4000)) {
    const summary = Object.entries(counts).map(([key, value]) => `${key} ×${value}`).join(', ');
    if (!window.confirm(`What got replaced: ${replacements} details (${summary}). Continue with scrubbed text upload?`)) return null;
  }
  return { files: safe, replacements, perFileReplacements };
}

document.addEventListener('change', (event) => {
  if (event.target?.id !== 'files' || replaying || !event.target.files?.length) return;
  event.stopImmediatePropagation();
  const input = event.target;
  const originals = [...input.files];
  input.value = '';
  void (async () => {
    const context = await message({ type: 'swap-context' });
    if (!(privateThread() || context?.private && context?.swap?.active)) {
      const transfer = new DataTransfer(); originals.forEach((file) => transfer.items.add(file));
      input.files = transfer.files; replaying = true;
      try { input.dispatchEvent(new Event('change', { bubbles: true })); } finally { replaying = false; }
      return;
    }
    if (!context?.localRosterReady) { notice('Private swapping is unavailable on this computer. Nothing was uploaded.'); return; }
    const result = await prepare(originals);
    if (!result?.files.length) return;
    const transfer = new DataTransfer(); result.files.forEach((file) => transfer.items.add(file));
    input.files = transfer.files;
    input.dataset.scrubbed = 'true';
    input.dataset.replaced = JSON.stringify(result.perFileReplacements);
    replaying = true;
    try { input.dispatchEvent(new Event('change', { bubbles: true })); }
    finally { replaying = false; input.dataset.scrubbed = ''; input.dataset.replaced = ''; }
  })().catch(() => notice('Private file handling failed. Nothing was uploaded.'));
}, true);

document.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.files?.length || !event.target?.closest?.('#composer')) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const input = document.querySelector('#files');
  if (!input) return;
  const transfer = new DataTransfer();
  for (const file of event.dataTransfer.files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, true);

// A copied or downloaded answer is rehydrated only at the user gesture. The
// page's message object, link href, and server transcript keep stand-ins.
document.addEventListener('click', (event) => {
  const target = event.target?.closest?.('button,a[download]');
  if (!target || !target.closest('#messages,#artifact-content') || replaying) return;
  const messageRow = target.closest('.message');
  const linkRow = target.closest('.answer-link');
  const isCopy = target.tagName === 'BUTTON' && target.textContent.trim() === 'Copy';
  const isDownload = target.matches('a[download]') || target.tagName === 'A'
    && /\.(?:pdf|docx|txt|md|csv|html)(?:[?#]|$)/iu.test(target.href);
  if (!isDownload && !(isCopy && (messageRow || linkRow))) return;
  if (!privateThread() && !privateBrowserSwap) return;
  event.preventDefault(); event.stopImmediatePropagation();
  void (async () => {
    const context = await message({ type: 'swap-context' });
    if (!context?.localRosterReady) { notice('Local restoration is unavailable on this computer.'); return; }
    if (isCopy) {
      const raw = linkRow?.querySelector('a')?.href || messageRow?.querySelector('.message-content')?.textContent || '';
      const restored = await message({ type: 'swap-restore', text: raw });
      await navigator.clipboard.writeText(restored?.text || raw);
      target.textContent = 'Copied';
      setTimeout(() => { target.textContent = 'Copy'; }, 1000);
      return;
    }
    const response = await fetch(target.href, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Download failed.');
    const type = response.headers.get('content-type') || '';
    let text;
    let name = target.download || new URL(target.href).pathname.split('/').pop() || 'document.txt';
    if (/pdf|wordprocessingml/iu.test(type) || /\.(?:pdf|docx)$/iu.test(name)) {
      text = await extract(new File([await response.blob()], name));
      name = name.replace(/\.[^.]+$/u, '') + '.txt';
    } else {
      text = await response.text();
    }
    const restored = await message({ type: 'swap-restore', text });
    const url = URL.createObjectURL(new Blob([restored?.text || text], { type: 'text/plain' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  })().catch((error) => notice(`Local copy or download failed: ${error.message}`));
}, true);
