# dsh-pet-brain 🐟

挂在 DeepSeek Harness 桌面上的桌宠，**脑子是「共享大脑」**。

它不自己编人设，也不自己攒记忆：人设、心情、长期记忆全部实时读
`dsh-shared-brain` 的落盘数据。共享大脑里换人设、心情变了、你聊过什么，
桌宠下一轮就跟着变。

## 它和 dsh-pet 是什么关系

| | dsh-pet | dsh-pet-brain |
| --- | --- | --- |
| 人设 | 插件配置里手写 | 共享大脑 `persona.json`（唯一源头） |
| 情绪 | 无 | 共享大脑 `emotion.json` 的 mood + 七维 |
| 记忆 | 本地 5 轮对话 | 共享大脑 `memory.json`，按当轮输入实时召回，**聊完还会写回去** |
| 主动搭话 | 自己写死的定时器 | **共享大脑的决策层算**（安静期/每日上限/均匀铺开/关心/分享），档位和它一致 |
| 工作状态 | 自己判断 | 直接读宿主的 `ctx.agents.list()`，你在干活它就换动作 |
| 表现 | 动画池大、桌面 Helper、余额 | 同上，但只做一只：462px 固定体型 + 心情徽章 + 气泡 + 面板 |
| 素材 | 自建 | 复用它的 44 个 webm（MIT，见 NOTICE.md） |

两者可以同时装，但都挂 `shell.overlay`，会叠在一起——建议只留一个。

## 装在哪

- 源码：`C:\Users\13176\Documents\dsh-pet-brain`
- profile 里是 junction：`C:\Users\13176\.dsh\profiles\desktop\node_modules\dsh-pet-brain`
  （所以改代码不用重装，重启宿主即可）

## 数据从哪来

```
%DSH_HOME%/storages/dsh-shared-brain/
  persona.json    当前人设正文（current → personas[].text）
  emotion.json    states[<sessionId>].mood / dims{} / lastReason
  memory.json     entries[]：text / tags / module / weight / pinned / lifetime
  modules.json    底线条目
```

读盘带 `mtime + size` 缓存，文件没动就不重复解析。

心情取 `updatedAt` 最新的那条会话状态（多会话并行时以最近活动为准）。
需要固定跟某只宠物绑一个会话，可以在 `/pet-brain/state?session=<id>` 里指定。

## HTTP 端点（仅 loopback）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/pet-brain/config` | 轮询间隔、尺寸、动画名表、档位→动画映射 |
| GET | `/pet-brain/state` | 当前人设名、心情、档位、七维、最近原因、建议动作、最近 3 条记忆、工作状态 |
| GET | `/pet-brain/usage` | 余额 / 今日已用 / 近 7 天 / 是否优惠时段（`?refresh=1` 跳过 60s 缓存） |
| POST | `/pet-brain/chat` | `{text, history}` → `{reply, mood, action, memories}` |
| GET | `/pet-brain/proactive` | 共享大脑主动互动决策的只读视图：该不该说、什么语气、什么话题、什么时候再说 |
| POST | `/pet-brain/speak` | 走完整决策链：决策 → 生成 → 回写每日额度 → `{text, emoji, actions}`；`{force:true}` 强制开口 |
| GET | `/pet-brain/work` | 当前有几个会话在跑、桌宠该配什么工作动作 |
| GET | `/pet-brain/anim/<名>.webm` | 动画素材（白名单，防路径穿越） |

## 心情档位 → 动作

档位名**必须跟共享大脑一致**（`lib/brain.js` 的 `bandOf`），否则表情禁忌表和主动决策对不上：

| 档位 | mood | 动作 |
| --- | --- | --- |
| 欢喜 `delighted` | ≥80 | 工作状态-雀跃庆祝 |
| 开心 `happy` | ≥62 | 点击回应-开心跃动 |
| 一般 `ok` | ≥42 | 悠闲哼歌 |
| 心疼 `heartache` | ≥25 | 碎碎念-发呆碎碎念 |
| 难过 `sad` | <25 | 原地小憩沉眠 |

