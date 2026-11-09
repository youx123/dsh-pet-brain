/**
 * JSON 账本的原子写。
 *
 * 为什么需要：这些账本（chat-log / host-follow / proactive-history / desktop / memory-watch / usage）
 * 同时被好几个进程读写 —— 宿主插件、桌面助手 Electron、共享大脑自己也会整份覆写 proactive-history。
 * 直接 writeFileSync 会有一个瞬间文件是半截的，别人正好这时读，就会 JSON.parse 失败、
 * 整份账本当空（表现就是"刚说过的话忘了""水位线归零又重复接茬"）。
 *
 * 做法：写同目录临时文件 → rename 顶掉目标。rename 在 Windows / POSIX 上都是原子的。
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

let seq = 0;

/** 原子写一个文本文件；失败会抛出，调用方自己决定要不要吞 */
export function writeTextAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  seq += 1;
  const tmp = `${file}.${process.pid}.${seq}.tmp`;
  writeFileSync(tmp, String(text), 'utf8');
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 临时文件清不掉也无所谓，下次 rename 会盖掉 */
    }
    throw e;
  }
}

/** 原子写一个 JSON 文件 */
export function writeJsonAtomic(file, value, { pretty = false } = {}) {
  writeTextAtomic(file, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
}
