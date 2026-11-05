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
  let quiet = localStorage.getItem('pet-desk:quiet') === '1';
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

  // ---- 与宿主通信 -------------------------------------------------------
  async function api(path, init) {
    const res = await fetch(HOST + path, init);
    if (!res.ok) throw new Error(path + ' → ' + res.status);
    return res.json();
  }

  /** 把启动进度回传给宿主，宿主的 /pet-brain/state 里能直接看到（排障用） */
  function ping(stage, detail = '') {
    fetch(HOST + '/pet-brain/ping', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'desk.' + stage, detail: String(detail).slice(0, 300) }),
    }).catch(() => {});
  }

  /** 桌宠动作池由宿主按心情算好（lib/index.js 的 actionPool），这里不做判断 */
  function actionOf(s) {
    const pool = s?.actions?.length ? s.actions : s?.action ? [s.action] : [];
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : '待机呼吸休闲';
  }

  const blobCache = new Map();
  let currentAnim = '';
  /** 换动画的令牌：连点时只让最后一次生效，避免旧请求回来把画面倒回去 */
  let animToken = 0;

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

  async function playAnim(name, loop = true) {
    if (!name || name === currentAnim) return;
    const token = ++animToken;
    currentAnim = name;
    try {
      let url = blobCache.get(name);
      if (!url) {
        const res = await fetch(`${HOST}/pet-brain/anim/${encodeURIComponent(name)}.webm`);
        if (!res.ok) throw new Error(`${name} → ${res.status}`);
        url = URL.createObjectURL(await res.blob());
        blobCache.set(name, url);
      }
      if (token !== animToken) return; // 已经切到别的动作了，这次作废
      const back = vids[1 - front];
      back.loop = loop;
      back.src = url;
      back.load();
      await waitPlayable(back);
      await back.play().catch(() => {});
      if (token !== animToken) return;
      // 两块在同一帧里切显隐，浏览器不会渲染出中间态
      back.classList.add('show');
      vids[front].classList.remove('show');
      front = 1 - front;
      ping('anim.ok', name);
      // 第一个有画面的动作到位后就量一次轮廓（待机最好，但别的动作也是同一只宠物）
      setTimeout(probeContentBox, 350);
    } catch (e) {
      // 素材缺失就退回待机，不要把窗口搞成空白
      ping('anim.fail', String(e?.message || e));
      if (name !== '待机呼吸休闲') playAnim('待机呼吸休闲', true);
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

  function hourBucket() {
    const h = new Date().getHours();
    if (h >= 5 && h < 11) return 'morning';
    if (h >= 11 && h < 14) return 'noon';
    if (h >= 22 || h < 5) return 'night';
    return '';
  }

  /** 从数组里随便挑一个 */
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

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
   */
  function say(text, ms = 8000, emojiKey = '') {
    if (!text) return;
    // 菜单或面板开着的时候不弹气泡：两者都往上长，会叠在一起互相盖住
    if (!menu.hidden || (typeof panelKind === 'string' && panelKind)) {
      ping('say.suppressed', String(text).slice(0, 20));
      return;
    }
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
  async function askHostSpeak(force = false) {
    try {
      const res = await api('/pet-brain/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(force ? { force: true } : {}),
      });
      if (res?.action !== 'speak' || !res?.text) return null;
      return res;
    } catch (e) {
      ping('speak.fail', String(e?.message || e));
      return null;
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
    const wait = delayMs || 90_000 + Math.random() * 150_000;
    setTimeout(async () => {
      const busy = dragging || panelKind || !bubble.hidden || menu.hidden === false;
      if (!quiet && !busy && state) {
        const res = await askHostSpeak(false);
        if (res?.text) {
          say(res.text, 9000, res.emoji || '');
          if (res.actions?.length) playAnim(res.actions[Math.floor(Math.random() * res.actions.length)], false);
          ping('speak.ok', `${res.reason}/${res.tone} ${res.text.slice(0, 24)}`);
        } else {
          ping('speak.skip', res?.reason || 'silent');
        }
        scheduleChatter(res?.intervalMs);
      } else {
        scheduleChatter();
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

  window.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    const click = dragging.moved < 6 && Date.now() - dragging.t0 < 350;
    const vel = estimateVelocity();
    window.petDesk.drag('end', e.screenX, e.screenY, vel.vx, vel.vy);
    dragging = null;
    velSamples = [];
    // 落地/松手后回到待机动作（抛掷的话主进程会另外通知落地）
    if (click) onTap();
    else if (Math.hypot(vel.vx, vel.vy) < 140) playAnim('待机呼吸休闲', true);
  });

  /** 最近一次落地撞击强度（探针用来验证物理真的跑起来了） */
  let lastLand = null;

  /** 上一次看到的工作状态，用来判断"是不是刚忙完" */
  let lastWorkStatus = 'idle';

  /** 上次换情绪动作的时间，避免每轮轮询都抽搐 */
  let lastActionSwap = 0;

  /** 落地压扁：主进程物理算出撞击强度后回调这里 */
  window.petDesk.onLand?.((info) => {
    lastLand = info?.impact ?? 0;
    pet.classList.remove('squash');
    // 强制回流一次，保证连续落地能重放动画
    void pet.offsetWidth;
    pet.classList.add('squash');
    ping('land', 'impact=' + (info?.impact ?? 0));
  });

  // ---- 交互 -------------------------------------------------------------
  function onTap() {
    menu.hidden = true;
    // 先给一句本地短句，点了立刻有反应（模型要两秒多，等着会以为没点中）
    say(withEmoji(pick(BAND_LINES[bandId()] || BAND_LINES.unknown)));
    playAnim(actionOf(state), false);
    // 再让宿主按共享大脑的调子重新说一句，来了就替换掉。
    // 这里不再跟着换动作 —— 上面已经动过一次，模型回来再换就是同一次点击换两回，看着闪。
    askHostSpeak(true).then((res) => {
      if (!res?.text) return;
      say(res.text, 9000, res.emoji || '');
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
    say('嘿嘿，别挠了');
    playAnim(cfg?.animations?.click?.[0] || '点击回应-开心跃动', false);
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

  function buildMenu() {
    const items = [
      ['💬 聊两句', () => openPanel('chat')],
      ['📊 看看心情', () => openPanel('mood')],
      ['💰 看看余额', () => openPanel('usage')],
      ['🎬 换个动作', () => openPanel('actions')],
      [quiet ? '🔊 多说点' : '🔇 安静点', () => toggleQuiet()],
      null,
      ['✕ 关掉桌面助手', () => closeByUser()],
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
    calm: '平静',
    sweet: '甜',
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

  function toggleQuiet() {    quiet = !quiet;
    localStorage.setItem('pet-desk:quiet', quiet ? '1' : '0');
    say(quiet ? '好，那我少说点' : '行，那我多说点');
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
    ['吃喝', ['eat']],
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
        if (Array.isArray(v)) names.push(...v);
        else names.push(v);
      }
      if (!names.length) continue;
      box.appendChild(el('div', 'act-group', label));
      for (const name of names) {
        const btn = el('button', 'act', name);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          playAnim(name, false);
          ping('act', name);
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
    panelKind = kind;
    panel.hidden = false;
    panelName.textContent =
      kind === 'chat' ? '聊天' : kind === 'usage' ? 'DeepSeek 余额' : kind === 'actions' ? '换个动作' : '心情';
    logEl.hidden = kind !== 'chat';
    rowEl.hidden = kind !== 'chat';
    infoEl.hidden = kind === 'chat' || kind === 'actions';
    $('actions').hidden = kind !== 'actions';
    syncGrow();
    if (kind === 'chat') {
      renderChat();
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

  /* ---- 聊天 ---- */
  /** 显示用的气泡记录 */
  const chatLog = [];
  /** 发给模型的历史，只留最近 8 条，避免上下文越滚越长 */
  const chatHistory = [];
  let sending = false;

  function renderChat() {
    logEl.textContent = '';
    if (!chatLog.length) logEl.appendChild(el('div', 'msg pet', '在的，说吧。'));
    for (const m of chatLog) logEl.appendChild(el('div', 'msg ' + m.role, m.text));
    if (sending) logEl.appendChild(el('div', 'msg typing', '…'));
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function sendChat() {
    const text = inputEl.value.trim();
    if (!text || sending) return;
    inputEl.value = '';
    chatLog.push({ role: 'me', text });
    sending = true;
    renderChat();
    try {
      const res = await api('/pet-brain/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, history: chatHistory.slice(-8) }),
      });
      const reply = res?.reply || '……';
      chatLog.push({ role: 'pet', text: reply });
      chatHistory.push({ role: 'user', text }, { role: 'assistant', text: reply });
      if (res?.mood) state = { ...state, mood: res.mood };
      paintBadge();
      playAnim(res?.action || actionOf(state), false);
      ping('chat.ok', reply.slice(0, 40));
    } catch (e) {
      chatLog.push({ role: 'pet', text: '连不上宿主，等会儿再试。' });
      ping('chat.fail', String(e?.message || e));
    } finally {
      sending = false;
      renderChat();
      inputEl.focus();
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
    big.appendChild(el('b', null, String(Math.round(m.mood))));
    big.appendChild(el('span', 'pill', m.band?.label || '—'));
    infoEl.appendChild(big);
    const dims = m.dims || {};
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
    if (!m) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    badge.textContent = `${m.mood} · ${m.band?.label || '—'}`;
  }

  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panelKind === 'mood') closePanel();
    else openPanel('mood');
  });

  // ---- 主循环 -----------------------------------------------------------
  async function poll() {
    try {
      state = await api('/pet-brain/state');
      if (!polledOnce) {
        polledOnce = true;
        ping('state.ok', `mood=${state?.mood?.mood ?? '?'} actions=${state?.actions?.length ?? 0}`);
      }
      paintBadge();
      if (panelKind === 'mood') renderMood();

      // 工作状态：老大在忙就安静干活，干完了冒一句
      const w = state?.work;
      if (w && w.status !== lastWorkStatus) {
        if (w.status === 'running' && w.action) {
          playAnim(w.action, true);
          ping('work.running', w.action);
        } else if (lastWorkStatus === 'running') {
          playAnim('待机呼吸休闲', true);
          ping('work.idle', 'turns=' + (w.turns ?? 0));
          if (!quiet && !panelKind && bubble.hidden) say('这轮干完啦，歇会儿？');
        }
        lastWorkStatus = w.status;
      }
      // 情绪动作：闲时才换，而且别换太勤（每 2 秒轮询一次，换太勤看着抽搐）
      // 老大在忙的时候不插播情绪动作 —— 专心干活，别打扰。
      if (!dragging && lastWorkStatus !== 'running' && state?.actions?.length) {
        const now = Date.now();
        if (now - lastActionSwap > 14000) {
          lastActionSwap = now;
          const pool = state.actions;
          playAnim(pool[Math.floor(Math.random() * pool.length)], true);
        }
      }
    } catch (e) {
      if (!polledOnce) ping('state.fail', String(e?.message || e));
    }
  }

  async function boot() {
    ping('boot');
    try {
      const env = await window.petDesk.env();
      if (env?.host) HOST = env.host;
      ping('env', HOST);
    } catch (e) {
      /* preload 不可用时退回 URL 参数 */
      ping('env.fail', String(e?.message || e));
    }
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
    setInterval(poll, 2000);
    applyScale();
    window.petDesk.resize(PET_SIZE);
    scheduleChatter();
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
      await clickItem('安静');
      out.push('quiet=' + quiet);
      await clickItem('安静');
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
        say(res.text, 9000, res.emoji || '');
        out.push('bubble=' + (bubble.hidden ? 'hidden' : 'shown'));
        out.push('emojiImg=' + bubble.querySelectorAll('img.emoji').length);
      }
      return out.join(' | ');
    },

    /**
     * 抛掷物理自检：合成一串指针事件快速拖动再松手，
     * 看主进程有没有真的把窗口甩出去、落地有没有回弹通知。
     */
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
