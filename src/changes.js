// 变更联动：作品修复、组件缺失、路线延误、场地变更、授权撤回、
// 观众辅助需求变化，都必须联动受影响的后续安排（预约场次、装载、布展），
// 并为每次变更与联动追加交接检查记录。

import { checkInstallation, checkLoad } from './logistics.js';
import { appendAudit } from './events.js';
import { getInstallEntry } from './tour.js';

function upcomingBookings(tour, at, predicate = () => true) {
  return tour.bookings.filter(
    (b) => b.status !== 'cancelled' && (b.scheduledAt ?? '') >= at && predicate(b),
  );
}

function suspendBookings(tour, bookings, reason) {
  const affected = [];
  for (const booking of bookings) {
    booking.status = 'suspended';
    booking.suspensionReason = reason;
    affected.push(booking.id);
  }
  return { affectedBookings: affected, reason };
}

// 状况报告：结论为需修复时，作品进入修复状态，联动暂停后续触摸场次
export function applyConditionReport(tour, { at = new Date().toISOString(), workId, reporter, verdict, findings = [], actor }) {
  if (!['ok', 'repair-needed'].includes(verdict)) throw new Error('状况报告结论无效');
  const work = tour.works.find((w) => w.id === workId);
  if (!work) throw new Error(`未知作品：${workId}`);
  appendAudit(tour, {
    at,
    type: 'condition-report',
    actor,
    target: { kind: 'work', id: workId },
    detail: { reporter, verdict, findings },
    signatures: [{ party: reporter, signed: true }],
  });
  let cascade = null;
  if (verdict === 'repair-needed') {
    work.status = 'under-repair';
    cascade = suspendBookings(
      tour,
      upcomingBookings(tour, at, (b) => b.works.includes(workId)),
      `作品 ${workId} 状况报告要求修复，触摸场次暂停`,
    );
    appendAudit(tour, { at, type: 'repair', actor, target: { kind: 'work', id: workId }, detail: { cascade } });
  }
  return { workStatus: work.status, cascade };
}

// 修复完成后必须有通过的状况检查，作品才恢复展出，预约场次方可恢复
export function completeRepair(tour, { at = new Date().toISOString(), workId, inspector, actor, findings = [] }) {
  const work = tour.works.find((w) => w.id === workId);
  if (!work || work.status !== 'under-repair') throw new Error(`作品 ${workId} 不在修复中`);
  appendAudit(tour, {
    at,
    type: 'inspection',
    actor,
    target: { kind: 'work', id: workId },
    detail: { inspector, result: findings.length === 0 ? 'pass' : 'issues', findings },
    signatures: [{ party: inspector, signed: true }],
  });
  if (findings.length > 0) throw new Error(`作品 ${workId} 复检仍有问题，不能结束修复`);
  work.status = work.components.some((c) => c.status === 'missing') ? 'incomplete' : 'intact';
  const resumed = [];
  for (const booking of upcomingBookings(tour, at, (b) => b.works.includes(workId))) {
    if (booking.status === 'suspended' && booking.suspensionReason?.includes(workId)) {
      booking.status = 'scheduled';
      booking.suspensionReason = null;
      resumed.push(booking.id);
    }
  }
  return { workStatus: work.status, resumedBookings: resumed };
}

// 组件缺失：作品不得运输布展，后续场次暂停；补配需复检
export function reportMissingComponent(tour, { at = new Date().toISOString(), workId, componentId, reporter, actor }) {
  const work = tour.works.find((w) => w.id === workId);
  const component = work?.components.find((c) => c.id === componentId);
  if (!component) throw new Error(`作品 ${workId} 没有组件 ${componentId}`);
  component.status = 'missing';
  work.status = 'incomplete';
  appendAudit(tour, {
    at,
    type: 'component-missing',
    actor,
    target: { kind: 'work', id: workId },
    detail: { reporter, componentId },
    signatures: [{ party: reporter, signed: true }],
  });
  const cascade = suspendBookings(
    tour,
    upcomingBookings(tour, at, (b) => b.works.includes(workId)),
    `作品 ${workId} 组件 ${componentId} 缺失，场次暂停`,
  );
  return { cascade };
}

export function replaceComponent(tour, { at = new Date().toISOString(), workId, componentId, replacement, inspector, actor }) {
  const work = tour.works.find((w) => w.id === workId);
  const component = work?.components.find((c) => c.id === componentId);
  if (!component) throw new Error(`作品 ${workId} 没有组件 ${componentId}`);
  component.status = 'present';
  if (replacement) component.note = `补配件：${replacement}`;
  if (!work.components.some((c) => c.status === 'missing')) work.status = 'intact';
  appendAudit(tour, {
    at,
    type: 'component-replaced',
    actor,
    target: { kind: 'work', id: workId },
    detail: { componentId, replacement: replacement ?? null, inspector },
    signatures: [{ party: inspector, signed: true }],
  });
  return { workStatus: work.status };
}