七维各自还有专属动作池（`DIM_ACTIONS`），优先级高于档位。

档位变化时才会换动作，而且只在它待机的时候换，不会打断你正在看的动画。

## 聊天是怎么拼的

每次 `/chat` 都现场拼一份 system prompt，顺序是：

1. 共享大脑当前人设正文（全文）
2. 桌宠身份约束（短、口语、不念提示词）
3. 当前心情 + 七维 + 最近一次情绪波动的原因
4. 按你这句输入召回的 5 条长期记忆
5. 底线条款（最多 3 条）

召先是中文 2-gram + 英文分词，打分 = 命中词数 × (0.4 + weight)，置顶 ×1.6，
排除底线条目和已过期的临时记忆。

## 与共享大脑的联动（核心）

桌宠不自己攒脑子，四条链路全部接在共享大脑上：

**1. 读**
人设（`persona.json`）、心情与七维（`emotion.json`）、长期记忆（`memory.json`）、
声音风格（`modules.json` 的 `voice.style`）、主动互动配置（`modules.json` 的 `agentive`）。
读盘带 `mtime + size` 缓存，文件没动不重复解析。

**2. 说**
主动搭话不自己拍脑袋，抄了共享大脑 `lib/proactive-mood.js` 的判定顺序（`lib/proactive.js`）：

```
安静期(quietPeriodMs×factor) → 每日上限(maxPerDay) → 均匀铺开(paced)
  → 有 pending 必说 → 心情低则关心(soft) → 心情高则分享(upbeat) → 否则 routine(light)
```

决策历史落在桌宠自己的账本 `%DSH_HOME%/dsh-pet-brain/proactive-history.json`，
字段跟共享大脑那份一模一样（`dayStamp`/`spokeToday`/`concerns`/`usedTopics`/`lastSpokeAt`）。

**为什么不共用那一份**：共享大脑是用「启动时读进内存的快照」整份覆写它的
`storages/dsh-shared-brain/proactive-history.json`。它的快照里没有桌宠的桶，
于是它每保存一次就把桌宠的记录整桶抹掉 —— 表现是每日额度归零、间隔判定失效，
桌宠会没完没了地搭话。分开存之后：桌宠每天 3 句、主会话每天 3 句，各算各的。

心情低了会主动关心你（最多 1 条/会话），高了会跟你分享。

**3. 表情**
`lib/proactive.js` 的 `proposeEmoji` 按维度/档位选表情，并给出一张**禁忌表**
（`avoid`，难过档禁 laughing/celebrate 之类）。气泡里贴的是共享大脑自己的 GIF
（`/api/dsh-shared-brain/emoji/<key>.gif`）。

**4. 写**
聊过的话会回写共享大脑（`lib/remember.js`），按内容自动分模块：

| 触发词 | 落哪个模块 | 权重 | 生命周期 |
| --- | --- | --- | --- |
| 不许/不能/别再/禁止/必须… | `bottomline` 底线 | 0.9 | 永久 |
| 喜欢/爱你/生气/难过… | `emotion` 情感 | 0.72 | 永久 |
| 我喜欢/我讨厌/以后都/每次都… | `instinct` 本能 | 0.68 | 永久 |
| 其它 | `cognition` 认知 | 0.55 | 临时 7 天 |

写进去的条目下一轮就进 system prompt 的「必须守住的底线」段 —— 也就是说
"老大我最喜欢你陪着我了" 这类话，说一次就记住，长期生效。
寒暄（"在吗"/"嗯"/"测试"）、纯标点、纯 emoji 不写。

**工作状态**：直接读宿主的 `ctx.agents.list()`（Agent 实例带 `status` 字段）。
注意 `ctx.on('agent/status')` 是 Scoped 事件，插件 scope 里收不到别的会话，别在那儿浪费时间。

## 交互

