import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTour, ACTORS } from './helpers.js';
import { createTour } from '../src/tour.js';
import {
  isTouchable,
  listTouchableWorks,
  getTouchAuthorization,
  cleaningDue,
  recordCleaning,
  checkBooking,
  recordTouchSession,
} from '../src/touch.js';

const DURING_TOUR = '2026-10-05T09:00:00Z';

test('有双方确认且在有效期内的授权才可触摸', async () => {
  const tour = await loadTour();
  const verdict = isTouchable(tour, 'W-01', 'M-A', DURING_TOUR);
  assert.equal(verdict.touchable, true);
  assert.equal(verdict.authorization.artistApprover.includes('RH-01'), true);
  assert.ok(verdict.authorization.venueApprover);
});

test('普通展签不构成触摸许可', async () => {
  const tour = await loadTour();
  // W-02 在 M-A 没有任何触摸授权；即便现场贴了普通展签也不可触摸
  const verdict = isTouchable(tour, 'W-02', 'M-A', DURING_TOUR, true);
  assert.equal(verdict.touchable, false);
  assert.ok(verdict.reasons.some((r) => r.includes('展签')));
  assert.ok(verdict.reasons.some((r) => r.includes('禁止触摸')));
});

test('缺少馆方确认的授权在组装期被拒绝', async () => {
  const base = JSON.parse(await readFile(new URL('../fixtures/tour.json', import.meta.url), 'utf8'));
  base.touchAuthorizations.push({
    workId: 'W-04',
    venueId: 'M-A',
    status: 'granted',
    artistApprover: '作者权利方代码 RH-04',
    cleaningIntervalHours: 2,
  });
  assert.throws(() => createTour(base), /馆方确认人/);
});

test('授权按场馆分别确认，不随展览自动转移', async () => {
  const tour = await loadTour();
  // W-01 在甲馆可触摸，乙馆没有授权
  assert.equal(isTouchable(tour, 'W-01', 'M-B', DURING_TOUR).touchable, false);
  assert.equal(getTouchAuthorization(tour, 'W-01', 'M-A', DURING_TOUR)?.venueId, 'M-A');
});

test('授权超出有效期不可触摸', async () => {
  const tour = await loadTour();
  assert.equal(isTouchable(tour, 'W-01', 'M-A', '2026-11-01T00:00:00Z').touchable, false);
  assert.equal(isTouchable(tour, 'W-01', 'M-A', '2026-10-02T00:00:00Z').touchable, false);
});

test('清洁间隔到期前不得开场，清洁记录后恢复', async () => {
  const tour = await loadTour();
  // 从未清洁：开场前必须清洁
  let due = cleaningDue(tour, 'W-01', 'M-A', '2026-10-05T09:00:00Z');
  assert.equal(due.due, true);

  recordCleaning(tour, { at: '2026-10-05T08:30:00Z', workId: 'W-01', venueId: 'M-A', actor: ACTORS.educator });
  recordCleaning(tour, { at: '2026-10-05T08:30:00Z', workId: 'W-03', venueId: 'M-A', actor: ACTORS.educator });
  due = cleaningDue(tour, 'W-01', 'M-A', '2026-10-05T10:00:00Z');
  assert.equal(due.due, false, '清洁后1.5小时未到2小时间隔');

  // W-03 清洁间隔仅1小时，10:00 已到期；补做清洁后 B-01（定于10:00）才可通过
  due = cleaningDue(tour, 'W-03', 'M-A', '2026-10-05T10:00:00Z');
  assert.equal(due.due, true);
  recordCleaning(tour, { at: '2026-10-05T09:30:00Z', workId: 'W-03', venueId: 'M-A', actor: ACTORS.educator });
  const booking = checkBooking(tour, 'B-01');
  assert.equal(booking.ok, true, booking.problems.join('；'));
});

test('预约人数超过场馆场次容量被拒', async () => {
  const tour = await loadTour();
  tour.bookings[0].visitors = 20;
  const verdict = checkBooking(tour, 'B-01', DURING_TOUR);
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(), /容量/);
});

test('观众辅助需求未落实时预约不能通过', async () => {
  const tour = await loadTour();
  recordCleaning(tour, { at: '2026-10-12T13:30:00Z', workId: 'W-01', venueId: 'M-A', actor: ACTORS.educator });
  // 观众新增场馆未配备、预约也未自带落实的辅助需求
  tour.bookings.find((b) => b.id === 'B-02').assistiveNeeds = ['触觉导览地图'];
  const verdict = checkBooking(tour, 'B-02', '2026-10-12T14:00:00Z');
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(), /触觉导览地图/);
});

test('实际触摸场次只能开放预约内且仍可触摸的作品', async () => {
  const tour = await loadTour();
  recordCleaning(tour, { at: '2026-10-12T13:00:00Z', workId: 'W-01', venueId: 'M-A', actor: ACTORS.educator });
  // B-02 需要手语讲解，场馆提供该服务（assistiveAvailable 含手语讲解）
  const session = recordTouchSession(tour, {
    at: '2026-10-12T14:00:00Z',
    bookingId: 'B-02',
    actor: ACTORS.educator,
    touchedWorks: ['W-01'],
    assistiveUsed: ['手语讲解'],
  });
  assert.equal(session.venueId, 'M-A');

  assert.throws(
    () => recordTouchSession(tour, {
      at: '2026-10-12T14:30:00Z',
      bookingId: 'B-02',
      actor: ACTORS.educator,
      touchedWorks: ['W-02'],
    }),
    /不可触摸|不在预约范围/,
  );
});

test('可触摸清单只列出当前场馆有授权的作品', async () => {
  const tour = await loadTour();
  const ids = listTouchableWorks(tour, 'M-A', DURING_TOUR).map((r) => r.workId);
  assert.deepEqual(ids.sort(), ['W-01', 'W-03']);
  assert.deepEqual(listTouchableWorks(tour, 'M-B', DURING_TOUR), []);
});
