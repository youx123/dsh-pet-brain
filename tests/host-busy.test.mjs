// 老大正在说话时，桌宠别凑热闹。
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'pet-busy-'))
process.env.DSH_HOME = home

const { hostBusy, refreshHostPulse, hostPulse } = await import('../lib/proactive.js')

const results = []
const check = (name, ok, extra = '') => results.push({ name, ok: Boolean(ok), extra })

// 1. 纯判定
check('hostBusy 对空值说 false', hostBusy(null) === false && hostBusy(undefined) === false)
check('hostBusy 认出 active', hostBusy({ active: true }) === true)
check('hostBusy 不认 active:false', hostBusy({ active: false }) === false)
check('hostBusy 不认字符串 "true"', hostBusy({ active: 'true' }) === false)

// 2. 缓存为空时不算忙（不能一开机就一直闭嘴）
check('没拉到脉搏时不算忙', hostPulse().active === false)

// 3. 真起一个极小的 /pulse 服务，验证拉取与过期
let payload = { ok: true, value: { enabled: true, at: Date.now(), fired: 1, active: true, lastTurnAt: Date.now() - 60 * 1000, text: '聊到读过的李白《将进酒》' } }
const server = createServer((req, res) => {
  if (req.url === '/api/dsh-shared-brain/pulse') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
    return
  }
  res.writeHead(404)
  res.end('{}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

await refreshHostPulse(origin)
const pulse = hostPulse()
check('拉到 active:true 后算忙', pulse.active === true)
check('带回了由头', pulse.text === '聊到读过的李白《将进酒》')

payload = { ok: true, value: { enabled: true, at: Date.now(), fired: 2, active: false, lastTurnAt: 0, text: '' } }
await refreshHostPulse(origin)
check('老大不说话了就恢复', hostPulse().active === false)

server.close()

// Windows 上偶尔删不掉，留着不碍事
try {
  rmSync(home, { recursive: true, force: true })
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  ' + r.extra}`)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : 'FAILED'} ${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)
