// 校验 lib/index.js 里引用的动画名，是否都能在 assets/webm 找到对应文件。
// 名字写错不会报错，只会在客户端静默 404 —— 表现就是「桌宠一直那几个动作」。
// 用法: node scripts/assets-audit.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'lib/index.js'), 'utf8');
const files = new Set(
  readdirSync(join(root, 'assets/webm'))
    .filter((f) => f.endsWith('.webm'))
    .map((f) => f.slice(0, -'.webm'.length)),
);

// 只扫动作池那几段：从 BAND_ACTIONS 定义到 listAnimations 函数之前。
// 全文件抓中文会把报错文案（'模型未返回文本'）也算进来。
const from = src.indexOf('const BAND_ACTIONS');
const to = src.indexOf('function listAnimations');
const scope = from >= 0 && to > from ? src.slice(from, to) : src;

const referenced = new Set();
for (const m of scope.matchAll(/'([^'\n]*[\u4e00-\u9fa5][^'\n]*)'/g)) {
  if (/[\s，。、！？]/.test(m[1])) continue;
  referenced.add(m[1]);
}

const missing = [...referenced].filter((name) => !files.has(name)).sort();
const unused = [...files].filter((name) => !referenced.has(name)).sort();

console.log(`素材 ${files.size} 个，index.js 引用 ${referenced.size} 个中文名`);
if (missing.length) {
  console.log(`\n✗ 引用了但素材不存在（${missing.length}，客户端会 404）：`);
  for (const n of missing) console.log(`   ${n}`);
} else {
  console.log('\n✓ 所有引用都有素材');
}
if (unused.length) {
  console.log(`\n· 素材没被引用（${unused.length}，留着不影响）：`);
  console.log(`   ${unused.join('、')}`);
}
process.exit(missing.length ? 1 : 0);