// 路线延误：若到达时间晚于目的场馆布展截止，受影响场次顺延或暂停
export function reportRouteDelay(tour, { at = new Date().toISOString(), legId, delayHours, reason, actor }) {
  const leg = tour.legs.find((l) => l.id === legId);
  if (!leg) throw new Error(`未知路段：${legId}`);
  const newArrival = new Date(new Date(leg.arrivesAt).getTime() + delayHours * 3_600_000).toISOString();
  leg.arrivesAt = newArrival;
  appendAudit(tour, {
    at,
    type: 'route-delay',
    actor,
    target: { kind: 'leg', id: legId },
    detail: { delayHours, reason, newArrival },
  });
  const venue = tour.venues.find((v) => v.id === leg.toVenueId);
  let cascade = null;
  if (venue?.installReadyBy && new Date(newArrival) > new Date(venue.installReadyBy)) {
    cascade = suspendBookings(
      tour,
      upcomingBookings(tour, at, (b) => b.venueId === venue.id),
      `路段 ${legId} 延误 ${delayHours} 小时，错过 ${venue.id} 布展截止，场次待重排`,
    );
  }
  return { newArrival, cascade };
}

// 场地变更：作品改到新场馆点位布展；触摸授权按场馆分别确认，不随场地自动转移，
// 原场馆预约改挂新场馆并在重新确认前暂停，新点位承重与支撑重新校验
export function changeVenue(tour, {
  at = new Date().toISOString(),
  workIds,
  fromVenueId,
  toVenueId,
  positionAssignment,
  approver,
  actor,
}) {
  const targetVenue = tour.venues.find((v) => v.id === toVenueId);
  if (!targetVenue) throw new Error(`未知场馆：${toVenueId}`);
  const moved = [];
  const reinstallChecks = [];
  for (const workId of workIds) {
    const entry = getInstallEntry(tour, workId);
    if (!entry || entry.venueId !== fromVenueId) throw new Error(`作品 ${workId} 不在 ${fromVenueId} 的布展计划内`);
    const positionId = positionAssignment?.[workId];
    if (!positionId) throw new Error(`场地变更缺少作品 ${workId} 的新点位`);
    entry.venueId = toVenueId;
    entry.positionId = positionId;
    entry.state = 'planned';
    moved.push(workId);
    // 场地变更只复核物理约束（承重、支撑、状况）；安装顺序由新场馆重新排程
    reinstallChecks.push({ workId, ...checkInstallation(tour, workId, toVenueId, positionId, [], { checkDependencies: false }) });
  }
  const failed = reinstallChecks.filter((r) => !r.ok);
  appendAudit(tour, {
    at,
    type: 'venue-change',
    actor,
    target: { kind: 'batch' },
    detail: {
      fromVenueId,
      toVenueId,
      workIds: moved,
      approver,
      reinstallProblems: failed.map((f) => ({ workId: f.workId, problems: f.problems })),
    },
    signatures: [{ party: approver, signed: true }],
  });
  // 原场馆涉及作品的预约改挂新场馆；授权不随场地转移，重新确认前暂停
  const relocated = [];
  for (const booking of upcomingBookings(tour, at, (b) => b.venueId === fromVenueId && b.works.some((w) => moved.includes(w)))) {
    booking.venueId = toVenueId;
    booking.status = 'suspended';
    booking.suspensionReason = '场地变更，触摸授权需在新场馆重新确认';
    relocated.push(booking.id);
  }
  return { moved, reinstallChecks, relocatedBookings: relocated };
}

// 授权撤回：后续场次立即移除该作品，场次无作品可开放则取消
export function revokeTouchAuthorization(tour, { at = new Date().toISOString(), workId, venueId, revoker, reason, actor }) {
  const auth = tour.touchAuthorizations.find((a) => a.workId === workId && a.venueId === venueId && a.status === 'granted');
  if (!auth) throw new Error(`作品 ${workId} 在 ${venueId} 没有有效授权可撤回`);
  auth.status = 'revoked';
  auth.revokedAt = at;
  appendAudit(tour, {
    at,
    type: 'authorization-revoke',
    actor,
    target: { kind: 'work', id: workId, venueId },
    detail: { revoker, reason },
    signatures: [{ party: revoker, signed: true }],
  });
  const changedBookings = [];
  const cancelledBookings = [];
  for (const booking of upcomingBookings(tour, at, (b) => b.venueId === venueId && b.works.includes(workId))) {
    booking.works = booking.works.filter((w) => w !== workId);
    if (booking.works.length === 0) {
      booking.status = 'cancelled';
      cancelledBookings.push(booking.id);
    } else {
      changedBookings.push(booking.id);
    }
    appendAudit(tour, {
      at,
      type: 'booking-change',
      actor,
      target: { kind: 'booking', id: booking.id },
      detail: { reason: `授权撤回：作品 ${workId} 移出场次`, status: booking.status },
    });
  }
  return { changedBookings, cancelledBookings };
}

