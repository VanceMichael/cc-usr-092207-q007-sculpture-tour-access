// 触摸开放与无障碍活动规则：双重授权、清洁间隔、分组人数、监督与辅助讲解。

// 触摸准入：作者授权 + 场馆授权均有效，且作品、场馆处于可开放状态。
// 普通展签不构成许可——即使展签写着欢迎触摸，没有有效授权也不得开放。
export function touchAdmission(records, artworkId, venueId) {
  const artwork = records.artworksById.get(artworkId);
  const venue = records.venuesById.get(venueId);
  const reasons = [];
  if (!artwork) throw new Error(`未知作品：${artworkId}`);
  if (!venue) throw new Error(`未知场馆：${venueId}`);

  const auth = records.authorizations.find((a) => a.artwork_id === artworkId);
  if (!auth || auth.status !== 'active') reasons.push('无有效触摸授权或授权已撤回');
  if (auth && !auth.artist_consent) reasons.push('缺少作者书面确认');
  const venueConsent = auth?.venue_consents.find((c) => c.venue_id === venueId);
  if (auth && (!venueConsent || venueConsent.status !== 'active')) {
    reasons.push(`缺少场馆 ${venueId} 的有效确认`);
  }
  if (venue.status !== 'active') reasons.push('场馆已退出巡展');
  if (artwork.status === 'repair_hold') reasons.push('作品修复中，暂停开放');
  if (artwork.status === 'partial') reasons.push('作品组件不完整，暂停开放');

  return {
    artwork_id: artworkId,
    venue_id: venueId,
    allowed: reasons.length === 0,
    authorization_id: auth?.id ?? null,
    rules: reasons.length === 0
      ? {
          cleaning_interval_min: auth.cleaning_interval_min,
          max_group_size: auth.max_group_size,
          supervision_required: auth.supervision_required,
          scope_zones: auth.artist_consent.scope_zones
        }
      : null,
    reasons
  };
}

// 场次计划触摸的每件作品都须在该场馆通过准入。
export function sessionTouchPlan(records, sessionId) {
  const session = records.sessionsById.get(sessionId);
  if (!session) throw new Error(`未知场次：${sessionId}`);
  return session.planned_artwork_ids.map((artworkId) =>
    touchAdmission(records, artworkId, session.venue_id)
  );
}

// 已执行分组的合规性：人数、监督、距上次清洁的间隔。
export function checkHeldGroups(records, sessionId) {
  const session = records.sessionsById.get(sessionId);
  if (!session) throw new Error(`未知场次：${sessionId}`);

  return session.held_groups.map((group, index) => {
    const violations = [];
    const authRules = session.planned_artwork_ids.map((artworkId) => {
      const auth = records.authorizations.find((a) => a.artwork_id === artworkId && a.status === 'active');
      return auth ? { artwork_id: artworkId, rules: auth } : null;
    }).filter(Boolean);

    for (const { artwork_id, rules } of authRules) {
      if (rules.supervision_required && !group.supervision) {
        violations.push(`${artwork_id} 要求全程监督，本组未记录监督人员`);
      }
      if (group.visitors > rules.max_group_size) {
        violations.push(`${artwork_id} 单组限 ${rules.max_group_size} 人，本组 ${group.visitors} 人`);
      }
      if (new Date(group.cleaned_at).getTime() > new Date(group.at).getTime()) {
        violations.push(`${artwork_id} 本组开始前未完成清洁`);
      }
      if (index > 0) {
        const previousStart = new Date(session.held_groups[index - 1].at).getTime();
        const gapMin = (new Date(group.at).getTime() - previousStart) / 60000;
        if (gapMin < rules.cleaning_interval_min) {
          violations.push(`${artwork_id} 清洁间隔不足：距上组 ${gapMin} 分钟 < ${rules.cleaning_interval_min} 分钟`);
        }
      }
    }
    return { at: group.at, visitors: group.visitors, violations, passed: violations.length === 0 };
  });
}

// 预约需求与场次辅助讲解配置是否匹配（轮椅通道等场地需求一并核对）。
export function supportCoverage(records, sessionId) {
  const session = records.sessionsById.get(sessionId);
  if (!session) throw new Error(`未知场次：${sessionId}`);
  return records.bookings
    .filter((b) => b.session_id === sessionId && b.status !== 'cancelled')
    .map((booking) => ({
      booking_id: booking.id,
      visitor_kind: booking.visitor_kind,
      headcount: 1 + booking.companions,
      missing_needs: booking.needs.filter((need) => !session.supports.includes(need)),
      covered: booking.needs.every((need) => session.supports.includes(need))
    }));
}

// 场次可否实际举行：场馆待确认、延期场次不得开放；预约总人数不得超容量。
export function sessionReadiness(records, sessionId) {
  const session = records.sessionsById.get(sessionId);
  if (!session) throw new Error(`未知场次：${sessionId}`);
  const venue = records.venuesById.get(session.venue_id);
  const violations = [];
  if (session.status === 'venue_pending') violations.push('换场后场馆尚未二次确认');
  if (session.status === 'postponed') violations.push('场次已延期');
  if (venue?.status !== 'active') violations.push('场馆不在巡展序列');

  const plan = sessionTouchPlan(records, sessionId);
  for (const item of plan) {
    if (!item.allowed) violations.push(`${item.artwork_id} 触摸准入未通过：${item.reasons.join('；')}`);
  }

  const activeBookings = records.bookings.filter(
    (b) => b.session_id === sessionId && b.status !== 'cancelled'
  );
  const headcount = activeBookings.reduce((sum, b) => sum + 1 + b.companions, 0);
  if (headcount > session.capacity) violations.push(`预约 ${headcount} 人超出场次容量 ${session.capacity} 人`);

  for (const coverage of supportCoverage(records, sessionId)) {
    if (!coverage.covered) violations.push(`${coverage.booking_id} 辅助需求未配齐：${coverage.missing_needs.join('、')}`);
  }

  return {
    session_id: sessionId,
    status: session.status,
    headcount,
    capacity: session.capacity,
    ready: violations.length === 0,
    violations
  };
}
