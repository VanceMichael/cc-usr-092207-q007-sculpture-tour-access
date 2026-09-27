// 六类事件的联动处理与交接/检查留痕完整性。
// recordEvent 不改动入参：基于深拷贝追加事件并派生后续安排，既往记录原样保留（只追加原则）。

const EVENT_TYPES = [
  'repair',
  'missing_component',
  'route_delay',
  'venue_change',
  'authorization_withdrawn',
  'support_change'
];

function clone(value) {
  return structuredClone(value);
}

function cratesCarrying(records, ref) {
  return records.crates.filter((c) => c.contents.some((content) => content.ref === ref));
}

function openShipmentsFor(records, crateIds) {
  const set = new Set(crateIds);
  return records.shipments.filter(
    (s) => s.status !== 'completed' && s.crate_ids.some((id) => set.has(id))
  );
}

// 依据事件类型机械派生联动动作，并应用到副本。
export function recordEvent(records, input) {
  if (!EVENT_TYPES.includes(input.type)) throw new Error(`未知事件类型：${input.type}`);
  if (!input.id || !input.at || !input.summary) throw new Error('事件缺少 id/at/summary');
  if (records.events.some((e) => e.id === input.id)) throw new Error(`事件标识已存在：${input.id}`);

  const next = clone(records);
  const cascade = [];
  const payload = input.payload ?? {};

  const apply = (action, ref, detail) => cascade.push({ action, ref, detail });

  if (input.type === 'repair' || input.type === 'missing_component') {
    let artworkId = payload.artwork_id;
    if (input.type === 'missing_component') {
      const owner = next.artworks.find((w) => w.components.some((c) => c.id === input.ref));
      if (!owner) throw new Error(`未知组件：${input.ref}`);
      const component = owner.components.find((c) => c.id === input.ref);
      component.present = false;
      artworkId = owner.id;
    }
    const artwork = next.artworksById.get(artworkId);
    if (!artwork) throw new Error(`未知作品：${artworkId}`);
    artwork.status = input.type === 'repair' ? 'repair_hold' : 'partial';
    apply(input.type === 'repair' ? 'artwork_hold' : 'artwork_partial', artworkId,
      input.type === 'repair' ? '状态置为 repair_hold' : '状态置为 partial，相关点位不予上件');

    for (const shipment of openShipmentsFor(next, cratesCarrying(next, artworkId).map((c) => c.id))) {
      shipment.requires_replan = true;
      apply('shipment_replan', shipment.id, '运段须重新排程');
    }
  }

  if (input.type === 'route_delay') {
    const shipment = next.shipmentsById.get(input.ref);
    if (!shipment) throw new Error(`未知运段：${input.ref}`);
    shipment.status = 'delayed';
    shipment.requires_replan = true;
    apply('shipment_delayed', shipment.id, '状态置为 delayed');
    if (payload.rescheduled_at) {
      const handover = next.handovers.find((h) => h.shipment_id === shipment.id && h.status === 'scheduled');
      if (handover) {
        handover.rescheduled_at = payload.rescheduled_at;
        apply('handover_reschedule', handover.id, `交接顺延至 ${payload.rescheduled_at}`);
      }
      // 新预计到达时间之前、目的场馆尚未举行的触摸场次随之延期。
      const eta = new Date(payload.rescheduled_at).getTime();
      for (const session of next.sessions) {
        if (
          session.venue_id === shipment.to &&
          !session.held_groups.length &&
          ['scheduled', 'venue_pending'].includes(session.status) &&
          new Date(session.starts_at).getTime() < eta
        ) {
          session.status = 'postponed';
          apply('session_postpone', session.id, '受运段延误影响，场次延期');
          for (const booking of next.bookings.filter((b) => b.session_id === session.id && b.status === 'reserved')) {
            booking.status = 'cancelled';
            apply('booking_cancel', booking.id, '场次延期，预约取消并通知重约');
          }
        }
      }
    }
  }

  if (input.type === 'venue_change') {
    const oldVenue = next.venuesById.get(input.ref);
    const replacementId = payload.replacement_venue_id;
    const newVenue = next.venuesById.get(replacementId);
    if (!oldVenue || !newVenue) throw new Error('场馆变更信息不完整');
    oldVenue.status = 'withdrawn';
    apply('venue_withdrawn', oldVenue.id, `场馆退出巡展，点位释放`);

    // 旧场馆已分配点位释放；按 position_map 改陈到替补场馆点位。
    for (const position of next.positions.filter((p) => p.venue_id === oldVenue.id && p.artwork_id)) {
      const artworkId = position.artwork_id;
      position.artwork_id = null;
      apply('position_release', position.id, `旧点位释放，作品 ${artworkId} 撤出`);
      const targetId = payload.position_map?.[artworkId];
      if (targetId) {
        const target = next.positions.find((p) => p.id === targetId);
        if (!target || target.venue_id !== newVenue.id) throw new Error(`改陈点位无效：${targetId}`);
        target.artwork_id = artworkId;
        apply('position_reassign', artworkId, `改陈至 ${newVenue.id} 的 ${targetId}`);
      }
    }
    for (const shipment of next.shipments.filter((s) => s.to === oldVenue.id && s.status !== 'completed')) {
      shipment.to = newVenue.id;
      apply('shipment_reroute', shipment.id, `目的地改为 ${newVenue.id}`);
    }
    for (const handover of next.handovers.filter((h) => h.status === 'scheduled' && h.to_party.startsWith(`${oldVenue.id} `))) {
      handover.to_party = `${newVenue.id} 馆方`;
      apply('handover_reschedule', handover.id, `交接改由 ${newVenue.id} 馆方接收`);
    }
    for (const session of next.sessions.filter((s) => s.venue_id === oldVenue.id)) {
      session.venue_id = newVenue.id;
      session.status = 'venue_pending';
      apply('session_relocate', session.id, `场次移至 ${newVenue.id}，待馆方二次确认`);
    }
  }

  if (input.type === 'authorization_withdrawn') {
    const auth = next.authsById.get(input.ref);
    if (!auth) throw new Error(`未知授权：${input.ref}`);
    auth.status = 'revoked';
    auth.revoked_event_id = input.id;
    apply('authorization_revoke', auth.id, '授权置为 revoked，全部场馆立即停止触摸开放');
    for (const session of next.sessions) {
      if (session.planned_artwork_ids.includes(auth.artwork_id)) {
        session.planned_artwork_ids = session.planned_artwork_ids.filter((id) => id !== auth.artwork_id);
        apply('session_remove_artwork', session.id, `已排触摸作品中剔除 ${auth.artwork_id}`);
      }
    }
  }

  if (input.type === 'support_change') {
    const booking = next.bookingsById.get(input.ref);
    if (!booking) throw new Error(`未知预约：${input.ref}`);
    for (const need of payload.add_needs ?? []) {
      if (!booking.needs.includes(need)) {
        booking.needs.push(need);
        apply('booking_update_needs', booking.id, `需求增加 ${need}`);
      }
      const session = next.sessionsById.get(booking.session_id);
      if (session && !session.supports.includes(need)) {
        session.supports.push(need);
        apply('session_add_support', session.id, `场次辅助讲解增配 ${need}`);
      }
    }
  }

  next.events.push({
    id: input.id,
    type: input.type,
    at: input.at,
    ref: input.ref,
    summary: input.summary,
    payload,
    cascade
  });
  return { records: next, event: next.events[next.events.length - 1] };
}