| 动作 | 效果 |
| --- | --- |
| 单击 | 开/关聊天面板 |
| 右键 | 菜单：聊两句 / 看看心情 / 看看余额 / 换个动作 / 多说点 / 关掉桌面助手 |
| 点心情徽章 | 开/关心情面板（总分 + 档位 + 七维条） |
| 滚轮 | 不再缩放（体型固定，见下） |
| 双击 | 摸摸头（卖萌 + 一句回应） |
| 拖动 | 拖着走，松手带惯性抛掷和弹墙；坐标允许越过视口边界（最多探出 35%，见下） |
| 拖到左右 1/3 区域松手 | 吸附到窗口边缘，并往外挪一点，看起来挂在边上 |
| 不动的时候 | 14–48 秒随机做个小动作；主动说话交给共享大脑的 `decideProactive` 决策 |

心情档位变化时会换动作，10 分钟内最多为心情变化吭一声；`多说点/安静点` 关掉主动说话（记忆存在 localStorage）。

## 桌面助手（真正的桌宠）

除了挂在 DSH 客户端里的那一只，还有一个**独立 Electron 窗口**版本 —— 它不在客户端页面里画，
是操作系统级窗口，客户端最小化、被挡住、甚至关掉，它都还在桌面上。

- 入口：`lib/desktop.js` spawn `runtime/desktop/main.js`
- **体型固定 462×260**（跟旧版 dsh-pet 的 `size: 462` 一致，高 = 462 × 9/16），不提供缩放
- **窗口尺寸从一开始就是固定的，之后永不改变**：窗口 = 宠物 462×260 + 底部 26px 徽章位 +
  上方 600px 的 HUD 预留区（`hudSpace()` 按 workArea 高度取 120~600）。气泡、右键菜单、
  各种面板都长在那块预留区里，窗口自己一动不动。
  为什么这么死板：**Windows 透明分层窗口每改一次尺寸就重建一次 DWM 合成层，屏幕上的表现就是闪一下**。
  「点一下就闪」查了半天不是视频换源、不是双缓冲，就是 `setContentBounds` 在改高度。
  `pet:grow` 这个 IPC 还留着（渲染端会调），但主进程收到只记一行日志、什么都不做。
- **重启后会自己回来，但被你关过就不回来**：插件加载时读 `%DSH_HOME%/dsh-pet-brain/desktop.json`
  的 `closedByUser`。右键菜单「✕ 关掉桌面助手」会先 `POST {"action":"close"}` 把这个标记写成
  `true` 再退出，所以下次宿主重启它不会自己爬回来；`{"action":"start"}` 会清掉标记。
  `{"action":"stop"}` 只是这一次停，不改意愿（重启后仍会回来）。
- 插件卸载时才顺手把 helper 收掉，不留孤儿进程
- 找不到 Electron 时按顺序试：`DSH_PET_BRAIN_ELECTRON_PATH` → `$DSH_HOME/electron/electron.exe` → `electron`
- **点击穿透靠 60ms 光标轮询，不靠 `forward` 转发**：窗口比宠物大一大圈，默认整窗穿透
  （`setIgnoreMouseEvents(true, {forward:true})`），否则右边会挡掉一整条桌面。
  但 Windows 上 `forward` 转发不稳（会静默失效，失效后没有任何退路，表现就是**永久点不动**），
  所以主进程每 `POINTER_POLL_MS = 60` 毫秒用 `screen.getCursorScreenPoint()` 取真实光标，
  比一遍热区：**宠物矩形由主进程自己算**（`petZone()`，固定的，不等渲染端），
  浮层矩形由渲染端 `hotzones()` 上报（菜单/面板，气泡不算 —— 它不可交互，算进去反而挡桌面）。
  命中才 `setIgnoreMouseEvents(false)`。渲染端不再自己用 `mousemove` 判命中。
- **双缓冲视频，换动作不闪**：两块 `<video>` 叠着（`.petvideo`），换动作时先把新素材
  加载到"背后"那块、等它真的出帧（`readyState >= 2` 或 `loadeddata`）再瞬间切显隐。
  单块 `<video>` 直接改 `src` 会露出黑白一帧，在透明窗口上就是闪一下。
  另外「被鼠标拖拽悬空反馈」只在拖动超过 10px 才切（点一下不该先播拖起来再弹回去），
  一次点击不再跟着模型回复二次换动作。
