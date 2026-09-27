import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRecords } from '../src/domain.js';
import { roleView, ROLES } from '../src/roles.js';
import { traceArtwork } from '../src/trace.js';

const load = async () => parseRecords(await readFile(new URL('../fixtures/domain.json', import.meta.url), 'utf8'));

test('承运安装人员只见操作资料：无作者、借展条款、授权与预约', async () => {
  const records = await load();
  const view = roleView(records, 'carrier');
  assert.equal(view.role, ROLES.carrier);
  for (const key of ['shipments', 'crates', 'positions', 'install_dependencies', 'handovers', 'inspections']) {
    assert.ok(Array.isArray(view[key]), `${key} 应可见`);
  }
  assert.equal(view.artists, undefined);
  assert.equal(view.authorizations, undefined);
  assert.equal(view.sessions, undefined);
  assert.equal(view.bookings, undefined);
  // 作品视图剥离借展条件，且不暴露作者标识
  const w1 = view.artworks.find((w) => w.id === 'W-001');
  assert.equal(w1.loan_conditions, undefined);
  assert.equal(w1.artist_id, undefined);
  assert.equal(w1.weight_kg, 480);
});

test('公教人员可确认触摸范围与清洁间隔，但看不到批准人身份与运输资料', async () => {
  const records = await load();
  const view = roleView(records, 'education');
  const au1 = view.authorizations.find((a) => a.id === 'AU-001');
  assert.equal(au1.status, 'active');
  assert.equal(au1.cleaning_interval_min, 30);
  assert.equal(au1.artist_consent_granted, true);
  assert.equal(au1.artist_consent, undefined);
  assert.equal(au1.venue_consents[0].by, undefined);
  assert.equal(view.shipments, undefined);
  assert.equal(view.crates, undefined);
  assert.equal(view.condition_reports, undefined);
  // 场次与预约辅助需求可见
  assert.ok(view.sessions.some((s) => s.id === 'T3'));
  assert.ok(view.bookings.some((b) => b.needs.includes('手语翻译')));
});

test('策展团队可见全量资料', async () => {
  const records = await load();
  const view = roleView(records, 'curator');
  assert.ok(view.artworks.length >= 6);
  assert.ok(view.events.length >= 6);
});

test('未知角色被拒绝', async () => {
  const records = await load();
  assert.throws(() => roleView(records, 'spy'), /未知角色/);
});

test('追溯 W-001：原状报告 → 移动路径 → 批准人 → 实际开放结果', async () => {
  const records = await load();
  const trace = traceArtwork(records, 'W-001');
  assert.equal(trace.baseline.id, 'CR-001');
  assert.equal(trace.baseline.findings[0], '原状完好');

  const leg = trace.movement[0].legs[0];
  assert.equal(trace.movement[0].crate_id, 'K1');
  assert.equal(leg.shipment_id, 'S1');
  assert.equal(leg.handover.to_party, 'V1 馆方');
  assert.deepEqual(leg.handover.inspection_ids, ['I1', 'I2']);

  assert.equal(trace.approvals[0].artist_consent.by, 'A-01');
  assert.equal(trace.approvals[0].venue_consents[0].venue_id, 'V1');

  const result = trace.access_results.find((r) => r.session_id === 'T1');
  assert.equal(result.status, 'held');
  assert.equal(result.admission.allowed, true);
  assert.equal(result.held_groups.length, 2);
  assert.equal(result.bookings[0].status, 'fulfilled');
});

test('追溯 W-002 可追到撤回授权的批准变化与事件', async () => {
  const records = await load();
  const trace = traceArtwork(records, 'W-002');
  assert.equal(trace.approvals[0].status, 'revoked');
  assert.equal(trace.approvals[0].revoked_event.id, 'EV-5');
});

test('追溯 W-004 保留修复状况链且其开放结果反映冻结', async () => {
  const records = await load();
  const trace = traceArtwork(records, 'W-004');
  assert.ok(trace.condition_trail.some((r) => r.findings[0].includes('裂纹')));
  assert.equal(trace.movement[0].legs[0].status, 'delayed');
});
