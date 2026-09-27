import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRecords } from '../src/domain.js';
import {
  touchAdmission,
  sessionTouchPlan,
  checkHeldGroups,
  supportCoverage,
  sessionReadiness
} from '../src/access.js';

const load = async () => parseRecords(await readFile(new URL('../fixtures/domain.json', import.meta.url), 'utf8'));

test('作者与馆方双重确认齐备才允许触摸（W-001@V1）', async () => {
  const records = await load();
  const decision = touchAdmission(records, 'W-001', 'V1');
  assert.equal(decision.allowed, true);
  assert.equal(decision.rules.cleaning_interval_min, 30);
  assert.equal(decision.rules.max_group_size, 6);
  assert.deepEqual(decision.rules.scope_zones, ['整体表面']);
});

test('普通展签不构成许可：W-003 无作者确认，即便有展签也不得触摸', async () => {
  const records = await load();
  const decision = touchAdmission(records, 'W-003', 'V1');
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.includes('作者')));
});

test('授权被作者撤回后所有场馆立即停止触摸（W-002）', async () => {
  const records = await load();
  const decision = touchAdmission(records, 'W-002', 'V1');
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.includes('撤回')));
});

test('修复中的作品不得用于触摸活动', async () => {
  const records = await load();
  records.authorizations[0].artwork_id; // noop 保持读感
  // 给 W-004 构造一份齐备授权，仍应因修复被拒
  records.authorizations.push({
    id: 'AU-X', artwork_id: 'W-004', status: 'active', revoked_event_id: null,
    artist_consent: { by: 'A-04', at: '2026-05-01T10:00', scope_zones: ['主体'] },
    venue_consents: [{ venue_id: 'V2', at: '2026-05-01T10:00', status: 'active' }],
    cleaning_interval_min: 30, max_group_size: 4, supervision_required: true
  });
  const decision = touchAdmission(records, 'W-004', 'V2');
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.includes('修复')));
});

test('场馆拒绝或缺失场馆确认时不得开放（W-006@V3）', async () => {
  const records = await load();
  const refused = touchAdmission(records, 'W-006', 'V3');
  assert.equal(refused.allowed, false);
  assert.ok(refused.reasons.some((r) => r.includes('V3')));

  const allowed = touchAdmission(records, 'W-006', 'V4');
  assert.equal(allowed.allowed, true);
});

test('场次触摸计划逐件给出准入结论', async () => {
  const records = await load();
  const plan = sessionTouchPlan(records, 'T1');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].artwork_id, 'W-001');
  assert.equal(plan[0].allowed, true);
});

test('已执行分组：监督、人数与清洁间隔均合规', async () => {
  const records = await load();
  // T1 两组间隔 35 分钟（10:05 → 10:40），授权间隔 30 分钟；均 6 人以内、有监督、开始前已清洁
  const results = checkHeldGroups(records, 'T1');
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.passed), [true, true]);
});

test('清洁间隔不足、超员或缺监督会被记为违规', async () => {
  const records = await load();
  const session = records.sessionsById.get('T1');
  session.held_groups = [
    { at: '2026-04-12T10:05', visitors: 6, cleaned_at: '2026-04-12T10:00', supervision: true },
    { at: '2026-04-12T10:20', visitors: 8, cleaned_at: '2026-04-12T10:20', supervision: false }
  ];
  const results = checkHeldGroups(records, 'T1');
  const violations = results[1].violations.join('|');
  assert.equal(results[1].passed, false);
  assert.ok(violations.includes('清洁间隔不足'));
  assert.ok(violations.includes('限 6 人'));
  assert.ok(violations.includes('监督'));
});

test('预约辅助需求必须被场次辅助讲解覆盖', async () => {
  const records = await load();
  const coverage = supportCoverage(records, 'T3');
  // B2 需轮椅通道与手语翻译，T3 均已配齐（含 EV-6 增配的手语翻译）
  assert.equal(coverage[0].covered, true);
  assert.deepEqual(coverage[0].missing_needs, []);
});

test('辅助需求未配齐时场次不得就绪', async () => {
  const records = await load();
  const session = records.sessionsById.get('T3');
  session.supports = ['口头导览'];
  const readiness = sessionReadiness(records, 'T3');
  assert.equal(readiness.ready, false);
  assert.ok(readiness.violations.some((v) => v.includes('手语翻译')));
});

test('延期场次与换场待确认场次不可举行', async () => {
  const records = await load();

  const t2 = sessionReadiness(records, 'T2');
  assert.equal(t2.ready, false);
  assert.ok(t2.violations.some((v) => v.includes('延期')));

  const t3 = sessionReadiness(records, 'T3');
  assert.equal(t3.ready, false);
  assert.ok(t3.violations.some((v) => v.includes('二次确认')));
});

test('T1 已举行场次：准入、容量、辅助全覆盖，判定就绪', async () => {
  const records = await load();
  const readiness = sessionReadiness(records, 'T1');
  assert.equal(readiness.ready, true);
  assert.equal(readiness.headcount, 2); // 1 名视障观众 + 1 名陪同
});

test('预约总人数超容量时阻断', async () => {
  const records = await load();
  records.bookings.push(
    { id: 'B9', session_id: 'T1', visitor_kind: '视障观众', companions: 8, needs: [], status: 'reserved' }
  );
  const readiness = sessionReadiness(records, 'T1');
  assert.equal(readiness.ready, false);
  assert.ok(readiness.violations.some((v) => v.includes('容量')));
});
