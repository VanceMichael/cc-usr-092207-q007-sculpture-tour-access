import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRecords } from '../src/domain.js';
import { recordEvent, verifyAuditTrail } from '../src/events.js';
import { touchAdmission } from '../src/access.js';

const load = async () => parseRecords(await readFile(new URL('../fixtures/domain.json', import.meta.url), 'utf8'));

test('示例资料的交接、检查与事件联动留痕完整', async () => {
  const records = await load();
  const audit = verifyAuditTrail(records);
  assert.equal(audit.ok, true, audit.problems.join('；'));
});

test('修复事件：冻结作品、运段须重排，且不改写既往记录', async () => {
  const records = await load();
  const beforeReports = records.condition_reports.length;
  const { records: next, event } = recordEvent(records, {
    id: 'EV-T1', type: 'repair', at: '2026-06-10T09:00', ref: 'W-001',
    summary: '巡展中发现新损伤', payload: { artwork_id: 'W-001' }
  });
  assert.equal(next.artworksById.get('W-001').status, 'repair_hold');
  assert.ok(event.cascade.some((c) => c.action === 'artwork_hold'));
  // W-001 仅在已完成的 S1 运输过，不产生重排
  assert.ok(!event.cascade.some((c) => c.action === 'shipment_replan'));
  // 既往记录数量不变，原入参不被修改
  assert.equal(records.artworksById.get('W-001').status, 'ok');
  assert.equal(records.condition_reports.length, beforeReports);
  assert.equal(next.events.length, records.events.length + 1);
});

test('缺件事件：组件标记缺失、作品 partial、在途运段须重排', async () => {
  const records = await load();
  const { records: next, event } = recordEvent(records, {
    id: 'EV-T2', type: 'missing_component', at: '2026-06-11T09:00', ref: 'C-004-2',
    summary: '钢索组件清点缺失'
  });
  assert.equal(next.artworksById.get('W-004').status, 'partial');
  assert.equal(next.artworksById.get('W-004').components.find((c) => c.id === 'C-004-2').present, false);
  assert.ok(event.cascade.some((c) => c.action === 'artwork_partial' && c.ref === 'W-004'));
  assert.ok(event.cascade.some((c) => c.action === 'shipment_replan' && c.ref === 'S2'));
});

test('延误事件：运段 delayed、交接顺延、早于新到货时间的场次延期并取消预约', async () => {
  const records = await load();
  // 让 S3 处于在途，并在 V4 安排一场早于改期交接的触摸
  records.shipmentsById.get('S3').status = 'in_transit';
  records.sessionsById.get('T3').status = 'scheduled';
  records.bookingsById.get('B2').status = 'reserved';

  const { records: next, event } = recordEvent(records, {
    id: 'EV-T3', type: 'route_delay', at: '2026-06-01T12:00', ref: 'S3',
    summary: '车辆故障', payload: { delay_hours: 72, rescheduled_at: '2026-06-09T17:30' }
  });
  assert.equal(next.shipmentsById.get('S3').status, 'delayed');
  assert.ok(event.cascade.some((c) => c.action === 'handover_reschedule' && c.ref === 'H3'));
  assert.equal(next.sessionsById.get('T3').status, 'postponed');
  assert.equal(next.bookingsById.get('B2').status, 'cancelled');
});

test('场馆变更：退出、改运、改陈、交接改接收方、场次待新馆二次确认', async () => {
  const records = await load();
  // 构造一个仍在计划中的旧馆场景：把 S3 目的地暂回 V3、W-006 摆在 P-201
  records.shipmentsById.get('S3').to = 'V3';
  records.handoversById.get('H3').to_party = 'V3 馆方';
  records.positions.find((p) => p.id === 'P-301').artwork_id = null;
  records.positions.find((p) => p.id === 'P-201').artwork_id = 'W-006';
  records.sessionsById.get('T3').venue_id = 'V3';

  const { records: next, event } = recordEvent(records, {
    id: 'EV-T4', type: 'venue_change', at: '2026-05-28T12:00', ref: 'V3',
    summary: '场地维修退出', payload: { replacement_venue_id: 'V4', position_map: { 'W-006': 'P-301' } }
  });
  assert.equal(next.venuesById.get('V3').status, 'withdrawn');
  assert.equal(next.shipmentsById.get('S3').to, 'V4');
  assert.equal(next.positions.find((p) => p.id === 'P-201').artwork_id, null);
  assert.equal(next.positions.find((p) => p.id === 'P-301').artwork_id, 'W-006');
  assert.equal(next.handoversById.get('H3').to_party, 'V4 馆方');
  assert.equal(next.sessionsById.get('T3').venue_id, 'V4');
  assert.equal(next.sessionsById.get('T3').status, 'venue_pending');
  assert.ok(event.cascade.some((c) => c.action === 'position_reassign'));
});

test('授权撤回：授权失效、场次剔除作品，所有场馆随即拒绝触摸', async () => {
  const records = await load();
  // W-001 处于有效授权；模拟作者撤回
  records.sessionsById.get('T1').planned_artwork_ids = ['W-001', 'W-006'];
  records.sessionsById.get('T1').venue_id = 'V1';
  const authId = records.authorizations.find((a) => a.artwork_id === 'W-001').id;

  const { records: next } = recordEvent(records, {
    id: 'EV-T5', type: 'authorization_withdrawn', at: '2026-04-15T09:00', ref: authId,
    summary: '作者撤回触摸授权'
  });
  assert.equal(next.authsById.get(authId).status, 'revoked');
  assert.equal(next.authsById.get(authId).revoked_event_id, 'EV-T5');
  assert.ok(!next.sessionsById.get('T1').planned_artwork_ids.includes('W-001'));
  assert.equal(touchAdmission(next, 'W-001', 'V1').allowed, false);
  assert.equal(touchAdmission(next, 'W-001', 'V2').allowed, false);
});

test('辅助需求变化：预约需求与场次辅助讲解联动增配', async () => {
  const records = await load();
  records.sessionsById.get('T3').supports = ['口头导览'];
  records.bookingsById.get('B2').needs = ['轮椅通道'];

  const { records: next, event } = recordEvent(records, {
    id: 'EV-T6', type: 'support_change', at: '2026-06-02T15:00', ref: 'B2',
    summary: '观众新增手语翻译需求', payload: { add_needs: ['手语翻译'] }
  });
  assert.ok(next.bookingsById.get('B2').needs.includes('手语翻译'));
  assert.ok(next.sessionsById.get('T3').supports.includes('手语翻译'));
  assert.ok(event.cascade.some((c) => c.action === 'session_add_support'));
});

test('事件只追加：重复标识与未知类型被拒绝', async () => {
  const records = await load();
  assert.throws(() => recordEvent(records, {
    id: 'EV-1', type: 'repair', at: '2026-06-10T09:00', ref: 'W-001',
    summary: '重复事件', payload: { artwork_id: 'W-001' }
  }), /事件标识已存在/);
  assert.throws(() => recordEvent(records, {
    id: 'EV-X', type: 'flood', at: '2026-06-10T09:00', ref: 'x', summary: '未知类型'
  }), /未知事件类型/);
});

test('留痕校验能发现断链引用与缺失联动', async () => {
  const records = await load();
  const broken = structuredClone(records);
  broken.handovers[0].report_ids.push('CR-NOPE');
  assert.equal(verifyAuditTrail(broken).ok, false);

  const noCascade = structuredClone(records);
  noCascade.events[0].cascade = [];
  assert.equal(verifyAuditTrail(noCascade).ok, false);
});
