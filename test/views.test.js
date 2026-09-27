import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTour, ACTORS } from './helpers.js';
import { buildView, ROLES } from '../src/views.js';
import { recordCleaning } from '../src/touch.js';

const AT = '2026-10-05T09:00:00Z';

test('承运安装视图只含职责内操作资料', async () => {
  const tour = await loadTour();
  const view = buildView(tour, ROLES.CARRIER_INSTALL, { venueId: 'M-A' });
  // 能看到重量、支撑、包装箱、车辆路段、点位承重
  assert.equal(view.works[0].weightKg, 420);
  assert.equal(view.crates[0].weightKg, 480);
  assert.equal(view.vehicles[0].capacityKg, 1200);
  assert.equal(view.venues[0].positions[0].maxLoadKg, 600);
  // 看不到借展条件、作者权利、触摸授权、预约观众信息
  assert.equal('loanCondition' in view.works[0], false);
  assert.equal('artistRights' in view.works[0], false);
  assert.equal('touchAuthorizations' in view, false);
  assert.equal('bookings' in view, false);
});

test('公教视图能确认可触摸范围与清洁间隔', async () => {
  const tour = await loadTour();
  recordCleaning(tour, { at: '2026-10-05T08:30:00Z', workId: 'W-01', venueId: 'M-A', actor: ACTORS.educator });
  const view = buildView(tour, ROLES.PUBLIC_EDUCATION, { venueId: 'M-A', at: AT });
  const scope = view.venues[0].touchScope;
  const w01 = scope.find((s) => s.workId === 'W-01');
  assert.equal(w01.touchable, true);
  assert.equal(w01.cleaningIntervalHours, 2);
  assert.equal(w01.cleaningDue, false);
  // W-02 作者禁止触摸且无授权
  const w02 = scope.find((s) => s.workId === 'W-02');
  assert.equal(w02.touchable, false);
  // 看不到运输装载资料
  assert.equal('vehicles' in view, false);
  assert.equal('loads' in view, false);
  assert.equal('crates' in view, false);
});

test('公教视图按场馆隔离：乙馆无授权', async () => {
  const tour = await loadTour();
  const view = buildView(tour, ROLES.PUBLIC_EDUCATION, { venueId: 'M-B', at: AT });
  assert.ok(view.venues[0].touchScope.every((s) => s.touchable === false));
});

test('策展视图可追溯全部资料', async () => {
  const tour = await loadTour();
  const view = buildView(tour, ROLES.CURATORIAL);
  assert.equal(view.works.length, tour.works.length);
  // 借展条件等完整资料仅策展可见
  assert.ok(view.works[0].loanCondition.includes('直立运输'));
  assert.equal(view.touchAuthorizations.length, 2);
  assert.equal(view.auditLog.length, 0);
});

test('未知角色被拒绝', async () => {
  const tour = await loadTour();
  assert.throws(() => buildView(tour, 'lender-public'), /未知角色/);
});