- **Windows 关硬件加速（照旧版 dsh-pet）**：`if (process.platform === 'win32') app.disableHardwareAcceleration();`
  Windows 的透明分层窗口（`WS_EX_LAYERED`）在 DWM 硬件加速合成下有缺陷 —— 改变窗口尺寸/位置
  时四周露黑边、大透明窗盖小透明窗时被盖住的内容丢帧、以及每改一次 `setBounds` 就重建合成层
  （看着就是"点一下就闪"）。改走软件合成规避；本进程只渲染 640×360 的 webm，完全扛得住。
- **窗口尺寸统一走 `setContentBounds` + 自己去重**：`applyWindowBounds()` 比的是"我们上一次
  请求的值"（`requestedBounds`），**不能回读 `win.getContentBounds()`** —— 回读值经过
  `ScaleToEnclosingRect` 向外取整，和设定值永远不相等，去重失效就变成每帧强制重设窗口。
  移动走 `movePetTo()`，改位置的同时同步 `curBounds`，否则下次 `pet:grow` 会拿旧坐标算底边、窗口自己跳回去。
  **别顺手把 `preload.js` 里的 `grow` 桥删掉**：`renderer.js` 写的是 `window.petDesk.grow?.(next)`，
  `?.` 遇到不存在的方法会静默跳过、不报错 —— 结果就是窗口不再长高，气泡和面板全渲染在窗口外被裁掉，
  现象正好是"不闪了，但点了什么都没有"。
- 右键菜单：聊两句 / 看看心情 / 看看余额 / 换个动作 / 安静点 / 关掉桌面助手
- **抛掷物理**：拖起来会飘，惯性 `GRAVITY=1400 / RESTITUTION=0.78 / 墙反弹 0.55`，
  落地按撞击强度压扁 220ms（`scale(1.14,.82)` 回弹），松手速度低于 140 不算抛
- **动作菜单**：按动画分类自动生成 28 个按钮（日常 / 吃喝 / 互动 / 特别），点一下就播
- **工作状态联动**：你在干活它切「工作状态-忙碌点按」，闲下来切「原地踱步张望」并吭一声
- **表情气泡**：气泡里能贴共享大脑的表情 GIF（按维度选，带禁忌表）
- 面板（聊天、余额、七维心情、动作列表）长在窗口上方那块 HUD 预留区里，**窗口不跟着变**，
  所以开合面板不会有任何尺寸变化、宠物也不会跳走；面板封顶 588px（预留区 600 减 12 间距），
  动作列表在自己内部滚动
- 双击摸头，拖动整窗跟手；体型固定 462×260，**不支持滚轮缩放**
- **主动搭话**：不再自己拍定时器 —— 问宿主 `/pet-brain/proactive` 要不要说，
  由共享大脑的决策层判定（安静期/每日上限/均匀铺开/关心/分享），间隔用它给的 `intervalMs`；
  拖拽中 / 面板开着 / 正在说话 / 开了「安静点」时不打扰
- 心情面板开着时每 4 秒跟着 `/pet-brain/state` 刷新，七维是活的
- 客户端里**不再画身体**：身体只有桌面助手这一只，不会出现"两只叠一起分不清在点哪个"

### 显示框的视觉口径

统一按旧版 dsh-pet 的观感：白底 `.92~.98` + `1px rgba(0,0,0,.12)` 细边 + 柔和大阴影，
正文 `#2b2b2b`、次要文字 `#9aa0a6`、主色 `#2b63ff`（hover 用 `rgba(43,99,255,.14)`）。

- 气泡：字号 20px、行高 1.6、圆角 16px、`max-width: min(340px, 100%)`、底部 8px 小三角、
  `backdrop-filter: blur(6px)`；字体走系统幼圆栈（旧版的「上首软糖体」有再分发授权问题，没打包）
