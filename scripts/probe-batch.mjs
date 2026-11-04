// 探测: 从 /plugins/events 拿当前 graph, 找到含 dsh-pet-brain 的 batch,
// 真的去下载那个 combo URL, 检查我的代码是否被拼进去、有没有语法错误。
// 只读, 不写盘(除了可选 dump)。
const BASE = process.argv[2] ?? 'http://127.0.0.1:59908';
const TARGET = 'dsh-pet-brain';

const res = await fetch(`${BASE}/plugins/events`, { headers: { accept: 'text/event-stream' } });
if (!res.ok) throw new Error(`events ${res.status}`);
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
let graph = null;
while (!graph) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  for (const line of buf.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const frame = JSON.parse(line.slice(6));
      if (frame.type === 'graph') graph = frame.graph;
    } catch {
      /* 不完整的行 */
    }
  }
}
try {
  await reader.cancel();
} catch {
  /* ignore */
}
if (!graph) throw new Error('没拿到 graph 帧');

const entry = graph.entries.find((e) => e.id === TARGET);
console.log('entry:', JSON.stringify(entry));
const batch = graph.batches.find((b) => b.entries.includes(TARGET));
console.log('batch phase:', batch.phase, 'rev:', batch.rev, 'entries:', batch.entries.length);
console.log('URL 长度:', batch.url.length, '字节');

const grabbed = await fetch(`${BASE}/${batch.url}`);
const text = await grabbed.text();
console.log('combo status:', grabbed.status, 'bytes:', text.length);
console.log('包含我的 id:', text.includes(TARGET));
console.log('包含我的 ping 端点:', text.includes('/pet-brain/ping'));
console.log('包含我的 factory 标记:', text.includes('__ModuleLoader__.load({ id: "dsh-pet-brain"') || text.includes("__ModuleLoader__.load({id:'dsh-pet-brain'") || text.includes('dsh-pet-brain'));
const idx = text.indexOf(TARGET);
console.log('首次出现位置:', idx);
// 把 service worker / 语法层面的问题也查一下: 用 new Function 尝试编译
try {
  new Function(text);
  console.log('combo 整体可编译: OK');
} catch (e) {
  console.log('combo 编译失败:', e.message);
}
// 单独编译我的那一段
const marker = 'window.__ModuleLoader__.load(';
const segs = [];
let from = 0;
for (;;) {
  const i = text.indexOf(marker, from);
  if (i === -1) break;
  segs.push(i);
  from = i + 1;
}
console.log('combo 内模块数(按 __ModuleLoader__.load 计):', segs.length);
