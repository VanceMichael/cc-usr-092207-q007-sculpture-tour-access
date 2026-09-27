// 读取并检查项目共享的领域资料。
export function parseDomain(raw) {
  const value = JSON.parse(raw);
  if (
    !value.domain ||
    !value.version ||
    !value.sample_id ||
    !Array.isArray(value.actors) || value.actors.length < 2 ||
    !Array.isArray(value.facts) || value.facts.length < 2 ||
    !Array.isArray(value.constraints) || value.constraints.length < 2
  ) {
    throw new Error('共享资料缺少必要字段');
  }
  if (value.version >= 2 && (!value.data || typeof value.data !== 'object')) {
    throw new Error('v2 共享资料缺少 data 业务数据');
  }
  return value;
}

// 以 id 建索引，便于各规则模块查找。
export function indexById(items = []) {
  const map = new Map();
  for (const item of items) {
    if (map.has(item.id)) throw new Error(`标识重复：${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

export function bindRecords(data) {
  const records = { ...data };
  records.artistsById = indexById(data.artists);
  records.artworksById = indexById(data.artworks);
  records.venuesById = indexById(data.venues);
  records.cratesById = indexById(data.crates);
  records.vehiclesById = indexById(data.vehicles);
  records.shipmentsById = indexById(data.shipments);
  records.reportsById = indexById(data.condition_reports);
  records.handoversById = indexById(data.handovers);
  records.inspectionsById = indexById(data.inspections);
  records.authsById = indexById(data.authorizations);
  records.sessionsById = indexById(data.sessions);
  records.bookingsById = indexById(data.bookings);
  records.eventsById = indexById(data.events);
  return records;
}

export function parseRecords(raw) {
  return bindRecords(parseDomain(raw).data);
}
