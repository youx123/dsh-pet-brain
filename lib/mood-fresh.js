/**
 * 心情数据新鲜度。
 *
 * 2026-11-11 加：共享大脑里的情绪状态是"最近一次判定"的快照，判定有额度，
 * 可能一两天没更新。桌宠却一直按那份旧情绪演 —— 明明两天前是"开心"，
 * 今天还在蹦跶，这就不是灵动，是穿帮。
 *
 * 这里的口径：
 *   - 6 小时内的当现在的（正常用）；
 *   - 6~24 小时算"旧"，照用但在提示语里说明，别把旧的当新的讲；
 *   - 超过 24 小时算"过期"，不再按它选表情，回到中性，并说明原因。
 */

export const MOOD_STALE_MS = 6 * 60 * 60 * 1000
export const MOOD_COLD_MS = 24 * 60 * 60 * 1000

/** 这份心情离现在多久了。没有时间戳就当无限久。 */
export function moodFreshness(mood, now = Date.now()) {
  const at = Number(mood?.updatedAt ?? 0)
  const known = Number.isFinite(at) && at > 0
  const ageMs = known ? Math.max(0, Number(now) - at) : Number.POSITIVE_INFINITY
  return {
    known,
    at: known ? at : 0,
    ageMs,
    ageHours: Number.isFinite(ageMs) ? Math.round((ageMs / 3600000) * 10) / 10 : null,
    stale: ageMs > MOOD_STALE_MS,
    cold: ageMs > MOOD_COLD_MS,
  }
}

function hoursText(hours) {
  if (!Number.isFinite(hours)) return '很久'
  if (hours < 1) return '不到一小时'
  if (hours < 48) return `${Math.round(hours)} 小时`
  return `${Math.round(hours / 24)} 天`
}

/**
 * 把"这份心情还能不能用"算清楚，给上层直接拿去渲染。
 * 过期时连 mood / dims 一起抹平 —— 留着数字，上层迟早会有地方顺手用上。
 */
export function effectiveMood(mood, now = Date.now()) {
  const base = mood && typeof mood === 'object' ? mood : null
  const freshness = moodFreshness(base, now)
  if (!base) {
    return { mood: 50, unknown: true, band: { id: 'unknown', label: '说不准' }, dims: {}, reason: '', updatedAt: 0, freshness, cold: true, stale: true, note: '没有心情数据，先按平常对待。' }
  }
  if (freshness.cold) {
    return {
      ...base,
      // 数值这里留 50 是给 actionPool 分档用的（内部要一个中性数），
      // 但界面上不能再显示「50」—— 老大看到会以为心情真是 50，
      // 其实只是「太旧了，不知道」。所以另给一个 unknown 标记，
      // 渲染层看到它就把数字换成「—」。
      mood: 50,
      unknown: true,
      band: { id: 'unknown', label: '说不准' },
      dims: {},
      // 旧的判定理由也一起抹掉：那句「因为事情落定了」说的是两天前的事，
      // 留着会被当成此刻的心情解释。
      reason: '',
      freshness,
      cold: true,
      stale: true,
      note: `心情数据是 ${hoursText(freshness.ageHours)}前的了，先不按它演。`,
    }
  }
  if (freshness.stale) {
    return {
      ...base,
      unknown: false,
      freshness,
      cold: false,
      stale: true,
      note: `心情数据是 ${hoursText(freshness.ageHours)}前的，仅供参考。`,
    }
  }
  return { ...base, unknown: false, freshness, cold: false, stale: false, note: '' }
}
