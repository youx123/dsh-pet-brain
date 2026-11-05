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
  /** 保留兼容：渲染端启动时会上报一次宽度。窗口尺寸已固定，主进程收到同值会直接忽略 */
  resize: (width) => ipcRenderer.send('pet:resize', width),
  quit: () => ipcRenderer.send('pet:quit'),
  env: () => ipcRenderer.invoke('pet:env'),
  /** 落地回调：主进程物理算出撞击强度时通知渲染端做压扁动画 */
  onLand: (cb) => ipcRenderer.on('pet:land', (_e, info) => cb(info)),
});
