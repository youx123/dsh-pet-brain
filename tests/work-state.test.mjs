/** 桌宠的「刚才出过错」要能过期，不然一次报错挂一整天。 */
import { recentErrors, renderErrorHint, WORK_ERROR_MEMORY_MS } from 'file:///C:/Users/13176/Documents/dsh-pet-brain/lib/work-state.js'

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++
    console.log('PASS  ' + name)
  } else {
    fail++
    console.log('FAIL  ' + name + '  ' + extra)
  }
}

const now = 1_800_000_000_000

check('没出过错回 0', recentErrors({ errors: 0 }, now) === 0)
check('十秒前报的错还算', recentErrors({ errors: 2, errorsAt: now - 10_000 }, now) === 2)
check('半小时前报的错不算', recentErrors({ errors: 2, errorsAt: now - 30 * 60 * 1000 }, now) === 0)
check('刚好到保鲜期仍算', recentErrors({ errors: 1, errorsAt: now - WORK_ERROR_MEMORY_MS }, now) === 1)
check('刚过保鲜期不算', recentErrors({ errors: 1, errorsAt: now - WORK_ERROR_MEMORY_MS - 1 }, now) === 0)
check('没有时间戳的老状态当过期', recentErrors({ errors: 3 }, now) === 0)
check('时钟回拨也认', recentErrors({ errors: 1, errorsAt: now + 5000 }, now) === 1)
check('脏数据不炸', recentErrors({ errors: 'x', errorsAt: 'y' }, now) === 0)
check('null 不炸', recentErrors(null, now) === 0)
check('自定义保鲜期生效', recentErrors({ errors: 1, errorsAt: now - 2000 }, now, 1000) === 0)

check('有新鲜错误时给提示', renderErrorHint({ errors: 1, errorsAt: now - 1000 }, now).includes('刚才出过 1 次错'))
check('错误过期后不再提示', renderErrorHint({ errors: 1, errorsAt: now - 30 * 60 * 1000 }, now) === '')
check('没错误不提示', renderErrorHint({ errors: 0 }, now) === '')
check('保鲜期常量是十分钟', WORK_ERROR_MEMORY_MS === 10 * 60 * 1000)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
