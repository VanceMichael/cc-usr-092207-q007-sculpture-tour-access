// 策展全链路追溯：从任一展出状态追到作品原状、移动路径、批准人与特殊观众实际开放结果。

import { touchAdmission } from './access.js';

function byTime(items) {
  return [...items].sort((a, b) => new Date(a.at ?? a.starts_at ?? 0) - new Date(b.at ?? b.starts_at ?? 0));
}

// 作品涉及的包装箱 → 运段 → 交接，构成移动路径。
function movementPath(records, artworkId) {
  const crates = records.crates.filter((c) => c.contents.some((content) => content.ref === artworkId));
  return crates.map((crate) => {
    const shipments = records.shipments.filter((s) => s.crate_ids.includes(crate.id));
    return {
      crate_id: crate.id,
      legs: shipments.map((shipment) => ({
        shipment_id: shipment.id,
        from: shipment.from,
        to: shipment.to,
        planned_departure: shipment.planned_departure,
        planned_arrival: shipment.planned_arrival,
        actual_arrival: shipment.actual_arrival,
        status: shipment.status,
        requires_replan: shipment.requires_replan,
        handover: (() => {
          const handover = records.handovers.find((h) => h.shipment_id === shipment.id);
          return handover
            ? {
                id: handover.id,
                at: handover.at,
                rescheduled_at: handover.rescheduled_at,
                from_party: handover.from_party,
                to_party: handover.to_party,
                status: handover.status,
                inspection_ids: handover.inspection_ids
              }
            : null;
        })()
      }))
    };
  });
}

// 触摸批准链条：作者确认、各场馆确认、撤回事件。
function approvalChain(records, artworkId) {
  return records.authorizations
    .filter((a) => a.artwork_id === artworkId)
    .map((auth) => ({
      authorization_id: auth.id,
      status: auth.status,
      artist_consent: auth.artist_consent,
      venue_consents: auth.venue_consents,
      revoked_event: auth.revoked_event_id
        ? records.eventsById.get(auth.revoked_event_id) ?? null
        : null
    }));
}

// 面向特殊观众的实际开放结果：场次状态、准入判定、已执行分组的人数/清洁/监督、预约履约。
function accessResults(records, artworkId) {
  return records.sessions
    .filter((s) => s.planned_artwork_ids.includes(artworkId))
    .map((session) => ({
      session_id: session.id,
      venue_id: session.venue_id,
      starts_at: session.starts_at,
      status: session.status,
      admission: touchAdmission(records, artworkId, session.venue_id),
      supports: session.supports,
      held_groups: session.held_groups,
      bookings: records.bookings
        .filter((b) => b.session_id === session.id)
        .map((b) => ({
          id: b.id,
          visitor_kind: b.visitor_kind,
          companions: b.companions,
          needs: b.needs,
          status: b.status
        }))
    }));
}

export function traceArtwork(records, artworkId) {
  const artwork = records.artworksById.get(artworkId);
  if (!artwork) throw new Error(`未知作品：${artworkId}`);
  const reports = byTime(records.condition_reports.filter((r) => r.artwork_id === artworkId));
  return {
    artwork,
    artist: records.artistsById.get(artwork.artist_id) ?? null,
    baseline: reports.find((r) => r.stage === 'baseline') ?? null,
    condition_trail: reports,
    movement: movementPath(records, artworkId),
    approvals: approvalChain(records, artworkId),
    access_results: accessResults(records, artworkId)
  };
}
