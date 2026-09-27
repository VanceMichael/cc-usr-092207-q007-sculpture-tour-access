// 角色最小知情视图：各方只能取得职责范围内的资料。
// 白名单投影，新增字段默认不会随视图泄露。

const ROLES = {
  curator: '巡展策展团队',
  lender: '作品出借方',
  carrier: '艺术品承运安装人员',
  education: '公教与无障碍服务人员'
};

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
  }
  return out;
}

// 承运与安装人员：重量、支撑、箱体、运段、点位、安装依赖、状况与交接检查。
// 不含作者身份、借展合同条款、触摸授权、预约观众信息。
function carrierView(records) {
  return {
    role: ROLES.carrier,
    venues: records.venues.map((v) => pick(v, ['id', 'name', 'status', 'galleries'])),
    artworks: records.artworks.map((w) =>
      pick(w, ['id', 'title', 'material', 'weight_kg', 'support_method', 'footprint_m2', 'status', 'components'])
    ),
    positions: records.positions,
    install_dependencies: records.install_dependencies,
    crates: records.crates,
    vehicles: records.vehicles,
    shipments: records.shipments,
    condition_reports: records.condition_reports,
    handovers: records.handovers,
    inspections: records.inspections
  };
}

// 公教与无障碍服务人员：可触摸范围、清洁间隔、分组与监督要求、场次与预约辅助需求。
// 只能看到授权是否存在与授权范围，不暴露批准人身份；看不到运输与状况合同细节。
function educationView(records) {
  return {
    role: ROLES.education,
    venues: records.venues.map((v) => pick(v, ['id', 'name', 'status'])),
    artworks: records.artworks.map((w) => pick(w, ['id', 'title', 'status'])),
    authorizations: records.authorizations.map((a) => ({
      id: a.id,
      artwork_id: a.artwork_id,
      status: a.status,
      artist_consent_granted: Boolean(a.artist_consent),
      scope_zones: a.artist_consent?.scope_zones ?? [],
      venue_consents: a.venue_consents.map((c) => pick(c, ['venue_id', 'status'])),
      cleaning_interval_min: a.cleaning_interval_min,
      max_group_size: a.max_group_size,
      supervision_required: a.supervision_required
    })),
    sessions: records.sessions,
    bookings: records.bookings.map((b) =>
      pick(b, ['id', 'session_id', 'visitor_kind', 'companions', 'needs', 'status'])
    )
  };
}

// 出借方：自家作品的原状、状况报告与授权处置；不含运输商业排程与观众预约。
function lenderView(records) {
  return {
    role: ROLES.lender,
    artworks: records.artworks,
    condition_reports: records.condition_reports,
    authorizations: records.authorizations
  };
}

// 策展团队：全量资料（追溯由 traceArtwork 提供）。
function curatorView(records) {
  return { role: ROLES.curator, ...records };
}

export function roleView(records, role) {
  switch (role) {
    case 'carrier': return carrierView(records);
    case 'education': return educationView(records);
    case 'lender': return lenderView(records);
    case 'curator': return curatorView(records);
    default:
      throw new Error(`未知角色：${role}`);
  }
}

export { ROLES };
