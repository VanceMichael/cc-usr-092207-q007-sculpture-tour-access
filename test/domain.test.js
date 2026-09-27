import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDomain, parseRecords, bindRecords } from '../src/domain.js';

const fixture = () => readFile(new URL('../fixtures/domain.json', import.meta.url), 'utf8');

test('样例领域标识正确', async () => {
  const value = parseDomain(await fixture());
  assert.equal(value.domain, 'sculpture-tour-access');
  assert.ok(value.constraints.length >= 2);
});

test('v2 资料可解析为带索引的业务记录', async () => {
  const records = parseRecords(await fixture());
  assert.equal(records.artworks.length, 6);
  assert.equal(records.artworksById.get('W-001').title, '石之一');
  assert.equal(records.sessionsById.get('T1').venue_id, 'V1');
});

test('缺少 data 的 v2 资料被拒绝', () => {
  assert.throws(() => parseDomain(JSON.stringify({
    domain: 'x', version: 2, sample_id: 's',
    actors: ['a', 'b'], facts: ['f1', 'f2'], constraints: ['c1', 'c2']
  })), /data/);
});

test('重复标识在建索引时报错', () => {
  assert.throws(() => bindRecords({
    artists: [], artworks: [{ id: 'W1' }, { id: 'W1' }], venues: [], positions: [],
    install_dependencies: [], crates: [], vehicles: [], shipments: [],
    condition_reports: [], handovers: [], inspections: [], authorizations: [],
    sessions: [], bookings: [], events: []
  }), /标识重复：W1/);
});
