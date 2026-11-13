/**
 * 桌面助手渲染端。
 *
 * 与浏览器半侧（lib/client.js）的区别：
 *   - 这里没有 React、没有 DSH 的 slot 体系，就是一块透明画布；
 *   - 数据全靠 fetch 宿主 HTTP 端点（/pet-brain/*），跟客户端内那份是同一套接口；
 *   - 窗口本身是 OS 级窗口，所以「拖动」= 移动窗口，「点击穿透」= 让透明像素不挡别的应用。
 *
 * 状态机只有一个：光标压在宠物身上就变成可交互，离开就恢复整窗穿透。
 * 不这么做的话，透明窗口会挡住整个矩形区域，连底下的桌面图标都点不到。
 */
(() => {
  const hostParam = new URLSearchParams(location.search).get('host');
  let HOST = hostParam || 'http://127.0.0.1:3080';
  /**
   * 宿主令牌：boot 时从 preload 的 env() 拿，之后的每个请求都带上。
   * 只放内存里 —— 写 localStorage 等于把令牌摊在用户目录里，没必要。
   */
  let PET_TOKEN = '';

  const $ = (id) => document.getElementById(id);
  const pet = $('pet');
  /**
   * 双缓冲视频：换动作时先把新素材加载到"背后"那块，等它真的出帧了
   * 再瞬间切换显隐。单块 <video> 改 src 会黑/白一帧，在透明窗口上就是闪。
   */
  const vids = [$('videoA'), $('videoB')];
  let front = 0;
  /** 待机动作名：既是兜底动作，也是"宠物站姿"采样热区的时机 */
  const IDLE_ANIM = '待机呼吸休闲';
  const badge = $('badge');
  const bubble = $('bubble');
  const menu = $('menu');

  let cfg = null;
  let state = null;
  /** 宠物身体命中区（相对窗口）：视频盒子四周有透明边，内缩一点更像"摸到它" */
  const HIT_INSET = { x: 0.14, y: 0.16 };
  let dragging = null;
  let bubbleTimer = 0;
  /**
   * 「安静点」= 关掉桌宠的自动互动（共享大脑那边照样说话，桌宠不接）。
   *
   * 默认是**开**的：老大要的就是桌宠默认启用共享大脑的自动互动。
   * 老版本把这个开关写在 'pet-desk:quiet'，调试时点过一次就永久压制 ——
   * 现在换新 key，并把旧 key 当历史噪音清掉，别让一次误点把互动摁死。
   */
  const QUIET_KEY = 'pet-desk:quiet.v2';
  let quiet = false;
  try {
    if (localStorage.getItem('pet-desk:quiet') !== null) localStorage.removeItem('pet-desk:quiet');
    quiet = localStorage.getItem(QUIET_KEY) === '1';
  } catch {
    quiet = false;
  }
  /** 桌宠上次开口的时间戳：本地节流用，别连着说 */
  let lastSaidAt = 0;
  /** 是否已有一路在向宿主讨话：防止两次生成前后脚冒泡 */
  let speakInFlight = false;
  /**
   * 上一次向宿主要话的结果备注（'silent' / 'quiet-period' / 'busy' / 'error:…'）。
   * 以前只写不读，而且是隐式全局（挂在 window 上），排障时在 /pet-brain/state 里看不见。
   */
  let lastSpeakNote = '';
  /**
   * 最近一次 /pet-brain/speak 的完整返回。
   *
   * 宿主说"这轮不说"时，返回里带着它自己算的 retryMs / intervalMs ——
   * 以前 askHostSpeak 只说"没话"就返回 null，这两个数字就丢了，
   * 于是每轮都退回 90~240 秒的瞎猜间隔。
   */
  let lastSpeakRes = null;
  /**
   * 已经接过的「共享大脑那一轮」的时间戳。
   *
   * 宿主那边也记水位线（host.seenAt），但渲染端也得自己记一份：
   * 宿主的水位线只在 t.follow 为真时推进，两边都记着才不会被带着话痨。
   */
  let hostFollowSeenAt = 0;
  /** 下次允许再问宿主的时刻：宿主没给出话时别每 2 秒问一次 */
  let hostFollowRetryAt = 0;
  /** 跟共享大脑接话的最小间隔，跟宿主 lib/index.js 的 PET_FOLLOW_GAP_MS 对齐 */
  const HOST_FOLLOW_GAP_MS = 45_000;
  /** 宿主这轮没给出话时，过多久再问一次（别每 2 秒追着问） */
  const FOLLOW_RETRY_MS = 60_000;
  /** 已经排过一轮主动搭话没：头一轮等短一点，后头按共享大脑给的间隔来 */
  let chatterStarted = false;
  /** 主动搭话的计时器句柄：始终只保留一条链 */
  let chatterTimer = 0;
  /**
   * 体型固定：跟旧版 dsh-pet 一样是 462px 宽（高 = 462 × 9/16）。
   * 不再提供滚轮缩放 —— 老大要求按旧版固定。
   */
  const PET_SIZE = 462;

  function applyScale() {
    pet.style.width = PET_SIZE + 'px';
    pet.style.height = Math.round((PET_SIZE * 9) / 16) + 'px';
  }
  let polledOnce = false;
  /** 面板种类：'' 关着 / 'chat' / 'usage' / 'mood'（提前声明，mousemove 回调里要用） */
  let panelKind = '';
  /** 正在跟共享大脑接话：别同时来两次，说成一堆 */
  let hostFollowBusy = false;

  // ---- 灵动相关状态 -----------------------------------------------------
  // 光标方位：-1 往左看 / 0 正对 / 1 往右看。主进程 60ms 采一次，变化时才推过来。
  let gazeSide = 0;
  /** 光标是不是正悬在宠物身上 */
  let cursorOver = false;
  /** 这次悬停从什么时候开始（0 = 没悬停） */
  let hoverSince = 0;
  /** 悬停期间已经抬头看过没有：看过就别每轮都再看一遍 */
  let hoverLooked = false;
  /** 悬停期间已经被"看毛"过没有 */
  let hoverStartled = false;
  /** 上一次"被盯毛了"的时刻：带冷却，别一直吓 */
  let lastStartleAt = 0;
  /** 连戳计数 / 计数起点：戳三下会不耐烦 */
  let tapCount = 0;
  let tapWindowAt = 0;
  /** 上一次点它去要模型的时刻：三秒内连点不重复生成 */
  let lastTapAskAt = 0;
  /** 这轮连续干活的起始时刻；0 = 没在干活 */
  let workSince = 0;
  /** 最近一次"在干活"和"刚干完"的时刻，用来挑有动机的动作 */
  let lastWorkBusyAt = 0;
  let lastWorkDoneAt = 0;
  /** 上次伸懒腰提醒 / 深夜陪着的时刻 */
  let lastStretchAt = 0;
  let lastNightYawnAt = 0;
  /** 午后小憩一天只来一次，记日子 */
  let napDay = '';
  /** 上一次问宿主是否带出了思考动作（决定回话时要不要再换动作） */
  let lastAskThought = false;
/*
 * 点击反应的批次号。
 * 连戳的时候每一戳都会各自去要一句模型回复，先发的后到，
 * 会把"别戳了"这种即时反应盖成一句不相干的话。
 * 每次点击 +1，回来的那一路只要发现号对不上就自己作废。
 */
let reactSeq = 0;
/**
 * 等多久还没回话就演「…」。
 * 正常四秒；自检钩子会临时调小，好让这条路径能被验证到。
 */
let THINK_DELAY_MS = 4_000;
  /** 进程起来的时刻：算"闲了多久"要有起点 */
  const bootedAt = Date.now();

  // ---- 与宿主通信 -------------------------------------------------------
  /**
   * 跟宿主说话。
   *
   * 必须带超时：/pet-brain/speak 要等宿主把模型跑完才回话，
   * 碰上宿主卡住不回，这次 fetch 就永远挂着 ——
   * 而 speakInFlight 是靠 finally 复位的，挂住 = 桌宠这一局再也不开口。
   */
  async function api(path, init = {}) {
    const ctrl = new AbortController();
    // 2026-11-12（桌宠审计 中危 C）：客户端超时以前是 45 秒，
    // 但宿主那条会话要跑满 90 秒（lib/index.js SESSION_REPLY_TIMEOUT_MS）。
    // 结果就是：跑到 50~80 秒时桌宠先 Abort、界面显示「没接上话」，
    // 宿主那边照样跑完 90 秒，还把这一轮写进了共享大脑 ——
    // 老大看着像失败，额度已经花了，记忆库里还多了一条。
    // 现在客户端比宿主多留 20 秒余量。
    const ms = init.timeoutMs ?? 110_000;
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      // file:// 页面对宿主来说是跨源，必须带上令牌，否则一律 403。
      // 令牌只在内存里，不落 localStorage、不进 ping（诊断日志会被看）。
      const headers = { ...(init.headers || {}) };
      if (PET_TOKEN) headers['x-pet-token'] = PET_TOKEN;
      const res = await fetch(HOST + path, { ...init, headers, signal: ctrl.signal });
      if (!res.ok) throw new Error(path + ' → ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 把启动进度回传给宿主，宿主的 /pet-brain/state 里能直接看到（排障用） */
  function ping(stage, detail = '') {
    const headers = { 'content-type': 'application/json' };
    if (PET_TOKEN) headers['x-pet-token'] = PET_TOKEN;
    fetch(HOST + '/pet-brain/ping', {
      method: 'POST',
      headers,
      body: JSON.stringify({ stage: 'desk.' + stage, detail: String(detail).slice(0, 300) }),
    }).catch(() => {});
  }

  /** 桌宠动作池由宿主按心情算好（lib/index.js 的 actionPool），这里不做判断 */
  function actionOf(s) {
    const pool = s?.actions?.length ? s.actions : s?.action ? [s.action] : [];
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : '待机呼吸休闲';
  }

  /**
   * 挑一个"有动机"的待机动作。
   *
   * 以前是从宿主给的池子里纯随机抽，抽到什么算什么 —— 正在写代码的时候
   * 突然撸猫，看着就是个会动的贴纸。现在只看三件事：
   * 在不在干活、刚说完话没、真闲了多久。
   */
  function pickMotivatedAnim() {
    const now = Date.now();
    // 抽中同一个等于没换，画面会僵在那儿 —— 先把自己现在演的那个剔掉
    const pickDiff = (pool) => {
      const rest = pool.filter((n) => n !== currentAnim);
      return pick(rest.length ? rest : pool);
    };
    // 干活时多数还是干活的姿势，但隔一阵也得抬头看两眼、挪挪脚。
    // 只在"写代码/敲桌面"两帧之间来回，一眼就是张会动的贴纸。
    if (lastWorkStatus === 'running') {
      if (Math.random() < 0.22) return pickDiff(['东张西望', '原地漂浮踏步', '摇扇纳凉', '照镜子']);
      return pickDiff(['写代码', '原地敲击桌面互动']);
    }
    // 气泡还挂着说明话没说完：吐泡泡这种"还在讲"的动作最贴身
    if (!bubble.hidden || now - lastSaidAt < 20_000) return pickDiff(['鲸鱼吐泡泡特效', '轻快摇摆舞']);
    // 刚干完活：庆祝一下
    if (lastWorkDoneAt && now - lastWorkDoneAt < 40_000) return pickDiff(['工作状态-雀跃庆祝', '轻快摇摆舞']);
    const idleFor = now - Math.max(lastWorkDoneAt, lastWorkBusyAt, bootedAt);
    // 2026-11-12：桌面这只以前从来不跟心情走 —— 空闲时就那固定的六七组动作轮着来，
    // 宿主 lib/mood-anim.js 算好的动作池只在点一下、回一句话的时候才用得上。
    // 浏览器半侧早就在用 data.actions 了，桌面半侧漏了，等于同一只宠物两个脾气。
    // 现在待机时按 55% 的概率从心情池里抽，其余扔给活动状态（干活闲了/刚闲下来）那几组。
    const moodPool = Array.isArray(state?.actions) ? state.actions.filter(Boolean) : [];
    const withMood = (fallback, chance = 0.55) => {
      if (moodPool.length === 0) return pickDiff(fallback);
      if (Math.random() < chance) return pickDiff(moodPool);
      return pickDiff(fallback);
    };
    // 闲过三分钟才轮到"闲到发慌"那一组
    if (idleFor > 3 * 60_000) return withMood(['超大伸懒腰', '哈欠连天', '撸猫', '照镜子']);
    return withMood(['东张西望', '悠闲哼歌', '原地漂浮踏步', '三球抛接', '摇扇纳凉', '踢毽子']);
  }

  const blobCache = new Map();
  /**
   * 素材一共 52 个、约 24MB。blob URL 一旦建了就一直攥在渲染进程手里，
   * 不回收就是纯内存泄漏（旧动作被淘汰了也还占着）。
   * 留个上限，超了就按插入顺序回收最老的。
   */
  const BLOB_CACHE_MAX = 24;
  function cacheBlob(name, url) {
    blobCache.set(name, url);
    while (blobCache.size > BLOB_CACHE_MAX) {
      const oldest = blobCache.keys().next().value;
      if (oldest === undefined) break;
      try { URL.revokeObjectURL(blobCache.get(oldest)); } catch { /* 已经回收过 */ }
      blobCache.delete(oldest);
    }
  }
  let currentAnim = '';
  /** 当前动作的基准倍速：光标压在它身上时在这个基础上再快一点（"呼吸加快"） */
  let currentRate = 1;
  /** 悬停时呼吸加快的比例 */
  const HOVER_RATE = 1.15;
  /** 被盯着看一秒半之后会换的眼神动作：轮着来，别每次都是同一个 */
  const HOVER_LOOK_ANIMS = ['东张西望', '照镜子', '悠闲哼歌'];
  /** 换动画的令牌：连点时只让最后一次生效，避免旧请求回来把画面倒回去 */
  let animToken = 0;
  /** 最近一次"一次性动作"（蹦一下、吓一跳）的开始时刻：别的插播要给它让路 */
  let lastReactionAt = 0;

  /** 等某块视频真的能出帧（最多等 ms 毫秒，超时就先切过去，总比一直空着强） */
  function waitPlayable(v, ms = 1200) {
    if (v.readyState >= 2) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        v.removeEventListener('loadeddata', onOk);
        v.removeEventListener('error', onErr);
        clearTimeout(timer);
        resolve(ok);
      };
      const onOk = () => finish(true);
      const onErr = () => finish(false);
      const timer = setTimeout(() => finish(false), ms);
      v.addEventListener('loadeddata', onOk, { once: true });
      v.addEventListener('error', onErr, { once: true });
    });
  }

  /**
   * 播一个动作。返回正在播的那块 <video>（拿它的 duration 用来算走位曲线），
   * 没播成返回 null。
   * rate 是播放倍速：素材统一 10 秒，走位时压到 1.5 倍，走起来不拖沓。
   */
  async function playAnim(name, loop = true, rate = 1, onEnded = null) {
    if (!name) return null;
    if (name === currentAnim) {
      /*
       * 同名 = 重播，不是"无事发生"。
       * 原来这里直接 return null，于是"点它"（动作池刚好抽中当前动作）、
       * "去吃饭"、"溜达"这些路径会静默失败 —— 看着就是点了没反应。
       * 同名就重播当前这块视频：动作一样，至少有反应。
       */
      const v = vids[front];
      if (!v) return null;
      v.loop = loop;
      currentRate = rate;
      applyRate();
      if (typeof onEnded === 'function') v.onended = onEnded;
      try { v.currentTime = 0; } catch { /* 没解码完就让它自己播 */ }
      void v.play().catch(() => {});
      if (!loop) lastReactionAt = Date.now();
      return v;
    }
    // 播别的动作就等于醒了：睡眠状态要跟着收掉（不然徽章一直挂着睡觉中）
    if (sleeping && !SLEEP_CLIPS.has(name)) cancelSleep();
    // 同理，追饭的戏被别的动作抢走就散场，不然状态卡住、宠物再也不溜达
    if (baifanPhase >= 0 && !BAIFAN.includes(name)) cancelBaifan();
    const token = ++animToken;
    currentAnim = name;
    try {
      let url = blobCache.get(name);
      if (!url) {
        const res = await fetch(`${HOST}/pet-brain/anim/${encodeURIComponent(name)}.webm`);
        if (!res.ok) throw new Error(`${name} → ${res.status}`);
        url = URL.createObjectURL(await res.blob());
        cacheBlob(name, url);
      }
      if (token !== animToken) return; // 已经切到别的动作了，这次作废
      const back = vids[1 - front];
      back.loop = loop;
      currentRate = rate;
      applyRate();
      // 播完回调：睡觉三段接力靠它接下一段。另一块 buffer 上的旧回调要先清掉，
      // 否则上一段播完会把已经换掉的动作又触发一遍。
      for (const v of vids) if (v !== back) v.onended = null;
      /*
       * 一次性动作播完必须有下文。
       * 以前没传回调就停在最后一帧 —— 说句话、点一下之后，屏幕上就是个定格的姿势，
       * 短的能卡半分钟，看着像卡死了。默认接回待机。
       * 走位动作例外：位移由主进程按素材时长推，走完它会自己发 walkEnd。
       */
      const autoIdle = !loop && typeof onEnded !== 'function' && !WALK_ANIMS.includes(name);
      if (!loop) lastReactionAt = Date.now();
      back.onended = typeof onEnded === 'function' ? onEnded : autoIdle ? () => playAnim(IDLE_ANIM, true) : null;
      back.src = url;
      back.load();
      await waitPlayable(back);
      await back.play().catch(() => {});
      if (token !== animToken) return;
      // 两块在同一帧里切显隐，浏览器不会渲染出中间态
      back.classList.add('show');
      const old = vids[front];
      old.classList.remove('show');
      old.pause(); // 旧的那块别再解码了 —— 两块一起解，白烧 CPU
      front = 1 - front;
      ping('anim.ok', name);
      lastAnimName = name;
      // 第一个有画面的动作到位后就量一次轮廓（待机最好，但别的动作也是同一只宠物）
      if (!boxProbed) setTimeout(probeContentBox, 350);
      return back;
    } catch (e) {
      // 素材缺失就退回待机，不要把窗口搞成空白
      ping('anim.fail', String(e?.message || e));
      if (name !== '待机呼吸休闲') playAnim('待机呼吸休闲', true);
      return null;
    }
  }

  for (const v of vids) {
    v.addEventListener('loadeddata', () => {
      if (v.classList.contains('show')) ping('video.ok', `${v.videoWidth}x${v.videoHeight} rs=${v.readyState}`);
    });
    v.addEventListener('error', () => {
      ping('video.err', `code=${v.error?.code} ${v.error?.message || ''}`);
    });
  }

  // ---- 宠物本体采样 -----------------------------------------------------
  // 视频是 640×360，宠物四周留着一大圈透明；用固定比例猜热区永远偏大。
  // 待机动作播到有画面后读一帧 alpha，算出真实轮廓报给主进程，热区就贴在身上了。
  let boxProbed = false;
  function probeContentBox() {
    if (boxProbed) return;
    const v = vids[front];
    if (!v || !v.videoWidth || !v.videoHeight) return;
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(v, 0, 0);
      const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
      let x0 = width;
      let y0 = height;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        for (let x = 0; x < width; x++) {
          if (data[row + x * 4 + 3] > 10) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return;
      boxProbed = true;
      const box = {
        left: +(x0 / width).toFixed(4),
        top: +(y0 / height).toFixed(4),
        right: +((x1 + 1) / width).toFixed(4),
        bottom: +((y1 + 1) / height).toFixed(4),
      };
      window.petDesk.contentBox?.(box);
      ping('box', JSON.stringify(box));
    } catch (e) {
      ping('box.fail', String(e?.message || e));
    }
  }

  // ---- 说话 -------------------------------------------------------------
  const BAND_LINES = {
    delighted: ['今天状态好得很，要不要一起干点大事', '心情好到想原地转圈', '这会儿干活的效率我能打满分'],
    happy: ['挺舒服的，你呢', '这会儿正好，干点什么吧', '要是卡住了就喊我一声'],
    ok: ['还行，稳着呢', '没什么起伏，正适合闷头做事', '不吵你，我就在旁边待着'],
    heartache: ['有点提不起劲', '嗯……稍微有点闷', '让我缓缓，一会儿就好'],
    down: ['状态不太行，让我趴一会儿', '有点累，别介意我话少', '先喝口水吧，我也歇会儿'],
    sad: ['不太想说话', '让我安静待着就好', '我在这儿，不用管我'],
    unknown: ['在的', '有事喊我', '我蹲这儿呢'],
  };

  /** 按时段挑的问候语 */
  const HOUR_LINES = {
    morning: ['早啊，今天想先干哪件', '早上好，昨晚睡够了吗'],
    noon: ['这个点了，吃了吗', '中午了，先扒口饭'],
    night: ['还不睡？我陪你一会儿', '夜深了，别熬太狠'],
  };

  /** 老大那边一轮活干完时说的话：换着说，别天天复读 */
  const WORK_DONE_LINES = [
    '这轮干完啦，歇会儿？',
    '收工，抖抖手',
    '搞定，歇三秒再战',
    '这段跑完了，喝口水去',
    '这块儿结了，下一件上',
  ];

  function hourBucket() {
    const h = new Date().getHours();
    if (h >= 5 && h < 11) return 'morning';
    if (h >= 11 && h < 14) return 'noon';
    if (h >= 22 || h < 5) return 'night';
    return '';
  }

  /** 从数组里随便挑一个 */
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  /**
   * 语气 → 动作。宿主 /pet-brain/speak 的响应里本来就有 tone：
   * soft（轻声细语）配温和那组，light（轻快）配雀跃那组。
   * 以前这个字段一路扔掉了，说话归说话、动作归动作，看着像两回事。
   */
  const TONE_ANIM = {
    soft: ['撸猫', '照镜子', '摇扇纳凉', '悠闲哼歌', '东张西望'],
    light: ['点击回应-开心跃动', '工作状态-雀跃庆祝', '鲸鱼吐泡泡特效', '轻快摇摆舞'],
  };

  function animForTone(tone) {
    const pool = TONE_ANIM[tone];
    return pool && pool.length ? pick(pool) : '';
  }

  /** 摸头的时候说的话：被吓一跳那一档，语气别太凶 */
  const TAP_HEAD_LINES = [
    '哎？摸我头…',
    '头发要乱了啦',
    '嗯…就一下哦',
    '嘿，痒',
  ];

  /** 说话时把共享大脑配的默认表情带上（已经有了就不重复贴） */
  function withEmoji(text) {
    const emoji = state?.voice?.emoji;
    if (!emoji || !text || text.includes(emoji)) return text;
    return text + ' ' + emoji;
  }

  /**
   * 冒一个气泡。
   * emojiKey 是共享大脑的语义表情键（neutral / nodding / happy …），
   * 走它自己的 /api/dsh-shared-brain/emoji/<key>.gif 路由贴图。
   *
   * opts.record：这句话是不是"本地自己冒的"（比如点一下先顶一句短话）。
   * 宿主那边已经记过账的（/speak、/chat 的回复）不要再记一遍，
   * 否则账本里同一条会出现两次。
   */
  /**
   * 2026-11-13：桌宠开口时同步念一遍。
   *
   * 宿主那边的 /pet-brain/tts 是跨源接口，必须带 x-pet-token；
   * <audio src> 塞不了自定义头，所以先用 fetch 取回二进制，再转 Blob URL 播。
   * 播音失败一律静默 —— 老大宁可没声音，也不要桌宠卡一下。
   */
  let voiceOn = (() => {
    try {
      return localStorage.getItem('pet-brain:voice') !== '0';
    } catch {
      return true;
    }
  })();
  let voiceAudio = null;
  let voiceToken = 0;
  // 最近一次播音的结果。排障时 __petDeskTest.speak 会把它一起带出来 ——
  // 浏览器里没声音是「没合成」还是「被自动播放策略拦了」，只看这个就分得清。
  let voiceLast = { at: 0, state: 'idle', bytes: 0, error: '' };

  /**
   * 2026-11-13：念之前先把表情摘掉 —— 老大要的是"表情不用说，只说文字"。
   * 气泡里带的表情来源有两处：共享大脑配的默认表情（withEmoji 追加），
   * 以及回复正文里自带的 emoji。交给 TTS 的话，轻则念出"鱼"这种词，重则念成一串乱码。
   * 顺手清掉 [偷笑]（笑）这类文字版表情备注，剩下的没有可读字就整条不念。
   */
  const EMOJI_WORD =
    /[（(\[【]\s*(?:偷笑|笑死|大笑|笑哭|笑|哭|流泪|叹气|无语|沉默|汗|尴尬|赞|点赞|比心|耶|抱抱|加油|鼓掌|思考|疑惑|惊讶|吃瓜|狗头|喵|嗷|哼|得意|委屈|可爱|开心|难过|生气)[^\u4e00-\u9fa5]{0,2}\s*[)）\]】]/g;

  function speakableText(text) {
    const stripped = String(text || '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // markdown 图片
      .replace(/https?:\/\/\S+/g, ' ') // 网址
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu, ' ')
      .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, ' ') // 肤色修饰
      .replace(EMOJI_WORD, ' ')
      .replace(/[\s\u3000]+/g, ' ')
      .trim();
    // 只剩标点符号的话，也不值得开口
    if (!/[\p{L}\p{N}]/u.test(stripped)) return '';
    return stripped.slice(0, 300);
  }

  async function speakAloud(text) {
    if (!voiceOn) {
      voiceLast = { at: Date.now(), state: 'off', bytes: 0, error: '' };
      return;
    }
    const plain = speakableText(text);
    if (!plain) {
      // 整条都是表情：不合成、不出声，气泡照旧显示
      voiceLast = { at: Date.now(), state: 'empty', bytes: 0, error: '' };
      return;
    }
    const mine = ++voiceToken;
    try {
      const headers = {};
      if (PET_TOKEN) headers['x-pet-token'] = PET_TOKEN;
      const res = await fetch(HOST + '/pet-brain/tts?text=' + encodeURIComponent(plain), {
        headers,
        signal: AbortSignal.timeout?.(25_000),
      });
      if (!res.ok) {
        voiceLast = { at: Date.now(), state: 'http-' + res.status, bytes: 0, error: '' };
        return;
      }
      if (mine !== voiceToken) return;
      const blob = await res.blob();
      if (mine !== voiceToken) return;
      voiceLast = { at: Date.now(), state: 'loaded', bytes: blob.size, error: '' };
      const url = URL.createObjectURL(blob);
      if (voiceAudio) {
        try {
          voiceAudio.pause();
          URL.revokeObjectURL(voiceAudio.src);
        } catch {
          /* 旧的那条已经废了，随它去 */
        }
      }
      const audio = new Audio(url);
      voiceAudio = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      // 浏览器可能拦自动播放；拦了就当没有声音，不弹任何东西
      const played = audio.play();
      if (played && typeof played.then === 'function') {
        played.then(
          () => {
            voiceLast.state = 'playing';
          },
          (err) => {
            voiceLast = { at: Date.now(), state: 'blocked', bytes: voiceLast.bytes, error: String(err?.message || err) };
          },
        );
      }
    } catch (err) {
      // 合成失败、断网、令牌过期 —— 都不影响气泡
      voiceLast = { at: Date.now(), state: 'error', bytes: 0, error: String(err?.message || err) };
    }
  }

  /**
   * 「念不念出声」的开关。默认念；右键菜单里能关，关掉的状态记在 localStorage。
   */
  function toggleVoice() {
    voiceOn = !voiceOn;
    try {
      localStorage.setItem('pet-brain:voice', voiceOn ? '1' : '0');
    } catch {
      /* 存不了就算了，这次会话照用 */
    }
    if (!voiceOn && voiceAudio) {
      try {
        voiceAudio.pause();
      } catch {
        /* 已经停了 */
      }
    }
    say(voiceOn ? '行，我念出声' : '好，我就显示字', 6000, '');
  }

  function say(text, ms = 8000, emojiKey = '', opts = {}) {
    if (!text) return;
    /**
     * opts.silent：只借气泡显示一下（比如等模型回话时的「…」）。
     * 不算"开过口"，也不进会话记录 —— 否则聊天面板里会躺着一串省略号。
     */
    const silent = opts.silent === true;
    if (!silent) {
      // 桌宠每次开口都记一下时刻：本地节流靠它，别连着说
      lastSaidAt = Date.now();
      // 桌宠说的每一句都进会话记录：气泡和聊天面板是同一个会话的两个视图，
      // 记在这儿，左键弹的气泡和右键开的聊天面板才连得上。
      pushChatLine('assistant', text, opts.kind || 'local');
    }
    if (opts.record) {
      // 本地短句宿主那边不知道 → 补记进账本，面板里也能看到
      void api('/pet-brain/chatlog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'assistant', kind: opts.kind || 'local', text }),
      })
        .then(() => {
          if (panelKind === 'chat') renderChat();
        })
        .catch(() => {});
    }
    // 2026-11-13：不管是气泡还是面板，开口就念 —— 面板开着的时候老大更看不见字。
    if (!silent) void speakAloud(text);
    // 面板开着就没地方站气泡了：写进面板 / 在徽章上留未读，话不能丢
    if (typeof panelKind === 'string' && panelKind) {
      ping('say.panel', String(text).slice(0, 20));
      if (panelKind === 'chat') renderChat();
      else markUnread();
      return;
    }
    // 右键菜单开着不挡话：主动搭话就该跟左键点它一样直接弹出来。
    // 以前这里连菜单开着也一起抑制掉，结果"互动了屏幕上一个字都没有"——
    // 老大要的就是这一下弹窗。菜单收起来给气泡让位。
    if (!menu.hidden) {
      menu.hidden = true;
      syncGrow();
    }
    // 说话前先站住：一边走一边冒泡，气泡跟着窗口飘，看着乱
    if (walking) stopWalk();
    bubble.textContent = '';
    if (emojiKey) {
      const img = document.createElement('img');
      img.src = `${HOST}/api/dsh-shared-brain/emoji/${encodeURIComponent(emojiKey)}.gif`;
      img.alt = '';
      img.className = 'emoji';
      img.onerror = () => img.remove();
      bubble.appendChild(img);
    }
    const span = document.createElement('span');
    span.textContent = text;
    bubble.appendChild(span);
    bubble.hidden = false;
    syncGrow();
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      bubble.hidden = true;
      syncGrow();
    }, ms);
  }

  /**
   * 问宿主「我现在该不该开口、说什么」。
   * 决策全在宿主侧（共享大脑的 decideProactive），这里只负责把结果显示出来。
   */
  async function askHostSpeak(force = false, extra = {}) {
    /*
     * 同一时刻只放一路去要话。
     * 主动搭话、接共享大脑的茬、点一下的反应，三条路都可能同时踩响，
     * 结果就是两次 LLM 生成、两个气泡前后脚冒出来，一句压一句。
     */
    if (speakInFlight) {
      lastSpeakNote = 'busy';
      return null;
    }
    speakInFlight = true;
    try {
      const res = await api('/pet-brain/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...extra, ...(force ? { force: true } : {}) }),
      });
      if (res?.action !== 'speak' || !res?.text) {
        // 宿主说"这轮不用说"的话，把原因留下来：排障时能看出是安静期、时间窗还是模型挂了。
        // 顺便记下整份返回 —— 里面的 retryMs 是宿主自己算的"什么时候再来问"，
        // 丢了就只能瞎猜一个 90~240 秒（以前就是这样，所以安静期一过还得再等两三分钟）。
        lastSpeakNote = res?.reason || 'silent';
        lastSpeakRes = res || null;
        return null;
      }
      lastSpeakNote = res?.reason || 'speak';
      lastSpeakRes = res;
      return res;
    } catch (e) {
      lastSpeakNote = 'error:' + String(e?.message || e);
      ping('speak.fail', String(e?.message || e));
      return null;
    } finally {
      speakInFlight = false;
      // 把这次的结果报给宿主：排障时一眼看出是安静期、时间窗还是模型挂了
      ping('speak.note', lastSpeakNote);
    }
  }

  /**
   * 带"等待表演"地问宿主一句话。
   *
   * 模型要两三秒才回话，这中间屏幕上得有点动静，不然点下去像石沉大海。
   * 四秒还没回来才把气泡换成「…」+ 思考动作 —— 回得快就一句都不多演，
   * 免得本来一秒就有答案，还先闪一下省略号。十二秒兜底收起。
   */
  async function askWithThinking(force = true, extra = {}) {
    lastAskThought = false;
    const seq = reactSeq;
    const thinkTimer = setTimeout(() => {
      // 期间又戳了一下：这一路已经作废，别再往屏幕上贴「…」
      if (seq !== reactSeq) return;
      lastAskThought = true;
      playAnim(cfg?.animations?.thinking || '工作状态-思考冒泡', true);
      // 气泡挂久一点：模型跑完常常要几十秒，12 秒就把「…」收了，
      // 中间那阵看着像"想不出来卡住了"。
      say('…', 60_000, '', { silent: true, kind: 'thinking' });
      ping('speak.wait', 'over ' + Math.round(THINK_DELAY_MS / 1000) + 's');
    }, THINK_DELAY_MS);
    try {
      return await askHostSpeak(force, extra);
    } finally {
      clearTimeout(thinkTimer);
    }
  }

  function bandId() {
    return state?.mood?.band?.id || 'unknown';
  }

  /**
   * 主动搭话 —— 决策不在这里。
   *
   * 宿主 /pet-brain/speak 里跑的是共享大脑那套 decideProactive：安静期、
   * 每日额度均匀铺开、低落时更关心但有次数上限、话题轮换、随机间隔。
   * 桌宠只负责照做：轮询到了就问一声，宿主说该开口才开口。
   *
   * 间隔用宿主给的 intervalMs（共享大脑的 interval × (1±jitter)）。
   */
  function scheduleChatter(delayMs = 0) {
    // 头一轮别等太久：默认开启的自动互动，老大重启完桌宠一会儿就该看到它冒泡
    const wait = delayMs || (chatterStarted ? 90_000 + Math.random() * 150_000 : 45_000 + Math.random() * 45_000);
    chatterStarted = true;
    // 只留一条计时链：手动「打开自动互动」时会再排一次，不清掉旧的就是两套在跑
    clearTimeout(chatterTimer);
    chatterTimer = setTimeout(async () => {
      const busy =
        dragging ||
        panelKind ||
        !bubble.hidden ||
        menu.hidden === false ||
        hostFollowBusy ||
        sleeping ||
        baifanPhase >= 0;
      if (!quiet && !busy && state) {
        const res = await askHostSpeak(false);
        if (res?.text) {
          say(res.text, 15000, res.emoji || '', { kind: 'proactive' });
          // 宿主给了动作就照做，没给就按语气补一个
          const toneAnim = res.actions?.length
            ? res.actions[Math.floor(Math.random() * res.actions.length)]
            : animForTone(res.tone);
          if (toneAnim) playAnim(toneAnim, false);
          ping('speak.ok', `${res.reason}/${res.tone} ${res.text.slice(0, 24)}`);
        } else {
          ping('speak.skip', res?.reason || lastSpeakNote || 'silent');
        }
        // 宿主没给话时，用它自己算的 retryMs（安静期 90 秒左右）而不是瞎猜 90~240 秒；
        // 给了话就按 intervalMs（共享大脑的间隔 ±50%）排下一轮。
        const next = res?.intervalMs ?? lastSpeakRes?.retryMs ?? 0;
        scheduleChatter(next);
      } else {
        // 忙/睡着/被关掉自动互动：不硬挤，过一分钟再看
        scheduleChatter(60_000);
      }
    }, wait);
  }

  // ---- 窗口高度 -------------------------------------------------------
  /**
   * 窗口平时只有桌宠那么大（贴着屏幕右下角，不挡桌面）。
   * 气泡 / 右键菜单 / 面板要浮在桌宠上方，才临时把窗口往上长出来（底边不动）。
   */
  /**
   * 布局变了就上报"哪些矩形现在要接收鼠标"。
   *
   * **不再改窗口尺寸**：窗口一开始就开好了 HUD 预留区，气泡/菜单/面板都长在里面。
   * 每改一次窗口尺寸，Windows 透明窗口就重建一次 DWM 合成层，屏幕上就是闪一下 ——
   * 这是"点一下就闪"的真正根因。窗口不动，只把可见浮层的矩形告诉主进程，
   * 它用 60ms 的光标轮询决定穿透（宠物矩形它自己算，不依赖这里）。
   */
  let lastZonesKey = '';
  function syncGrow() {
    const zones = [];
    const add = (el) => {
      if (!el || el.hidden) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      zones.push({
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    };
    // 只要菜单和面板 —— 气泡是不可交互的，算进热区反而挡桌面
    add(menu);
    add(panel);
    // 2026-11-11：徽章在宠物下沿 -22px（BADGE_SPACE 里），不在宠物热区里，
    // 不单独上报的话点击永远穿透到桌面，心情/未读入口等于没有。
    add(badge);
    const key = JSON.stringify(zones);
    if (key === lastZonesKey) return;
    lastZonesKey = key;
    window.petDesk.hotzones?.(zones);
    ping('hotzones', zones.length + ' zones' + (zones[0] ? ' first@' + zones[0].y : ''));
  }

  // ---- 点击穿透 ---------------------------------------------------------
  /**
   * 穿透交给主进程：它每 60ms 拿真实光标位置比一次"宠物矩形 + 上面上报的浮层矩形"，
   * 命中就不穿透、否则穿透。渲染端不再自己判（Windows 上 setIgnoreMouseEvents 的
   * forward 转发不稳，靠 mousemove 判命中会永久卡在穿透状态 → 点不动，踩过）。
   * 这里只留一个矩形内缩比，给 pointerdown 判"这一下是不是点在宠物身上"。
   */
  function petHit(x, y) {
    const r = pet.getBoundingClientRect();
    const ix = r.width * HIT_INSET.x;
    const iy = r.height * HIT_INSET.y;
    return x >= r.left + ix && x <= r.right - ix && y >= r.top + iy && y <= r.bottom - iy;
  }

  // ---- 拖拽 -------------------------------------------------------------
  /**
   * 抛掷测速：取最近 150ms 的指针位移算速度（dsh-pet 的 estimateReleaseVelocity 同思路）。
   * 样本太少就不给速度，让它老老实实放回去。
   */
  let velSamples = [];

  function pushSample(e) {
    velSamples.push({ t: Date.now(), x: e.screenX, y: e.screenY });
    const cutoff = Date.now() - 150;
    velSamples = velSamples.filter((s) => s.t >= cutoff);
  }

  function estimateVelocity() {
    if (velSamples.length < 2) return { vx: 0, vy: 0 };
    const first = velSamples[0];
    const last = velSamples[velSamples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0.001) return { vx: 0, vy: 0 };
    return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
  }

  pet.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const hit = petHit(e.clientX, e.clientY);
    // 排障：鼠标到底有没有进到窗口、命中判定过没过
    ping('desk.pointerdown', 'hit=' + hit + ' at=' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' rect=' + JSON.stringify(pet.getBoundingClientRect().toJSON?.() ?? {}));
    if (!hit) return;
    dragging = { x0: e.screenX, y0: e.screenY, t0: Date.now(), moved: 0, animSwitched: false };
    velSamples = [{ t: Date.now(), x: e.screenX, y: e.screenY }];
    window.petDesk.drag('start', e.screenX, e.screenY);
    pet.setPointerCapture?.(e.pointerId);
    // 这里故意不换动画：单纯点一下不该先播"被拎起来"再弹回待机 —— 那是两次换源，
    // 看着就是闪两下。等真的拖动超过阈值再换（见 pointermove）。
  });

  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dragging.moved = Math.max(dragging.moved, Math.hypot(e.screenX - dragging.x0, e.screenY - dragging.y0));
    if (!dragging.animSwitched && dragging.moved > 10) {
      dragging.animSwitched = true;
      playAnim('被鼠标拖拽悬空反馈', true);
    }
    pushSample(e);
    window.petDesk.drag('move', e.screenX, e.screenY);
  });

  /**
   * 这一下点在哪儿。视频是整幅 16:9，宠物头在上三分之一左右，
   * 用归一化高度切一刀就够分辨"摸头"和"戳身子"了。
   */
  function tapZone(x, y) {
    const r = pet.getBoundingClientRect();
    if (!r.height) return 'body';
    return (y - r.top) / r.height < 0.34 ? 'head' : 'body';
  }

  window.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    const click = dragging.moved < 6 && Date.now() - dragging.t0 < 350;
    const vel = estimateVelocity();
    window.petDesk.drag('end', e.screenX, e.screenY, vel.vx, vel.vy);
    dragging = null;
    velSamples = [];
    // 落地/松手后回到待机动作（抛掷的话主进程会另外通知落地）
    if (click) onTap(tapZone(e.clientX, e.clientY));
    else if (Math.hypot(vel.vx, vel.vy) < 140) playAnim('待机呼吸休闲', true);
  });

  /**
   * 拖到一半断电的兜底。
   *
   * 只有 pointerup 一条出路：拖着的时候切窗口、锁屏、任务栏抢走指针，
   * pointerup 就不来了 → dragging 永远为真 →
   * 溜达、睡觉、换动作全被挡死，桌宠从此变成一块不会动的贴纸。
   */
  function abortDrag() {
    if (!dragging) return;
    dragging = null;
    velSamples = [];
    window.petDesk.drag('end', 0, 0, 0, 0);
    playAnim('待机呼吸休闲', true);
    ping('drag.abort', 'pointer lost');
  }
  window.addEventListener('pointercancel', abortDrag);
  window.addEventListener('blur', abortDrag);

  /** 最近一次落地撞击强度（探针用来验证物理真的跑起来了） */
  let lastLand = null;

  /** 上一次看到的工作状态，用来判断"是不是刚忙完" */
  let lastWorkStatus = 'idle';

  /** 上次换情绪动作的时间，避免每轮轮询都抽搐 */
  let lastActionSwap = 0;

  /** 上一次看到的心情档位，用来判断"心情变了没有"（空串 = 还没看到过） */
  let lastMoodBand = '';

  /** 轮询闸：上一次还没回来就不发新的；pollSkipped 只用来排障 */
  let pollInFlight = false;
  let pollSkipped = 0;

  /** 落地压扁：主进程物理算出撞击强度后回调这里 */
  window.petDesk.onLand?.((info) => {
    lastLand = info?.impact ?? 0;
    pet.classList.remove('squash');
    // 强制回流一次，保证连续落地能重放动画
    void pet.offsetWidth;
    pet.classList.add('squash');
    ping('land', 'impact=' + (info?.impact ?? 0));
  });

  // ---- 走动 -------------------------------------------------------------
  /**
   * 素材里全是原地动作（上游的提示词还写死了「全程不许产生 X 轴位移」），
   * 真正"从这儿走到那儿"只能靠代码平移窗口。
   *
   * 做法照抄上游 dsh-pet 的 `src/client/pet/motion/walk.ts`：
   *   起手 leadSec 秒原地不动 → 中段按「动画播放时间」线性插值位移
   *   → 收脚 tailSec 秒到位站定。
   * 关键是位移曲线跟着动画走而不是匀速 —— 脚不打滑，起身收步也自然。
   */
  const WALK_ANIMS = ['开心小跑', '螃蟹走路', '原地漂浮踏步'];
  /** 走位参数（对齐上游 moves.default 的 leadSec / tailSec 思路） */
  const WALK_PLAY = {
    leadSec: 1.0, // 起手原地蓄力（媒体秒）
    tailSec: 1.6, // 收脚站定（媒体秒）
    rate: 1.5, // 播放倍速：素材统一 10 秒，压到 ~6.7 秒走完
  };
  let walking = false;
  /** 当前在播的动画名（探针用） */
  let lastAnimName = '';
  /** 上次走动结束的时间，用来拉开间隔，别一直在地上爬 */
  let lastWalkAt = 0;

  function setFlip(on) {
    for (const v of vids) if (v) v.classList.toggle('flip', Boolean(on));
  }

  // ---- 视线跟随 / 悬停 ---------------------------------------------------
  /**
   * 视线跟着光标走。
   *
   * 素材只有正面站姿，没有独立的眼动帧，所以粗调用镜像（朝哪边就翻哪边），
   * 细调用 CSS 上的轻微位移和侧倾（见 index.html 的 .gaze-left/.gaze-right），
   * 两层叠起来才有"她在看你"的感觉。
   *
   * 走路的时候让位：走位系统自己管朝向，这里再翻一次就走成倒退了。
   */
  function applyGaze(side) {
    gazeSide = Number(side) || 0;
    pet.classList.toggle('gaze-left', gazeSide < 0);
    pet.classList.toggle('gaze-right', gazeSide > 0);
    if (walking) return;
    setFlip(gazeSide > 0);
  }

  /**
   * 播速 = 当前动作的基准 × 悬停加成。
   * 走路时不掺和：走位那套按素材时长推位移，倍速一变就成顺拐。
   */
  function applyRate() {
    const rate = walking ? currentRate : cursorOver ? currentRate * HOVER_RATE : currentRate;
    for (const v of vids) if (v) v.playbackRate = rate;
  }

  /** 主进程推过来的光标方位（只在变化时发，一次一条） */
  function applyCursor(info) {
    if (!info) return;
    applyGaze(info.side);
    const over = Boolean(info.over);
    if (over === cursorOver) return;
    cursorOver = over;
    pet.classList.toggle('hover', over);
    // 呼吸加快/恢复正常：只在悬停状态真的变化时调一次，别每帧改倍速
    applyRate();
    hoverSince = over ? Date.now() : 0;
    hoverLooked = false;
    hoverStartled = false;
    // 只在"移进它身上"的时候报一条：来回晃悠时不必刷屏，pings 只有十几格
    if (over) ping('cursor', `side=${gazeSide} inside=${info.inside ? 1 : 0}`);
  }

  window.petDesk.onCursor?.(applyCursor);

  /**
   * 悬停反应：盯着一秒半她会抬头看你一眼，盯到四秒会"被看毛"。
   * 忙/睡/走/开面板的时候不插播 —— 那些时候插一脚像抽风。
   */
  (function hoverWatcher() {
    setTimeout(() => {
      try {
        const idle =
          cursorOver &&
          hoverSince &&
          !dragging &&
          !sleeping &&
          !walking &&
          baifanPhase < 0 &&
          panelKind === '' &&
          menu.hidden &&
          bubble.hidden;
        if (idle) {
          const held = Date.now() - hoverSince;
          /*
           * 以前这里要求"正停在待机动作"才抬头。
           * 可动作池上线之后它基本不待机（写代码、哼歌、吐泡泡轮着来），
           * 「盯一秒半就看你一眼」等于被自己关掉了。改成：只要没在演一次性动作就给。
           */
          const passive = Date.now() - lastReactionAt > 4_000;
          if (held > 1_500 && !hoverLooked && passive) {
            hoverLooked = true;
            const pool = HOVER_LOOK_ANIMS.filter((n) => n !== currentAnim);
            const look = pick(pool.length ? pool : HOVER_LOOK_ANIMS);
            playAnim(look, true);
            ping('hover.look', `${Math.round(held / 1000)}s ${look}`);
          }
          if (held > 4_000 && !hoverStartled && Date.now() - lastStartleAt > 90_000) {
            hoverStartled = true;
            lastStartleAt = Date.now();
            playAnim(cfg?.animations?.surprise || '被吓一跳', false, 1, () => playAnim(IDLE_ANIM, true));
            say(pick(['哎…你盯着我看干嘛', '怎、怎么了？我脸上有东西？', '看够没呀']), 9_000, '', {
              record: true,
            });
            ping('hover.startle', Math.round(held / 1000) + 's');
          }
        }
      } catch {
        /* 悬停反应出问题不能影响主流程 */
      }
      hoverWatcher();
    }, 400);
  })();

  function stopWalk() {
    if (!walking) return;
    walking = false;
    // 走完把朝向还给光标：别因为走过一次就把"看着你"的姿态丢掉
    applyGaze(gazeSide);
    applyRate();
    window.petDesk.stopWalk?.();
    playAnim(IDLE_ANIM, true);
  }

  window.petDesk.onWalkStart?.((info) => {
    // 兼容旧路径（主进程直接发起位移）。动画由渲染端自己播，这里只管朝向。
    walking = true;
    setFlip(Number(info?.dir) > 0);
    ping('walk.start', 'dir=' + (info?.dir ?? 1));
  });

  window.petDesk.onWalkEnd?.((info) => {
    walking = false;
    applyGaze(gazeSide);
    applyRate();
    lastWalkAt = Date.now();
    ping('walk.end', String(info?.reason ?? ''));
    // 追饭第一段走完了，接着演后面四段
    if (baifanPhase === 0) baifanNext();
    else playAnim(IDLE_ANIM, true);
  });

  /** 走动条件：别在忙、别在说话、别拖着的时候满地跑 */
  function canWander() {
    return (
      !dragging &&
      !quiet &&
      !panelKind &&
      bubble.hidden &&
      menu.hidden &&
      lastWorkStatus !== 'running' &&
      !walking &&
      !sleeping &&
      baifanPhase < 0 &&
      Date.now() - lastWalkAt > 25_000
    );
  }

  /**
   * 真正走一步：播走位动画 → 拿到素材时长 → 交给主进程按播放时间插值位移。
   * dx 是相对位移（渲染端不知道窗口坐标，只有主进程能改窗口）。
   */
  async function startWalkRun(dx, name) {
    walking = true;
    // 素材的滑步动势是朝左的（上游提示词原文："向左侧横向移动的滑步动势"），
    // 所以往右走时镜像一次，脚步方向和位移方向才一致。
    setFlip(dx > 0);
    applyRate();
    const v = await playAnim(name, false, WALK_PLAY.rate);
    if (!v) {
      walking = false;
      applyGaze(gazeSide);
      applyRate();
      return false;
    }
    const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 10.04;
    window.petDesk.walkBegin?.({
      dx: Math.round(dx),
      duration,
      leadSec: WALK_PLAY.leadSec,
      tailSec: WALK_PLAY.tailSec,
      rate: WALK_PLAY.rate,
    });
    ping('walk.go', `dx=${Math.round(dx)} anim=${name} dur=${duration.toFixed(2)}`);
    return true;
  }

  /** 随机溜达一段：心情越好走得越远，低落时就近挪两步 */
  function maybeWander() {
    if (!canWander()) return;
    const moodNow = Number(state?.mood?.mood ?? 60);
    // 距离按上游 moves 的量级来（60~320px），再远就像瞬移了
    const reach = moodNow >= 72 ? 240 : moodNow >= 55 ? 160 : 90;
    const dx = (70 + Math.random() * reach) * (Math.random() < 0.5 ? -1 : 1);
    startWalkRun(dx, pick(WALK_ANIMS));
  }

  (function wanderLoop() {
    setTimeout(() => {
      // 不是每次都走，有一半概率原地待着 —— 太勤快反而像扫地机器人
      if (Math.random() < 0.55) maybeWander();
      wanderLoop();
    }, 35_000 + Math.random() * 55_000);
  })();

  // ---- 睡觉三段接力 -----------------------------------------------------
  // 照抄上游 dsh-pet 的 sleep 玩法：入睡(睡觉-开始) → 循环(睡觉-循环) → 起床(睡觉-起来)。
  // 中间那段必须 loop=true 播（上游要求循环段首尾帧完全相同，否则循环处会跳）。
  const SLEEP = { start: '睡觉-开始', loop: '睡觉-循环', end: '睡觉-起来', maxMs: 45_000, menu: '😴 睡一觉' };
  const SLEEP_CLIPS = new Set([SLEEP.start, SLEEP.loop, SLEEP.end]);
  /** 午后小憩趴多久：十分钟就够，睡久了反而糊 */
  const NAP_MS = 10 * 60_000;
  let sleeping = false;
  let sleepPhase = '';
  let sleepTimer = 0;
  let lastSleepAt = 0;

  /**
   * 睡觉被打断：拖走、点别的动作、干活去了 —— 直接把睡眠状态收掉，
   * 不然宠物会一直挂着「💤 睡觉中」却已经在干别的了。
   */
  function cancelSleep() {
    if (!sleeping && !sleepPhase) return;
    clearTimeout(sleepTimer);
    sleeping = false;
    sleepPhase = '';
    ping('sleep.cancel', 'interrupted');
    paintBadge();
  }

  /** 睡到明天早上 7 点（自动入睡时用），手动睡只睡一小会儿 */
  function msUntilHour(hour) {
    const now = new Date();
    const t = new Date(now);
    t.setHours(hour, 0, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t.getTime() - now.getTime();
  }

  /**
   * 开始睡觉。auto=true 是夜里自动睡，睡到早上 7 点；
   * nap=true 是午后小憩，只趴 NAP_MS（十分钟）；
   * 手动睡只睡 SLEEP.maxMs（45 秒），免得手动点一下就睡死过去。
   */
  async function startSleep(auto = false, nap = false) {
    if (sleeping) return false;
    if (!animTable) return false;
    if (walking) stopWalk();
    sleeping = true;
    sleepPhase = 'start';
    clearTimeout(sleepTimer);
    ping('sleep.start', nap ? 'nap' : auto ? 'auto' : 'manual');
    if (nap) say('吃过了，我趴十分钟', 5000, '', { record: true });
    else if (auto) say('困了，先眯一会儿…', 4000, '', { record: true });
    const ok = await playAnim(SLEEP.start, false, 1, () => sleepLoop());
    if (!ok) {
      sleeping = false;
      sleepPhase = '';
      return false;
    }
    sleepTimer = setTimeout(() => wakeUp(), nap ? NAP_MS : auto ? msUntilHour(7) : SLEEP.maxMs);
    paintBadge();
    return true;
  }

  /** 入睡段播完 → 进入循环段 */
  function sleepLoop() {
    if (!sleeping || sleepPhase !== 'start') return;
    sleepPhase = 'loop';
    ping('sleep.loop', SLEEP.loop);
    playAnim(SLEEP.loop, true);
  }

  /** 醒来：播起床段，播完回待机 */
  function wakeUp() {
    if (!sleeping) return;
    clearTimeout(sleepTimer);
    sleepPhase = 'end';
    lastSleepAt = Date.now();
    ping('sleep.wake', SLEEP.end);
    playAnim(SLEEP.end, false, 1, () => {
      sleeping = false;
      sleepPhase = '';
      ping('sleep.done', 'idle');
      paintBadge();
    });
  }

  /**
   * 自动睡：夜里 23 点到早上 6 点，闲着就睡；午后 12:30-13:30 趴十分钟。
   * 夜里老大还在干活就不睡 —— 它先倒下不合适，那是陪着的时候（见 maybeNightYawn）。
   */
  function maybeAutoSleep() {
    if (sleeping) return;
    const now = new Date();
    const h = now.getHours();
    const mi = now.getMinutes();
    const night = h >= 23 || h < 6;
    const napWindow = (h === 12 && mi >= 30) || (h === 13 && mi < 30);
    if (!night && !napWindow) return;
    if (night && lastWorkStatus === 'running') return;
    if (dragging || walking || quiet || panelKind || !bubble.hidden) return;
    if (now.getTime() - lastSleepAt < 30 * 60_000) return;
    if (napWindow && !night) {
      const day = now.toDateString();
      if (napDay === day) return; // 一天趴一次就够
      napDay = day;
      ping('sleep.nap', 'afternoon');
      startSleep(false, true);
      return;
    }
    startSleep(true);
  }

  /**
   * 连着干活满四十五分钟就伸个懒腰提醒一句。
   * 走本地短句不走模型：提醒这事儿不该等两秒生成。
   */
  function maybeStretchBreak() {
    if (!workSince || lastWorkStatus !== 'running') return;
    const held = Date.now() - workSince;
    if (held < 45 * 60_000) return;
    if (Date.now() - lastStretchAt < 45 * 60_000) return;
    if (dragging || walking || sleeping || baifanPhase >= 0 || panelKind || !bubble.hidden || quiet) return;
    lastStretchAt = Date.now();
    playAnim('超大伸懒腰', false, 1, () => playAnim(IDLE_ANIM, true));
    say(pick(['连着四十五分钟了，起来动动？', '坐太久了，肩膀该僵了', '喝口水吧，别干成石头']), 10_000, '', {
      record: true,
    });
    ping('break.stretch', Math.round(held / 60_000) + 'min');
  }

  /** 深夜陪同：老大还在干，它就不睡，隔一阵打个哈欠表示还在 */
  function maybeNightYawn() {
    const h = new Date().getHours();
    if (!(h >= 23 || h < 6)) return;
    if (lastWorkStatus !== 'running') return;
    if (sleeping || dragging || walking || baifanPhase >= 0 || panelKind || !bubble.hidden || quiet) return;
    if (Date.now() - lastNightYawnAt < 15 * 60_000) return;
    lastNightYawnAt = Date.now();
    playAnim('哈欠连天', false, 1, () => playAnim(IDLE_ANIM, true));
    say(pick(['哈……你还没睡啊', '这么晚了，我陪着你', '眼皮重了…但你还在干']), 8_000, '', { record: true });
    ping('night.yawn', new Date().toTimeString().slice(0, 5));
  }

  (function sleepWatcher() {
    setTimeout(() => {
      try {
        maybeAutoSleep();
        maybeStretchBreak();
        maybeNightYawn();
      } catch {
        /* 作息相关的动作失败也别影响主流程 */
      }
      sleepWatcher();
    }, 60_000);
  })();

  // ---- 追饭（照抄上游 dsh-pet 的 baifan 五连）--------------------------
  // 上游 assets/config.jsonc 里 "baifan": ["开心小跑","侧身急躁跑","期待开饭","吃饭·碗饭","吃饭团"]
  // 依次是：跑向饭 / 追饭时的侧身跑 / 到位后等开饭 / 吃到碗饭 / 吃饭团。
  // 第一段用走位系统（窗口真的会跑），后面四段原地演，演完接下一段。
  const BAIFAN = ['开心小跑', '侧身急躁跑', '期待开饭', '吃饭·碗饭', '吃饭团'];
  let baifanPhase = -1;

  function cancelBaifan(reason = 'interrupted') {
    if (baifanPhase < 0) return;
    baifanPhase = -1;
    ping('baifan.cancel', reason);
  }

  /** 开始追饭：先跑过去 */
  async function startBaifan() {
    if (baifanPhase >= 0) return false;
    // 「安静点」只是别话多，不该连吃饭都不让 —— 所以这里不看 quiet
    if (sleeping || walking || dragging || panelKind) {
      ping('baifan.blocked', `sleeping=${sleeping} walking=${walking} dragging=${!!dragging} panel=${panelKind}`);
      return false;
    }
    baifanPhase = 0;
    const dx = Math.round((140 + Math.random() * 240) * (Math.random() < 0.5 ? -1 : 1));
    ping('baifan.start', 'dx=' + dx);
    const ok = await startWalkRun(dx, BAIFAN[0]);
    if (!ok) baifanPhase = -1;
    return ok;
  }

  /** 上一段演完，接下一段 */
  function baifanNext() {
    if (baifanPhase < 0) return;
    baifanPhase += 1;
    if (baifanPhase >= BAIFAN.length) {
      baifanDone();
      return;
    }
    const name = BAIFAN[baifanPhase];
    ping('baifan.step', `${baifanPhase}:${name}`);
    playAnim(name, false, 1, () => baifanNext());
  }

  /** 吃完了：本地先报一声，再让共享大脑按它的调子补一句 */
  function baifanDone() {
    baifanPhase = -1;
    ping('baifan.done', 'ate');
    say('呼——吃饱啦～', 8000, '', { record: true });
    askHostSpeak(true).then((res) => {
      if (!res?.text) return;
      say(res.text, 15000, res.emoji || '', { kind: 'proactive' });
      ping('baifan.speak', res.text.slice(0, 30));
    });
  }

  // ---- 交互 -------------------------------------------------------------
  function onTap(zone = 'body') {
    // 藏了菜单就得把热区也收回去，不然主进程那边还留着菜单那块，
    // 直到下一次 syncGrow 之前那一片点不到桌面。
    if (!menu.hidden) {
      menu.hidden = true;
      syncGrow();
    }
    // 走着被点：先站住，不然她一边滑行一边演点击回应，像在溜冰
    if (walking) stopWalk();
    // 睡着的时候点一下就是叫醒，别搭话
    if (sleeping) {
      wakeUp();
      return;
    }
    const now = Date.now();
    // 这一戳的批次号：比它更新的点击会让这一路回来的话作废
    const mySeq = ++reactSeq;
    // 连戳三下：同一个 1.6 秒窗口里数到第三下就翻脸，别一直戳
    if (now - tapWindowAt > 1_600) tapCount = 0;
    tapWindowAt = now;
    tapCount += 1;
    if (tapCount >= 3) {
      tapCount = 0;
      say(withEmoji(pick(['别戳了别戳了', '哎哟，连着戳我干嘛', '手痒啊你'])), 9_000, '', { record: true });
      playAnim(cfg?.animations?.click?.[3] || '点击回应-傲娇生气', false, 1, () => playAnim(IDLE_ANIM, true));
      ping('tap.poke', 'triple');
      return;
    }
    if (zone === 'head') {
      // 摸头一档：动作是吓一跳，话得软。
      // 这一档到此为止 —— 摸头要的是即时的反应，别等两秒后用模型那句盖掉，
      // 那样老大摸的是头，听到的却是"三点半了"这种话题词，驴唇不对马嘴。
      say(withEmoji(pick(TAP_HEAD_LINES)), 9_000, '', { record: true });
      playAnim(cfg?.animations?.surprise || '被吓一跳', false, 1, () => playAnim(IDLE_ANIM, true));
      ping('tap.head', 'surprise');
      return;
    }
    // 点身子：先给一句本地短句，点了立刻有反应（模型要两秒多，等着会以为没点中）
    say(withEmoji(pick(BAND_LINES[bandId()] || BAND_LINES.unknown)), 9_000, '', { record: true });
    playAnim(actionOf(state), false);
    ping('tap.body', 'click');
    /*
     * 连点别每次都去要一句。
     * 本地短句已经给过反应了，三秒内的第二第三下再各生成一次，纯属烧钱，
     * 而且两句话前后脚冒出来会互相打架。
     */
    if (now - lastTapAskAt <= 2_500) {
      ping('tap.speak.skip', 'debounce');
      return;
    }
    lastTapAskAt = now;
    // 再让宿主按共享大脑的调子重新说一句，来了就替换掉。
    // 四秒不回就自己先演「…」+ 思考动作（见 askWithThinking）。
    askWithThinking(true).then((res) => {
      if (mySeq !== reactSeq) return;
      if (!res?.text) return;
      // 只有真的等过（已经切到思考动作）才按语气再换一次动作；
      // 回得快就保持刚才那一下 —— 同一次点击连换两回，看着闪。
      // 等过又没有对应语气的动作，就先回待机，别顶着「？」听人说话。
      const toneAnim = animForTone(res.tone);
      if (lastAskThought) {
        if (toneAnim) playAnim(toneAnim, false);
        else playAnim(IDLE_ANIM, true);
      }
      say(res.text, 15_000, res.emoji || '', { kind: 'proactive' });
      ping('tap.speak', res.text.slice(0, 30));
    });
  }

  // 滚轮不再改大小：体型按旧版 dsh-pet 固定在 462px
  pet.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
    },
    { passive: false }
  );

  pet.addEventListener('dblclick', () => {
    if (sleeping) return;
    say('拆礼物？是给我的吗', 8_000, '', { record: true });
    playAnim(cfg?.animations?.gift || '拆礼物', false, 1, () => playAnim(IDLE_ANIM, true));
    ping('tap.gift', 'dblclick');
  });

  pet.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    bubble.hidden = true;
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      // 先把菜单内容填好再上报热区：反过来的话上报的矩形还是空的
      buildMenu();
    }
    syncGrow();
  });

  // 点窗口别处关菜单
  window.addEventListener('pointerdown', (e) => {
    if (menu.hidden) return;
    if (!menu.contains(e.target)) {
      menu.hidden = true;
      syncGrow();
    }
  }, false);

  // 2026-11-11：点面板外面也关面板（以前只有 ✕ 和输入框里的 Esc）
  window.addEventListener('pointerdown', (e) => {
    if (panel.hidden) return;
    if (panel.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest('#badge')) return;
    closePanel();
  }, false);

  // 关掉是不可逆的（宿主会记 closedByUser，下次启动不再拉起），所以点一次只是「上膛」
  let closeArmed = false;

  function buildMenu() {
    const items = [
      ['💬 聊两句', () => openPanel('chat')],
      ['📊 看看心情', () => openPanel('mood')],
      ['💰 看看余额', () => openPanel('usage')],
      ['🎬 换个动作', () => openPanel('actions')],
      ['🍚 去吃饭', () => startBaifan()],
      [sleeping ? '☀️ 叫醒它' : '😴 睡一觉', () => (sleeping ? wakeUp() : startSleep())],
      [quiet ? '🔔 打开自动互动' : '🔕 关掉自动互动', () => toggleQuiet()],
      [voiceOn ? '🔇 只显示文字' : '🗣️ 也念出声', () => toggleVoice()],
      // 2026-11-11：找不到 / 跑到屏幕外面时的手动兜底
      ['🎯 重新居中', () => window.petDesk.recenter?.()],
      null,
      [
        closeArmed ? '✕ 再点一次就关掉' : '✕ 关掉桌面助手',
        () => {
          if (!closeArmed) {
            closeArmed = true;
            buildMenu();
            syncGrow();
            return;
          }
          closeByUser();
        },
      ],
    ];
    menu.innerHTML = '';
    for (const it of items) {
      if (!it) {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'menu-item';
      btn.type = 'button';
      btn.textContent = it[0];
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden = true;
        syncGrow();
        it[1]();
      });
      menu.appendChild(btn);
    }
  }

  function showMood() {
    if (panelKind === 'mood') closePanel();
    else openPanel('mood');
  }

  const DIM_LABEL = {
    happy: '开心',
    calm: '踏实',
    sweet: '甜蜜',
    heartache: '心疼',
    worry: '担心',
    sad: '难过',
    jealous: '吃醋',
  };

  /**
   * 用户主动关掉桌面助手。
   *
   * 必须先告诉宿主「是用户关的」，宿主才会落 closedByUser 标记 ——
   * 否则下次宿主重启它又自己爬回来（老大刚为这个提过一次）。
   */
  async function closeByUser() {
    try {
      await api('/pet-brain/desktop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'close' }),
      });
    } catch {
      // 宿主那边 stopDesktop 已经把它 SIGTERM 了，走到这里通常是"已经关了"
    }
    window.petDesk.quit();
  }

  function toggleQuiet() {
    quiet = !quiet;
    try {
      localStorage.setItem(QUIET_KEY, quiet ? '1' : '0');
    } catch {
      /* localStorage 不可用：这次会话里生效就行 */
    }
    say(quiet ? '好，那我少说点' : '行，那我多说点', 8000, '', { record: true });
    // 刚把自动互动打开：别等下一轮随机间隔，马上试一次
    if (!quiet) scheduleChatter(5_000);
  }

  // ---- 面板：聊天 / 余额 / 心情 ------------------------------------------
  const panel = $('panel');
  const panelName = $('panelName');
  const panelClose = $('panelClose');
  const logEl = $('log');
  const infoEl = $('info');
  const rowEl = $('row');

  /**
   * 面板内容是异步填进去的（余额要等接口、聊天要等回复），
   * 只在 openPanel 那一刻算热区会算少 → 面板右上角那块点不动。
   * 所以盯着 DOM：内容一变就重新上报一次（rAF 合并）。窗口尺寸不动，只更新热区。
   */
  let growQueued = false;
  function queueGrow() {
    if (growQueued) return;
    growQueued = true;
    requestAnimationFrame(() => {
      growQueued = false;
      syncGrow();
    });
  }
  new MutationObserver(() => {
    if (panelKind) queueGrow();
  }).observe(panel, { childList: true, subtree: true, characterData: true });
  const inputEl = $('input');
  const sendBtn = $('send');

  /**
   * 动作分组。数据来自宿主 /pet-brain/config 的 animations，
   * 按 dsh-pet 的 buildMenuTree 思路把上百个动画归成几组，不平铺。
   */
  const ACTION_GROUPS = [
    ['日常', ['idle', 'small']],
    ['走路', ['walk']],
    ['吃喝', ['eat']],
    ['睡觉', ['sleep']],
    ['互动', ['click']],
    ['特别', ['whale', 'gift', 'surprise']],
  ];

  /** 宿主给的动画表；拉不到就退回到几个保底动作 */
  let animTable = null;

  function allActions() {
    if (!animTable) return ['待机呼吸休闲'];
    const out = [];
    for (const [, keys] of ACTION_GROUPS) {
      for (const k of keys) {
        const v = animTable[k];
        if (!v) continue;
        if (Array.isArray(v)) out.push(...v);
        else out.push(v);
      }
    }
    return [...new Set(out)];
  }

  function renderActions() {
    const box = $('actions');
    box.innerHTML = '';
    for (const [label, keys] of ACTION_GROUPS) {
      const names = [];
      for (const k of keys) {
        const v = animTable && animTable[k];
        if (!v) continue;
        // 睡觉是一套三段接力，单播一段没有意义，给一个「睡一觉」按钮走完整流程
        if (k === 'sleep') {
          names.push(SLEEP.menu);
          continue;
        }
        if (Array.isArray(v)) names.push(...v);
        else names.push(v);
      }
      if (!names.length) continue;
      box.appendChild(el('div', 'act-group', label));
      for (const name of names) {
        const btn = el('button', 'act', name);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          if (name === SLEEP.menu) {
            startSleep();
            ping('act', 'sleep');
          } else {
            playAnim(name, false);
            ping('act', name);
          }
          closePanel();
        });
        box.appendChild(btn);
      }
    }
    if (!box.childElementCount) box.appendChild(el('div', 'act-group', '没有可播的动作'));
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function openPanel(kind) {
    menu.hidden = true;
    bubble.hidden = true;
    if (walking) stopWalk();
    panelKind = kind;
    panel.hidden = false;
    /*
     * 2026-11-11（P0）：面板是从宠物上沿向上长进 HUD 预留区的，可用高度就是
     * 「宠物顶边到窗口顶」这一段。以前 #panel/#actions 写死 588/460，动作面板
     * 实高约 513，多出来的顶部跑出窗口 —— 标题栏和 ✕ 都点不到，只能重启。
     * 现在按真实可用空间算，超了就在面板内部滚。
     */
    try {
      const petRect = pet.getBoundingClientRect();
      const avail = Math.max(180, Math.round(petRect.top - 8));
      panel.style.maxHeight = `${avail}px`;
      panel.style.overflowY = 'auto';
      const actionsEl = $('actions');
      if (actionsEl) actionsEl.style.maxHeight = `${Math.max(140, avail - 96)}px`;
    } catch {
      /* 量不到就退回 CSS 默认值 */
    }
    panelName.textContent =
      kind === 'chat' ? '聊天' : kind === 'usage' ? 'DeepSeek 余额' : kind === 'actions' ? '换个动作' : '心情';
    logEl.hidden = kind !== 'chat';
    rowEl.hidden = kind !== 'chat';
    infoEl.hidden = kind === 'chat' || kind === 'actions';
    $('actions').hidden = kind !== 'actions';
    syncGrow();
    if (kind === 'chat') {
      renderChat();
      // 拉一次宿主账本：桌宠在气泡里说过的话、主动搭过的话，面板里都要看得见
      void syncChatLog().then(() => {
        renderChat();
        clearUnread();
      });
      setTimeout(() => inputEl.focus(), 70);
    } else if (kind === 'usage') {
      renderUsage();
      void fetchUsage(false);
    } else if (kind === 'actions') {
      renderActions();
    } else {
      renderMood();
    }
    // 内容填完再量一次真实高度（上面那次 syncGrow 量的还是空面板）
    requestAnimationFrame(() => syncGrow());
  }

  function closePanel() {
    panelKind = '';
    panel.hidden = true;
    syncGrow();
  }

  panelClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closePanel();
  });

  /* ---- 会话记录：气泡和聊天面板共用一份 ---- */
  /**
   * 桌宠这边的会话记录（本地那份）。
   *
   * 以前气泡和聊天面板各记各的：气泡里说的话，面板里看不见；
   * 面板里说的话，气泡里也没有 —— 老大点两处，像在跟两只会说话的东西打交道。
   * 现在两边共用一份会话：桌宠说的每一句都记在这儿，再跟宿主账本合并，
   * 就是完整的一条对话线。
   */
  const localSpeech = [];
  function pushChatLine(role, text, kind = 'local') {
    const t = String(text || '').trim();
    if (!t) return;
    localSpeech.push({
      role: role === 'user' ? 'user' : 'assistant',
      kind,
      text: t.slice(0, 200),
      at: Date.now(),
    });
    if (localSpeech.length > 60) localSpeech.splice(0, localSpeech.length - 60);
  }

  /** 宿主账本（聊过的、主动搭过的都记在那边） */
  let hostLog = { lines: [] };

  /** 有话没显示出来：徽章上挂个提示，别让老大以为它没说话 */
  let unread = 0;
  function markUnread() {
    unread += 1;
    paintBadge();
  }
  function clearUnread() {
    if (!unread) return;
    unread = 0;
    paintBadge();
  }

  /* ---- 聊天 ---- */
  /** 拉一次宿主账本，让面板里的内容和桌宠说过的话对齐 */
  async function syncChatLog() {
    try {
      const res = await api('/pet-brain/chatlog?limit=60');
      if (res && Array.isArray(res.lines)) hostLog = { lines: res.lines };
    } catch (e) {
      /* 拉不到就先用本地的，别把面板搞空 */
    }
    return hostLog;
  }

  /** 本地记录 + 宿主账本，按时间排好、去掉重复 */
  function mergedChat() {
    const out = [];
    const seen = new Map();
    const add = (m) => {
      const key = `${m.role}|${m.text}`;
      const prev = seen.get(key);
      // 同一条别显示两遍（本地那份和宿主那份是同一条，只是时间戳差一点）
      if (prev !== undefined && Math.abs((m.at ?? 0) - prev) < 4000) return;
      seen.set(key, m.at ?? 0);
      out.push(m);
    };
    for (const m of hostLog.lines ?? []) add(m);
    for (const m of localSpeech) add(m);
    out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    return out.slice(-60);
  }
  /** 发给模型的历史，只留最近 8 条，避免上下文越滚越长 */
  const chatHistory = [];
  let sending = false;

  function renderChat() {
    logEl.textContent = '';
    const rows = mergedChat();
    if (!rows.length) logEl.appendChild(el('div', 'msg pet', '在的，说吧。'));
    for (const m of rows) logEl.appendChild(el('div', 'msg ' + (m.role === 'user' ? 'me' : 'pet'), m.text));
    if (sending) logEl.appendChild(el('div', 'msg typing', '…'));
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function sendChat() {
    const text = inputEl.value.trim();
    if (!text || sending) return;
    inputEl.value = '';
    pushChatLine('user', text, 'chat');
    sending = true;
    renderChat();
    try {
      const res = await api('/pet-brain/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, history: chatHistory.slice(-8) }),
      });
      const reply = res?.reply || '……';
      pushChatLine('assistant', reply, 'chat');
      chatHistory.push({ role: 'user', text }, { role: 'assistant', text: reply });
      if (res?.mood) state = { ...state, mood: res.mood };
      paintBadge();
      playAnim(res?.action || actionOf(state), false);
      // 面板里聊完也给个气泡：两个视图要互相能看见
      say(reply, 12000, '', { kind: 'chat' });
      ping('chat.ok', reply.slice(0, 40));
    } catch (e) {
      pushChatLine('assistant', '连不上宿主，等会儿再试。', 'chat');
      ping('chat.fail', String(e?.message || e));
    } finally {
      sending = false;
      renderChat();
      inputEl.focus();
      void syncChatLog().then(() => renderChat());
    }
  }

  sendBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void sendChat();
  });
  inputEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      void sendChat();
    } else if (e.key === 'Escape') {
      closePanel();
    }
  });

  /* ---- 余额 ---- */
  let usage = null;
  let usageBusy = false;

  async function fetchUsage(force) {
    if (usageBusy) return;
    usageBusy = true;
    try {
      usage = await api('/pet-brain/usage' + (force ? '?refresh=1' : ''));
    } catch (e) {
      usage = null;
      ping('usage.fail', String(e?.message || e));
    } finally {
      usageBusy = false;
      if (panelKind === 'usage') renderUsage();
    }
  }

  function renderUsage() {
    infoEl.textContent = '';
    if (!usage) {
      infoEl.appendChild(el('div', 'warn', '读不到余额，检查凭据或网络'));
    } else {
      const big = el('div', 'big');
      big.appendChild(el('b', null, '¥' + Number(usage.balance ?? 0).toFixed(2)));
      big.appendChild(el('span', 'pill', usage.discount ? '优惠时段' : '标准价时段'));
      infoEl.appendChild(big);
      const mk = (k, v) => {
        const row = el('div', 'stat');
        row.appendChild(el('span', null, k));
        row.appendChild(el('span', null, v));
        infoEl.appendChild(row);
      };
      mk('今日已用', '¥' + Number(usage.today ?? 0).toFixed(3));
      mk('近 7 天', '¥' + Number(usage.week ?? 0).toFixed(3));
      infoEl.appendChild(el('div', 'hint', '按余额差值累计，不是逐条账单'));
    }
    const fresh = el('button', 'menu-item', '🔄 刷新');
    fresh.type = 'button';
    fresh.style.padding = '4px 2px';
    fresh.addEventListener('click', (e) => {
      e.stopPropagation();
      void fetchUsage(true);
    });
    infoEl.appendChild(fresh);
  }

  /* ---- 心情七维 ---- */
  function renderMood() {
    infoEl.textContent = '';
    const m = state?.mood;
    if (!m) {
      infoEl.appendChild(el('div', 'warn', '还没读到心情'));
      return;
    }
    const big = el('div', 'big');
    // 数据太旧时宿主给的是中性兜底值 50，不是真心情 —— 印成「—」。
    // 直接写 50，老大看了会以为这会儿心情就是 50 分。
    big.appendChild(el('b', null, m.unknown ? '—' : String(Math.round(m.mood))));
    big.appendChild(el('span', 'pill', m.band?.label || '—'));
    infoEl.appendChild(big);
    if (m.note) infoEl.appendChild(el('div', 'warn', String(m.note).slice(0, 80)));
    // 不知道的时候别摆七行全零的进度条，那是噪声不是信息。
    const dims = m.unknown ? {} : m.dims || {};
    for (const key of Object.keys(DIM_LABEL)) {
      const v = Math.max(0, Math.min(10, Number(dims[key]) || 0));
      const row = el('div', 'dim');
      row.appendChild(el('i', null, DIM_LABEL[key]));
      const track = el('u');
      const fill = el('b');
      fill.style.width = v * 10 + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('em', null, String(Math.round(v))));
      infoEl.appendChild(row);
    }
    if (m.reason) infoEl.appendChild(el('div', 'hint', String(m.reason).slice(0, 60)));
  }

  // ---- 徽章 / 心情 -------------------------------------------------------
  function paintBadge() {
    const m = state?.mood;
    if (sleeping) {
      badge.hidden = false;
      badge.textContent = '💤 睡觉中';
      return;
    }
    if (!m) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    // 同 renderMood：data 太旧时那个 50 是兜底值，不印数字，省得被当真。
    badge.textContent = m.unknown
      ? `— · ${m.band?.label || '—'}`
      : `${m.mood} · ${m.band?.label || '—'}`;
    // 有话没显示出来（面板/菜单开着，气泡被压住了）→ 徽章上挂个提示
    if (unread > 0) badge.textContent += ` · 💬${unread}`;
  }

  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    // 有没看完的话 → 先开聊天面板，别让老大点的不是他以为的那个
    if (unread > 0) {
      openPanel('chat');
      return;
    }
    if (panelKind === 'mood') closePanel();
    else openPanel('mood');
  });

  // ---- 主循环 -----------------------------------------------------------
  /**
   * 轮询序号。
   *
   * 2 秒一轮，宿主忙时一轮可能超过 2 秒 → 两轮并发。
   * 旧的那轮后到就把 state 覆盖成旧值："刚干完活"被误判成"还在干活"，
   * 桌宠的动作跟着来回倒。只认最新那次。
   */
  let pollSeq = 0;
  async function poll() {
    // 2026-11-12 修（桌宠审计）：轮询没有「上一次还在跑」的闸。
    // 宿主卡一下（它要读记忆库、算图谱），2 秒一次的定时器照样往里塞请求 ——
    // 实测最多堆到二十来个并发 fetch，越卡越堆、越堆越卡。
    // 现在同一时刻只允许一个在飞，这一轮的定时器直接跳过，等下一轮。
    if (pollInFlight) {
      pollSkipped += 1;
      return;
    }
    pollInFlight = true;
    const mySeq = ++pollSeq;
    try {
      const st = await api('/pet-brain/state');
      if (mySeq !== pollSeq) return; // 已经有更新的结果了，这次作废
      state = st;
      if (!polledOnce) {
        polledOnce = true;
        ping('state.ok', `mood=${state?.mood?.mood ?? '?'} actions=${state?.actions?.length ?? 0}`);
      }
      paintBadge();
      if (panelKind === 'mood') renderMood();

      // 工作状态：老大在忙就安静干活，干完了冒一句
      const w = state?.work;
      const busyScene = sleeping || baifanPhase >= 0 || !!dragging; // 睡觉/追饭/被拎着时不插播工作动作
      if (w && w.status !== lastWorkStatus) {
        if (w.status === 'running' && w.action) {
          // 记住这轮活儿的起点：满四十五分钟要提醒起来动动
          if (!workSince) workSince = Date.now();
          lastWorkBusyAt = Date.now();
          if (!busyScene) {
            playAnim(w.action, true);
            ping('work.running', w.action);
          }
        } else if (lastWorkStatus === 'running') {
          workSince = 0;
          lastWorkDoneAt = Date.now();
          if (!busyScene) {
            playAnim('待机呼吸休闲', true);
            ping('work.idle', 'turns=' + (w.turns ?? 0));
          }
          if (!quiet && !panelKind && bubble.hidden) {
            // 每次干完活都说同一句，一天天听下来就是复读机。换着说。
            say(withEmoji(pick(WORK_DONE_LINES)), 9000, '', { record: true });
          }
        }
        lastWorkStatus = w.status;
      } else if (w && w.status === 'running') {
        lastWorkBusyAt = Date.now();
      }
      // 2026-11-12：心情档位变了就立刻换一个同档的动作。
      // 原来只有待机轮换（30~70 秒一次）会重新抽，档位早变了画面还挂着上一个表情。
      const bandNow = state?.mood?.band?.id || 'unknown';
      if (
        lastMoodBand &&
        bandNow !== lastMoodBand &&
        !busyScene &&
        !dragging &&
        !sleeping &&
        !walking &&
        panelKind === ''
      ) {
        const pool = Array.isArray(state?.actions) ? state.actions.filter(Boolean) : [];
        if (pool.length > 0) {
          lastActionSwap = Date.now();
          playAnim(pick(pool), true);
          ping('mood.band', bandNow);
        }
      }
      lastMoodBand = bandNow;

      // 有动机的动作池：别在忙、睡着、追饭、走着、开着面板的时候插播。
      // 间隔改成 30~70 秒随机 —— 以前固定 14 秒，节奏太像机器。
      if (!dragging && !sleeping && baifanPhase < 0 && !walking && panelKind === '') {
        const nowSwap = Date.now();
        const gap = 30_000 + Math.random() * 40_000;
        // 正在演一次性动作（蹦一下、吓一跳）就别打断：等它自己接回待机
        if (nowSwap - lastActionSwap > gap && nowSwap - lastReactionAt > 6_000) {
          lastActionSwap = nowSwap;
          const next = pickMotivatedAnim();
          if (next) playAnim(next, true);
        }
      }

      // 共享大脑主会话刚开口、而这一条我还没接过 → 跟着接一句。
      // 以前这事儿接不上：判定只留了一个 3 分钟的时间窗，共享大脑今天
      // 额度用完、隔很久才说一句，桌宠永远等不到那个窗口。
      // 现在宿主那边记着"接到哪一条"，这边只看"有没有新的"。
      const h = state?.host;
      const now = Date.now();
      if (
        h &&
        h.at &&
        h.at > (h.seenAt ?? 0) &&
        h.at > hostFollowSeenAt &&
        !quiet &&
        !dragging &&
        !sleeping &&
        !walking &&
        !hostFollowBusy &&
        // 菜单/面板开着说明老大正在动手操作，这时候抢一句会把菜单顶掉。
        // 让位，等这一轮操作完了再说 —— 反正 h.at 还留着，下一轮轮询还能接。
        menu.hidden &&
        panelKind === '' &&
        now >= hostFollowRetryAt &&
        now - lastSaidAt > HOST_FOLLOW_GAP_MS
      ) {
        hostFollowBusy = true;
        /*
         * 走 askHostSpeak，不自己裸调 api()：
         * 裸调就绕开了 speakInFlight 这道闸 —— 共享大脑接茬和主动搭话/点击反应
         * 能同时要话，两次 LLM 生成、两个气泡前后脚冒出来，一句压一句。
         */
        void askHostSpeak(false, { follow: true })
          .then((res) => {
            if (res?.text) {
              // 这一条接过了，记住：别再接一遍
              hostFollowSeenAt = h.at;
              hostFollowRetryAt = 0;
              // 跟上语气再动一下：以前光冒泡不动，说话的人像贴纸
              const toneAnim = animForTone(res.tone);
              if (toneAnim) playAnim(toneAnim, false);
              say(res.text, 15000, res.emoji || '', { kind: 'proactive' });
              ping('host.follow', `${res.reason} ${res.text.slice(0, 24)}`);
            } else if (lastSpeakNote === 'busy') {
              // 另一路正在要话：不记账，下一轮轮询接着接（h.at 还在，不会丢）
              ping('host.follow.busy', 'speak in flight');
            } else {
              hostFollowRetryAt = now + FOLLOW_RETRY_MS;
              ping('host.follow.skip', res?.reason || lastSpeakNote || 'silent');
            }
          })
          .catch((e) => {
            hostFollowRetryAt = now + FOLLOW_RETRY_MS;
            ping('host.follow.fail', String(e?.message || e));
          })
          .finally(() => {
            hostFollowBusy = false;
          });
      }
    } catch (e) {
      if (!polledOnce) ping('state.fail', String(e?.message || e));
    } finally {
      // 无论成功、失败还是提前 return（mySeq 过期那条不算提前返回，走的是 return 之后
      // 的 finally 语义），这里都要放闸，否则一次异常就把轮询永久卡死。
      pollInFlight = false;
    }
  }

  async function boot() {
    try {
      const env = await window.petDesk.env();
      if (env?.host) HOST = env.host;
      if (typeof env?.token === 'string') PET_TOKEN = env.token;
      // 只报"有没有拿到"，不把令牌本身写进诊断日志
      ping('env', HOST + (PET_TOKEN ? ' token=ok' : ' token=none'));
    } catch (e) {
      /* preload 不可用时退回 URL 参数 */
      ping('env.fail', String(e?.message || e));
    }
    // 顺带把自动互动的开关状态报上来：排障时一眼看出是不是被"关掉自动互动"摁住了
    ping('boot', quiet ? 'auto=off' : 'auto=on');
    try {
      cfg = await api('/pet-brain/config');
      ping('config.ok', `${cfg?.animations ? 'anim ok' : 'no anim'}`);
    } catch (e) {
      cfg = null;
      ping('config.fail', String(e?.message || e));
    }
    await poll();
    // 拉一次动画表，菜单里能按分组选动作
    void api('/pet-brain/config')
      .then((c) => {
        if (c && c.animations) {
          animTable = c.animations;
          ping('config.ok', 'animations=' + allActions().length);
        }
      })
      .catch(() => {});
    const pollTimer = setInterval(poll, 2000);
    window.addEventListener('beforeunload', () => clearInterval(pollTimer));
    applyScale();
    window.petDesk.resize(PET_SIZE);
    scheduleChatter();
    /*
     * 按时段打个招呼。
     * 这组问候语早就写好了，可是一直没接上开关 —— 早/中午/夜里那三档从来没触发过。
     * 起床时冒一句"早啊"，比十分钟后突然冒泡自然得多。
     */
    try {
      const hb = hourBucket();
      if (hb && HOUR_LINES[hb]?.length) {
        say(withEmoji(pick(HOUR_LINES[hb])), 8000, '', { record: true });
        ping('hour.hello', hb);
      }
    } catch {
      /* 打招呼失败不影响别的 */
    }
    setTimeout(() => {
      const r = pet.getBoundingClientRect();
      ping('rect', `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`);
    }, 600);
  }

  /*
   * 排障钩子：主进程可以用 executeJavaScript 调它，把面板打开再截图验收。
   * 正常使用不会碰它，留着无副作用。
   */
  window.__petDeskTest = {
    /**
     * 按钮体检：真的把右键菜单每一项点一遍、把余额的刷新按钮点一遍，
     * 把每步的副作用记下来返回。React 的 onClick 在 DOM 上看不出来，
     * 只有真点才能确认不是"看着有按钮、点了没反应"。
     */
    probe: async () => {
      const out = [];
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      closePanel();
      menu.hidden = false;
      buildMenu();
      const items = [...menu.querySelectorAll('.menu-item')];
      out.push('menu=[' + items.map((b) => b.textContent).join('/') + ']');

      const clickItem = async (kw) => {
        menu.hidden = false;
        buildMenu();
        const b = [...menu.querySelectorAll('.menu-item')].find((x) => x.textContent.includes(kw));
        if (!b) return out.push(kw + '=missing');
        b.click();
        await wait(700);
      };

      await clickItem('心情');
      out.push('mood panel=' + panelKind + ' dims=' + infoEl.querySelectorAll('.dim').length);
      await clickItem('余额');
      out.push('usage panel=' + panelKind + ' stats=' + infoEl.querySelectorAll('.stat').length);
      const fresh = [...infoEl.querySelectorAll('button')].find((b) => b.textContent.includes('刷新'));
      out.push('refresh=' + (fresh ? 'found' : 'missing'));
      if (fresh) {
        fresh.click();
        await wait(1800);
        out.push('refresh clicked, stats=' + infoEl.querySelectorAll('.stat').length);
      }
      await clickItem('自动互动');
      out.push('quiet=' + quiet);
      await clickItem('自动互动');
      out.push('quietBack=' + quiet);
      await clickItem('动作');
      out.push('actions panel=' + panelKind + ' btns=' + $('actions').querySelectorAll('.act').length);
      closePanel();
      await clickItem('聊两句');
      out.push('chat panel=' + panelKind + ' input=' + !!inputEl);
      closePanel();
      out.push('closed=' + panelKind);
      return out.join(' | ');
    },
    /**
     * 主动搭话链路自检：真的走一遍「问宿主 → 宿主决策 → 生成 → 气泡显示」，
     * 把每一步的结果报出来。
     */
    speak: async (force = true) => {
      const out = [];
      const res = await askHostSpeak(force);
      if (!res) return 'speak:no-response';
      out.push('action=' + res.action);
      out.push('reason=' + res.reason);
      out.push('tone=' + res.tone);
      out.push('emoji=' + (res.emoji || 'none'));
      out.push('text=' + String(res.text || '').slice(0, 40));
      out.push('actions=' + (res.actions || []).length);
      if (res.text) {
        say(res.text, 15000, res.emoji || '', { kind: 'proactive' });
        out.push('bubble=' + (bubble.hidden ? 'hidden' : 'shown'));
        out.push('emojiImg=' + bubble.querySelectorAll('img.emoji').length);
        // 等合成 + 起播，把播音结果也报出来（没声音时靠它分清是没合成还是被拦）
        await new Promise((r) => setTimeout(r, 2500));
        out.push('voice=' + JSON.stringify(voiceLast));
      }
      return out.join(' | ');
    },

    /**
     * 抛掷物理自检：合成一串指针事件快速拖动再松手，
     * 看主进程有没有真的把窗口甩出去、落地有没有回弹通知。
     */
    /**
     * 视线/悬停自检：直接喂一条光标消息进去，返回朝向、class 和呼吸倍速。
     * 不用真去挪鼠标 —— 截图验证的时候鼠标在哪儿不好控制。
     */
    cursor: async (side = 1, over = false) => {
      applyCursor({ side, over, inside: true, nx: side, ny: 0 });
      await new Promise((r) => setTimeout(r, 500));
      const v = vids[front];
      return (
        'side=' +
        gazeSide +
        ' flip=' +
        vids.some((x) => x && x.classList.contains('flip')) +
        ' hover=' +
        pet.classList.contains('hover') +
        ' gaze=' +
        (pet.classList.contains('gaze-left') ? 'left' : pet.classList.contains('gaze-right') ? 'right' : 'front') +
        ' rate=' +
        (v ? v.playbackRate.toFixed(2) : '?') +
        ' onCursor=' +
        typeof window.petDesk.onCursor
      );
    },

    /** 现在演的是哪个动作（验证"一次性动作播完有没有接回待机"用） */
    animNow: () => 'anim=' + currentAnim + ' rate=' + currentRate,

    /** 姿势自检：先把画面钉在某个非待机动作上，后面验"悬停抬头"才不会被待机态掩盖 */
    pose: async (name = '写代码') => {
      await playAnim(name, true);
      await new Promise((r) => setTimeout(r, 400));
      return 'anim=' + currentAnim;
    },

    /** 点法自检：直接走一次点击（head/body），看用了哪个动作、气泡有没有出来 */
    tap: async (zone = 'body') => {
      const before = lastAnimName;
      onTap(zone);
      await new Promise((r) => setTimeout(r, 1200));
      return `zone=${zone} anim=${lastAnimName} was=${before} bubble=${bubble.hidden ? 'hidden' : 'shown'}`;
    },

    /** 连戳三下：验证不耐烦那一档 */
    poke: async () => {
      onTap('body');
      await new Promise((r) => setTimeout(r, 260));
      onTap('body');
      await new Promise((r) => setTimeout(r, 260));
      onTap('body');
      await new Promise((r) => setTimeout(r, 900));
      return 'anim=' + lastAnimName + ' taps=' + tapCount;
    },

    /** 动机池自检：只算出"此刻会挑哪个动作"，不真的播 */
    motive: () =>
      'next=' +
      pickMotivatedAnim() +
      ' busy=' +
      lastWorkStatus +
      ' idleMs=' +
      (Date.now() - Math.max(lastWorkDoneAt, lastWorkBusyAt, bootedAt)),

    /**
     * 作息自检：把"连轴转"的计时拨到 46 分钟，看会不会真的伸懒腰提醒。
     * 不然这条要等满四十五分钟才有机会验证。
     */
    stretch: () => {
      workSince = Date.now() - 46 * 60_000;
      lastStretchAt = 0;
      lastWorkStatus = 'running';
      bubble.hidden = true;
      menu.hidden = true;
      const before = lastAnimName;
      maybeStretchBreak();
      return 'anim=' + lastAnimName + ' was=' + before;
    },

    /**
     * 等待期自检：把"多久演省略号"压到 300ms，戳一下就能看到「…」+ 思考动作。
     * 正常是四秒，靠真等一小时才撞得上不合适。
     */
    think: async () => {
      // 临时压小，等这一轮走完必须还原 ——
      // 不还原的话跑过一次自检，这一局所有"思考"都变成 0.3 秒。
      const old = THINK_DELAY_MS;
      THINK_DELAY_MS = 300;
      try {
        onTap('body');
        await new Promise((r) => setTimeout(r, 1_500));
      } finally {
        THINK_DELAY_MS = old;
      }
      const text = String(bubble.textContent || '').trim().slice(0, 24);
      return 'anim=' + lastAnimName + ' bubble=' + (bubble.hidden ? 'hidden' : 'shown') + ' text=' + text;
    },

    throwTest: async () => {
      lastLand = null;
      const r = pet.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const sx = (window.screenX || 0) + cx;
      const sy = (window.screenY || 0) + cy;
      const mk = (type, x, y) =>
        new PointerEvent(type, { clientX: x, clientY: y, screenX: sx + (x - cx), screenY: sy + (y - cy), button: 0, buttons: 1, bubbles: true, pointerId: 1 });
      pet.dispatchEvent(mk('pointerdown', cx, cy));
      for (let i = 1; i <= 8; i++) {
        window.dispatchEvent(mk('pointermove', cx + i * 40, cy - i * 6));
        await new Promise((r2) => setTimeout(r2, 16));
      }
      window.dispatchEvent(mk('pointerup', cx + 320, cy - 48));
      await new Promise((r2) => setTimeout(r2, 2600));
      return 'land=' + (lastLand === null ? 'none' : lastLand) + ' | squash=' + pet.classList.contains('squash');
    },

    /**
     * 直接给定初速度抛一次（不走指针事件），用来验证上下边界。
     * 抛掷只用 vx/vy，不需要坐标。
     */
    throwTo: async (vx = 0, vy = -3000) => {
      lastLand = null;
      window.petDesk.drag('end', 0, 0, vx, vy);
      await new Promise((r2) => setTimeout(r2, 2400));
      return 'screenY=' + Math.round(window.screenY) + ' | land=' + (lastLand === null ? 'none' : lastLand);
    },

    /**
     * 走动自检：让人走一段，采样窗口 x 看真的挪了没有、走完动画有没有收回 idle。
     */
    walkTest: async (dx = -300) => {
      const x0 = Math.round(window.screenX || 0);
      await startWalkRun(dx, WALK_ANIMS[0]);
      await new Promise((r2) => setTimeout(r2, 300));
      const started = walking;
      // 走位全长 = 素材时长 / 倍速，等它走完再采样
      const waitMs = Math.round((10.04 / WALK_PLAY.rate) * 1000) + 900;
      await new Promise((r2) => setTimeout(r2, waitMs));
      const x1 = Math.round(window.screenX || 0);
      return `x ${x0}→${x1} | moved=${x1 - x0} | started=${started} | walking=${walking} | anim=${lastAnimName}`;
    },

    /**
     * 睡觉三段接力自检：睡下去 → 看有没有进循环段 → 叫醒 → 看有没有回待机。
     */
    sleepTest: async () => {
      const phases = [];
      const started = await startSleep();
      phases.push('start:' + sleepPhase);
      await new Promise((r2) => setTimeout(r2, 12000)); // 入睡段 10 秒素材播完
      phases.push('afterStart:' + sleepPhase);
      await new Promise((r2) => setTimeout(r2, 1500));
      phases.push('loop:' + sleepPhase);
      wakeUp();
      phases.push('wake:' + sleepPhase);
      await new Promise((r2) => setTimeout(r2, 11000)); // 起床段 10 秒素材播完
      phases.push('done:' + sleepPhase);
      return `started=${started} | ${phases.join(' | ')} | badge=${badge.textContent}`;
    },

    /**
     * 追饭五连自检：跑 → 追 → 等开饭 → 吃碗饭 → 吃饭团。
     */
    baifanTest: async () => {
      const steps = [];
      const ok = await startBaifan();
      steps.push('p' + baifanPhase);
      for (let i = 0; i < 13; i++) {
        await new Promise((r2) => setTimeout(r2, 3000));
        steps.push('p' + baifanPhase + ':' + lastAnimName);
        if (baifanPhase < 0) break;
      }
      return `started=${ok} | ${steps.join(' | ')}`;
    },

    open: (kind) => openPanel(kind),
    close: () => closePanel(),
    chat: (text) => {
      inputEl.value = text;
      return sendChat();
    },
    kind: () => panelKind,
  };

  boot();
})();
