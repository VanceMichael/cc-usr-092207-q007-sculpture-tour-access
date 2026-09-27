import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTour, ACTORS } from './helpers.js';
import { checkLoad, checkInstallation, planVenueInstall } from '../src/logistics.js';

test('车辆装载不超过限载', async () => {
  const tour = await loadTour();
  const verdict = checkLoad(tour, 'L-01');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.totalKg, 1005);
  assert.ok(verdict.totalKg <= verdict.capacityKg);
});

test('超重装载被拒绝', async () => {
  const tour = await loadTour();
  tour.vehicles[0].capacityKg = 900;
  const verdict = checkLoad(tour, 'L-01');
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(), /限载/);
});

test('点位承重与支撑方式决定能否布展', async () => {
  const tour = await loadTour();
  // W-01 青铜立像 420kg 落地展示，放在 120kg 展座上不可行
  const bad = checkInstallation(tour, 'W-01', 'M-A', 'M-A-P1');
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes('承重')));
  assert.ok(bad.problems.some((p) => p.includes('支撑方式')));
  // 回到中庭地面位、且前置作品 W-02 已装时可行
  const good = checkInstallation(tour, 'W-01', 'M-A', 'M-A-F1', ['W-02']);
  assert.deepEqual(good.problems, []);
});

test('安装依赖规定先后顺序', async () => {
  const tour = await loadTour();
  const ordered = planVenueInstall(tour, 'M-A').map((r) => r.workId);
  assert.ok(ordered.indexOf('W-02') < ordered.indexOf('W-01'));
  assert.ok(ordered.indexOf('W-01') < ordered.indexOf('W-03'));

  // W-01 依赖 W-02 先装；未装 W-02 时布展被拒
  const verdict = checkInstallation(tour, 'W-01', 'M-A', 'M-A-F1', []);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes('W-02')));
});

test('修复中或组件缺失的作品不得布展', async () => {
  const tour = await loadTour();
  tour.works[0].status = 'under-repair';
  let verdict = checkInstallation(tour, 'W-01', 'M-A', 'M-A-F1', ['W-02']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(), /修复/);

  const fresh = await loadTour();
  fresh.works[2].components[0].status = 'missing';
  verdict = checkInstallation(fresh, 'W-03', 'M-A', 'M-A-P1', ['W-02', 'W-01']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(), /缺失/);
});

test('隔离包装箱不得装车', async () => {
  const tour = await loadTour();
  tour.crates[0].state = 'quarantined';
  const verdict = checkLoad(tour, 'L-01');
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(), /隔离/);
  assert.equal(ACTORS.carrier.role, 'carrier-install');
});
