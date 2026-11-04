// 在 app.asar 里按文件名关键词找文件，并把命中的文件内容读出来（只读，不写盘）
// 用法: node scripts/asar-find.mjs <asar路径> <路径关键词> [是否打印内容 1|0]
import { readFileSync } from 'node:fs';

const [, , asarPath, needle = 'client', print = '0'] = process.argv;
const buf = readFileSync(asarPath);

// asar 格式：4B uint32 = 4（pickle 长度信息）、4B header size、4B header json size...
const headerSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'));
const baseOffset = 16 + headerSize;
// 对齐到 4 字节
const dataStart = 8 + buf.readUInt32LE(4);

const hits = [];
const walk = (node, prefix) => {
  for (const [name, meta] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (meta.files) walk(meta, p);
    else {
      if (p.includes(needle)) hits.push({ path: p, offset: Number(meta.offset), size: meta.size });
    }
  }
};
walk(header, '');

console.log(`命中 ${hits.length} 个`);
for (const h of hits) console.log(`${h.size}\t${h.path}`);
if (print === '1') {
  for (const h of hits) {
    console.log(`\n===== ${h.path} =====`);
    const start = dataStart + h.offset;
    console.log(buf.subarray(start, start + Math.min(h.size, 20000)).toString('utf8'));
  }
}
