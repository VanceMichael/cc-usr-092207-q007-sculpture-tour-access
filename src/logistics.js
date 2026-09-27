// 运输与布展可行性校验：车辆限载、展厅点位承重、支撑方式匹配、
// 安装依赖顺序、作品与组件状况。返回问题清单，不满足的方案不得执行。

import { getLeg, getPosition, getInstallEntry, getWork } from './tour.js';

// 车辆装载：路段所装包装箱总重不得超过限载，重复装载的包装箱需先卸装
export function checkLoad(tour, legId) {
  const leg = getLeg(tour, legId);
  const vehicle = tour.vehicles.find((v) => v.id === leg.vehicleId);
  const problems = [];
  const loads = tour.loads.filter((l) => l.legId === legId);
  const seen = new Set();
  let totalKg = 0;
  for (const load of loads) {
    for (const crateId of load.crateIds ?? []) {
      const crate = tour.crates.find((c) => c.id === crateId);
      if (!crate) {
        problems.push(`装载 ${load.id} 含未知包装箱 ${crateId}`);
        continue;
      }
      if (crate.state === 'quarantined') problems.push(`包装箱 ${crateId} 已隔离，不得装车`);
      if (seen.has(crateId)) problems.push(`包装箱 ${crateId} 在路段 ${legId} 重复装车`);
      seen.add(crateId);
      totalKg += crate.weightKg;
    }
  }
  if (totalKg > vehicle.capacityKg) {
    problems.push(`路段 ${legId} 总重 ${totalKg}kg 超过车辆 ${vehicle.id} 限载 ${vehicle.capacityKg}kg`);
  }
  return { ok: problems.length === 0, totalKg, capacityKg: vehicle.capacityKg, problems };
}

// 单点布展：作品状况、组件齐全、点位承重、支撑方式、安装依赖
export function checkInstallation(tour, workId, venueId, positionId, installedWorks = [], { checkDependencies = true } = {}) {
  const work = getWork(tour, workId);
  const position = getPosition(tour, venueId, positionId);
  const problems = [];

  if (work.status === 'under-repair') problems.push(`作品 ${workId} 在修复中，不得布展`);
  if (work.status === 'deinstalled-storage' && !work.allowStorageDisplay) {
    problems.push(`作品 ${workId} 已撤出入库，不参与展出`);
  }
  const missing = work.components.filter((c) => c.status === 'missing');
  for (const comp of missing) problems.push(`组件 ${comp.id} 缺失，作品 ${workId} 不得布展`);

  if (work.weightKg > position.maxLoadKg) {
    problems.push(`作品 ${workId} 重 ${work.weightKg}kg，超过点位 ${position.id} 承重 ${position.maxLoadKg}kg`);
  }
  if (position.allowedSupport && !position.allowedSupport.includes(work.supportType)) {
    problems.push(`点位 ${position.id} 不接受支撑方式 ${work.supportType}`);
  }

  const entry = getInstallEntry(tour, workId);
  if (checkDependencies) {
    for (const dep of entry?.after ?? []) {
      if (!installedWorks.includes(dep)) {
        problems.push(`作品 ${workId} 依赖作品 ${dep} 先行安装`);
      }
    }
  }
  return { ok: problems.length === 0, problems, position, work };
}

// 整馆布展顺序：按安装依赖排序，并逐项校验
export function planVenueInstall(tour, venueId) {
  const entries = tour.installPlan.filter((e) => e.venueId === venueId && e.state !== 'removed');
  const ordered = [];
  const placed = new Set();
  const remaining = new Set(entries.map((e) => e.workId));
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => {
      const e = entries.find((x) => x.workId === id);
      return (e.after ?? []).every((dep) => placed.has(dep) || !remaining.has(dep));
    });
    if (ready.length === 0) {
      const cycle = [...remaining].join('、');
      throw new Error(`场馆 ${venueId} 安装依赖存在循环：${cycle}`);
    }
    for (const id of ready) {
      ordered.push(id);
      placed.add(id);
      remaining.delete(id);
    }
  }
  return ordered.map((id) => {
    const e = entries.find((x) => x.workId === id);
    return { workId: id, ...checkInstallation(tour, id, venueId, e.positionId, ordered.slice(0, ordered.indexOf(id))) };
  });
}
