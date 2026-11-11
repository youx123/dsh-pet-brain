import {
  moodSignature,
  actionPool,
  rankedDims,
  BAND_ACTIONS,
  DIM_TIERS,
  COMBO_ACTIONS,
  DIM_HOT,
  DIM_STRONG,
  DIM_RELATIVE_MIN,
} from '../lib/mood-anim.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const mood = (dims, band = 'ok') => ({ mood: 71, band: { id: band, label: band }, dims })

// 1. 空心情 / 全零
check('没有心情 → unknown', moodSignature(undefined).band === 'unknown')
check('没有心情 → 档位池', moodSignature(undefined).pool === BAND_ACTIONS.unknown)
check('全零维度 → 档位池', moodSignature(mood({})).tier === 'band')
check('全零维度 → via=band', moodSignature(mood({})).via === 'band')

// 2. 绝对路：一维够到 DIM_HOT
const strong = moodSignature(mood({ happy: DIM_STRONG + 1, calm: 0 }))
check('绝对：高分走 strong', strong.tier === 'strong', JSON.stringify(strong))
check('绝对：strong 走绝对路', strong.via === 'absolute')
check('绝对：strong 池是 strong 那套', strong.pool === DIM_TIERS.happy.strong)

const mild = moodSignature(mood({ happy: DIM_HOT, calm: 0 }))
check('绝对：够门槛但不够 strong → mild', mild.tier === 'mild', JSON.stringify(mild))

// 3. 绝对路：两维都够门槛 → combo
const combo = moodSignature(mood({ happy: 5, sweet: 5 }))
check('绝对：两维齐 → combo', combo.tier === 'combo', JSON.stringify(combo))
check('绝对：combo 池对得上', combo.pool === COMBO_ACTIONS['happy|sweet'])

// 4. 相对路：绝对门槛够不到，但有一维明显领先
const rel = moodSignature(mood({ happy: 2, calm: 1 }))
check('相对：2 比 1 领先 → 不退回档位', rel.tier !== 'band', JSON.stringify(rel))
check('相对：走相对路', rel.via === 'relative')
check('相对：领先的那一维被选中', rel.top[0] === 'happy', JSON.stringify(rel.top))
check('相对：只给 mild（绝对值不够 strong）', rel.tier === 'mild')
check('相对：池是该维的 mild', rel.pool === DIM_TIERS.happy.mild)

// 5. 相对路：两维都在场且只差一点点 → combo
const relCombo = moodSignature(mood({ happy: 3, sweet: 3 }))
check('相对：两维只差 1 → combo', relCombo.tier === 'combo', JSON.stringify(relCombo))
check('相对：combo 也标相对路', relCombo.via === 'relative')

// 6. 平数据不算信号：全维度一样 → 退回档位
const flat = moodSignature(mood({ happy: 1, calm: 1, worry: 1 }))
check('平数据（全 1）→ 退回档位', flat.tier === 'band', JSON.stringify(flat))
const flat2 = moodSignature(mood({ happy: 2, calm: 2 }))
check('两维同为 2 → 算组合（这两维独占了场面）', flat2.tier === 'combo', JSON.stringify(flat2))
const flat3 = moodSignature(mood({ happy: 2, calm: 2, worry: 2 }))
check('三维同为 2 → 平数据，退回档位', flat3.tier === 'band', JSON.stringify(flat3))

// 7. 峰值太低不算领先
const low = moodSignature(mood({ happy: 1, calm: 0 }))
check('峰值 1 不到相对门槛 → 退回档位', low.tier === 'band', JSON.stringify(low))
check('相对门槛是 2', DIM_RELATIVE_MIN === 2)

// 8. 同值按 DIM_KEYS 顺序，top 稳定
const tie = moodSignature(mood({ worry: 3, happy: 3 }))
check('同值时按固定顺序取 top', tie.top[0] === 'happy', JSON.stringify(tie.top))
const ranked = rankedDims({ dims: { happy: 3, calm: 3, worry: 1 } })
check('排序：值降序', ranked[0].value === 3 && ranked[1].value === 3 && ranked[2].value === 1)
check('排序：同值按 DIM_KEYS', ranked[0].key === 'happy' && ranked[1].key === 'calm')

// 9. actionPool 与 signature 一致
check('actionPool = signature.pool', actionPool(mood({ happy: 2, calm: 1 })).join() === moodSignature(mood({ happy: 2, calm: 1 })).pool.join())

// 10. 所有动作名都在 assets 里
const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'webm')
const files = new Set(fs.readdirSync(assets).filter((f) => f.endsWith('.webm')).map((f) => f.replace(/\.webm$/, '')))
const used = new Set()
for (const list of Object.values(BAND_ACTIONS)) for (const a of list) used.add(a)
for (const dim of Object.values(DIM_TIERS)) {
  for (const a of dim.strong) used.add(a)
  for (const a of dim.mild) used.add(a)
}
for (const list of Object.values(COMBO_ACTIONS)) for (const a of list) used.add(a)
const missing = [...used].filter((a) => !files.has(a))
check('映射里的动作名都真实存在（' + used.size + '/' + files.size + '）', missing.length === 0, missing.join(','))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exit(1)
