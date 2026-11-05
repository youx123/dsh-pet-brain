/**
 * 沙箱验证「记忆写入 → 立刻影响桌宠说话」这条链路。
 *
 * 用临时 DSH_HOME，不动真库：
 *  1. 第一次跑：把现有条目全登记为已见，fresh 必须为空（不能把整个库当新记忆）
 *  2. 新写一条：它必须立刻出现在 fresh 里（且只有它）
 *  3. 再调一次：仍然在（30 分钟窗口内）
 *  4. buildSystem 必须把「刚记下的」那段拼进 prompt
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REAL = 'C:/Users/13176/.dsh/storages/dsh-shared-brain/memory.json';
const SANDBOX = mkdtempSync(join(tmpdir(), 'petbrain-fresh-'));
process.env.DSH_HOME = SANDBOX;

const storeDir = join(SANDBOX, 'storages', 'dsh-shared-brain');
cpSync(REAL, join(mkdtempSync(join(SANDBOX, 'seed-')), 'memory.json'), { recursive: false });

// 复制到规范位置
import { mkdirSync } from 'node:fs';
mkdirSync(storeDir, { recursive: true });
cpSync(REAL, join(storeDir, 'memory.json'));

const { freshMemoryEntries, watchFile } = await import('../lib/memory-watch.js');
const { buildSystem } = await import('../lib/brain.js');

const memPath = join(storeDir, 'memory.json');
const readMem = () => JSON.parse(readFileSync(memPath, 'utf8'));

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail += 1;
    console.log('  ✗ ' + name + ' — ' + String(e?.message ?? e).split('\n')[0]);
  }
};

console.log('沙箱：' + SANDBOX);
console.log('账本：' + watchFile());

// 1) 首次：全登记，不能冒出记忆
const mem0 = readMem();
const first = freshMemoryEntries(mem0, { minutes: 30, limit: 5 });
ok('首次运行不把整库当新记忆', () => assert.equal(first.length, 0));
ok('账本已落盘', () => assert.ok(readFileSync(watchFile(), 'utf8').includes('bootstrappedAt')));

// 2) 新写一条，立刻应被识别
const mem1 = readMem();
mem1.entries.push({
  id: 'mem_probe_fresh_' + Date.now(),
  text: '老大说：桌宠要记得我喜欢吃辣的，别老推荐甜的',
  tags: ['probe'],
  module: 'cognition',
  weight: 0.7,
  lifetime: 'permanent',
  source: 'probe',
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
writeFileSync(memPath, JSON.stringify(mem1), 'utf8');

const probeId = mem1.entries[mem1.entries.length - 1].id;
const second = freshMemoryEntries(mem1, { minutes: 30, limit: 5 });
ok('新写入的条目立刻被判为"刚学会"', () => {
  assert.equal(second.length, 1);
  assert.equal(second[0].id, probeId);
});
ok('只有新条目，老条目没被误判', () => assert.ok(second.every((x) => x.id === probeId)));

// 3) 第二次读仍然在窗口内
const third = freshMemoryEntries(mem1, { minutes: 30, limit: 5 });
ok('30 分钟窗口内仍然算刚学会', () => assert.equal(third.length, 1));

// 4) buildSystem 要把这段拼进去
const system = buildSystem({
  persona: { name: '小深', text: '你是小深。' },
  mood: null,
  memories: [],
  fresh: second,
  rules: [],
  voice: null,
});
ok('prompt 里有【你刚记下的】', () => assert.ok(system.includes('【你刚记下的】')));
ok('prompt 里带上了刚记的内容', () => assert.ok(system.includes('喜欢吃辣的')));
ok('提醒了别念清单', () => assert.ok(system.includes('别念清单')));

// 5) 和关键词召回重复时不重复列
const system2 = buildSystem({
  persona: { name: '小深', text: '你是小深。' },
  mood: null,
  memories: [{ text: '老大说：桌宠要记得我喜欢吃辣的，别老推荐甜的' }],
  fresh: second,
  rules: [],
  voice: null,
});
ok('与已召回内容重复时不重复列出', () => assert.ok(!system2.includes('【你刚记下的】')));

console.log('');
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 通过 ${pass} 项`);
process.exit(fail === 0 ? 0 : 1);
