/**
 * 「刚才出过错」这件事的保鲜期。
 *
 * 桌宠在工作时会根据 `work.errors` 演一个「卡住了」的表情，提示里也会说
 * 「刚才出过 N 次错」。可这个计数以前只加不减：上午报过一次错，下午每次
 * 开工的头三十秒都还挂着那张脸，像一直在卡。
 *
 * 所以这里给错误加一个时间戳，超过保鲜期就不算数 —— 报错是「刚才」的事，
 * 不是永久标签。
 */

/** 错误在多少毫秒内还算「刚才」。10 分钟足够覆盖一次排障，又不至于挂一整天。 */
export const WORK_ERROR_MEMORY_MS = 10 * 60 * 1000

/**
 * 数一下还有多少次「新鲜」的错误。
 *
 * @param {{ errors?: number, errorsAt?: number } | null | undefined} work
 * @param {number} [now]
 * @param {number} [memoryMs]
 * @returns {number}
 */
export function recentErrors(work, now = Date.now(), memoryMs = WORK_ERROR_MEMORY_MS) {
  const count = Number(work?.errors ?? 0)
  if (!Number.isFinite(count) || count <= 0) return 0
  const at = Number(work?.errorsAt ?? 0)
  const span = Number.isFinite(Number(memoryMs)) ? Math.max(0, Number(memoryMs)) : WORK_ERROR_MEMORY_MS
  // 没有时间戳的老状态：当作早就过去了。这个字段由本模块的调用方在报错时写入，
  // 缺失只会发生在升级前的内存对象上，按「已过期」处理更接近真实情况。
  if (!Number.isFinite(at) || at <= 0) return 0
  const age = now - at
  // 时钟回拨（age 为负）时也认为新鲜，宁可多演一次担心的脸。
  if (age < 0) return count
  return age <= span ? count : 0
}

/** 给提示语用的短句；没有新鲜错误就返回空串。 */
export function renderErrorHint(work, now = Date.now(), memoryMs = WORK_ERROR_MEMORY_MS) {
  const count = recentErrors(work, now, memoryMs)
  if (count <= 0) return ''
  return `，刚才出过 ${count} 次错，可能正卡着`
}
