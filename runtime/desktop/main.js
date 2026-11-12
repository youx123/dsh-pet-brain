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
// 2026-11-11（P2）：argv 里有 --token，原样写进日志等于把令牌落在 %TEMP% 里，
// 同机别的进程一读就能调 /pet-brain/*。打日志前先掩掉。
const maskedArgv = process.argv
  .slice(2)
  .map((a) => (/^--token=/i.test(a) ? '--token=***' : a))
  .join(' ');
log('boot argv=' + maskedArgv);

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

/**
 * 只认本机回环的 origin。
 *
 * --host= 是命令行参数，任意进程都能传。
 * 不校验的话，一个第三方进程可以把 origin 换成自己的地址，
 * 桌宠就会把老大的点击、对话往那儿送（面板内容也会从那儿加载）。
 * 只放行 http://127.0.0.1:<端口>。
 */
function normalizeHost(raw) {
  const fallback = 'http://127.0.0.1:3080';
  if (typeof raw !== 'string' || !raw) return fallback;
  const s = raw.trim().replace(/\/+$/, '');
  return /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(s) ? s : fallback;
}

/**
 * 宿主 origin，由 lib/desktop.js 通过参数传进来。
 *
 * 用 let 不用 const：DSH 重启后端口会变（每次都是随机端口），插件在启动时
 * 会再拉一次桌面助手，但单实例锁会让新进程直接退出 —— 于是留下一个还指着
 * 上一轮死端口的旧窗口，点什么都没反应。第二条实例的命令行里带着新 origin，
 * 靠下面的 second-instance 把它换过来（见 on('second-instance')）。
 */
let HOST_ORIGIN = (() => {
  const arg = process.argv.find((a) => a.startsWith('--host='));
  return normalizeHost(arg ? arg.slice('--host='.length) : '');
})();

/**
 * 宿主令牌：桌面助手是 file:// 页面，对宿主来说属于跨源，
 * 不带这个头宿主会一律回 403（见 lib/index.js 的 isCrossOrigin）。
 *
 * 来源两处，依次兜底：
 *   1. 宿主 spawn 时传的 --token=（正常路径）
 *   2. $HOME/.dsh/dsh-pet-brain/token（手动起窗口、排障时用）
 * 读不到就留空 —— 旧宿主没有这道门，空令牌也能用；新宿主下会 403，
 * 日志里能直接看出来是"没拿到令牌"。
 */
