import fs from 'node:fs/promises';
import path from 'node:path';

const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;
const STAND_IN = /^\[(?:CLIENT|PERSON|PHONE|EMAIL|ADDRESS|ID|DATE)-\d+\]$/u;

export function readReview(response) {
  const counts = {};
  let count = 0;
  let textLength = 0;
  const payloadLength = Array.isArray(response?.content) ? response.content.filter((item) => item?.type === 'text').reduce((total, item) => total + String(item.text || '').length, 0) : 0;
  const visit = (value) => {
    if (typeof value === 'string' && value.startsWith('{')) { try { visit(JSON.parse(value)); } catch {} return; }
    if (!value || typeof value !== 'object') return;
    if (value.swapReview) {
      const review = value.swapReview;
      if (Number.isSafeInteger(review.count) && review.count >= 0) count = Math.max(count, review.count);
      if (Number.isSafeInteger(review.textLength) && review.textLength >= 0) textLength = Math.max(textLength, review.textLength);
      for (const [key, amount] of Object.entries(review.counts || {})) if (STAND_IN.test(key) && Number.isSafeInteger(amount) && amount > 0) counts[key] = Math.max(counts[key] || 0, amount);
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'swapReview') visit(child);
  };
  visit(response);
  textLength = Math.max(textLength, payloadLength);
  const label = `Replaced ${count} details: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, amount]) => `${name} ×${amount}`).join(', ')}`;
  return count >= 10 || textLength > 4000 ? { count, textLength, counts, label } : null;
}

export function createCloudReceived({ directory = '/var/lib/field-browser-bridge/cloud-received' } = {}) {
  const file = (runId) => {
    if (!RUN_ID.test(runId)) throw new TypeError('Invalid run id.');
    return path.join(directory, `${runId}.jsonl`);
  };
  return {
    async append(runId, entry) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.appendFile(file(runId), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    },
    async read(runId) {
      try { return (await fs.readFile(file(runId), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }
  };
}
