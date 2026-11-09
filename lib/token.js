/**
 * 本机令牌：只给「桌面助手」用。
 *
 * 为什么需要：桌面助手是独立的 Electron 进程，页面是 file://，
 * 它请求 /pet-brain/* 时浏览器会带上 `Origin: null` —— 对宿主来说这就是"跨源"。
 * 以前所有端点直接回 `access-control-allow-origin: *`，于是**任何网页**
 * 都能跨源读 /pet-brain/state（人设、记忆、会话 id），甚至 POST /speak 刷生成。
 *
 * 现在：跨源请求必须带 `x-pet-token`，令牌落在 $DSH_HOME/dsh-pet-brain/token，
 * 权限 600，只有本机读得到；桌面助手由宿主 spawn 时通过 argv 传过去。
 * 令牌跨 DSH 重启保持不变（避免重启后桌宠被自己的宿主踢出去）。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome } from './brain.js';
import { writeTextAtomic } from './atomic.js';

let cached = '';

export function petTokenFile() {
  return join(dshHome(), 'dsh-pet-brain', 'token');
}

/** 取令牌；没有就生成一个落盘（只落一次，之后一直读它） */
export function petToken() {
  if (cached) return cached;
  const file = petTokenFile();
  try {
    const raw = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32,128}$/i.test(raw)) {
      cached = raw;
      return cached;
    }
  } catch {
    /* 没文件 / 读不动 → 下面生成 */
  }
  const next = randomBytes(32).toString('hex');
  try {
    writeTextAtomic(file, next);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* Windows 上 chmod 基本是空操作，失败无所谓 */
    }
  } catch (e) {
    console.warn(`[pet-brain] 令牌落盘失败，本次运行用内存里的：${e instanceof Error ? e.message : String(e)}`);
  }
  cached = next;
  return cached;
}

/** 常量时间比较，别让比较本身泄露前缀 */
export function tokenMatches(got, want = petToken()) {
  const a = Buffer.from(String(got ?? ''), 'utf8');
  const b = Buffer.from(String(want ?? ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
