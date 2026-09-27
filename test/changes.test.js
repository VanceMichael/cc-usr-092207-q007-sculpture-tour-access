import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTour, ACTORS } from './helpers.js';
import {
  applyConditionReport,
  completeRepair,
  reportMissingComponent,
  replaceComponent,
  reportRouteDelay,
  changeVenue,
  revokeTouchAuthorization,
  updateAssistiveNeeds,
  performLoading,
  performInstallation,
  traceWork,
} from '../src/changes.js';
import { recordHandover, recordInspection, eventsForWork } from '../src/events.js';

test('状况报告要求修复时，联动暂停该作品的后续场次', async () => {
  const tour = await loadTour();
  const result = applyConditionReport(tour, {
    at: '2026-10-04T09:00:00Z',
    workId: 'W-01',
    reporter: '巡馆状况检查岗位',
    verdict: 'repair-needed',
    findings: ['底座固定盘松动'],
    actor: ACTORS.registrar,
  });
  assert.equal(result.workStatus, 'under-repair');
  assert.deepEqual(result.cascade.affectedBookings.sort(), ['B-01', 'B-02']);
  assert.equal(tour.bookings.find((b) => b.id === 'B-02').status, 'suspended');

  // 修复复检通过后恢复
  const repaired = completeRepair(tour, {
    at: '2026-10-04T15:00:00Z',
    workId: 'W-01',
    inspector: '修复复检岗位',
    actor: ACTORS.registrar,
  });
  assert.equal(repaired.workStatus, 'intact');
  assert.deepEqual(repaired.resumedBookings.sort(), ['B-01', 'B-02']);
});

test('复检仍有问题时不能结束修复', async () => {
  const tour = await loadTour();
  applyConditionReport(tour, {
    at: '2026-10-04T09:00:00Z',
    workId: 'W-01',
    reporter: '岗位',
    verdict: 'repair-needed',
    actor: ACTORS.registrar,
  });
  assert.throws(
    () => completeRepair(tour, {
      at: '2026-10-04T15:00:00Z',
      workId: 'W-01',
      inspector: '复检岗位',
      findings: ['仍有裂纹'],
      actor: ACTORS.registrar,
    }),
    /复检仍有问题/,
  );
  assert.equal(tour.works[0].status, 'under-repair');
});

test('组件缺失暂停场次，补配复检后恢复', async () => {
  const tour = await loadTour();
  const r = reportMissingComponent(tour, {
    at: '2026-10-04T09:00:00Z',
    workId: 'W-03',
    componentId: 'W-03-C2',
    reporter: '开箱检查岗位',
    actor: ACTORS.carrier,
  });
  assert.deepEqual(r.cascade.affectedBookings, ['B-01']);
  assert.equal(tour.works.find((w) => w.id === 'W-03').status, 'incomplete');

  replaceComponent(tour, {
    at: '2026-10-04T12:00:00Z',
    workId: 'W-03',
    componentId: 'W-03-C2',
    replacement: '经出借方确认的同形陶瓶乙',
    inspector: '补配复检岗位',
    actor: ACTORS.registrar,
  });
  assert.equal(tour.works.find((w) => w.id === 'W-03').status, 'intact');
});

test('路线延误错过布展截止时，目的场馆场次暂停', async () => {
  const tour = await loadTour();
  const r = reportRouteDelay(tour, {
    at: '2026-10-01T08:00:00Z',
    legId: 'L-01',
    delayHours: 40,
    reason: '高速封闭绕行',
    actor: ACTORS.carrier,
  });
  assert.equal(new Date(r.newArrival).getTime(), new Date('2026-10-03T01:00:00Z').getTime());
  assert.deepEqual(r.cascade.affectedBookings.sort(), ['B-01', 'B-02']);
});

test('场地变更重新校验点位，授权不随场地转移', async () => {
  const tour = await loadTour();
  const r = changeVenue(tour, {
    at: '2026-10-02T09:00:00Z',
    workIds: ['W-01'],
    fromVenueId: 'M-A',
    toVenueId: 'M-B',
    positionAssignment: { 'W-01': 'M-B-F1' },
    approver: '巡展策展负责人（岗位）',
    actor: ACTORS.curator,
  });
  assert.deepEqual(r.moved, ['W-01']);
  // M-B 地面位 500kg 可承 W-01（420kg），支撑方式匹配
  assert.equal(r.reinstallChecks[0].ok, true);
  // 预约改挂 M-B 但授权需重新确认 → 暂停
  const booking = tour.bookings.find((b) => b.id === 'B-01');
  assert.equal(booking.venueId, 'M-B');
  assert.equal(booking.status, 'suspended');
});

test('场地变更到不承重的点位会在校验结果中标注问题', async () => {
  const tour = await loadTour();
  // W-03（55kg 展座作品）若被改到 M-B 的 100kg 展座可行；
  // W-01（420kg 落地）若错配到 100kg 展座，方案记录问题且不自动执行
  const r = changeVenue(tour, {
    at: '2026-10-02T09:00:00Z',
    workIds: ['W-01'],
    fromVenueId: 'M-A',
    toVenueId: 'M-B',
    positionAssignment: { 'W-01': 'M-B-P1' },
    approver: '岗位',
    actor: ACTORS.curator,
  });
  assert.equal(r.reinstallChecks[0].ok, false);
  assert.match(r.reinstallChecks[0].problems.join(), /承重/);
});

