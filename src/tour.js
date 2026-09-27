// 巡展状态：聚合作品组件、作者权利、包装箱、车辆路段、装载、
// 场馆点位、布展计划、触摸授权与预约场次，并在组装时校验资料一致性。

export const SUPPORT_TYPES = new Set(['freestanding', 'pedestal', 'wall-mounted', 'suspended']);

export function createTour(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('巡展资料必须是对象');
  }
  const tour = {
    works: (data.works ?? []).map((w) => ({
      status: 'intact',
      ...w,
      components: (w.components ?? []).map((c) => ({ status: 'present', ...c })),
    })),
    crates: (data.crates ?? []).map((c) => ({ state: 'available', ...c })),
    vehicles: data.vehicles ?? [],
    legs: data.legs ?? [],
    loads: data.loads ?? [],
    venues: data.venues ?? [],
    installPlan: (data.installPlan ?? []).map((e) => ({ state: 'planned', ...e, after: e.after ?? [] })),
    touchAuthorizations: (data.touchAuthorizations ?? []).map((a) => ({ status: 'granted', ...a })),
    bookings: (data.bookings ?? []).map((b) => ({ status: 'scheduled', ...b })),
    sessions: [],
    cleanings: [],
    auditLog: [],
  };
  validateTour(tour);
  return tour;
}

function checkUnique(ids, label, problems) {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) problems.push(`${label}标识重复：${id}`);
    seen.add(id);
  }
}

