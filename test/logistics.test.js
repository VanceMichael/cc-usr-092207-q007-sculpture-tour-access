import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRecords } from '../src/domain.js';
import {
  crateWeight,
  shipmentLoad,
  positionLoadCheck,
  installBlockers,
  missingRequiredComponents
} from '../src/logistics.js';

const load = async () => parseRecords(await readFile(new URL('../fixtures/domain.json', import.meta.url), 'utf8'));

test('包装箱毛重 = 皮重 + 内装作品重量，且不超箱体限重', async () => {
  const records = await load();
  const k1 = crateWeight(records, 'K1');
  assert.equal(k1.load_kg, 480);       // W-001
  assert.equal(k1.total_kg, 540);      // 60 皮重
  assert.equal(k1.within_crate_limit, true);

  const k2 = crateWeight(records, 'K2');
  assert.equal(k2.load_kg, 155);       // W-002 95 + W-003 60
});

test('运段合计毛重受车辆载重约束', async () => {
  const records = await load();
  const s1 = shipmentLoad(records, 'S1'); // K1 540 + K2 195 = 735 ≤ 800
  assert.equal(s1.total_kg, 735);
  assert.equal(s1.within_vehicle_payload, true);

  const s3 = shipmentLoad(records, 'S3'); // K5: 30 + 260 = 290
  assert.equal(s3.total_kg, 290);
});

test('超车辆载重的运段被识别', async () => {
  const records = await load();
  records.vehiclesById.get('TR1').payload_kg = 100;
  const s1 = shipmentLoad(records, 'S1');
  assert.equal(s1.within_vehicle_payload, false);
});

test('点位面荷载对照点位与展厅承重', async () => {
  const records = await load();
  // W-001 480kg / 2m² = 240kg/m²，点位 500、展厅 G1 500，均满足
  const p101 = positionLoadCheck(records, 'P-101');
  assert.equal(p101.kg_per_m2, 240);
  assert.equal(p101.within_load, true);
});

test('展厅承重不足构成安装阻断', async () => {
  const records = await load();
  // 把 P-101 放到低承重展厅：480/2=240 > G2 限值的复制场景
  const p = records.positions.find((x) => x.id === 'P-101');
  p.floor_load_limit_kg_m2 = 200;
  const result = installBlockers(records, 'W-001', 'V1');
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((b) => b.includes('承重不足')));
});

test('地脚固定但点位无锚固条件时阻断', async () => {
  const records = await load();
  // W-006 地脚固定，P-301 有 anchor；去掉后应阻断
  const p = records.positions.find((x) => x.id === 'P-301');
  p.features = [];
  const result = installBlockers(records, 'W-006', 'V4');
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((b) => b.includes('anchor')));
});

test('悬挂作品需要 rigging 吊点', async () => {
  const records = await load();
  // W-004 修复中且 V2 的 P-104 有 rigging；先解除修复态验证依赖通过
  records.artworksById.get('W-004').status = 'ok';
  records.positions.find((x) => x.id === 'P-104').artwork_id = 'W-004';
  const result = installBlockers(records, 'W-004', 'V2');
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
});

test('修复冻结与必备组件缺失都不得布展', async () => {
  const records = await load();
  assert.deepEqual(missingRequiredComponents(records.artworksById.get('W-005')), ['C-005-2']);

  const w4 = installBlockers(records, 'W-004', 'V2');
  assert.equal(w4.ready, false);
  assert.ok(w4.blockers.some((b) => b.includes('修复冻结')));

  records.positions.find((x) => x.id === 'P-105').artwork_id = 'W-005';
  const w5 = installBlockers(records, 'W-005', 'V2');
  assert.equal(w5.ready, false);
  assert.ok(w5.blockers.some((b) => b.includes('必备组件缺失')));
});

test('未分配点位的作品在该场馆不可安装', async () => {
  const records = await load();
  const result = installBlockers(records, 'W-002', 'V4');
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((b) => b.includes('未分配')));
});

test('台座供电依赖在 W-003/P-103 上满足', async () => {
  const records = await load();
  const result = installBlockers(records, 'W-003', 'V1');
  assert.equal(result.ready, true);
  assert.ok(result.dependency_details.some((d) => d.includes('220V')));
});