- 菜单：`min-width:176px`、内边距 4px、圆角 10px、`max-height: min(62vh,460px)` 可滚
- 面板：宽 380px、圆角 10px、`max-height: 640px`（**不能用 vh** —— 窗口会跟着面板长高，vh 会自我压缩成死循环）
- 徽章：白底胶囊，挂在宠物下沿 `-22px`，所以窗口高度要多留 26px 才不会被裁

控制：

```bash
GET  /pet-brain/desktop                              # 进程状态
POST /pet-brain/desktop {"action":"start"}           # 起 / 清掉「用户关过」标记
POST /pet-brain/desktop {"action":"stop"}            # 停这一次（重启后仍会自己回来）
POST /pet-brain/desktop {"action":"close"}           # 用户主动关（落 closedByUser，别再自动起）
POST /pet-brain/desktop {"action":"restart"}         # 重启（内部等 900ms 避开单实例锁）
POST /pet-brain/desktop {"action":"restart","panel":"chat"}   # 起来后自动开某面板（排障用）
POST /pet-brain/desktop {"action":"restart","panel":"menu"}   # 派发一次右键，验证菜单样式
```

## 界面

配色跟旧挂件 `dsh-whale-widget` 一个路子：**白底卡片 + 深蓝字（#2b3a63 / #3d4f7d）+ 大号粗体数字**。
深色玻璃在深色界面里糊成一片，数字和字都跳不出来，所以气泡、菜单、心情面板、余额面板、聊天面板全部换成了浅色卡片。

桌宠本体用 `react-dom` 的 `createPortal` 挂到 `document.body`，不在 `shell.overlay` 的容器里：
那个容器带 `visibility:hidden` / `overflow` / `transform`，切一次视图整棵子树就被继承隐藏；
祖先一旦有 `transform`，`position:fixed` 还会变成相对祖先定位。挂到 body 下这两件事一起躲掉。
拿不到 `react-dom` 时自动退回原地渲染，不会整只桌宠不出来。

## 余额与用量

`GET /pet-brain/usage` 走 DSH 凭据服务里的 `DEEPSEEK_API_KEY`，调 `https://api.deepseek.com/user/balance`，
结果缓存 60 秒。

- **今日已用** = 余额差分累计（每次刷新若余额比上次低，差额进当天账本）。
  这不是精确账单：充值、赠金过期都会干扰，只能回答"今天大概花掉多少"。
- **优惠时段** 按官方规则判断北京时间 `00:30–08:30`。**不展示单价**——单价会调，写死了就是错的。
- 账本落盘 `%DSH_HOME%/dsh-pet-brain/usage.json`，保留 90 天；损坏时自动备份成 `.corrupt-<ts>.bak` 再重建，不会卡死。

## 换素材

`assets/webm/*.webm`（VP9-alpha，640×360）。想换自己的，同名覆盖即可；
新增名字要在 `lib/index.js` 的 `ANIMATIONS` 里登记。

## 自测

```bash
node scripts/selftest.mjs       # 不启动 DSH，验证读人设/心情/召回链路
node scripts/check-host.mjs     # 起真 HTTP server，验证端点与素材路由
node scripts/check-client.mjs   # 模拟 __ModuleLoader__，验证客户端半侧导出与 slot 注册
node scripts/render-test.mjs    # 离线渲染六个界面状态，检查 style 里的 undefined、按钮有没有 onClick
node scripts/assets-audit.mjs   # 动作名 ↔ 素材文件一致性（名字写错只会静默 404）
node scripts/copy-assets.mjs    # 从 dsh-pet 重新拷一份素材
node scripts/chat-memory-test.mjs  # 用 node fetch 发中文，验证桌宠对话写回共享大脑记忆
```

> 测中文**必须用 node fetch**。Windows 下 `curl -d '{"text":"中文"}'` 按 GBK 发字节，
> 服务端按 UTF-8 解析会得到乱码，然后把乱码当记忆写进共享大脑（我踩过，已清理）。
> 聊天历史和写回的记忆都是 UTF-8，curl 那条路在 Windows 上会一直踩坑。