function validateTour(tour) {
  const problems = [];

  checkUnique(tour.works.map((w) => w.id), '作品', problems);
  checkUnique(tour.crates.map((c) => c.id), '包装箱', problems);
  checkUnique(tour.vehicles.map((v) => v.id), '车辆', problems);
  checkUnique(tour.legs.map((l) => l.id), '路段', problems);
  checkUnique(tour.loads.map((l) => l.id), '装载', problems);
  checkUnique(tour.venues.map((v) => v.id), '场馆', problems);
  checkUnique(tour.bookings.map((b) => b.id), '预约', problems);

  for (const work of tour.works) {
    if (!(work.weightKg > 0)) problems.push(`作品 ${work.id} 重量无效`);
    if (!SUPPORT_TYPES.has(work.supportType)) problems.push(`作品 ${work.id} 支撑方式未知：${work.supportType}`);
    checkUnique(work.components.map((c) => c.id), `作品 ${work.id} 组件`, problems);
  }

  // 包装箱：指向存在的作品与组件，每个组件恰好装一箱
  const packed = new Map();
  for (const crate of tour.crates) {
    const work = tour.works.find((w) => w.id === crate.workId);
    if (!work) {
      problems.push(`包装箱 ${crate.id} 指向未知作品 ${crate.workId}`);
      continue;
    }
    if (!(crate.weightKg > 0)) problems.push(`包装箱 ${crate.id} 重量无效`);
    for (const compId of crate.componentIds ?? []) {
      if (!work.components.some((c) => c.id === compId)) {
        problems.push(`包装箱 ${crate.id} 装了不属于作品 ${work.id} 的组件 ${compId}`);
      } else if (packed.has(compId)) {
        problems.push(`组件 ${compId} 被重复装箱（${packed.get(compId)} 与 ${crate.id}）`);
      } else {
        packed.set(compId, crate.id);
      }
    }
  }
  for (const work of tour.works) {
    for (const comp of work.components) {
      if (!packed.has(comp.id)) problems.push(`作品 ${work.id} 的组件 ${comp.id} 未装箱`);
    }
  }

  for (const vehicle of tour.vehicles) {
    if (!(vehicle.capacityKg > 0)) problems.push(`车辆 ${vehicle.id} 限载无效`);
  }
  for (const leg of tour.legs) {
    if (!tour.vehicles.some((v) => v.id === leg.vehicleId)) problems.push(`路段 ${leg.id} 指向未知车辆 ${leg.vehicleId}`);
  }

  // 装载：路段存在，包装箱不重复装载
  const loadedCrates = new Set();
  for (const load of tour.loads) {
    if (!tour.legs.some((l) => l.id === load.legId)) problems.push(`装载 ${load.id} 指向未知路段 ${load.legId}`);
    for (const crateId of load.crateIds ?? []) {
      if (!tour.crates.some((c) => c.id === crateId)) {
        problems.push(`装载 ${load.id} 包含未知包装箱 ${crateId}`);
      } else if (loadedCrates.has(crateId)) {
        problems.push(`包装箱 ${crateId} 被重复装载`);
      } else {
        loadedCrates.add(crateId);
      }
    }
  }

  for (const venue of tour.venues) {
    if (!(venue.sessionCapacity > 0)) problems.push(`场馆 ${venue.id} 场次容量无效`);
    checkUnique(venue.positions.map((p) => p.id), `场馆 ${venue.id} 点位`, problems);
    for (const position of venue.positions) {
      if (!(position.maxLoadKg > 0)) problems.push(`点位 ${position.id} 承重无效`);
    }
  }

  // 布展计划：作品、场馆、点位与安装依赖均须存在
  for (const entry of tour.installPlan) {
    if (!tour.works.some((w) => w.id === entry.workId)) problems.push(`布展计划指向未知作品 ${entry.workId}`);
    const venue = tour.venues.find((v) => v.id === entry.venueId);
    if (!venue) {
      problems.push(`布展计划指向未知场馆 ${entry.venueId}`);
      continue;
    }
    if (!venue.positions.some((p) => p.id === entry.positionId)) {
      problems.push(`布展计划指向场馆 ${venue.id} 的未知点位 ${entry.positionId}`);
    }
    for (const dep of entry.after) {
      if (!tour.works.some((w) => w.id === dep)) problems.push(`作品 ${entry.workId} 的安装依赖 ${dep} 不存在`);
    }
  }

  // 触摸授权：有效授权必须作者与馆方双方确认，且作者未声明禁止触摸
  for (const auth of tour.touchAuthorizations) {
    const work = tour.works.find((w) => w.id === auth.workId);
    if (!work) {
      problems.push(`触摸授权指向未知作品 ${auth.workId}`);
      continue;
    }
    if (auth.status === 'granted') {
      if (!auth.artistApprover || !auth.venueApprover) {
        problems.push(`作品 ${auth.workId} 的触摸授权缺少作者或馆方确认人`);
      }
      if (!(auth.cleaningIntervalHours > 0)) problems.push(`作品 ${auth.workId} 的触摸授权缺少清洁间隔`);
      if (work.artistRights?.touchPolicy === 'no-touch') problems.push(`作品 ${auth.workId} 作者声明禁止触摸，授权无效`);
    }
  }

  for (const booking of tour.bookings) {
    if (!tour.venues.some((v) => v.id === booking.venueId)) problems.push(`预约 ${booking.id} 指向未知场馆`);
    if (!Array.isArray(booking.works) || booking.works.length === 0) {
      problems.push(`预约 ${booking.id} 没有关联作品`);
    } else {
      for (const workId of booking.works) {
        if (!tour.works.some((w) => w.id === workId)) problems.push(`预约 ${booking.id} 包含未知作品 ${workId}`);
      }
    }
    if (!(booking.visitors > 0)) problems.push(`预约 ${booking.id} 人数无效`);
  }

  if (problems.length > 0) {
    throw new Error(`巡展资料不一致：\n- ${problems.join('\n- ')}`);
  }
}

function findById(list, id, label) {
  const hit = list.find((item) => item.id === id);
  if (!hit) throw new Error(`未知${label}：${id}`);
  return hit;
}

export const getWork = (tour, id) => findById(tour.works, id, '作品');
export const getCrate = (tour, id) => findById(tour.crates, id, '包装箱');
export const getVehicle = (tour, id) => findById(tour.vehicles, id, '车辆');
export const getLeg = (tour, id) => findById(tour.legs, id, '路段');
export const getVenue = (tour, id) => findById(tour.venues, id, '场馆');
export const getBooking = (tour, id) => findById(tour.bookings, id, '预约');

export function getPosition(tour, venueId, positionId) {
  const venue = getVenue(tour, venueId);
  const position = venue.positions.find((p) => p.id === positionId);
  if (!position) throw new Error(`场馆 ${venueId} 没有点位 ${positionId}`);
  return position;
}

// 当前有效的布展计划条目（已被移出计划的除外）
export function getInstallEntry(tour, workId) {
  return tour.installPlan.find((e) => e.workId === workId && e.state !== 'removed') ?? null;
}
