import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { validateBrokerUrl, brokerOrigin, websocketEndpointUrl, pairExchangeUrl } from '../extension/broker-url.js';
import { HOSTED_INGEST_URL } from '../extension/hosted-default.js';

test('accepts the hosted default, any https server, and loopback http', () => {
  for (const ok of ['https://fbb.example.com/work-edge/ingest', 'https://fbb.example.com:8443/work-edge/ingest', 'http://127.0.0.1:8767/work-edge/ingest', 'http://localhost:8767/work-edge/ingest']) assert.equal(validateBrokerUrl(ok), true, ok);
});

test('refuses plain http to remote hosts, credentials, queries, fragments, and junk', () => {
  for (const bad of ['http://fbb.example.com/work-edge/ingest', 'https://user:pw@fbb.example.com/work-edge/ingest', 'https://fbb.example.com/work-edge/ingest?x=1', 'https://fbb.example.com/work-edge/ingest#a', 'ftp://fbb.example.com/', 'fbb.example.com', '', ' https://fbb.example.com/work-edge/ingest', 'https:///work-edge/ingest']) assert.equal(validateBrokerUrl(bad), false, bad);
});

test('derives origin, websocket and pair URLs from the chosen server', () => {
  assert.equal(brokerOrigin('https://fbb.example.com:8443/work-edge/ingest'), 'https://fbb.example.com:8443');
  assert.equal(websocketEndpointUrl('https://fbb.example.com/work-edge/ingest'), 'wss://fbb.example.com/work-edge/ws');
  assert.equal(websocketEndpointUrl('http://127.0.0.1:8767/work-edge/ingest'), 'ws://127.0.0.1:8767/work-edge/ws');
  assert.equal(pairExchangeUrl('https://fbb.example.com/work-edge/ingest'), 'https://fbb.example.com/work-edge/pair/exchange');
});

test('the hosted address appears only in hosted-default.js among extension sources', () => {
  const dir = new URL('../extension/', import.meta.url);
  const offenders = readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'hosted-default.js').filter((f) => readFileSync(new URL(f, dir), 'utf8').includes('private-example'));
  assert.deepEqual(offenders, []);
});
