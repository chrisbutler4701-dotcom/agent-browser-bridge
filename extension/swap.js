// Pure, browser-independent identifier replacement. The caller persists map.
const LABELS = { client: 'CLIENT', person: 'PERSON', phone: 'PHONE', email: 'EMAIL', address: 'ADDRESS', id: 'ID', date: 'DATE' };
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalized = (value) => String(value || '').trim().toLocaleLowerCase();

function put(map, kind, value) {
  map.values ||= {};
  map.next ||= {};
  const key = `${kind}:${normalized(value)}`;
  if (!map.values[key]) {
    const label = LABELS[kind];
    const number = map.next[kind] = (map.next[kind] || 0) + 1;
    map.values[key] = { standIn: `[${label}-${number}]`, real: value, kind };
  }
  return map.values[key].standIn;
}

export function scrub(text, roster = [], map = {}) {
  let output = String(text ?? '');
  const replaced = [];
  const replace = (pattern, kind, resolve = () => kind) => {
    output = output.replace(pattern, (match, ...args) => {
      // A replacement from an earlier pass must not be replaced again.
      const selected = resolve(match, ...args);
      if (!selected) return match;
      const standIn = put(map, selected, match.replace(/[’']s$/iu, ''));
      replaced.push({ standIn, kind: selected });
      return /[’']s$/iu.test(match) ? `${standIn}${match.slice(-2)}` : standIn;
    });
  };
  const aliases = roster.flatMap((client) => [client.name, ...(Array.isArray(client.aliases) ? client.aliases : String(client.aliases || '').split(/[;,]/u))]
    .filter(Boolean).map((name) => ({ name: String(name).trim(), client })));
  aliases.sort((a, b) => b.name.length - a.name.length);
  for (const { name, client } of aliases) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?:[’']s)?(?![\\p{L}\\p{N}])`, 'giu');
    output = output.replace(pattern, (match) => {
      const standIn = put(map, 'client', String(client.name).trim());
      replaced.push({ standIn, kind: 'client' });
      return /[’']s$/iu.test(match) ? `${standIn}${match.slice(-2)}` : standIn;
    });
  }
  for (const client of roster) if (client.dob) {
    replace(new RegExp(`(?<![\\d])${escape(String(client.dob))}(?![\\d])`, 'giu'), 'date');
  }
  output = output.replace(/\b((?:client|patient|person|contact|name)\s*:\s*)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/giu, (_match, label, value) => {
    const standIn = put(map, 'person', value); replaced.push({ standIn, kind: 'person' }); return label + standIn;
  });
  replace(/(?<![\w])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w])/gu, 'email');
  replace(/(?<!\d)(?:\+1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/gu, 'phone');
  replace(/(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/gu, 'id');
  replace(/(?<![\w])[A-Za-z]{2}\d{5}[A-Za-z](?![\w])/gu, 'id');
  replace(/\b\d{1,6}\s+(?:[A-Za-z0-9]+\s+){1,5}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Court|Ct\.?)\b/giu, 'address');
  output = output.replace(/\b((?:case|medicaid)\s*(?:number|no\.?|#|id)\s*[:#]?\s*)([A-Za-z0-9-]{5,})/giu, (_match, label, value) => {
    const standIn = put(map, 'id', value); replaced.push({ standIn, kind: 'id' }); return label + standIn;
  });
  // Only dates in a short identifier context are swapped.
  output = output.replace(/\b(?:DOB|born|date of birth)\b(?:[ \t]*[:#-])?(?:[ \t]+[\w/-]+){0,5}/giu, (window) =>
    window.replace(/(?<!\d)(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})(?!\d)/giu, (date) => {
      const standIn = put(map, 'date', date); replaced.push({ standIn, kind: 'date' }); return standIn;
    }));
  return { text: output, replaced };
}

export function restore(text, map = {}) {
  const byStandIn = new Map(Object.values(map.values || {}).map(({ standIn, real }) => [standIn, real]));
  return String(text ?? '').replace(/\[(?:CLIENT|PERSON|PHONE|EMAIL|ADDRESS|ID|DATE)-\d+\]/gu, (match) => byStandIn.get(match) || match);
}
