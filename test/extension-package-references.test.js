import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import test from 'node:test';
import { listZipEntries, packageExtension } from '../scripts/package-extension.js';

const extensionRoot = new URL('../extension/', import.meta.url);

function assetReferences(source, file) {
  if (file.endsWith('.js')) {
    const references = [];
    for (const match of source.matchAll(/\bimport\s+(?:[^;'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g)) references.push(match[1]);
    for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) references.push(match[1]);
    return references.filter((reference) => reference.startsWith('./') || reference.startsWith('../'));
  }
  const references = [];
  for (const script of source.matchAll(/<script\b[^>]*>/gi)) {
    const src = script[0].match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const reference = src?.[1] ?? src?.[2] ?? src?.[3];
    if (reference && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) references.push(reference);
  }
  return references;
}

function manifestReferences(value) {
  if (Array.isArray(value)) return value.flatMap(manifestReferences);
  if (value && typeof value === 'object') return Object.values(value).flatMap(manifestReferences);
  if (typeof value !== 'string') return [];
  return /\.(?:js|html|css|svg|png|jpe?g|webp|json)$/i.test(value) && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value) ? [value] : [];
}

test('packaged extension includes every relative script and manifest reference', () => {
  const packaged = new Set(listZipEntries(packageExtension()).filter((entry) => !entry.endsWith('/')));
  for (const file of packaged) {
    if (!/\.(?:js|html)$/.test(file)) continue;
    const source = readFileSync(new URL(file, extensionRoot), 'utf8');
    for (const reference of assetReferences(source, file)) {
      const target = posix.normalize(posix.join(posix.dirname(file), reference));
      assert.ok(packaged.has(target), `${file} references ${reference}, but ${target} is not packaged`);
    }
  }
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', extensionRoot), 'utf8'));
  for (const reference of manifestReferences(manifest)) {
    const target = posix.normalize(reference);
    assert.ok(packaged.has(target), `manifest.json references ${reference}, but ${target} is not packaged`);
  }
});
