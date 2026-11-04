// 在 app.asar 的全部脚本文件里搜关键词，打印命中行 + 上下文（只读）
// 用法: node scripts/asar-grep.mjs <asar路径> <关键词> [上下文行数] [最多命中数]
import { readFileSync } from 'node:fs';

const [, , asarPath, needle, ctxArg = '3', maxArg = '40'] = process.argv;
if (!needle) {
  console.error('缺少关键词');
  process.exit(2);
}
const ctx = Number(ctxArg) || 3;
const maxHits = Number(maxArg) || 40;

const buf = readFileSync(asarPath);
const headerSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'));
const dataStart = 8 + buf.readUInt32LE(4);

const files = [];
const walk = (node, prefix) => {
  for (const [name, meta] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (meta.files) walk(meta, p);
    else if (/\.(?:js|mjs|cjs)$/.test(p)) files.push({ path: p, offset: Number(meta.offset), size: meta.size });
  }
};
walk(header, '');
console.log(`扫描 ${files.length} 个脚本文件，关键词 "${needle}"`);

let total = 0;
for (const f of files) {
  if (total >= maxHits) break;
  if (f.size > 40 * 1024 * 1024) continue;
  let text;
  try {
    const start = dataStart + f.offset;
    text = buf.subarray(start, start + f.size).toString('utf8');
  } catch {
    continue;
  }
  if (!text.includes(needle)) continue;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && total < maxHits; i++) {
    if (!lines[i].includes(needle)) continue;
    total++;
    console.log(`\n----- ${f.path}:${i + 1} -----`);
    const from = Math.max(0, i - ctx);
    const to = Math.min(lines.length, i + ctx + 1);
    for (let j = from; j < to; j++) {
      const mark = j === i ? '>' : ' ';
      console.log(`${mark} ${String(j + 1).padStart(5)}| ${lines[j].slice(0, 400)}`);
    }
  }
}
console.log(`\n共 ${total} 处命中`);
