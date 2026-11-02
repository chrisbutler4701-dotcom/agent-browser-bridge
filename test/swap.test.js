import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { scrub, restore } from '../extension/swap.js';

const roster = JSON.parse(fs.readFileSync(new URL('../test-fixtures/roster.json', import.meta.url)));

test('roster names, aliases and possessives use stable client stand-ins', () => {
  const map = {};
  const first = scrub('Maya Ellison, Maya E. and MAYA E.’s note', roster, map);
  assert.equal(first.text, '[CLIENT-1], [CLIENT-1] and [CLIENT-1]’s note');
  assert.equal(scrub('Maya Ellison', roster, map).text, '[CLIENT-1]');
  assert.equal(restore(first.text, map), 'Maya Ellison, Maya Ellison and Maya Ellison’s note');
});

test('identifier patterns replace phones, emails, SSNs, addresses, CIN and case ids', () => {
  const map = {};
  const input = '212-555-0101 maya@example.test 123-45-6789 124 Maple Avenue AB12345C Case # CASE-44551';
  const result = scrub(input, roster, map);
  for (const kind of ['PHONE', 'EMAIL', 'ID', 'ADDRESS']) assert.match(result.text, new RegExp(`\\[${kind}-\\d+\\]`));
  assert.equal(restore(result.text, map), input);
});

test('a labelled person outside the roster gets a person stand-in', () => {
  const map = {};
  const result = scrub('Name: John Smith', roster, map);
  assert.equal(result.text, 'Name: [PERSON-1]');
  assert.equal(restore(result.text, map), 'Name: John Smith');
});

test('birth dates are replaced; unrelated schedule dates stay', () => {
  const map = {};
  const input = 'DOB 04/12/1988. Meeting 10/28/2026. Born on 9/3/1976.';
  const result = scrub(input, roster, map);
  assert.match(result.text, /DOB \[DATE-1\]/u);
  assert.match(result.text, /Meeting 10\/28\/2026/u);
  assert.match(result.text, /Born on \[DATE-2\]/u);
  assert.equal(restore(result.text, map), input);
});
