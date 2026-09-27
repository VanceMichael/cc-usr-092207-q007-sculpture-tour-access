// 运输与布展规则：重量、承重、支撑与安装依赖、组件完整性。

const SUPPORT_FEATURE = {
  地脚固定: 'anchor',
  悬挂吊装: 'rigging',
  台座展陈: 'plinth',
  独立落地: null
};

function findComponent(records, componentId) {
  for (const artwork of records.artworks) {
    const component = artwork.components.find((c) => c.id === componentId);
    if (component) return { artwork, component };
  }
  return null;
}

function contentWeight(records, content) {
  if (content.kind === 'artwork') {
    return records.artworksById.get(content.ref)?.weight_kg ?? 0;
  }
  return findComponent(records, content.ref)?.component.weight_kg ?? 0;
}

// 包装箱毛重 = 皮重 + 内装物重量；同时校验箱体限重。
export function crateWeight(records, crateId) {
  const crate = records.cratesById.get(crateId);
  if (!crate) throw new Error(`未知包装箱：${crateId}`);
  const load = crate.contents.reduce((sum, content) => sum + contentWeight(records, content), 0);
  return {
    crate_id: crate.id,
    tare_kg: crate.tare_kg,
    load_kg: load,
    total_kg: crate.tare_kg + load,
    within_crate_limit: load <= crate.max_load_kg
  };
}

// 车辆运段装载：合计随车包装箱毛重，对照车辆载重。
export function shipmentLoad(records, shipmentId) {
  const shipment = records.shipmentsById.get(shipmentId);
  if (!shipment) throw new Error(`未知运段：${shipmentId}`);
  const vehicle = records.vehiclesById.get(shipment.vehicle_id);
  const crates = shipment.crate_ids.map((id) => crateWeight(records, id));
  const total = crates.reduce((sum, c) => sum + c.total_kg, 0);
  return {
    shipment_id: shipment.id,
    vehicle_id: shipment.vehicle_id,
    payload_kg: vehicle?.payload_kg ?? null,
    crates,
    total_kg: total,
    within_vehicle_payload: vehicle ? total <= vehicle.payload_kg : null,
    all_crates_within_limit: crates.every((c) => c.within_crate_limit)
  };
}

export function checkAllShipments(records) {
  return records.shipments.map((s) => shipmentLoad(records, s.id));
}

function galleryLimit(records, venueId, gallery) {
  return records.venuesById.get(venueId)?.galleries.find((g) => g.id === gallery)?.load_limit_kg_m2 ?? null;
}

// 展厅点位承重：作品重量 / 占地面积，对照点位与展厅设计承重。
export function positionLoadCheck(records, positionId) {
  const position = records.positions.find((p) => p.id === positionId);
  if (!position) throw new Error(`未知点位：${positionId}`);
  if (!position.artwork_id) return { position_id: positionId, placed: false };
  const artwork = records.artworksById.get(position.artwork_id);
  const kgPerM2 = artwork.weight_kg / position.footprint_m2;
  const galleryLimitKg = galleryLimit(records, position.venue_id, position.gallery);
  const limits = [position.floor_load_limit_kg_m2, galleryLimitKg].filter((v) => v != null);
  return {
    position_id: position.id,
    artwork_id: artwork.id,
    kg_per_m2: round1(kgPerM2),
    position_limit_kg_m2: position.floor_load_limit_kg_m2,
    gallery_limit_kg_m2: galleryLimitKg,
    within_load: limits.every((limit) => kgPerM2 <= limit)
  };
}

export function missingRequiredComponents(artwork) {
  return artwork.components.filter((c) => c.required && !c.present).map((c) => c.id);
}

// 作品在某场馆的安装阻断条件：修复/缺件状态、点位承重、支撑与安装依赖。
export function installBlockers(records, artworkId, venueId) {
  const artwork = records.artworksById.get(artworkId);
  if (!artwork) throw new Error(`未知作品：${artworkId}`);
  const blockers = [];

  if (artwork.status === 'repair_hold') blockers.push('作品处于修复冻结状态，不得布展');
  const missing = missingRequiredComponents(artwork);
  if (missing.length > 0) blockers.push(`必备组件缺失：${missing.join('、')}`);

  const position = records.positions.find((p) => p.venue_id === venueId && p.artwork_id === artworkId);
  if (!position) {
    blockers.push(`场馆 ${venueId} 未分配该作品点位`);
    return { artwork_id: artworkId, venue_id: venueId, ready: false, blockers };
  }

  const load = positionLoadCheck(records, position.id);
  if (!load.within_load) blockers.push(`点位承重不足：${load.kg_per_m2}kg/m² 超出限值`);

  const neededFeatures = new Set();
  const supportFeature = SUPPORT_FEATURE[artwork.support_method];
  if (supportFeature) neededFeatures.add(supportFeature);
  const dependency = records.install_dependencies.find((d) => d.artwork_id === artworkId);
  const dependencyDetails = [];
  if (dependency) {
    for (const requirement of dependency.requires) {
      neededFeatures.add(requirement.type);
      dependencyDetails.push(requirement.detail);
    }
  }
  const missingFeatures = [...neededFeatures].filter((feature) => !position.features.includes(feature));
  if (missingFeatures.length > 0) {
    blockers.push(`点位缺少安装条件：${missingFeatures.join('、')}`);
  }

  return {
    artwork_id: artworkId,
    venue_id: venueId,
    position_id: position.id,
    ready: blockers.length === 0,
    blockers,
    dependency_details: dependencyDetails
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
