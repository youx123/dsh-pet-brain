/**
 * 从已安装的 dsh-pet 里挑一批动画素材拷进本包。
 *
 * 为什么拷而不是引用：dsh-pet 是别人的包，升级/卸载都会让路径失效；
 * 素材本身是 MIT（见 NOTICE.md），拷贝并保留署名是最稳的做法。
 *
 * 用法：node scripts/copy-assets.mjs [源目录]
 * 默认源目录 = %DSH_HOME%/profiles/desktop/node_modules/dsh-pet/assets/webm
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const DEST = join(PKG, 'assets', 'webm');

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
const SRC = process.argv[2] ?? join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-pet', 'assets', 'webm');

/** 需要的动画（名字必须与 dsh-pet 的 assets/webm 文件名一致） */
const WANT = [
  '待机呼吸休闲',
  '东张西望',
  '被鼠标拖拽悬空反馈',
  '点击回应-开心跃动',
  '点击回应-元气挥手',
  '悠闲哼歌',
  '超大伸懒腰',
  '哈欠连天',
  '原地小憩沉眠',
  '写代码',
  '鲸鱼吐泡泡特效',
  '吃白饭',
  '工作状态-思考冒泡',
  '工作状态-忙碌点按',
  '工作状态-雀跃庆祝',
  '工作状态-垂头叹气冒汗',
];

if (!existsSync(SRC)) {
  console.error(`源目录不存在：${SRC}`);
  console.error('请传入 dsh-pet 的 assets/webm 路径，或先安装 dsh-pet。');
  process.exit(1);
}

mkdirSync(DEST, { recursive: true });
const have = new Set(readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.webm')));
let copied = 0;
let bytes = 0;
for (const n of WANT) {
  const file = `${n}.webm`;
  if (!have.has(file)) {
    console.warn(`跳过（源里没有）：${file}`);
    continue;
  }
  copyFileSync(join(SRC, file), join(DEST, file));
  copied += 1;
  bytes += statSync(join(DEST, file)).size;
}
console.log(`拷了 ${copied}/${WANT.length} 个动画，共 ${(bytes / 1024 / 1024).toFixed(1)} MB → ${DEST}`);