const TOKEN_RE = /^[0-9a-f]{32,128}$/i;
function readTokenFile() {
  try {
    // 2026-11-12（桌宠审计 中低 F）：这里原来写死 homedir()/.dsh，
    // 但插件本体的口径是 DSH_HOME 优先（lib/brain.js 的 dshHome()，
    // lib/token.js 也用它）。设了 DSH_HOME 的机器上手动起窗口会读错文件，
    // 令牌读到空 → 所有请求 403。桌面助手是独立进程引不到 lib/brain.js，
    // 所以这里把同一套口径抄一份。
    const env = process.env.DSH_HOME;
    const home = (typeof env === 'string' && env.trim() !== '') ? env.trim() : path.join(require('node:os').homedir(), '.dsh');
    const p = path.join(home, 'dsh-pet-brain', 'token');
    const v = String(fs.readFileSync(p, 'utf8')).trim();
    return TOKEN_RE.test(v) ? v : '';
  } catch {
    return '';
  }
}
function tokenFromArgv(argv) {
  const arg = (argv || []).find((a) => a.startsWith('--token='));
  if (!arg) return '';
  const v = arg.slice('--token='.length).trim();
  return TOKEN_RE.test(v) ? v : '';
}
let PET_TOKEN = (() => {
  // 2026-11-11（P2）：优先用环境变量。命令行参数在 Windows 上任何进程都能通过
  // WMI 读到，等于把令牌摆在桌面上；环境变量只有本进程和它的父进程看得到。
  const fromEnv = String(process.env.PET_BRAIN_TOKEN ?? '').trim();
  if (TOKEN_RE.test(fromEnv)) return fromEnv;
  return tokenFromArgv(process.argv) || readTokenFile();
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
  // 2026-11-11（P2）：退出码用 3 而不是 0。
  // stop→start 连点的时候，上一个进程刚被 kill、锁还没释放，新进程拿不到锁；
  // 以前 app.quit() 是 0，宿主那边的自动重启看到「正常退出」就不管了，
  // 结果界面说已启动、窗口永远不出现。非 0 退出会触发退避重启（1s 后重试）。
  log('无锁，退出（code=3，让宿主稍后重试）');
  app.exit(3);
}

/**
 * 第二条实例（通常来自 DSH 重启后的自动拉起）把自己的 --host 递过来。
 *
 * 宿主每次启动端口都不一样，老窗口指着旧端口 → 轮询 404、点击没回话，
 * 看上去就是"桌宠死了"。这里换掉 origin 重载页面，等于免费自愈。
 */
app.on('second-instance', (_evt, argv) => {
  if (!win) return;
  const arg = (argv || []).find((a) => a.startsWith('--host='));
  const next = arg ? normalizeHost(arg.slice('--host='.length)) : '';
  log('second-instance host=' + (next || '(none)') + ' 现在=' + HOST_ORIGIN);
  // 令牌也可能换了（极少见：换了 DSH_HOME）—— 有就跟着换，没有就沿用旧的
  const tok = tokenFromArgv(argv);
  if (tok) PET_TOKEN = tok;
  if (next && next !== HOST_ORIGIN) {
    HOST_ORIGIN = next;
    win.loadFile(path.join(__dirname, 'index.html'), { query: { host: HOST_ORIGIN } });
    return;
  }
  // 同一个 origin：说明只是被重复拉起，把窗口亮一下就行
  try {
    win.showInactive();
  } catch {
    /* 窗口已销毁，忽略 */
  }
});


/**
 * 透明窗口对 DPI 缩放敏感，但**不要**像 dsh-pet 那样强推
 * `--force-device-scale-factor=1`：那是为了修 macOS 桌面宠物大一倍的问题。
 * 在 Windows 200% 缩放下强推 1，Electron 的 DIP 与系统物理像素会各算各的，
 * 实测 420×320 的窗口被坐成 210×160，视频盒子直接撑破窗口。
 * 按系统 DPI 走，窗口尺寸就是 DIP 尺寸，观感才对。
 */

let win = null;
let petWidth = DEFAULT_PET_W;
/** 渲染进程连续崩溃次数：成功加载一次就清零，用来做重载退避（P2-11）。 */
let crashReloads = 0;
/**
 * 当前是否整窗点击穿透（渲染端按光标是否压在宠物身上翻转）。
 *
 * 初值必须是 null 而不是 true：
 * Electron 新建 BrowserWindow 默认**不**忽略鼠标事件，
 * 而 setIgnore() 里 `if (ignoring === next) return;` 会把初值 true 的那次调用直接吞掉 ——
 * 结果 win.setIgnoreMouseEvents(true) 一次都没下发，
 * 屏幕右下角那块全透明置顶窗口就一直吃桌面点击（看着像桌面坏了）。
 * null = 还没下发过，第一次调用一定会真的执行。
 */
let ignoring = null;

/** 排障自检（PET_BRAIN_AUTO_PANEL）的定时器句柄：建窗/重建时要能清掉上一轮 */
let debugTimer = 0;

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
  // NaN/Infinity 传进 setPosition 会让窗口跳到不可知的地方（甚至消失）
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    log('movePetTo 忽略非法坐标 ' + x + ',' + y);
    return;
  }
  // 2026-11-11（P0）：拖拽/抛掷不能把人扔到屏幕外面去。以前这里不夹边界，
  // 慢速拖过边缘或拔掉副屏之后窗口就留在可视区外，进程还活着、客户端那只
  // 又被藏起来 —— 两只都看不见，只能重启宿主。
  const safe = clampToDisplay(Math.round(x), Math.round(y));
  const nx = safe.x;
  const ny = safe.y;
  win.setPosition(nx, ny);
  curBounds.x = nx;
  curBounds.y = ny;
  requestedBounds = `${nx},${ny},${curBounds.width},${curBounds.height}`;
}

/** 窗口（或某个矩形）落在哪块屏幕上。多屏时别一律拿主屏。 */
function displayOf(bounds = curBounds) {
  try {
    const point = {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    };
    return screen.getDisplayNearestPoint(point);
  } catch {
    return screen.getPrimaryDisplay();
  }
}

/**
 * 把窗口夹回屏幕可见区域。
 *
 * 2026-11-12：改成按**宠物本体**夹，四条边都贴屏幕工作区。
 * 旧版按窗口算（横向允许探出一半、纵向留 20%/40%），结果是：
 * 顶部抛不到屏幕顶、落地时宠物悬空一截 —— 看起来就是「碰撞范围是那块界面，不是屏幕」。
 */
function clampToDisplay(x, y, width = curBounds.width, height = curBounds.height) {
  const area = displayOf({ x, y, width, height }).workArea;
  const box = petBoxIn(width, height);
  const minX = area.x - box.x;
  const maxX = area.x + area.width - box.x - box.w;
  const minY = area.y - box.y;
  const maxY = area.y + area.height - box.y - box.h;
  const nx = maxX < minX ? minX : Math.min(maxX, Math.max(minX, Math.round(x)));
  const ny = maxY < minY ? minY : Math.min(maxY, Math.max(minY, Math.round(y)));
  return { x: nx, y: ny };
}