// 留痕完整性：标识唯一、交接引用的报告/检查/箱体必须存在、事件联动引用必须可解析。
export function verifyAuditTrail(records) {
  const problems = [];
  const uniqueIds = (label, items) => {
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item.id)) problems.push(`${label} 标识重复：${item.id}`);
      seen.add(item.id);
    }
    return seen;
  };
  const reportIds = uniqueIds('状况报告', records.condition_reports);
  const inspectionIds = uniqueIds('检查记录', records.inspections);
  const crateIds = uniqueIds('包装箱', records.crates);
  uniqueIds('交接', records.handovers);
  uniqueIds('事件', records.events);

  for (const handover of records.handovers) {
    for (const id of handover.report_ids) {
      if (!reportIds.has(id)) problems.push(`交接 ${handover.id} 引用了不存在的状况报告：${id}`);
    }
    for (const id of handover.inspection_ids) {
      if (!inspectionIds.has(id)) problems.push(`交接 ${handover.id} 引用了不存在的检查记录：${id}`);
    }
    for (const id of handover.crate_ids) {
      if (!crateIds.has(id)) problems.push(`交接 ${handover.id} 引用了不存在的包装箱：${id}`);
    }
    if (handover.shipment_id && !records.shipmentsById.has(handover.shipment_id)) {
      problems.push(`交接 ${handover.id} 引用了不存在的运段：${handover.shipment_id}`);
    }
  }

  for (const auth of records.authorizations) {
    if (auth.revoked_event_id && !records.eventsById.has(auth.revoked_event_id)) {
      problems.push(`授权 ${auth.id} 指向不存在的撤回事件：${auth.revoked_event_id}`);
    }
  }

  // 事件联动引用的对象（作品/组件/运段/交接/场次/预约/授权/场馆/点位）必须可解析。
  const known = new Set();
  for (const collection of ['artworks', 'positions', 'crates', 'vehicles', 'shipments',
    'condition_reports', 'handovers', 'inspections', 'authorizations', 'sessions', 'bookings', 'venues']) {
    for (const item of records[collection]) known.add(item.id);
  }
  for (const artwork of records.artworks) {
    for (const component of artwork.components) known.add(component.id);
  }

  for (const event of records.events) {
    if (!event.cascade?.length) {
      problems.push(`事件 ${event.id} 没有联动记录`);
      continue;
    }
    for (const step of event.cascade) {
      if (!known.has(step.ref)) problems.push(`事件 ${event.id} 联动引用无法解析：${step.action} → ${step.ref}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