## 排障

- **桌上没出现**：确认宿主重启过；`curl http://127.0.0.1:<port>/pet-brain/config` 有返回说明宿主侧已加载。
- **改了 client.js 界面没变**：客户端 bundle 是按 boot graph 在**启动时**拉一次，且带 `immutable` 缓存头。
  宿主重挂插件、等 HMR 都可能不生效——**必须完全退出客户端进程再启动**（关窗口不算）。
  想确认跑的是哪一版：`curl .../pet-brain/state` 看 `client.pings` 里的 `mount.v2` 这类版本探针。
- **一直是待机**：共享大脑 `emotion.json` 里可能没有状态（没聊过天），档位会落 `unknown`。
- **聊天回 502**：宿主 `llm` 服务不可用，或者没有可用模型；看宿主日志。
- **记忆召回为空**：`memory.json` 里条目太少或全是底线/过期条目。
- **能不能飘到客户端窗口外面**：客户端内那份做不到 —— 它渲染在 DSH 页面的 `shell.overlay` 里，
  宿主跑在 `ELECTRON_RUN_AS_NODE` 子进程里（`/pet-brain/env` 能看到 electron 版本，但 `process.type` 是 null、
  `require('electron')` 报 MODULE_NOT_FOUND），插件侧拿不到 `BrowserWindow`。
  **真正的窗口外版本走「桌面助手」**：spawn 一个独立 Electron 进程开透明置顶窗口，见上面那节。
- **桌面助手窗口 visible 但看起来空白**：`paintWhenInitiallyHidden` 必须是 `true`，
  设成 `false` 时渲染器认为窗口一直隐藏，首帧永远不合成。
- **透明窗口截图是空的**：别用 GDI / `CopyFromScreen`，`UpdateLayeredWindow` 的窗口在 BitBlt 里直接缺失，
  截出来是它**后面的内容**。用 `win.webContents.capturePage()`，helper 会自动存到
  `<tmp>/dsh-pet-brain-desk-shot.png`。
- **改完面板想直接看效果**：`POST /pet-brain/desktop {"action":"restart","panel":"chat"}`，
  helper 起来 3.5 秒后调 `window.__petDeskTest.open()` 打开面板并截图。
- **`EDGE_OUT` 是什么**：`lib/client.js` 顶部的常量（默认 `0.35`）。拖动和贴边吸附时允许坐标越过视口边界，
  超出部分会被 Electron 窗口裁掉——**这不是真的画到窗口外**，只是贴边时留个"探出去"的观感，拖回来就复原。
  想让它完全贴住窗口边缘，把这个值改成 `0`。
- **桌宠画了但看不见（画面是空的）**：`lib/client.js` 里 `require('react/jsx-runtime')` 拿到的
  `jsx` 第三个参数是 **key** 不是 children —— 用它当 `h()` 用会把所有子元素静默丢掉，
  渲染出一个透明空 div。必须用 `react.createElement`。
- **改了 `lib/client.js` 没生效**：客户端 bundle 是按 boot graph 在**启动时**拉一次，且带 `immutable` 缓存头。
  宿主重挂插件、等 HMR 都可能不生效——**必须完全退出客户端进程再启动**（关窗口不算）。
  桌面助手是独立进程，不受这个限制，`POST /pet-brain/desktop {"action":"restart"}` 就行。
- **想确认跑的是哪一版**：`curl .../pet-brain/state` 看 `client.pings`（最近 14 条），
  里面有 `bundle / apply / mount / config.ok / anim.ok / video.ok` 这些阶段探针。
- **共享大脑删不掉的记忆**：`removeItem` 只在 `modules.json` 的模块桶里找 id，
  同步进来的扁平库条目（`source:"sync"`）它删不到。要删这种条目得写墓碑：
  `~/.dsh/storages/dsh-shared-brain/sync.json` 的 `tombstones[id] = {at, kind:'entry'}`，
  再把 `memory.json` 里的那条删掉（store 有 mtime+size 缓存，改完自动重读，不用停插件）。
