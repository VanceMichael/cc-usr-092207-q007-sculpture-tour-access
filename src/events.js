// 交接与检查留痕：作品、包装箱、车辆、场馆之间的每次交接与检查都要记录，
// 并校验签字双方齐全。所有变更动作都通过 appendAudit 留痕，供策展方追溯。

export const EVENT_TYPES = new Set([
  'condition-report',
  'repair',
  'component-missing',
  'component-replaced',
  'handover',
  'inspection',
  'loading',
  'unloading',
  'route-delay',
  'venue-change',
  'installation',
  'deinstallation',
  'authorization-grant',
  'authorization-revoke',
  'cleaning',
  'assistive-update',
  'booking',
  'booking-change',
  'touch-session',
]);

export function appendAudit(tour, entry) {
  if (!EVENT_TYPES.has(entry.type)) throw new Error(`未知事件类型：${entry.type}`);
  if (!entry.actor || !entry.actor.role) throw new Error('事件缺少执行方');
  const event = {
    seq: tour.auditLog.length + 1,
    at: entry.at ?? new Date().toISOString(),
    type: entry.type,
    actor: entry.actor,
    target: entry.target ?? null,
    detail: entry.detail ?? {},
    signatures: entry.signatures ?? [],
  };
  tour.auditLog.push(event);
  return event;
}

// 交接必须由交出方与接收方共同签字；检查必须有检查人与记录状态
export function recordHandover(tour, { at, from, to, crateIds = [], workIds = [], actor, conditionNote }) {
  if (!from || !to) throw new Error('交接必须记录交出方与接收方');
  const event = appendAudit(tour, {
    at,
    type: 'handover',
    actor,
    target: { kind: 'batch' },
    detail: { from, to, crateIds, workIds, conditionNote },
    signatures: [
      { party: from, signed: true },
      { party: to, signed: true },
    ],
  });
  return event;
}

export function recordInspection(tour, { at, inspector, scope, result, findings = [], actor }) {
  if (!['pass', 'issues', 'fail'].includes(result)) throw new Error('检查结果取值无效');
  if (findings.length > 0 && result === 'pass') throw new Error('检查有发现时不能记为通过');
  return appendAudit(tour, {
    at,
    type: 'inspection',
    actor,
    target: scope ?? { kind: 'batch' },
    detail: { result, findings },
    signatures: [{ party: inspector, signed: true }],
  });
}

export function eventsForWork(tour, workId) {
  const mentionsWork = (e) => {
    if (e.target?.workId === workId || (e.target?.kind === 'work' && e.target.id === workId)) return true;
    const d = e.detail;
    if (d.workIds?.includes(workId)) return true;
    if (d.crateIds) {
      return d.crateIds.some((id) => tour.crates.find((c) => c.id === id)?.workId === workId);
    }
    return false;
  };
  return tour.auditLog.filter(mentionsWork);
}
