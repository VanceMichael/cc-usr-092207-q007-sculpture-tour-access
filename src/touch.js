// 触摸活动与无障碍开放：作品是否可触摸只取决于作者与馆方双方确认的授权，
// 展厅普通展签、讲解词或既往场次都不构成安全许可。
// 公教人员只能在授权范围内确认可触摸作品与清洁间隔，并据此安排预约场次。

import { appendAudit } from './events.js';
import { getBooking, getVenue, getWork } from './tour.js';

// 取某场馆当前有效的触摸授权（作者与馆方确认、未撤回、未过期）
export function getTouchAuthorization(tour, workId, venueId, at = new Date().toISOString()) {
  return tour.touchAuthorizations.find(
    (a) =>
      a.workId === workId &&
      a.venueId === venueId &&
      a.status === 'granted' &&
      a.artistApprover &&
      a.venueApprover &&
      (!a.validFrom || at >= a.validFrom) &&
      (!a.validUntil || at <= a.validUntil),
  );
}

// 可触摸判定。hasLabel 只是现场说明资料，绝不参与许可判断。
export function isTouchable(tour, workId, venueId, at = new Date().toISOString(), hasLabel = false) {
  const work = getWork(tour, workId);
  const reasons = [];
  if (work.artistRights?.touchPolicy === 'no-touch') reasons.push('作者声明禁止触摸');
  if (work.status === 'under-repair') reasons.push('作品修复中');
  if (work.components.some((c) => c.status === 'missing')) reasons.push('作品组件缺失');
  const auth = getTouchAuthorization(tour, workId, venueId, at);
  if (!auth) reasons.push('缺少作者与馆方双方确认且在有效期内的触摸授权');
  if (hasLabel && !auth) reasons.push('普通展签不构成触摸许可');
  return { touchable: reasons.length === 0, authorization: auth ?? null, reasons };
}

export function listTouchableWorks(tour, venueId, at) {
  return tour.works
    .map((w) => ({ workId: w.id, ...isTouchable(tour, w.id, venueId, at) }))
    .filter((r) => r.touchable);
}

export function lastCleaningAt(tour, workId, venueId) {
  const at = tour.cleanings
    .filter((c) => c.workId === workId && c.venueId === venueId)
    .map((c) => c.at)
    .sort()
    .at(-1);
  return at ?? null;
}

// 距上次清洁是否已达到授权规定的清洁间隔
export function cleaningDue(tour, workId, venueId, at = new Date().toISOString()) {
  const auth = getTouchAuthorization(tour, workId, venueId, at);
  if (!auth) return { due: false, reason: '该作品当前不可触摸' };
  const last = lastCleaningAt(tour, workId, venueId);
  if (!last) return { due: true, reason: '触摸前从未清洁', authorization: auth };
  const elapsedHours = (new Date(at) - new Date(last)) / 3_600_000;
  return {
    due: elapsedHours >= auth.cleaningIntervalHours,
    elapsedHours: Math.round(elapsedHours * 10) / 10,
    intervalHours: auth.cleaningIntervalHours,
    authorization: auth,
  };
}

export function recordCleaning(tour, { at = new Date().toISOString(), workId, venueId, actor }) {
  const auth = getTouchAuthorization(tour, workId, venueId, at);
  if (!auth) throw new Error(`作品 ${workId} 在 ${venueId} 无有效触摸授权，无需按触摸标准清洁`);
  const cleaning = { at, workId, venueId };
  tour.cleanings.push(cleaning);
  appendAudit(tour, {
    at,
    type: 'cleaning',
    actor,
    target: { kind: 'work', id: workId, venueId },
    detail: { intervalHours: auth.cleaningIntervalHours },
  });
  return cleaning;
}

// 校验预约场次：作品可触摸、人数不超场次容量、观众辅助需求已落实、
// 开场前各作品已按间隔完成清洁
export function checkBooking(tour, bookingId, at = new Date().toISOString()) {
  const booking = getBooking(tour, bookingId);
  if (booking.status === 'cancelled') return { ok: false, problems: ['预约已取消'] };
  const venue = getVenue(tour, booking.venueId);
  const problems = [];
  if (booking.visitors > venue.sessionCapacity) {
    problems.push(`预约 ${booking.visitors} 人超过场馆场次容量 ${venue.sessionCapacity} 人`);
  }
  for (const workId of booking.works) {
    const verdict = isTouchable(tour, workId, venue.id, booking.scheduledAt ?? at);
    if (!verdict.touchable) problems.push(`作品 ${workId} 不可触摸：${verdict.reasons.join('；')}`);
    const due = cleaningDue(tour, workId, venue.id, booking.scheduledAt ?? at);
    if (due.due) problems.push(`作品 ${workId} 开场前需重新清洁（间隔 ${due.intervalHours ?? due.authorization?.cleaningIntervalHours} 小时）`);
  }
  for (const need of booking.assistiveNeeds ?? []) {
    if (!venue.assistiveAvailable?.includes(need) && !(booking.assistiveProvided ?? []).includes(need)) {
      problems.push(`观众辅助需求未落实：${need}`);
    }
  }
  return { ok: problems.length === 0, problems, venue };
}

// 记录实际举办的触摸场次，记录实际开放作品与到场辅助；只能开放校验通过的作品
export function recordTouchSession(tour, { at = new Date().toISOString(), bookingId, actor, touchedWorks, assistiveUsed = [], notes }) {
  const booking = getBooking(tour, bookingId);
  const venueId = booking.venueId;
  const problems = [];
  for (const workId of touchedWorks ?? []) {
    if (!booking.works.includes(workId)) problems.push(`作品 ${workId} 不在预约范围内`);
    const verdict = isTouchable(tour, workId, venueId, at);
    if (!verdict.touchable) problems.push(`作品 ${workId} 当场不可触摸：${verdict.reasons.join('；')}`);
  }
  if (problems.length > 0) throw new Error(`触摸场次不能举办：\n- ${problems.join('\n- ')}`);
  const session = {
    id: `session-${tour.sessions.length + 1}`,
    at,
    bookingId,
    venueId,
    touchedWorks,
    assistiveUsed,
    notes: notes ?? null,
  };
  tour.sessions.push(session);
  appendAudit(tour, {
    at,
    type: 'touch-session',
    actor,
    target: { kind: 'booking', id: bookingId },
    detail: { touchedWorks, assistiveUsed, visitors: booking.visitors, notes: session.notes },
  });
  return session;
}
