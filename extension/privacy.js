import { normalizeRoster } from './swap-store.js';

const status = document.querySelector('#status');
const editor = document.querySelector('#editor');
const roster = document.querySelector('#roster');
let clients = [];

function render() {
  roster.replaceChildren();
  clients.forEach((client, index) => {
    const row = document.createElement('fieldset');
    const legend = document.createElement('legend'); legend.textContent = `Client ${index + 1}`; row.append(legend);
    for (const [field, label] of [['name', 'Name'], ['aliases', 'Aliases (comma separated)'], ['dob', 'Date of birth (optional)']]) {
      const wrap = document.createElement('label'); wrap.textContent = label;
      const input = document.createElement('input'); input.value = field === 'aliases' ? client.aliases.join(', ') : client[field] || '';
      input.addEventListener('input', () => { client[field] = field === 'aliases' ? input.value.split(',').map((part) => part.trim()).filter(Boolean) : input.value; });
      wrap.append(input); row.append(wrap);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
    remove.addEventListener('click', () => { clients.splice(index, 1); render(); }); row.append(remove); roster.append(row);
  });
}

function csvRows(text) {
  const rows = []; let row = []; let field = ''; let quote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote && char === '"' && text[i + 1] === '"') { field += '"'; i++; }
    else if (char === '"') quote = !quote;
    else if (!quote && char === ',') { row.push(field); field = ''; }
    else if (!quote && (char === '\n' || char === '\r')) { if (char === '\r' && text[i + 1] === '\n') i++; row.push(field); if (row.some(Boolean)) rows.push(row); row = []; field = ''; }
    else field += char;
  }
  row.push(field); if (row.some(Boolean)) rows.push(row);
  const headers = rows.shift()?.map((item) => item.trim().toLowerCase());
  if (!headers || !['name', 'aliases', 'dob'].every((name) => headers.includes(name))) throw new Error('CSV needs name, aliases and dob headers.');
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

async function init() {
  const state = await chrome.runtime.sendMessage({ type: 'swap-state' });
  if (state.private !== true) { status.textContent = 'Set this browser to private in Cockpit to manage its roster.'; return; }
  if (state.error) { status.textContent = 'Encrypted privacy storage is unavailable.'; return; }
  clients = normalizeRoster(state.roster); status.textContent = `${clients.length} clients stored on this computer.`; editor.hidden = false; render();
}
document.querySelector('#add').addEventListener('click', () => { clients.push({ name: '', aliases: [], dob: '' }); render(); });
document.querySelector('#save').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'swap-save', roster: clients });
  status.textContent = result.ok ? `${result.rosterCount} clients saved on this computer.` : result.error;
});
document.querySelector('#import').addEventListener('click', async () => {
  try {
    const file = document.querySelector('#file').files[0]; if (!file) throw new Error('Choose a roster file.');
    const text = await file.text();
    clients = normalizeRoster(file.name.toLowerCase().endsWith('.json') ? JSON.parse(text) : csvRows(text));
    const result = await chrome.runtime.sendMessage({ type: 'swap-save', roster: clients });
    if (!result.ok) throw new Error(result.error);
    render(); status.textContent = `${result.rosterCount} clients imported and saved.`;
  } catch (error) { status.textContent = error.message; }
});
init().catch((error) => { status.textContent = error.message; });
