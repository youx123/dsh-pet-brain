/**
 * dsh-pet-brain 桌面助手（Electron 主进程）
 *
 * 存在的理由：DSH 客户端本身是一个 Electron 窗口，插件挂在它的 `shell.overlay` 里，
 * 只能在窗口内显示。要让桌宠真正飘到 Windows 桌面上，必须另起一个进程去开
 * 自己的窗口 —— 这正是 dsh-pet 的 `runtime/electron-helper` 的做法，这里按同样
 * 的思路写了一个精简版：只用得上「透明 / 无边框 / 置顶 / 不占任务栏 / 点击穿透」。
 *
 * 与浏览器半侧的区别：那个 `<video>` 挂在页面里，会跟着页面滚动、被祖先裁切；
 * 这里的窗口是 OS 级窗口，宠物停在桌面上，跟客户端窗口没有关系。
 */
const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

/** 排障日志：helper 是独立进程，出了问题界面上没有任何痕迹，只能靠它 */
const LOG = path.join(require('node:os').tmpdir(), 'dsh-pet-brain-desktop.log');
function log(...args) {
  const line = `${new Date().toISOString()} [${process.pid}] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(LOG, line);
  } catch {
    /* 日志失败不能影响启动 */
  }
}
log('boot argv=' + process.argv.slice(2).join(' '));

/**
 * 窗口平时就贴着桌宠本身：桌宠 16:9 占满窗口宽度，窗口贴在屏幕右下角。
 * 气泡 / 菜单 / 面板要往上长出来时，才由渲染端 grow 一点点高度（底边不动）。
 * 之所以不常年留一大圈空白：窗口不穿透（transparent + setIgnoreMouseEvents 在
 * Windows 上转发不稳，会导致点不动），留白就等于挡住桌面。
 */
const PAD_X = 0;
const PAD_TOP = 0;
const PAD_BOTTOM = 0;
const BADGE_SPACE = 26;
/** 默认宠物宽度（渲染端会按实际尺寸回报，主进程据此调整窗口） */
const DEFAULT_PET_W = 462;

/** 宿主 origin，由 lib/desktop.js 通过参数传进来 */
const HOST_ORIGIN = (() => {
  const arg = process.argv.find((a) => a.startsWith('--host='));
  return arg ? arg.slice('--host='.length) : 'http://127.0.0.1:3080';
})();

/**
 * 独立的 userData 目录：Electron 默认按包名共用一个缓存目录，
 * 重启时旧进程还没退干净就再起一个，会撞出
 * `Unable to move the cache: 拒绝访问 (0x5)` 然后自己退出。
 *
 * 必须在 requestSingleInstanceLock() **之前**设置：单实例锁就是按 userData
 * 算出来的，晚一行就会去拿默认目录（%APPDATA%/Electron）的锁，跟别的
 * Electron 应用（包括 DSH 自己）抢同一个，拿不到就静默退出 —— 窗口永远不出现。
 */
app.setPath('userData', path.join(app.getPath('appData'), 'dsh-pet-brain-desktop'));

/**
 * 参考旧版 dsh-pet 的做法，Windows 上关掉硬件加速。
 *
 * 原因（旧版 main.js 注释里写明的实测结论）：Windows 的透明分层窗口
 * （WS_EX_LAYERED）在 DWM 硬件加速合成下有多处缺陷 —— 改变窗口尺寸/位置时
 * 四周会露出黑边、大透明窗覆盖小透明窗时被盖住的那块内容会丢、以及这里
 * 遇到的「点一下、开个菜单就闪一下」。改走软件合成可以规避。
 *
 * 本进程只渲染一块 640×360 的 webm，软件合成完全扛得住；而且和主 DSH、
 * 浏览器形态是不同进程，不影响它们。非 Windows 合成路径不同，保留硬件加速。
 */
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
}

/** 单实例：重复拉起会叠出一堆宠物 */
const gotLock = app.requestSingleInstanceLock();
log('singleLock=' + gotLock);
if (!gotLock) {
  log('无锁，退出');
  app.quit();
}


/**
 * 透明窗口对 DPI 缩放敏感，但**不要**像 dsh-pet 那样强推
 * `--force-device-scale-factor=1`：那是为了修 macOS 桌面宠物大一倍的问题。
 * 在 Windows 200% 缩放下强推 1，Electron 的 DIP 与系统物理像素会各算各的，
 * 实测 420×320 的窗口被坐成 210×160，视频盒子直接撑破窗口。
 * 按系统 DPI 走，窗口尺寸就是 DIP 尺寸，观感才对。
 */

let win = null;
let petWidth = DEFAULT_PET_W;
/** 当前是否整窗点击穿透（渲染端按光标是否压在宠物身上翻转） */
let ignoring = true;

/**
 * 窗口尺寸统一走 setContentBounds，而不是 setBounds。
 *
 * 两点讲究（都是抄旧版 dsh-pet 的踩坑结论）：
 * 1. 窗口是 frameless + useContentSize，我们要控制的是**内容区**尺寸；setBounds
 *    还要多算一层窗口边框，200% 缩放下落点会抖。
 * 2. 去重必须比"我们自己上一次请求的值"，绝不能回读 win.getContentBounds() ——
 *    回读值经过 ScaleToEnclosingRect 向外取整，永远和设定值不相等，去重会失效，
 *    变成每次调用都强制重设窗口 → 每一帧都重建一次合成层 → 看起来就是闪。
 */
let requestedBounds = '';
let curBounds = { x: 0, y: 0, width: 0, height: 0 };
function applyWindowBounds(rect) {
  if (!win || win.isDestroyed()) return;
  const r = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  const key = `${r.x},${r.y},${r.width},${r.height}`;
  if (key === requestedBounds) return;
  requestedBounds = key;
  curBounds = r;
  win.setContentBounds(r, false);
}

/**
 * 只移动、不改尺寸。物理抛掷和拖拽都走这里。
 * 必须同步更新 curBounds / requestedBounds，否则后面 pet:grow 会拿旧坐标算底边，
 * 窗口"自己跳回去"。
 */
function movePetTo(x, y) {
  if (!win || win.isDestroyed()) return;
  const nx = Math.round(x);
  const ny = Math.round(y);
  win.setPosition(nx, ny);
  curBounds.x = nx;
  curBounds.y = ny;
  requestedBounds = `${nx},${ny},${curBounds.width},${curBounds.height}`;
}

/**
 * 窗口固定高度 = 宠物 + 徽章 + 上方 HUD 预留区。
 *
 * **窗口尺寸一旦定下来就不再改**。原因是 Windows 透明分层窗口每改一次尺寸
 * 就重建一次 DWM 合成层，屏幕上的表现就是闪一下 —— 这正是"点一下弹窗就闪"
 * 的根因（改视频源、双缓冲都不是）。旧版 dsh-pet 的做法一样：窗口开大，
 * 气泡/面板都长在预留区里，外扩区靠光标轮询自己翻点击穿透。
 */
const HUD_MAX = 600;
const HUD_MIN = 120;
/** 真正需要的高度：气泡 176 / 右键菜单 250 / 面板最高 300，留一点余量就够 */
const HUD_WANT = 320;
function hudSpace() {
  const area = screen.getPrimaryDisplay().workArea;
  // 之前是"屏幕剩多少给多少"（最高 600），窗口一大半是空的，手上没反应也挡桌面
  return Math.max(HUD_MIN, Math.min(HUD_WANT, Math.round(area.height * 0.42)));
}

function windowSize(width) {
  const w = Math.round(width);
  // 宠物 16:9 + 底部 BADGE_SPACE 给状态徽章（#badge 挂在宠物下沿 -22px，不留就被窗口裁掉）
  // 上面再加 HUD 预留区，气泡/菜单/面板都长在里面
  const base = Math.round((w * 9) / 16) + BADGE_SPACE;
  return { width: w, height: base + hudSpace() };
}

function createWindow() {
  const { width, height } = windowSize(petWidth);
  const area = screen.getPrimaryDisplay().workArea;

  win = new BrowserWindow({
    width,
    height,
    // 初始落在右下角，渲染端首帧会按自身尺寸再校正一次
    x: Math.max(area.x, area.x + area.width - width - 24),
    y: Math.max(area.y, area.y + area.height - height - 24),
    show: false,
    useContentSize: true,
    // 允许窗口部分伸出屏幕：贴边时宠物可以探出去一点
    enableLargerThanScreen: true,
    transparent: true,
    // 显式给全透明底色：不给的话部分驱动会拿默认白/黑当背景，透明窗口变成色块
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // 聊天输入框要能打字，所以窗口本身要可聚焦；显示时用 showInactive 不抢焦点
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 不开硬件加速时视频更稳；这里保持默认，由 Chromium 选。
      // 必须让首帧照常绘制：paintWhenInitiallyHidden:false 会让渲染器认为窗口一直隐藏，
      // 首帧永远不合成 —— 窗口 visible=true 但屏幕上一片空白（踩过一次）
      paintWhenInitiallyHidden: true,
      spellcheck: false,
    },
  });

  // 'screen-saver' 是 Windows 上最高的置顶层级，普通 alwaysOnTop 会被全屏应用盖住
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 被别的窗口遮挡时 Chromium 会暂停渲染，宠物看着就像消失了
  win.webContents.setBackgroundThrottling(false);
  // 右键菜单由渲染端自绘，屏蔽 Electron 默认菜单（否则两个菜单一起弹）
  win.webContents.on('context-menu', (e) => e.preventDefault());

  // 记下建窗时的实际内容区，后面 pet:grow 算底边要用（不回读窗口，避免取整误差）
  {
    const b = win.getContentBounds();
    curBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    requestedBounds = `${b.x},${b.y},${b.width},${b.height}`;
  }

  setIgnore(true);
  // 光标轮询：窗口大、默认穿透，靠它把"光标压在宠物/浮层上"那一小块翻成可交互
  startPointerPoll();
  win.loadFile(path.join(__dirname, 'index.html'), { query: { host: HOST_ORIGIN } });

  win.once('ready-to-show', () => {
    log('ready-to-show');
    win.showInactive();
  });
  // paintWhenInitiallyHidden:false 时 ready-to-show 可能永不触发，补一次兜底
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      if (!win || win.isDestroyed()) return;
      // 排障用：设了 PET_BRAIN_AUTO_PANEL 就把对应面板打开再截图
      const auto = process.env.PET_BRAIN_AUTO_PANEL;
      if (auto) {
        try {
          if (auto === 'throw') {
            const report = await win.webContents.executeJavaScript('window.__petDeskTest.throwTest()');
            log('throw ' + report);
          } else if (auto === 'throwup') {
            // 猛甩一次向上的，边飞边采样，看顶部边界有没有把宠物挡在屏幕内
            const p = win.webContents.executeJavaScript('window.__petDeskTest.throwTo(0,-3000)');
            let minY = Infinity;
            let maxY = -Infinity;
            for (let i = 0; i < 24; i++) {
              await new Promise((r) => setTimeout(r, 120));
              if (!win || win.isDestroyed()) break;
              const b = win.getBounds();
              minY = Math.min(minY, b.y);
              maxY = Math.max(maxY, b.y);
            }
            const report = await p;
            log('throwup minY=' + minY + ' maxY=' + maxY + ' final=' + JSON.stringify(win.getBounds()) + ' ' + report);
          } else if (auto === 'speak') {
            const report = await win.webContents.executeJavaScript('window.__petDeskTest.speak(true)');
            log('speak ' + report);
          } else if (auto === 'walk') {
            // 一边走一边采样窗口 x，确认真的在平移而不是只播了个原地动画
            // 往左走：桌宠本来就贴着右下角，往右只有二十来像素空间，看不出效果
            const startX = win.getBounds().x;
            const p = win.webContents.executeJavaScript('window.__petDeskTest.walkTest(-320)');
            let minX = Infinity;
            let maxX = -Infinity;
            for (let i = 0; i < 18; i++) {
              await new Promise((r) => setTimeout(r, 150));
              if (!win || win.isDestroyed()) break;
              const b = win.getBounds();
              minX = Math.min(minX, b.x);
              maxX = Math.max(maxX, b.x);
            }
            const report = await p;
            log(`walk startX=${startX} minX=${minX} maxX=${maxX} span=${maxX - minX} | ${report}`);
          } else if (auto === 'probe') {
            const report = await win.webContents.executeJavaScript('window.__petDeskTest.probe()');
            log('probe ' + report);
          } else if (auto === 'menu') {
            // 派发一次右键，验证菜单样式
            await win.webContents.executeJavaScript(
              'document.getElementById("pet").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:240,clientY:120}));"dispatched"'
            );
            log('auto menu');
          } else {
            await win.webContents.executeJavaScript('window.__petDeskTest && window.__petDeskTest.open(' + JSON.stringify(auto) + ');');
            log('auto panel ' + auto);
          }
          // 排障用：再把输入框填上并真的点一次发送按钮，验证按钮链路通
          const text = process.env.PET_BRAIN_AUTO_SEND;
          if (text) {
            await win.webContents.executeJavaScript(
              '(function(){var i=document.getElementById("input");i.value=' +
                JSON.stringify(text) +
                ';i.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("send").click();return "clicked";})()'
            );
            log('auto send ' + text);
            await new Promise((r) => setTimeout(r, 6000));
          }
        } catch (e) {
          log('auto panel fail ' + (e?.message || e));
        }
        await new Promise((r) => setTimeout(r, 1400));
      }
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(require('node:os').tmpdir(), 'dsh-pet-brain-desk-shot.png'), img.toPNG());
        log('capturePage ok ' + JSON.stringify(img.getSize()));
      } catch (e) {
        log('capturePage fail ' + (e?.message || e));
      }
    }, 3500);
  });
  win.webContents.on('render-process-gone', (_e, d) => log('renderer gone ' + JSON.stringify(d)));
  win.webContents.on('console-message', (_e, level, message) => log('console[' + level + '] ' + message));


  win.on('closed', () => {
    log('window closed');
    stopPointerPoll();
    overlays = [];
    win = null;
  });
}

/**
 * 整窗点击穿透开关。
 *
 * 窗口现在比宠物大很多（上方一大块 HUD 预留区是透明的），所以必须默认穿透，
 * 否则右边会挡掉一整条桌面。谁该接收鼠标由 60ms 的光标轮询决定：
 * 光标压在宠物身上或某个可见浮层上 → 不穿透；在透明区 → 穿透。
 */
function setIgnore(next) {
  if (!win || win.isDestroyed()) return;
  if (ignoring === next) return;
  ignoring = next;
  win.setIgnoreMouseEvents(next, { forward: true });
}

/**
 * 热区 = 宠物矩形（主进程自己算，固定的，不依赖渲染端）+ 渲染端上报的浮层矩形。
 *
 * 宠物永远可点这件事不能等渲染端：窗口刚起来时如果全穿透、又还没有浮层，
 * 光标压在宠物身上点不动，看着就是"又坏了"。
 */
/**
 * 渲染端采样出来的"宠物本体"包围盒（0..1 比例，相对视频框）。
 * 视频是 640×360，宠物在画面里四周留着一大圈透明；固定比例内缩永远调不准，
 * 所以让渲染端读一帧的 alpha 通道，算出真正的轮廓再报上来。
 */
let petBox = null;

function petZone() {
  const w = Math.round(petWidth);
  const h = Math.round((petWidth * 9) / 16);
  // 没采样到就退回保守内缩，保证至少点得到
  const box = petBox || { left: 0.06, top: 0.08, right: 0.94, bottom: 0.92 };
  const x0 = Math.round(w * box.left);
  const y0 = Math.round(h * box.top);
  const x1 = Math.round(w * box.right);
  const y1 = Math.round(h * box.bottom);
  return {
    x: Math.round((curBounds.width - w) / 2) + x0,
    y: Math.round(curBounds.height - BADGE_SPACE - h) + y0,
    w: Math.max(24, x1 - x0),
    h: Math.max(24, y1 - y0),
  };
}

let overlays = [];
const POINTER_POLL_MS = 60;
let pollTimer = null;

let lastHitDbg = null;
function pollPointer() {
  if (!win || win.isDestroyed() || !curBounds.width) return;
  const p = screen.getCursorScreenPoint();
  const lx = p.x - curBounds.x;
  const ly = p.y - curBounds.y;
  let hit = false;
  if (lx >= 0 && ly >= 0 && lx < curBounds.width && ly < curBounds.height) {
    const zones = [petZone(), ...overlays];
    hit = zones.some((z) => z && lx >= z.x && ly >= z.y && lx < z.x + z.w && ly < z.y + z.h);
  }
  if (hit !== lastHitDbg) {
    lastHitDbg = hit;
    log('pointer hit=' + hit + ' at=' + lx + ',' + ly + ' zones=' + JSON.stringify(overlays));
  }
  setIgnore(!hit);
}

function startPointerPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(pollPointer, POINTER_POLL_MS);
}

function stopPointerPoll() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

ipcMain.on('pet:hotzones', (_e, list) => {
  overlays = Array.isArray(list) ? list.filter((z) => z && z.w > 0 && z.h > 0) : [];
});

ipcMain.on('pet:contentbox', (_e, box) => {
  // 比例得讲道理：宠物本体至少占三成，否则多半是采到了透明帧或半截动作
  if (!box) return;
  const { left, top, right, bottom } = box;
  const ok =
    [left, top, right, bottom].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) &&
    right - left >= 0.3 &&
    bottom - top >= 0.3;
  if (!ok) {
    log('contentbox 忽略 ' + JSON.stringify(box));
    return;
  }
  petBox = { left, top, right, bottom };
  log('contentbox ' + JSON.stringify(petBox) + ' zone=' + JSON.stringify(petZone()));
});

ipcMain.on('pet:interactive', (_e, next) => {
  // 渲染端只在"确实需要整窗接收"时用这个快通道；常态交给轮询
  if (next === true) setIgnore(false);
});

/**
 * 拖拽 + 抛掷物理。
 * 参数参照 dsh-pet 的 shared-core.js：
 *   GRAVITY 1400 px/s^2、地面弹性 0.78、落地水平摩擦 0.86、撞墙 0.55。
 * 窗口位置只有主进程能改，所以物理必须跑在这里，渲染端只负责测速。
 */
const PHYS = {
  GRAVITY: 1400,
  RESTITUTION: 0.78,
  FLOOR_FRICTION: 0.86,
  WALL_BOUNCE: 0.55,
  AIR_DRAG: 0.9995,
  /** 小于这个速度直接判定为"轻轻放下"，不飞 */
  THROW_MIN: 140,
  /** 落地后低于这个速度就彻底停 */
  REST_SPEED: 60,
};

let dragOffset = null;
const phys = { mode: 'idle', vx: 0, vy: 0, last: 0, timer: null };

function stopPhysics() {
  phys.mode = 'idle';
  phys.vx = 0;
  phys.vy = 0;
  if (phys.timer) {
    clearInterval(phys.timer);
    phys.timer = null;
  }
}

function physTick() {
  if (!win || win.isDestroyed() || phys.mode !== 'throw') {
    stopPhysics();
    return;
  }
  const now = Date.now();
  let dt = (now - phys.last) / 1000;
  phys.last = now;
  // 切后台再回来时 dt 可能很大，钳一下免得一次飞穿屏幕
  if (dt > 0.1) dt = 0.1;

  const b = win.getBounds();
  const area = screen.getPrimaryDisplay().workArea;

  phys.vy += PHYS.GRAVITY * dt;
  phys.vx *= PHYS.AIR_DRAG;
  let x = b.x + phys.vx * dt;
  let y = b.y + phys.vy * dt;

  // 左右墙
  if (x < area.x) {
    x = area.x;
    phys.vx = -phys.vx * PHYS.WALL_BOUNCE;
  } else if (x + b.width > area.x + area.width) {
    x = area.x + area.width - b.width;
    phys.vx = -phys.vx * PHYS.WALL_BOUNCE;
  }

  // 顶部边界按"宠物头顶"算：窗口上方那一大块是 HUD 留白，拿窗口顶当边界的话
  // 宠物永远够不到屏幕顶；反过来说，只按窗口顶钳制又会让宠物整只飞出屏幕不要紧。
  const petH = Math.round((petWidth * 9) / 16);
  const ceil = area.y - (b.height - BADGE_SPACE - petH);
  if (y < ceil) {
    y = ceil;
    phys.vy = Math.abs(phys.vy) * PHYS.WALL_BOUNCE;
  }

  // 左右墙 + 地面。地面按"宠物脚底"算：窗口底部还留着 BADGE_SPACE 给状态徽章，
  // 用窗口底当地面会让宠物悬空一截。
  const floor = area.y + area.height - (b.height - BADGE_SPACE);
  if (y >= floor) {
    y = floor;
    const impact = Math.abs(phys.vy);
    phys.vy = -phys.vy * PHYS.RESTITUTION;
    phys.vx *= PHYS.FLOOR_FRICTION;
    movePetTo(x, y);
    // 撞得够狠才通知渲染端压扁，落地一下也要有反馈
    win.webContents.send('pet:land', { impact: Math.round(impact) });
    if (Math.abs(phys.vy) < PHYS.REST_SPEED && Math.abs(phys.vx) < PHYS.THROW_MIN) {
      phys.vy = 0;
      phys.vx = 0;
      stopPhysics();
    }
    return;
  }

  movePetTo(x, y);
}

function startPhysics() {
  if (phys.timer) return;
  stopWalk('throw');
  phys.last = Date.now();
  phys.timer = setInterval(physTick, 16);
}

/**
 * 走动：窗口自己在屏幕上平移。
 *
 * 素材里没有"从 A 走到 B"的动画（moves.actions 那几个全是原地动作），
 * 所以位移只能由主进程做 —— 渲染端播「螃蟹走路」，主进程把窗口平滑挪过去，
 * 两边凑起来才像真的在走。速度给个范围，太快像瞬移、太慢像卡住。
 */
const WALK = {
  minSpeed: 50, // px/s
  maxSpeed: 130,
  tickMs: 16,
};

const walk = { mode: 'idle', targetX: 0, speed: 0, timer: null, dir: 1 };

function stopWalk(reason = '') {
  if (walk.timer) {
    clearInterval(walk.timer);
    walk.timer = null;
  }
  const was = walk.mode;
  walk.mode = 'idle';
  if (was === 'walk' && reason && win && !win.isDestroyed()) {
    win.webContents.send('pet:walk-end', { reason });
  }
}

function walkTick() {
  if (!win || win.isDestroyed() || walk.mode !== 'walk') {
    stopWalk();
    return;
  }
  const b = win.getBounds();
  const area = screen.getPrimaryDisplay().workArea;
  const minX = area.x;
  const maxX = area.x + area.width - b.width;
  const target = Math.min(Math.max(walk.targetX, minX), maxX);
  const dx = target - b.x;

  // 一步走一小截，够近了就吸附上去 —— 免得在目标点附近来回抖
  const step = Math.max(1, (walk.speed * WALK.tickMs) / 1000);
  if (Math.abs(dx) <= step) {
    movePetTo(target, b.y);
    stopWalk(target === walk.targetX ? 'arrived' : 'hit-edge');
    return;
  }
  movePetTo(b.x + Math.sign(dx) * step, b.y);
}

function startWalk(targetX, speed = 80) {
  if (!win || win.isDestroyed()) return;
  const target = Number(targetX);
  if (!Number.isFinite(target)) return;
  stopPhysics();
  const b = win.getBounds();
  walk.targetX = Math.round(target);
  walk.speed = Math.min(Math.max(Number(speed) || 80, WALK.minSpeed), WALK.maxSpeed);
  walk.dir = walk.targetX >= b.x ? 1 : -1;
  walk.mode = 'walk';
  if (!walk.timer) walk.timer = setInterval(walkTick, WALK.tickMs);
  win.webContents.send('pet:walk-start', { dir: walk.dir });
}

ipcMain.on('pet:walk', (_e, msg) => {
  if (!msg) return;
  if (msg.stop) {
    stopWalk('cancel');
    return;
  }
  // dx = 相对当前位置走多远（渲染端不知道窗口坐标，所以走这条）
  if (Number.isFinite(Number(msg.dx)) && win && !win.isDestroyed()) {
    startWalk(win.getBounds().x + Number(msg.dx), msg.speed);
    return;
  }
  startWalk(msg.x, msg.speed);
});

ipcMain.on('pet:drag', (_e, msg) => {
  if (!win || win.isDestroyed() || !msg) return;
  if (msg.phase === 'start') {
    stopPhysics();
    stopWalk('drag');
    const [wx, wy] = win.getPosition();
    dragOffset = { dx: msg.screenX - wx, dy: msg.screenY - wy };
    return;
  }
  if (msg.phase === 'end') {
    dragOffset = null;
    const vx = Number(msg.vx) || 0;
    const vy = Number(msg.vy) || 0;
    if (Math.hypot(vx, vy) >= PHYS.THROW_MIN) {
      phys.mode = 'throw';
      phys.vx = vx;
      phys.vy = vy;
      startPhysics();
    } else {
      stopPhysics();
      win.webContents.send('pet:land', { impact: 0 });
    }
    return;
  }
  if (!dragOffset) return;
  movePetTo(msg.screenX - dragOffset.dx, msg.screenY - dragOffset.dy);
});

/** 渲染端回报宠物实际宽度，据此调整窗口大小（滚轮缩放 / 设置里改尺寸都走这里） */
ipcMain.on('pet:resize', (_e, width) => {
  if (!win || win.isDestroyed()) return;
  const w = Math.max(120, Math.min(640, Math.round(Number(width) || DEFAULT_PET_W)));
  if (w === petWidth) return;
  petWidth = w;
  const size = windowSize(w);
  const [x, y] = win.getPosition();
  // 只有窗口尺寸变了才重设，位置保持不变（避免缩放时宠物跳走）
  applyWindowBounds({ x, y, width: size.width, height: size.height });
});

/**
 * 面板空间：**不再改窗口尺寸**（改了就会重建合成层 → 闪）。
 * 窗口一开始就留好了 HUD 预留区，气泡/菜单/面板都长在里面。
 * 这个 IPC 保留只是为了兼容渲染端的调用，收到就记一笔，什么都不做。
 */
let panelExtra = 0;
ipcMain.on('pet:grow', (_e, extra) => {
  const next = Math.max(0, Math.min(HUD_MAX, Math.round(Number(extra) || 0)));
  if (next !== panelExtra) {
    panelExtra = next;
    log('pet:grow ignored (window size is fixed) extra=' + next);
  }
});

ipcMain.on('pet:quit', () => {
  app.quit();
});

ipcMain.handle('pet:env', () => ({
  host: HOST_ORIGIN,
  petWidth,
  ignoring,
  version: process.versions.electron,
}));

app.whenReady().then(() => {
  log('app ready');
  // 应用菜单在无边框窗口里也会响应 Alt 键，清掉
  Menu.setApplicationMenu(null);
  createWindow();
  log('window created ' + JSON.stringify(curBounds) + ' petZone=' + JSON.stringify(petZone()));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => log('before-quit'));
app.on('window-all-closed', () => {
  log('window-all-closed → quit');
  app.quit();
});
process.on('uncaughtException', (e) => log('uncaught', e?.stack || String(e)));