// 观众辅助需求变化：更新需求并由场馆落实；场馆无法提供时场次暂停
export function updateAssistiveNeeds(tour, { at = new Date().toISOString(), bookingId, needs, provided = [], actor }) {
  const booking = tour.bookings.find((b) => b.id === bookingId);
  if (!booking) throw new Error(`未知预约：${bookingId}`);
  const venue = tour.venues.find((v) => v.id === booking.venueId);
  booking.assistiveNeeds = needs;
  booking.assistiveProvided = provided;
  const unmet = needs.filter((n) => !venue.assistiveAvailable?.includes(n) && !provided.includes(n));
  if (unmet.length > 0 && booking.status === 'scheduled') {
    booking.status = 'suspended';
    booking.suspensionReason = `辅助需求待落实：${unmet.join('、')}`;
  }
  if (unmet.length === 0 && booking.status === 'suspended' && booking.suspensionReason?.startsWith('辅助需求')) {
    booking.status = 'scheduled';
    booking.suspensionReason = null;
  }
  appendAudit(tour, {
    at,
    type: 'assistive-update',
    actor,
    target: { kind: 'booking', id: bookingId },
    detail: { needs, provided, unmet, status: booking.status },
  });
  return { status: booking.status, unmet };
}

// 实际装车：通过载重与状况校验后记录，形成移动路径
export function performLoading(tour, { at = new Date().toISOString(), legId, actor }) {
  const verdict = checkLoad(tour, legId);
  if (!verdict.ok) throw new Error(`装车被拒：\n- ${verdict.problems.join('\n- ')}`);
  const crates = tour.loads.filter((l) => l.legId === legId).flatMap((l) => l.crateIds);
  appendAudit(tour, {
    at,
    type: 'loading',
    actor,
    target: { kind: 'leg', id: legId },
    detail: { crateIds: crates, totalKg: verdict.totalKg },
  });
  return verdict;
}

export function performInstallation(tour, { at = new Date().toISOString(), workId, venueId, positionId, installedWorks = [], actor }) {
  const verdict = checkInstallation(tour, workId, venueId, positionId, installedWorks);
  if (!verdict.ok) throw new Error(`布展被拒：\n- ${verdict.problems.join('\n- ')}`);
  const entry = getInstallEntry(tour, workId);
  if (entry) entry.state = 'installed';
  appendAudit(tour, {
    at,
    type: 'installation',
    actor,
    target: { kind: 'work', id: workId, venueId, positionId },
    detail: { supportType: verdict.work.supportType },
  });
  return verdict;
}

// 策展追溯：任一展出状态 → 作品原状、移动路径、批准人、实际开放结果
export function traceWork(tour, workId) {
  const work = tour.works.find((w) => w.id === workId);
  if (!work) throw new Error(`未知作品：${workId}`);
  const related = tour.auditLog.filter((e) => {
    if (e.target?.kind === 'work' && e.target.id === workId) return true;
    if (e.detail?.workIds?.includes(workId)) return true;
    if (e.detail?.crateIds) {
      return e.detail.crateIds.some((id) => tour.crates.find((c) => c.id === id)?.workId === workId);
    }
    return false;
  });
  return {
    work,
    originalCondition: work.originalCondition ?? null,
    crates: tour.crates.filter((c) => c.workId === workId).map((c) => c.id),
    movementPath: related.filter((e) =>
      ['loading', 'unloading', 'handover', 'venue-change', 'installation', 'deinstallation'].includes(e.type)),
    conditionHistory: related.filter((e) =>
      ['condition-report', 'repair', 'inspection', 'component-missing', 'component-replaced'].includes(e.type)),
    approvals: tour.touchAuthorizations
      .filter((a) => a.workId === workId)
      .map((a) => ({
        venueId: a.venueId,
        status: a.status,
        artistApprover: a.artistApprover ?? null,
        venueApprover: a.venueApprover ?? null,
        revokedAt: a.revokedAt ?? null,
      })),
    actualAccess: tour.sessions
      .filter((s) => s.touchedWorks.includes(workId))
      .map((s) => ({ at: s.at, venueId: s.venueId, bookingId: s.bookingId, assistiveUsed: s.assistiveUsed, notes: s.notes })),
  };
}
