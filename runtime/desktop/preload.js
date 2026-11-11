/**
 * preload 桥：只暴露窗口原语，不碰文件系统。
 *
 * 渲染端拿不到 node / electron，只能通过这几个方法与主进程通信：
 *   - setInteractive(boolean)：整窗点击穿透翻转（光标是否压在宠物身上）
 *   - hotzones(list)：上报可见浮层矩形（窗口坐标），主进程据此 + 宠物矩形翻穿透
 *   - drag(phase, screenX, screenY, vx, vy)：拖拽时移动窗口，松手带速度做抛掷
 *   - grow(extra)：保留兼容，主进程已不改窗口尺寸（改了会闪）
 *   - quit()：关掉桌面助手
 *   - env()：读宿主 origin 等启动信息
 *   - onLand(cb)：落地回调
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petDesk', {
  setInteractive: (next) => ipcRenderer.send('pet:interactive', Boolean(next)),
  /** 上报可见浮层矩形（窗口坐标 DIP）：[{x,y,w,h}]，主进程按它 + 宠物矩形翻穿透 */
  hotzones: (list) => ipcRenderer.send('pet:hotzones', Array.isArray(list) ? list : []),
  /** 上报宠物本体包围盒（0..1 比例，相对视频框）：{left,top,right,bottom}，主进程据此定热区 */
  contentBox: (box) => ipcRenderer.send('pet:contentbox', box || null),
  /**
   * 拖拽。phase='end' 时带上 vx/vy（px/s），主进程据此抛掷。
   */
  drag: (phase, screenX = 0, screenY = 0, vx = 0, vy = 0) =>
    ipcRenderer.send('pet:drag', { phase, screenX, screenY, vx, vy }),
  /** 气泡/菜单/面板出现时把窗口往上长（底边不动），收起来传 0 */
  grow: (extra) => ipcRenderer.send('pet:grow', extra),
  /** 走动：把窗口平滑挪到屏幕 x（主进程限速 + 限边界）；stop 用于打断 */
  walk: (x, speed = 80) => ipcRenderer.send('pet:walk', { x, speed }),
  /** 相对走动：dx 是"往右走多少像素"，渲染端不知道窗口坐标，用这个 */
  walkBy: (dx, speed = 80) => ipcRenderer.send('pet:walk', { dx, speed }),
  /**
   * 上游式走位（对齐 dsh-pet 的 motion/walk.ts）：
   * 渲染端先播走位动画，再把「相对位移 + 素材时长 + 起收脚秒数」交给主进程，
   * 主进程按动画播放时间线性插值窗口位置 —— 脚不打滑，起步收步也自然。
   */
  walkBegin: (info) =>
    ipcRenderer.send('pet:walk-begin', {
      dx: Number(info?.dx) || 0,
      duration: Number(info?.duration) || 0,
      leadSec: Number(info?.leadSec) || 0,
      tailSec: Number(info?.tailSec) || 0,
      rate: Number(info?.rate) || 1,
    }),
  stopWalk: () => ipcRenderer.send('pet:walk', { stop: true }),
  /** 保留兼容：渲染端启动时会上报一次宽度。窗口尺寸已固定，主进程收到同值会直接忽略 */
  resize: (width) => ipcRenderer.send('pet:resize', width),
  quit: () => ipcRenderer.send('pet:quit'),
  /** 把桌宠挪回光标所在屏幕的右下角（找不到 / 掉到屏幕外时的兜底） */
  recenter: () => ipcRenderer.send('pet:recenter'),
  env: () => ipcRenderer.invoke('pet:env'),
  /** 落地回调：主进程物理算出撞击强度时通知渲染端做压扁动画 */
  // 每次注册都返回退订函数：以前重复注册会堆一堆 listener，事件来一次回调 N 次
  onLand: (cb) => {
    const h = (_e, info) => cb(info);
    ipcRenderer.on('pet:land', h);
    return () => ipcRenderer.off('pet:land', h);
  },
  /** 开始走动：dir=1 向右、-1 向左，渲染端据此决定播走路动画和要不要镜像 */
  onWalkStart: (cb) => {
    const h = (_e, info) => cb(info);
    ipcRenderer.on('pet:walk-start', h);
    return () => ipcRenderer.off('pet:walk-start', h);
  },
  /** 走完 / 被打断 */
  onWalkEnd: (cb) => {
    const h = (_e, info) => cb(info);
    ipcRenderer.on('pet:walk-end', h);
    return () => ipcRenderer.off('pet:walk-end', h);
  },
  /**
   * 光标方位（主进程 60ms 采样，只在变化时推）：
   * { side: -1|0|1, over: 是否悬在宠物身上, inside: 是否还在窗口内, nx, ny }
   * 渲染端拿它做视线跟随和悬停反应。
   */
  onCursor: (cb) => {
    const h = (_e, info) => cb(info);
    ipcRenderer.on('pet:cursor', h);
    return () => ipcRenderer.off('pet:cursor', h);
  },
});