test('授权撤回联动后续场次：移除作品，空场次取消', async () => {
  const tour = await loadTour();
  const r = revokeTouchAuthorization(tour, {
    at: '2026-10-04T09:00:00Z',
    workId: 'W-01',
    venueId: 'M-A',
    revoker: '作者权利方代码 RH-01',
    reason: '作品表面出现敏感变化',
    actor: ACTORS.registrar,
  });
  // B-01 还含 W-03 → 保留但移除 W-01；B-02 仅含 W-01 → 取消
  assert.deepEqual(r.changedBookings, ['B-01']);
  assert.deepEqual(r.cancelledBookings, ['B-02']);
  assert.deepEqual(tour.bookings.find((b) => b.id === 'B-01').works, ['W-03']);
});

test('观众辅助需求变化：场馆无法提供时暂停，落实后恢复', async () => {
  const tour = await loadTour();
  let r = updateAssistiveNeeds(tour, {
    at: '2026-10-04T09:00:00Z',
    bookingId: 'B-01',
    needs: ['盲文图录', '触觉导览地图'],
    actor: ACTORS.educator,
  });
  assert.equal(r.status, 'suspended');
  assert.deepEqual(r.unmet, ['触觉导览地图']);

  r = updateAssistiveNeeds(tour, {
    at: '2026-10-04T10:00:00Z',
    bookingId: 'B-01',
    needs: ['盲文图录', '触觉导览地图'],
    provided: ['触觉导览地图'],
    actor: ACTORS.educator,
  });
  assert.equal(r.status, 'scheduled');
});

test('交接必须双方签字，检查结果与发现一致', () => {
  const handover = recordHandover({ auditLog: [] }, {
    from: '承运组',
    to: '甲馆典藏组',
    crateIds: ['C-01'],
    actor: ACTORS.carrier,
  });
  assert.equal(handover.signatures.length, 2);
  assert.throws(() => recordInspection({ auditLog: [] }, {
    inspector: '岗位',
    result: 'pass',
    findings: ['有划痕'],
    actor: ACTORS.carrier,
  }), /不能记为通过/);
});

test('装车与布展执行通过校验后留痕，形成移动路径', async () => {
  const tour = await loadTour();
  performLoading(tour, { at: '2026-09-30T08:00:00Z', legId: 'L-01', actor: ACTORS.carrier });
  recordHandover(tour, {
    at: '2026-10-01T10:00:00Z',
    from: '承运组',
    to: '甲馆典藏组',
    crateIds: ['C-01', 'C-03'],
    actor: ACTORS.carrier,
  });
  performInstallation(tour, {
    at: '2026-10-02T10:00:00Z',
    workId: 'W-02',
    venueId: 'M-A',
    positionId: 'M-A-W1',
    actor: ACTORS.installer,
  });
  performInstallation(tour, {
    at: '2026-10-02T11:00:00Z',
    workId: 'W-01',
    venueId: 'M-A',
    positionId: 'M-A-F1',
    installedWorks: ['W-02'],
    actor: ACTORS.installer,
  });
  assert.equal(tour.installPlan.find((e) => e.workId === 'W-01').state, 'installed');

  const trace = traceWork(tour, 'W-01');
  assert.equal(trace.originalCondition.baselineReport, 'CR-W01-000');
  const pathTypes = trace.movementPath.map((e) => e.type);
  assert.deepEqual(pathTypes, ['loading', 'handover', 'installation']);
  assert.ok(eventsForWork(tour, 'W-01').length >= 3);
});

test('未通过载重校验的装车被拒绝且不留痕', async () => {
  const tour = await loadTour();
  tour.vehicles[0].capacityKg = 100;
  assert.throws(() => performLoading(tour, { legId: 'L-01', actor: ACTORS.carrier }), /装车被拒/);
  assert.equal(tour.auditLog.length, 0);
});

test('策展追溯含批准人与面向特殊观众的实际开放结果', async () => {
  const tour = await loadTour();
  const { recordCleaning } = await import('../src/touch.js');
  const { recordTouchSession } = await import('../src/touch.js');
  recordCleaning(tour, { at: '2026-10-12T13:00:00Z', workId: 'W-01', venueId: 'M-A', actor: ACTORS.educator });
  recordTouchSession(tour, {
    at: '2026-10-12T14:00:00Z',
    bookingId: 'B-02',
    actor: ACTORS.educator,
    touchedWorks: ['W-01'],
    assistiveUsed: ['手语讲解'],
  });
  const trace = traceWork(tour, 'W-01');
  assert.equal(trace.approvals[0].artistApprover.includes('RH-01'), true);
  assert.equal(trace.actualAccess[0].assistiveUsed[0], '手语讲解');
});
