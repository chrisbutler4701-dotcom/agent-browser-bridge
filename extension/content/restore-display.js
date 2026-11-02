// Restores text nodes only. The page's network code and inputs retain stand-ins.
const standIn = /\[(?:CLIENT|PERSON|PHONE|EMAIL|ADDRESS|ID|DATE)-\d+\]/gu;
const title = 'Real details shown only on this computer';
let busy = false;
async function update() {
  if (busy) return;
  busy = true;
  try {
    const root = document.querySelector('#messages');
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('input,textarea,script,style,[contenteditable],.local-real-detail')) continue;
      if (standIn.test(node.textContent)) nodes.push(node);
      standIn.lastIndex = 0;
    }
    for (const node of nodes) {
      const raw = node.textContent;
      const response = await chrome.runtime.sendMessage({ type: 'swap-restore', text: raw });
      if (!response?.text || response.text === raw || !node.isConnected || node.textContent !== raw) continue;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const match of raw.matchAll(standIn)) {
        if (match.index > cursor) fragment.append(document.createTextNode(raw.slice(cursor, match.index)));
        const span = document.createElement('span'); span.className = 'local-real-detail'; span.title = title;
        span.style.textDecoration = 'underline dotted'; span.style.textUnderlineOffset = '3px';
        const replacement = await chrome.runtime.sendMessage({ type: 'swap-restore', text: match[0] });
        span.textContent = replacement?.text || match[0]; fragment.append(span); cursor = match.index + match[0].length;
      }
      if (cursor < raw.length) fragment.append(document.createTextNode(raw.slice(cursor)));
      node.replaceWith(fragment);
    }
  } finally { busy = false; }
}
new MutationObserver(() => { void update(); }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
void update();
let resubmitting = false;
document.addEventListener('submit', async (event) => {
  if (event.target?.id !== 'composer' || resubmitting) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const prompt = document.querySelector('#prompt');
  if (!prompt) return;
  const response = await chrome.runtime.sendMessage({ type: 'swap-scrub', text: prompt.value });
  if (response?.error) { window.alert('Privacy scrubbing is unavailable. The message was not sent.'); return; }
  prompt.value = response.text;
  resubmitting = true;
  try { event.target.requestSubmit(); } finally { resubmitting = false; }
}, true);
