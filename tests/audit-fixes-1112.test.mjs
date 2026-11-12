/**
 * 2026-11-12 桌宠审计修复的回归测试。
 *
 * 覆盖这批改的六件事：
 *   1. emotionBiasOf 改成只认 sentiment（以前拿 module 兜底，永远命中不了）
 *   2. owner === 'self' 的条目不算（桌宠就是小深，别自己吓自己）
 *   3. sad / happy 两档极性跟共享大脑 SENTIMENTS 对齐
 *   4. 七维中文标签跟共享大脑一致（踏实 / 甜蜜）
 *   5. 客户端请求超时 110s（宿主那条会话要跑满 90s）
 *   6. 动画 blob 缓存有上限并回收（52 个素材 ~24MB）
 *   7. 手动启动读令牌走 DSH_HOME 口径
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'lib').replace(/\\/g, '/');

const { emotionBiasOf, DIMS } = await import(`file:///${LIB}/proactive.js`);
const { DIM_LABELS, DIM_KEYS } = await import(`file:///${LIB}/brain.js`);

const SRC = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}

console.log('桌宠审计修复回归（2026-11-12）');

check('负向 sentiment 现在能算出来（以前恒为 0）', () => {
  const bias = emotionBiasOf([{ sentiment: 'worry' }]);
  assert.equal(bias, -0.5);
});

check('两条负向累积到 -1', () => {
  const bias = emotionBiasOf([{ sentiment: 'worry' }, { sentiment: 'sad' }]);
  assert.equal(bias, -1);
});

check('正向 sentiment 加 0.2', () => {
  const bias = emotionBiasOf([{ sentiment: 'like' }]);
  assert.equal(bias, 0.2);
});

check('sad 算负向、happy 算正向（跟共享大脑 SENTIMENTS 对齐）', () => {
  assert.equal(emotionBiasOf([{ sentiment: 'sad' }]), -0.5);
  assert.equal(emotionBiasOf([{ sentiment: 'happy' }]), 0.2);
});

check('module 兜底已经去掉（module=cognition 不该被当成 sentiment）', () => {
  const bias = emotionBiasOf([{ module: 'cognition', sentiment: undefined }]);
  assert.equal(bias, 0);
});

check('owner=self 的条目不参与偏置', () => {
  const bias = emotionBiasOf([{ sentiment: 'sad', owner: 'self' }]);
  assert.equal(bias, 0);
});

check('owner=user 的条目参与偏置', () => {
  const bias = emotionBiasOf([{ sentiment: 'sad', owner: 'user' }]);
  assert.equal(bias, -0.5);
});

check('owner 没写（老数据）按 general 参与偏置', () => {
  const bias = emotionBiasOf([{ sentiment: 'sad' }]);
  assert.equal(bias, -0.5);
});

check('偏置夹在 -1..1 之间', () => {
  const bias = emotionBiasOf(Array.from({ length: 9 }, () => ({ sentiment: 'hate' })));
  assert.equal(bias, -1);
});

check('七维标签：calm=踏实、sweet=甜蜜（跟共享大脑一致）', () => {
  assert.equal(DIM_LABELS.calm, '踏实');
  assert.equal(DIM_LABELS.sweet, '甜蜜');
});

check('proactive.js 的 DIMS 与 brain.js 的 DIM_LABELS 同名同序', () => {
  assert.deepEqual(DIMS.map(([k]) => k), DIM_KEYS);
  for (const [key, label] of DIMS) {
    assert.equal(DIM_LABELS[key], label, `${key} 标签对不上`);
  }
});

check('客户端请求超时改成 110 秒（宿主那条会话要跑满 90 秒）', () => {
  const src = SRC('runtime/desktop/renderer.js');
  assert.ok(src.includes('init.timeoutMs ?? 110_000'), 'renderer.js 里的超时没改');
  assert.ok(!src.includes('init.timeoutMs ?? 45_000'), '旧的 45 秒还在');
});

check('动画 blob 缓存有上限，并且会 revokeObjectURL', () => {
  const src = SRC('lib/client.js');
  assert.ok(src.includes('BLOB_CACHE_MAX = 24'), 'BLOB_CACHE_MAX 没定义');
  assert.ok(src.includes('URL.revokeObjectURL'), '没回收 blob url');
});

check('手动启动读令牌走 DSH_HOME 口径', () => {
  const src = SRC('runtime/desktop/main.js');
  assert.ok(src.includes('process.env.DSH_HOME'), 'main.js 没读 DSH_HOME');
  assert.ok(
    !/homedir\(\), '\.dsh', 'dsh-pet-brain'/.test(src),
    '还写死 homedir()/.dsh',
  );
});

console.log(`\n${passed} 项通过`);
