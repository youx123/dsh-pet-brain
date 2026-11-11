import { effectiveMood, moodFreshness, MOOD_COLD_MS, MOOD_STALE_MS } from '../lib/mood-fresh.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log('PASS  ' + name)
  } else {
    fail++
    console.log('FAIL  ' + name + '  ' + extra)
  }
}

const now = Date.UTC(2026, 10, 11, 12, 0, 0)
const mood = (hoursAgo) => ({
  mood: 81,
  band: { id: 'happy', label: '开心' },
  dims: { happy: 2 },
  reason: '事情落定了',
  updatedAt: now - hoursAgo * 3600000,
})

// 1. 新鲜度
const fresh = moodFreshness(mood(1), now)
check('一小时前算新鲜', fresh.stale === false && fresh.cold === false, JSON.stringify(fresh))
check('年龄折算成小时', Math.round(fresh.ageHours) === 1)
const stale = moodFreshness(mood(8), now)
check('八小时前算旧', stale.stale === true && stale.cold === false)
const cold = moodFreshness(mood(50), now)
check('五十小时前算过期', cold.cold === true)
check('没有时间戳算过期', moodFreshness({ mood: 80 }, now).cold === true)

// 2. 新鲜的照用，且不啰嗦
const bFresh = effectiveMood(mood(1), now)
check('新鲜：情绪原样', bFresh.mood === 81 && bFresh.band.id === 'happy')
check('新鲜：不写提示', bFresh.note === '')

// 3. 旧的照用但说明
const bStale = effectiveMood(mood(8), now)
check('旧：情绪还留着', bStale.mood === 81 && bStale.band.id === 'happy')
check('旧：提示写明几小时前', bStale.note.includes('8 小时'), bStale.note)
check('旧：不算过期', bStale.cold === false && bStale.stale === true)

// 4. 过期的抹平
const bCold = effectiveMood(mood(50), now)
check('过期：情绪回中性', bCold.mood === 50 && bCold.band.id === 'unknown', `${bCold.mood}/${bCold.band.id}`)
check('过期：维度清空', Object.keys(bCold.dims).length === 0)
check('过期：提示按天说', bCold.note.includes('2 天'), bCold.note)
check('过期：标记 cold', bCold.cold === true && bCold.stale === true)
check('过期：不残留旧理由', !String(bCold.reason ?? '').includes('落定') || bCold.reason === undefined)

// 5. 没有任何心情数据
const none = effectiveMood(null, now)
check('没有数据也不炸', none.mood === 50 && none.band.id === 'unknown')
check('没有数据也说明', none.note.includes('没有心情数据'), none.note)

// 6. 边界：正好 6 小时不算旧、正好 24 小时不算过期
check('六小时整不算旧', moodFreshness(mood(6), now).stale === false)
check('二十四小时整不算过期', moodFreshness(mood(24), now).cold === false)
check('常量对齐', MOOD_STALE_MS === 6 * 3600000 && MOOD_COLD_MS === 24 * 3600000)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
