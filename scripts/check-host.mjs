/**
 * 宿主侧冒烟测试：起一个真 HTTP server，把 /pet-brain 的路由挂上去真调一遍。
 * 不启动 DSH、不调模型，验证 config / state / anim 三个端点与鉴权边界。
 * 用法：node scripts/check-host.mjs
 */
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href);

let route = null;
mod.apply({
  effect: (fn) => {
    const d = fn();
    return typeof d === 'function' ? d : () => {};
  },
  // 插件会订阅事件；冒烟测试不需要真收到
  on: () => () => {},
  off: () => {},
  webServer: {
    register(r) {
      route = r;
      return () => {};
    },
  },
  agents: {
    list: () => [],
  },
});
if (!route) throw new Error('没有注册路由');
console.log('✓ 注册路由', route.kind, route.path);

const server = http.createServer((req, res) => route.handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log('✓ 测试服务器', base);

const get = (p) => fetch(base + p);
const show = (label, r) => console.log(label, r.status, r.headers.get('content-type'));

const cfgRes = await get('/pet-brain/config');
show('✓ /config', cfgRes);
const cfg = await cfgRes.json();
console.log('   pollMs =', cfg.pollMs, ' size =', cfg.size);
console.log('   动画键 =', Object.keys(cfg.animations).join(','));
console.log('   档位映射 =', JSON.stringify(cfg.bandActions));

const stRes = await get('/pet-brain/state');
show('✓ /state', stRes);
const stJson = await stRes.json();
console.log('   voice =', JSON.stringify(stJson.voice));
console.log('  ', JSON.stringify(stJson).slice(0, 240));

const sessRes = await get('/pet-brain/state?session=no-such-session');
show('✓ /state?session=（不存在时应回落）', sessRes);

const animRes = await get('/pet-brain/anim/' + encodeURIComponent(cfg.animations.idle) + '.webm');
show('✓ 取素材', animRes);
const buf = Buffer.from(await animRes.arrayBuffer());
console.log('   字节数 =', buf.length, ' 头 =', buf.subarray(0, 4).toString('hex'), '(webm 应为 1a45dfa3)');

const travRes = await get('/pet-brain/anim/' + encodeURIComponent('../../package.json'));
show('✓ 路径穿越被拒', travRes);

const missRes = await get('/pet-brain/nope');
show('✓ 未知路径', missRes);

// 主动互动：决策要能读到共享大脑主会话的脉搏（host.sinceMs 是距主会话上次开口的毫秒数）
const proRes = await get('/pet-brain/proactive');
show('✓ /proactive', proRes);
const pro = await proRes.json();
console.log('   action =', pro.action, ' reason =', pro.reason, ' followHost =', pro.followHost, ' retryMs =', pro.retryMs);
console.log('   host =', JSON.stringify(pro.host));
console.log('   pacing =', JSON.stringify({ quiet: pro.config?.mood?.quietPeriodMs, maxPerDay: pro.config?.mood?.maxPerDay }));

const postRes = await fetch(base + '/pet-brain/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '' }),
});
show('✓ 空文本被拒', postRes);
console.log('  ', await postRes.text());

server.close();
console.log('\n全部通过');