/** 这个矩形在所有显示器上露出来的面积（平方像素）。 */
function visibleAreaOf(bounds) {
  let total = 0;
  for (const display of screen.getAllDisplays()) {
    const r = display.workArea;
    const w = Math.min(bounds.x + bounds.width, r.x + r.width) - Math.max(bounds.x, r.x);
    const h = Math.min(bounds.y + bounds.height, r.y + r.height) - Math.max(bounds.y, r.y);
    if (w > 0 && h > 0) total += w * h;
  }
  return total;
}

/** 把桌宠放回光标所在屏幕的右下角。 */
function recenterPet(reason = '') {
  if (!win || win.isDestroyed()) return;
  const display = (() => {
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch {
      return screen.getPrimaryDisplay();
    }
  })();
  const area = display.workArea;
  const { width, height } = win.getBounds();
  const x = Math.max(area.x, area.x + area.width - width - 24);
  const y = Math.max(area.y, area.y + area.height - height - 24);
  movePetTo(x, y);
  log(`桌宠回中${reason ? '（' + reason + '）' : ''} → ${x},${y}`);
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
  // 用光标所在的那块屏幕算，多屏时不至于按主屏高度把窗口开成奇怪的比例
  let area;
  try {
    area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  } catch {
    area = screen.getPrimaryDisplay().workArea;
  }
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

  /*
   * 兜底拦截三件套。
   *
   * 桌宠只会显示自己的 index.html、只会往宿主 origin 发请求。现在页面里没有跳转入口，
   * 但这层不该靠"代码里恰好没写 <a>"来保证：某天面板里渲染了带链接的文本、
   * 或者打开的网页里又开了弹窗，默认行为就是把桌宠这个窗口换成一张网页 ——
   * 于是右下角那个东西既不是宠物、也没有穿透，看着像桌面坏了。
   */
  win.webContents.setWindowOpenHandler(({ url }) => {
    log('window.open blocked ' + String(url).slice(0, 120));
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    // 只放行自己这份 index.html 的加载（含 ?host= 查询串）
    if (/^file:\/\/.+\/index\.html(\?|$)/i.test(String(url))) return;
    e.preventDefault();
    log('will-navigate blocked ' + String(url).slice(0, 120));
  });
  // 权限一律不给：一只桌宠不需要摄像头、麦克风、定位、通知
  try {
    win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
      log('permission denied ' + permission);
      cb(false);
    });
  } catch (e) {
    log('permission handler 装不上 ' + String(e?.message || e));
  }

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
    // 能加载出页面就说明渲染进程是好的，把崩溃计数清零，下次真崩重新从 1s 起退避。
    crashReloads = 0;
    // 句柄要存着：窗口重建（render-process-gone 自愈、second-instance 换源）时
    // 上一轮的排障定时器还在跑，3.5 秒后会打到新窗口上，串成莫名其妙的截图/面板。
    if (debugTimer) clearTimeout(debugTimer);
    debugTimer = setTimeout(async () => {
      debugTimer = 0;
      if (!win || win.isDestroyed()) return;
      // 排障用：设了 PET_BRAIN_AUTO_PANEL 就把对应面板打开再截图
      const auto = process.env.PET_BRAIN_AUTO_PANEL;
      // 2026-11-11（P2）：这一整套只有排障时才跑。以前每次启动都会在 3.5 秒后
      // 截一张图写进 %TEMP%，生产启动也照跑 —— 白写磁盘，还留个没人看的文件。
      const wantShot = process.env.PET_BRAIN_SHOT === '1';
      if (!auto && !wantShot) return;
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
            // 走位全程 = 素材 10.04s ÷ 1.5 倍速 ≈ 6.7s，采样要盖住整段
            for (let i = 0; i < 56; i++) {
              await new Promise((r) => setTimeout(r, 150));
              if (!win || win.isDestroyed()) break;
              const b = win.getBounds();
              minX = Math.min(minX, b.x);
              maxX = Math.max(maxX, b.x);
              // 走到一半抓一张，确认画面真的在动（不是只有窗口在挪）
              if (i === 8) {
                try {
                  const mid = await win.webContents.capturePage();
                  fs.writeFileSync(path.join(require('node:os').tmpdir(), 'dsh-pet-brain-walk-shot.png'), mid.toPNG());
                } catch {
                  /* 抓不到就算了 */
                }
              }
            }
            const report = await p;
            log(`walk startX=${startX} minX=${minX} maxX=${maxX} span=${maxX - minX} | ${report}`);
          } else if (auto === 'probe') {
            const report = await win.webContents.executeJavaScript('window.__petDeskTest.probe()');
            log('probe ' + report);
          } else if (auto === 'sleep') {
            // 睡觉三段接力：入睡 → 循环 → 叫醒 → 回待机
            const p = win.webContents.executeJavaScript('window.__petDeskTest.sleepTest()');
            // 等 13 秒：入睡段 10 秒素材播完，这会儿正在循环段（睡着的姿势），抓一张
            await new Promise((r) => setTimeout(r, 13000));
            try {
              const shot = await win.webContents.capturePage();
              fs.writeFileSync(path.join(require('node:os').tmpdir(), 'dsh-pet-brain-sleep-shot.png'), shot.toPNG());
            } catch {
              /* 抓不到就算了 */
            }
            const report = await p;
            log('sleep ' + report);
          } else if (auto === 'baifan') {
            // 追饭五连：跑 → 追 → 等开饭 → 吃碗饭 → 吃饭团
            const p = win.webContents.executeJavaScript('window.__petDeskTest.baifanTest()');
            // 走到一半抓一张，确认真的在跑
            await new Promise((r) => setTimeout(r, 4000));
            try {
              const shot = await win.webContents.capturePage();
              fs.writeFileSync(path.join(require('node:os').tmpdir(), 'dsh-pet-brain-baifan-shot.png'), shot.toPNG());
            } catch {
              /* 抓不到就算了 */
            }
            const report = await p;
            log('baifan ' + report);
          } else if (auto === 'gazeleft' || auto === 'gazeright' || auto === 'hover') {
            // 视线/悬停：直接喂一条光标消息，不用真去挪鼠标
            const side = auto === 'gazeleft' ? -1 : auto === 'gazeright' ? 1 : 0;
            const over = auto === 'hover';
            const report = await win.webContents.executeJavaScript(
              `window.__petDeskTest.cursor(${side}, ${over ? 'true' : 'false'})`
            );
            log('cursor ' + report);
            await new Promise((r) => setTimeout(r, 900));
          } else if (auto === 'taphead' || auto === 'tapbody') {
            const report = await win.webContents.executeJavaScript(
              `window.__petDeskTest.tap(${JSON.stringify(auto === 'taphead' ? 'head' : 'body')})`
            );
            log('tap ' + report);
            await new Promise((r) => setTimeout(r, 1200));
          } else if (auto === 'hoverlook') {
            // 悬停盯久了会不会抬头/被看毛：先把画面钉在非待机动作上
            // （以前"抬头看你"卡着"必须正待机"，动作池上线后就再没触发过），
            // 再喂一条"悬停中"，等六秒让它自己演
            await win.webContents.executeJavaScript('window.__petDeskTest.pose("写代码")');
            const report = await win.webContents.executeJavaScript('window.__petDeskTest.cursor(0, true)');
            log('hoverlook ' + report);
            await new Promise((r) => setTimeout(r, 6_000));
          } else if (auto === 'think') {
            const report = await win.webContents.executeJavaScript('window.__petDeskTest.think()');
            log('think ' + report);
            await new Promise((r) => setTimeout(r, 200));
          } else if (auto === 'freeze') {
            // 一次性动作播完会不会僵在最后一帧：点一下，等八秒再看它站没站回去
            const report = await win.webContents.executeJavaScript('window.__petDeskTest.tap("body")');
            log('freeze ' + report);
            await new Promise((r) => setTimeout(r, 8_000));
            const after = await win.webContents.executeJavaScript('window.__petDeskTest.animNow()');
            log('freeze-after ' + after);
            // 素材普遍 10 秒，再等一轮确认它真的接回待机了
            await new Promise((r) => setTimeout(r, 5_000));
            const after2 = await win.webContents.executeJavaScript('window.__petDeskTest.animNow()');
            log('freeze-after2 ' + after2);
          } else if (auto === 'stretch') {
            const report = await win.webContents.executeJavaScript('window.__petDeskTest.stretch()');
            log('stretch ' + report);
            await new Promise((r) => setTimeout(r, 1_000));
          } else if (auto === 'poke') {
            const report = await win.webContents.executeJavaScript('window.__petDeskTest.poke()');
            log('poke ' + report);
            await new Promise((r) => setTimeout(r, 600));
          } else if (auto === 'motive') {
            const report = await win.webContents.executeJavaScript('window.__petDeskTest.motive()');
            log('motive ' + report);
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
  win.webContents.on('render-process-gone', (_e, d) => {
    log('renderer gone ' + JSON.stringify(d));
    // 2026-11-11（P2）：以前固定 1 秒重载一次，真崩（OOM/GPU）时变成每秒重建
    // 一个渲染进程，CPU 和日志一起涨，永远停不下来。改成指数退避，三次后停手
    // 并把窗口收起 —— 宿主那边的看门狗会把它重新居中/拉起。
    crashReloads += 1;
    if (crashReloads > 3) {
      log('renderer 连续崩溃 ' + crashReloads + ' 次，停止自动重载');
      try {
        if (win && !win.isDestroyed()) win.hide();
      } catch {
        /* ignore */
      }
      return;
    }
    const delay = 1000 * 2 ** (crashReloads - 1); // 1s / 2s / 4s
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      try {
        win.webContents.reload();
        log('renderer reloaded（第 ' + crashReloads + ' 次，延迟 ' + delay + 'ms）');
      } catch (err) {
        log('reload fail ' + (err?.message || err));
      }
    }, delay);
  });
  // Electron 35 起 console-message 改成只传一个 details 对象（位置参数已废弃，47 会移除）
  win.webContents.on('console-message', (_e, details) => {
    const d = details && typeof details === 'object' ? details : null;
    log('console[' + (d?.level ?? '?') + '] ' + (d?.message ?? String(details)));
  });


  win.on('closed', () => {
    log('window closed');
    stopPointerPoll();
    // 排障定时器也要清：不清的话窗口关了它还会醒一次，去打一个已销毁的 webContents
    if (debugTimer) {
      clearTimeout(debugTimer);
      debugTimer = 0;
    }
    overlays = [];
    // 窗口没了，"当前穿透状态"也要复位：下次建窗时 ignoring=null，
    // 第一句 setIgnore(true) 才会真的下发。
    ignoring = null;
    petBox = null;
    lastCursorKey = '';
    lastHitDbg = null;
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

/**
 * 宠物本体在窗口里的位置（相对窗口左上角）。
 *
 * 2026-11-12：碰撞范围改成「屏幕」之后，所有边界都按**宠物本体**算，不再按窗口算 ——
 * 窗口上面那一大块是 HUD 留白（320px），拿窗口当边界的话宠物永远够不到屏幕顶，
 * 而拿窗口的 20%/40% 当边界又会让落地悬在半空。
 */
function petBoxIn(width = curBounds.width, height = curBounds.height) {
  const w = Math.round(petWidth);
  const h = Math.round((petWidth * 9) / 16);
  // 没采样到就退回保守内缩，保证至少点得到
  const box = petBox || { left: 0.06, top: 0.08, right: 0.94, bottom: 0.92 };
  const x0 = Math.round(w * box.left);
  const y0 = Math.round(h * box.top);
  const x1 = Math.round(w * box.right);
  const y1 = Math.round(h * box.bottom);
  return {
    x: Math.round((width - w) / 2) + x0,
    y: Math.round(height - BADGE_SPACE - h) + y0,
    w: Math.max(24, x1 - x0),
    h: Math.max(24, y1 - y0),
  };
}

function petZone() {
  return petBoxIn(curBounds.width, curBounds.height);
}

/**
 * 宠物本体在**屏幕**上能待的范围（窗口坐标）。
 * 四条边都是屏幕工作区：左/右/上/下 —— 老大 2026-11-12 定的口径，
 * 碰撞范围是屏幕，不是桌面端那块界面。
 */
function petLimits(width = curBounds.width, height = curBounds.height, area = null) {
  const r = area || displayOf({ x: curBounds.x, y: curBounds.y, width, height }).workArea;
  const box = petBoxIn(width, height);
  return {
    minX: r.x - box.x,
    maxX: r.x + r.width - box.x - box.w,
    minY: r.y - box.y,
    maxY: r.y + r.height - box.y - box.h,
  };
}

let overlays = [];
const POINTER_POLL_MS = 60;
let pollTimer = null;

let lastHitDbg = null;
/** 最近一次光标命中判定：pet:interactive 收回常态时要用它还原穿透状态 */
let pointerHit = false;

/**
 * 光标方位回传：渲染端拿它做「视线跟着鼠标」和「悬停反应」。
 *
 * 只在方位档位（左/中/右）、是否悬在宠物身上、是否还在窗口内这三件事变化时才发，
 * 不然 60ms 一条 IPC，渲染端每秒要处理十六次无关更新。
 */
let lastCursorKey = '';
function publishCursor(lx, ly) {
  if (!win || win.isDestroyed()) return;
  const zone = petZone();
  const inside = lx >= 0 && ly >= 0 && lx < curBounds.width && ly < curBounds.height;
  const over =
    inside &&
    lx >= zone.x &&
    ly >= zone.y &&
    lx < zone.x + zone.w &&
    ly < zone.y + zone.h;
  const cx = zone.x + zone.w / 2;
  const cy = zone.y + zone.h / 2;
  const nx = (lx - cx) / Math.max(1, zone.w / 2);
  const ny = (ly - cy) / Math.max(1, zone.h / 2);
  // 死区 0.18：正中那一小段算"正对着"，免得手一抖就左右横跳
  const side = nx < -0.18 ? -1 : nx > 0.18 ? 1 : 0;
  /*
   * 离得远就别一直扭着脸。
   * 桌宠贴着屏幕右下角，光标绝大多数时间都在它左边 —— 要是无条件跟，
   * 它就永远是镜像的那一面，看着像贴反了。只有光标靠近了才扭头看过去，走远了回正。
   */
  const dist = Math.hypot(lx - cx, ly - cy);
  const near = dist < 520;
  const look = near ? side : 0;
  const key = look + '|' + (over ? 1 : 0) + '|' + (inside ? 1 : 0);
  if (key === lastCursorKey) return;
  lastCursorKey = key;
  win.webContents.send('pet:cursor', {
    side: look,
    over,
    inside,
    near,
    nx: Math.round(nx * 100) / 100,
    ny: Math.round(ny * 100) / 100,
  });
}

function pollPointer() {
  if (!win || win.isDestroyed() || !curBounds.width) return;
  // 窗口不可见时不必再采样：看不见的东西不吃点击，也没人去点它
  if (!win.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const lx = p.x - curBounds.x;
  const ly = p.y - curBounds.y;
  let hit = false;
  if (lx >= 0 && ly >= 0 && lx < curBounds.width && ly < curBounds.height) {
    const zones = [petZone(), ...overlays];
    hit = zones.some((z) => z && lx >= z.x && ly >= z.y && lx < z.x + z.w && ly < z.y + z.h);
  }
  pointerHit = hit;
  if (hit !== lastHitDbg) {
    lastHitDbg = hit;
    log('pointer hit=' + hit + ' at=' + lx + ',' + ly + ' zones=' + JSON.stringify(overlays));
  }
  // 渲染端要求整窗可交互时（菜单/面板正开着），别被轮询翻回穿透 ——
  // 菜单刚展开那一下点不中，就是这个 60ms 空窗造成的。
  setIgnore(forceInteractive ? false : !hit);
  try {
    publishCursor(lx, ly);
  } catch (err) {
    log('cursor 回传失败 ' + (err?.message || err));
  }
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

/**
 * IPC 来源校验。
 *
 * 这些通道只该由本进程自己开的那一个窗口发。
 * 不校验的话，将来窗口里加载了任何外来内容，它都能驱动桌宠
 * （移动窗口、抛掷、关进程）。sender 对不上就当没听见。
 */
function fromPet(e) {
  return !!win && !win.isDestroyed() && e && e.sender === win.webContents;
}

ipcMain.on('pet:recenter', (e) => {
  if (!fromPet(e)) return;
  recenterPet('菜单点了重新居中');
});

ipcMain.on('pet:hotzones', (_e, list) => {
  if (!fromPet(_e)) return;
  // 坐标必须都是有限数：NaN/Infinity 混进来，命中判定会静默失灵，
  // 光标压在宠物身上也算不中 → 看着就是"点不动"。
  overlays = Array.isArray(list)
    ? list
        .filter(
          (z) =>
            z &&
            [z.x, z.y, z.w, z.h].every((n) => Number.isFinite(n)) &&
            z.w > 0 &&
            z.h > 0
        )
        .map((z) => ({ x: Math.round(z.x), y: Math.round(z.y), w: Math.round(z.w), h: Math.round(z.h) }))
    : [];
  // 浮层刚出现时立刻重判一次命中：否则要等最多 60ms 轮询才翻穿透，
  // 那一瞬间点菜单会穿透到桌面（"菜单点了没反应"）。
  try {
    pollPointer();
  } catch {
    /* 指针采样失败不影响 */
  }
});

ipcMain.on('pet:contentbox', (_e, box) => {
  if (!fromPet(_e)) return;
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

/**
 * 渲染端明确要求的整窗可交互状态。
 *
 * preload 暴露的 setInteractive(boolean) 是双向的：true = 整窗收鼠标，
 * false = 回到按光标位置判断。以前主进程只认 true，false 被丢掉，
 * 于是"菜单收起后回到常态"这个动作永远做不了 ——
 * 契约只实现了一半。
 */
let forceInteractive = false;

ipcMain.on('pet:interactive', (_e, next) => {
  if (!fromPet(_e)) return;
  // 渲染端只在"确实需要整窗接收"时用这个快通道；常态交给轮询
  forceInteractive = next === true;
  if (forceInteractive) setIgnore(false);
  else setIgnore(!pointerHit);
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
  // 2026-11-12：碰撞范围 = 整块屏幕的工作区，按「宠物本体」算。
  // 旧版这里按窗口算顶部/地面，跟 clampToDisplay 的窗口口径打架，
  // 结果宠物永远够不到屏幕顶、落地还悬空一截。
  const area = displayOf(b).workArea;
  const limits = petLimits(b.width, b.height, area);

  phys.vy += PHYS.GRAVITY * dt;
  phys.vx *= PHYS.AIR_DRAG;
  let x = b.x + phys.vx * dt;
  let y = b.y + phys.vy * dt;

  // 左右墙
  if (x < limits.minX) {
    x = limits.minX;
    phys.vx = -phys.vx * PHYS.WALL_BOUNCE;
  } else if (x > limits.maxX) {
    x = limits.maxX;
    phys.vx = -phys.vx * PHYS.WALL_BOUNCE;
  }

  // 天花板：宠物头顶到屏幕顶就弹回来
  if (y < limits.minY) {
    y = limits.minY;
    phys.vy = Math.abs(phys.vy) * PHYS.WALL_BOUNCE;
  }

  // 地面：宠物脚底贴屏幕底（窗口底下还留着 BADGE_SPACE 给状态徽章）
  const floor = limits.maxY;
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
 * 素材里没有"从 A 走到 B"的动画（上游的提示词还写死了「全程不许产生 X 轴位移」），
 * 所以位移只能由主进程做 —— 渲染端播一段原地走路动画，主进程把窗口挪过去。
 *
 * 位移曲线照抄上游 dsh-pet 的 `src/client/pet/motion/walk.ts`：
 *   起手 leadSec 秒原地不动 → 中段按「动画播放时间」线性插值 → 收脚 tailSec 秒站定。
 * 跟着动画时间走而不是匀速，脚不会打滑，起身和收步也自然。
 */
const WALK = {
  minSpeed: 50, // px/s（旧的匀速路径还在用）
  maxSpeed: 130,
  tickMs: 16,
  /** 起手 / 收脚各多少媒体秒原地不动（对齐上游 moves.default） */
  leadSec: 1.0,
  tailSec: 1.6,
};

const walk = {
  mode: 'idle',
  startX: 0,
  targetX: 0,
  t0: 0,
  duration: 0,
  leadSec: WALK.leadSec,
  tailSec: WALK.tailSec,
  rate: 1,
  speed: 0,
  timer: null,
  dir: 1,
};

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
  // 2026-11-11：物理边界跟着窗口所在的屏幕走，副屏上不会一步跳回主屏
  const area = displayOf(b).workArea;
  const minX = area.x;
  const maxX = area.x + area.width - b.width;
  const target = Math.min(Math.max(walk.targetX, minX), maxX);

  // 走了多少（媒体时间，素材按 rate 倍速播放）
  const elapsed = (Date.now() - walk.t0) / 1000;
  const media = elapsed * walk.rate;
  const travel = Math.max(0.1, walk.duration - walk.leadSec - walk.tailSec);
  let ratio;
  if (media <= walk.leadSec) ratio = 0;
  else if (media >= walk.duration - walk.tailSec) ratio = 1;
  else ratio = (media - walk.leadSec) / travel;

  const wantX = Math.round(walk.startX + (target - walk.startX) * ratio);
  if (wantX !== b.x) movePetTo(wantX, b.y);

  if (media >= walk.duration) {
    movePetTo(target, b.y);
    stopWalk(target === walk.targetX ? 'arrived' : 'hit-edge');
  }
}

function startWalk(targetX, speed = 80, opts = {}) {
  if (!win || win.isDestroyed()) return;
  const target = Number(targetX);
  if (!Number.isFinite(target)) return;
  stopPhysics();
  const b = win.getBounds();
  walk.startX = b.x;
  walk.targetX = Math.round(target);
  walk.speed = Math.min(Math.max(Number(speed) || 80, WALK.minSpeed), WALK.maxSpeed);
  walk.dir = walk.targetX >= b.x ? 1 : -1;
  walk.duration = Number(opts.duration) > 0 ? Number(opts.duration) : 10.04;
  walk.leadSec = Number.isFinite(Number(opts.leadSec)) ? Number(opts.leadSec) : WALK.leadSec;
  walk.tailSec = Number.isFinite(Number(opts.tailSec)) ? Number(opts.tailSec) : WALK.tailSec;
  walk.rate = Number(opts.rate) > 0 ? Number(opts.rate) : 1;
  walk.t0 = Date.now();
  walk.mode = 'walk';
  if (!walk.timer) walk.timer = setInterval(walkTick, WALK.tickMs);
  win.webContents.send('pet:walk-start', { dir: walk.dir });
}

/**
 * 渲染端发起走位：它已经播上了动画，把时长和起收脚秒数一起报过来，
 * 主进程按播放时间插值把窗口挪过去。
 */
ipcMain.on('pet:walk-begin', (_e, msg) => {
  if (!fromPet(_e)) return;
  if (!win || win.isDestroyed() || !msg) return;
  const dx = Number(msg.dx);
  if (!Number.isFinite(dx) || Math.abs(dx) < 4) return;
  const b = win.getBounds();
  startWalk(b.x + dx, 0, msg);
});

ipcMain.on('pet:walk', (_e, msg) => {
  if (!fromPet(_e)) return;
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
  if (!fromPet(_e)) return;
  if (!win || win.isDestroyed() || !msg) return;
  if (msg.phase === 'start') {
    stopPhysics();
    stopWalk('drag');
    // 坐标必须是有限数：NaN 会把 dragOffset 变成 NaN，之后 movePetTo 一直搬 NaN
    if (!Number.isFinite(msg.screenX) || !Number.isFinite(msg.screenY)) {
      log('pet:drag start 非法坐标');
      return;
    }
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
  if (!Number.isFinite(msg.screenX) || !Number.isFinite(msg.screenY)) return;
  movePetTo(msg.screenX - dragOffset.dx, msg.screenY - dragOffset.dy);
});

/** 渲染端回报宠物实际宽度，据此调整窗口大小（滚轮缩放 / 设置里改尺寸都走这里） */
ipcMain.on('pet:resize', (_e, width) => {
  if (!fromPet(_e)) return;
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
  if (!fromPet(_e)) return;
  const next = Math.max(0, Math.min(HUD_MAX, Math.round(Number(extra) || 0)));
  if (next !== panelExtra) {
    panelExtra = next;
    log('pet:grow ignored (window size is fixed) extra=' + next);
  }
});

ipcMain.on('pet:quit', (e) => {
  if (!fromPet(e)) return;
  app.quit();
});

ipcMain.handle('pet:env', (e) => {
  if (!fromPet(e)) return null;
  return {
    host: HOST_ORIGIN,
    // 跨源令牌：渲染端每个请求都得带上，别落到 localStorage / 日志里
    token: PET_TOKEN,
    petWidth,
    // 回报真实的穿透状态：ignoring 可能是 null（还没下发过），别把它当成"没穿透"
    ignoring: ignoring === true,
    version: process.versions.electron,
  };
});

app.whenReady().then(() => {
  // 没抢到锁说明已经有宠物在跑：这时候只该退出，别再开一个窗口闪一下
  if (!gotLock) return;
  log('app ready');
  // 应用菜单在无边框窗口里也会响应 Alt 键，清掉
  Menu.setApplicationMenu(null);
  /*
   * 建窗失败必须显式退出。
   * 以前 createWindow() 抛异常会变成 whenReady 的 unhandled rejection，
   * 再被 uncaughtException handler 吞掉 —— 结果进程活着、单实例锁占着、
   * 一个窗口都没有，宿主那边还显示"helper 在跑"。
   */
  try {
    createWindow();
  } catch (e) {
    log('createWindow 失败 ' + (e?.stack || String(e)));
    app.exit(1);
    return;
  }
  log('window created ' + JSON.stringify(curBounds) + ' petZone=' + JSON.stringify(petZone()));

  /*
   * 2026-11-11（P0）：兜底「找得回」。
   * 拖拽已经夹边界了，但还有几种漏网：拔掉副屏、改分辨率、远程桌面切换、
   * 以及窗口被系统挪到可视区外。每 5 秒看一眼：窗口在所有显示器上的
   * 可见面积不足三成，就把它放回光标所在屏幕的右下角。
   */
  const watchdog = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const area = Math.max(1, b.width * b.height);
    if (visibleAreaOf(b) < area * 0.3) recenterPet('窗口掉到屏幕外了');
  }, 5000);
  watchdog.unref?.();

  // 显示器变化（插拔、改分辨率、缩放）时立刻重新夹一次
  const reclamp = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const safe = clampToDisplay(b.x, b.y, b.width, b.height);
    if (safe.x !== b.x || safe.y !== b.y) movePetTo(safe.x, safe.y);
  };
  screen.on('display-metrics-changed', reclamp);
  screen.on('display-removed', reclamp);
  screen.on('display-added', reclamp);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        createWindow();
      } catch (e) {
        log('createWindow 失败 ' + (e?.stack || String(e)));
        app.exit(1);
      }
    }
  });
});

app.on('before-quit', () => log('before-quit'));
app.on('window-all-closed', () => {
  log('window-all-closed → quit');
  app.quit();
});
process.on('uncaughtException', (e) => {
  log('uncaught', e?.stack || String(e));
  // 致命错误别硬撑：进程半死不活，宿主还以为它在跑
  const fatal = /ERR_[A-Z_]+/.test(String(e?.code || e?.message || ''));
  if (fatal) {
    log('致命错误，退出 ' + (e?.code || e?.message));
    app.exit(1);
  }
});
// 未处理的 Promise 拒绝以前没人管：跟未捕获异常一样静默吞掉，问题看不见
process.on('unhandledRejection', (reason) => {
  log('unhandledRejection ' + (reason?.stack || String(reason)));
});
