/**
 * 桌面助手进程管理。
 *
 * 为什么需要它：DSH 客户端本身是个 Electron 窗口，插件挂在它的页面里，只能在窗口内显示。
 * 要让桌宠真正停在 Windows 桌面上（跟客户端窗口无关），必须另起一个进程开自己的窗口。
 * dsh-pet 的做法是 spawn 一个 Electron helper，这里照同样的思路做精简版。
 *
 * Electron 二进制复用 dsh-pet 已经下好的那份（$DSH_HOME/electron/electron.exe），
 * 找不到就报错给状态接口，**不自动下载** —— 下载 100MB 这种事不能瞒着老大的磁盘做。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshHome } from './brain.js';
import { petToken } from './token.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = join(HERE, '..', 'runtime', 'desktop');
const MAIN_JS = join(RUNTIME_DIR, 'main.js');

/** 平台对应的可执行文件名（与 dsh-pet 的 ELECTRON_REL 一致） */
function exeName() {
  if (process.platform === 'win32') return 'electron.exe';
  if (process.platform === 'darwin') return join('Electron.app', 'Contents', 'MacOS', 'Electron');
  return 'electron';
}

export function electronExe() {
  const candidates = [
    process.env.DSH_PET_BRAIN_ELECTRON_PATH,
    join(dshHome(), 'electron', exeName()),
  ].filter(Boolean);
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/** 当前进程状态 */
const proc = {
  child: null,
  pid: 0,
  startedAt: 0,
  lastError: '',
  /** 最近一次退出原因，供 /state 排查 */
  exited: null,
};

/*
 * 2026-11-11（P0）：helper 退出后没人管，桌宠就永久消失，老大只能重启 DSH。
 * 这里做有限次退避重启：1s / 5s / 15s，三次都失败就停手并把原因写进状态。
 * 用户主动关掉（stopDesktop）不算，不重启。
 */
const RESTART_DELAYS = [1000, 5000, 15000];
let restartAttempts = 0;
let restartTimer = null;
let stopping = false;
let lastOpts = null;

function cancelRestart() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function scheduleRestart(code) {
  if (stopping || !lastOpts) return;
  // 正常退出（code 0）一般是渲染端自己退的，不硬拉
  if (code === 0) return;
  if (restartAttempts >= RESTART_DELAYS.length) {
    proc.lastError = `桌面助手连续退出 ${restartAttempts} 次，已停止自动重启：${proc.lastError || '未知原因'}`;
    return;
  }
  const delay = RESTART_DELAYS[restartAttempts];
  restartAttempts += 1;
  console.warn(`[dsh-pet-brain] 桌面助手退出（code=${code}），${delay}ms 后第 ${restartAttempts} 次重启`);
  cancelRestart();
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (stopping || !lastOpts) return;
    // 重启不复用临时的 panel/send/probe，否则每次崩溃重拉都会再弹一次面板
    const result = startDesktop({ ...lastOpts, panel: '', send: '', probe: '' });
    if (!result.ok) {
      proc.lastError = `自动重启失败：${result.error || '未知原因'}`;
      scheduleRestart(-1);
    }
  }, delay);
  restartTimer.unref?.();
}

/**
 * 启动桌面助手。
 * 已经活着就原样返回（重复点菜单不会叠出两只宠物）。
 * @param {{origin: string, width?: number}} opts
 */
export function startDesktop({ origin, width = 320, panel = '', send = '', speak = false, probe = '' } = {}) {
  // 2026-11-11：有人在起进程，就说明不是「用户关掉的」，把自动重启的闸门打开。
  stopping = false;
  cancelRestart();
  lastOpts = { origin, width };
  if (proc.child && proc.child.exitCode === null && !proc.child.killed) {
    return { ok: true, already: true, pid: proc.pid, exe: electronExe() };
  }
  const exe = electronExe();
  if (!exe) {
    proc.lastError = `找不到 Electron 运行时（期望在 ${join(dshHome(), 'electron', exeName())}）`;
    return { ok: false, error: proc.lastError };
  }
  if (!existsSync(MAIN_JS)) {
    proc.lastError = `找不到桌面助手入口 ${MAIN_JS}`;
    return { ok: false, error: proc.lastError };
  }

  // 宿主自己就是 Electron 应用，process.env 里带着 ELECTRON_RUN_AS_NODE。
  // 原样透传下去，helper 会以纯 node 模式启动 —— 没有窗口、也不报错，只是永远不出现。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // 排障用：启动后自动把某个面板打开，方便直接截图验收
  if (panel) env.PET_BRAIN_AUTO_PANEL = panel;
  if (speak) env.PET_BRAIN_AUTO_PANEL = "speak";
  if (probe) env.PET_BRAIN_AUTO_PANEL = probe;
  if (send) env.PET_BRAIN_AUTO_SEND = send;

  let child;
  try {
    // 令牌走环境变量，不走命令行：Windows 上任何进程都能通过 WMI 读到别人的
    // 命令行，等于把令牌摆在明面上；环境变量只有父子进程看得见。
    // --host 留着（它只是个回环地址，不是秘密，也方便排障时一眼看出连的哪）。
    env.PET_BRAIN_TOKEN = petToken();
    child = spawn(exe, [MAIN_JS, `--host=${origin}`], {
      cwd: RUNTIME_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });
  } catch (err) {
    proc.lastError = String(err?.message || err);
    return { ok: false, error: proc.lastError };
  }

  proc.child = child;
  proc.pid = child.pid || 0;
  proc.startedAt = Date.now();
  proc.lastError = '';
  proc.exited = null;

  let stderrTail = '';
  child.stderr?.on('data', (buf) => {
    stderrTail = (stderrTail + String(buf)).slice(-2000);
  });
  child.stdout?.on('data', () => {});

  child.on('error', (err) => {
    proc.lastError = String(err?.message || err);
  });
  child.on('exit', (code, signal) => {
    proc.exited = { code, signal, at: Date.now(), stderr: stderrTail.slice(-600) };
    proc.child = null;
    proc.pid = 0;
    if (code !== 0 && code !== null) {
      proc.lastError = `helper 退出 code=${code}${signal ? ' signal=' + signal : ''}`;
    }
    // 2026-11-11：渲染崩溃 / 被杀之后，桌宠不该就这么消失 —— 交给退避重启。
    scheduleRestart(code);
  });

  // 活了 60 秒就算「稳住了」，把连续失败计数清零，下次崩了还能再拉三次。
  const healthy = setTimeout(() => {
    if (proc.child === child) restartAttempts = 0;
  }, 60_000);
  healthy.unref?.();

  return { ok: true, pid: proc.pid, exe };
}

export function stopDesktop() {
  // 用户主动关：关掉自动重启的闸门，别再把它拉起来
  stopping = true;
  cancelRestart();
  const child = proc.child;
  if (!child) return { ok: true, already: true };
  try {
    child.kill();
  } catch {
    /* 已经没了 */
  }
  proc.child = null;
  proc.pid = 0;
  return { ok: true };
}

export function desktopStatus() {
  const alive = Boolean(proc.child && proc.child.exitCode === null && !proc.child.killed);
  return {
    ok: true,
    alive,
    pid: proc.pid,
    uptimeMs: alive && proc.startedAt ? Date.now() - proc.startedAt : 0,
    exe: electronExe(),
    entry: MAIN_JS,
    entryExists: existsSync(MAIN_JS),
    error: proc.lastError || null,
    exited: proc.exited,
  };
}

/** 读 helper 的 package.json 只是为了把它固定成 commonjs —— 可选，失败不影响 */
export function runtimeManifest() {
  const p = join(RUNTIME_DIR, 'package.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
