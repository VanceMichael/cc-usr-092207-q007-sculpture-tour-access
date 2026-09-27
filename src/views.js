// 按角色裁剪资料：承运安装人员只看到职责内的操作资料；
// 公教人员能确认可触摸范围、清洁间隔与辅助安排；策展方可以看到全部资料并追溯。

import { getTouchAuthorization, cleaningDue, lastCleaningAt } from './touch.js';

export const ROLES = {
  CURATORIAL: 'curatorial',
  CARRIER_INSTALL: 'carrier-install',
  PUBLIC_EDUCATION: 'public-education',
};

const OPERATIONAL_EVENTS = new Set([
  'handover',
  'inspection',
  'loading',
  'unloading',
  'route-delay',
  'venue-change',
  'installation',
  'deinstallation',
  'component-missing',
  'component-replaced',
  'condition-report',
  'repair',
]);

// 承运/安装视图：重量、支撑、包装箱、车辆路段、点位承重与操作交接，
// 不含借展条件、作者权利细节、触摸批准人与观众信息
function carrierInstallView(tour, { venueId } = {}) {
  return {
    role: ROLES.CARRIER_INSTALL,
    works: tour.works.map((w) => ({
      id: w.id,
      title: w.title,
      weightKg: w.weightKg,
      supportType: w.supportType,
      status: w.status,
      components: w.components.map((c) => ({ id: c.id, label: c.label, status: c.status })),
    })),
    crates: tour.crates.map((c) => ({
      id: c.id,
      workId: c.workId,
      componentIds: c.componentIds,
      weightKg: c.weightKg,
      state: c.state,
    })),
    vehicles: tour.vehicles,
    legs: tour.legs,
    loads: tour.loads,
    venues: tour.venues
      .filter((v) => !venueId || v.id === venueId)
      .map((v) => ({
        id: v.id,
        name: v.name,
        installReadyBy: v.installReadyBy ?? null,
        positions: v.positions.map((p) => ({
          id: p.id,
          label: p.label,
          maxLoadKg: p.maxLoadKg,
          allowedSupport: p.allowedSupport ?? null,
        })),
      })),
    installPlan: tour.installPlan
      .filter((e) => !venueId || e.venueId === venueId)
      .map((e) => ({ workId: e.workId, venueId: e.venueId, positionId: e.positionId, after: e.after, state: e.state })),
    auditLog: tour.auditLog.filter((e) => OPERATIONAL_EVENTS.has(e.type)),
  };
}

// 公教视图：可触摸范围、双方批准状态、清洁间隔与清洁状态、预约场次与辅助落实。
// 不提供车辆限载、装载排程、借展条件等运输资料
function publicEducationView(tour, { venueId, at } = {}) {
  const venues = tour.venues.filter((v) => !venueId || v.id === venueId);
  return {
    role: ROLES.PUBLIC_EDUCATION,
    at: at ?? new Date().toISOString(),
    venues: venues.map((v) => ({
      id: v.id,
      name: v.name,
      sessionCapacity: v.sessionCapacity,
      assistiveAvailable: v.assistiveAvailable ?? [],
      touchScope: tour.works.map((w) => {
        const auth = getTouchAuthorization(tour, w.id, v.id, at);
        if (!auth) {
          return { workId: w.id, title: w.title, touchable: false, note: '无双方确认的有效触摸授权' };
        }
        const due = cleaningDue(tour, w.id, v.id, at);
        return {
          workId: w.id,
          title: w.title,
          touchable: true,
          artistApprover: auth.artistApprover,
          venueApprover: auth.venueApprover,
          validFrom: auth.validFrom ?? null,
          validUntil: auth.validUntil ?? null,
          cleaningIntervalHours: auth.cleaningIntervalHours,
          lastCleaningAt: lastCleaningAt(tour, w.id, v.id),
          cleaningDue: due.due,
          touchGuidance: auth.touchGuidance ?? null,
        };
      }),
    })),
    bookings: tour.bookings.filter((b) => !venueId || b.venueId === venueId),
    sessions: tour.sessions.filter((s) => !venueId || s.venueId === venueId),
    cleanings: tour.cleanings.filter((c) => !venueId || c.venueId === venueId),
  };
}

// 策展视图：全部资料，用于从任一展出状态追溯原状、路径、批准人与开放结果
function curatorialView(tour) {
  return {
    role: ROLES.CURATORIAL,
    ...tour,
  };
}

export function buildView(tour, role, options = {}) {
  switch (role) {
    case ROLES.CARRIER_INSTALL:
      return carrierInstallView(tour, options);
    case ROLES.PUBLIC_EDUCATION:
      return publicEducationView(tour, options);
    case ROLES.CURATORIAL:
      return curatorialView(tour);
    default:
      throw new Error(`未知角色：${role}`);
  }
}
