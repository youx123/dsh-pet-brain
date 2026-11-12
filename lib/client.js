/**
 * dsh-pet-brain —— 浏览器半侧
 *
 * 挂在 shell.overlay 上，自己渲染身体（<video> 播 VP9-alpha 的 webm），
 * 数据全部来自宿主 /pet-brain/{config,state,chat}。
 *
 * 与 dsh-pet 的区别：这里的"动作"不是随机抽的，而是被共享大脑的心情档位驱动的；
 * 聊天也不是拿一段静态人设去问，而是宿主每轮现场拼 system prompt（人设+心情+召回记忆）。
 */
function makeFactory() {
  return (require) => {
    const react = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = react;
    /**
     * 注意：这里必须用 createElement 而不是 react/jsx-runtime 的 jsx()。
     * jsx(type, props, key) 的第三个参数是 key，不是 children —— 用它带 children
     * 会导致整棵子树静默丢失（渲染出一个空 div，DOM 里连 <video> 都没有）。
     */
    const h = react.createElement;
    /*
     * 把桌宠挂到 document.body 下，而不是留在 shell.overlay 的 slot 容器里。
     * 原因：宿主那个容器带 visibility:hidden / overflow / transform，只要切一次视图桌宠就整棵子树
     * 被继承隐藏；更阴的是祖先一旦有 transform，子元素的 position:fixed 就不再相对视口，
     * 变成相对那个祖先定位 —— 位置直接跑偏。
     * 拿不到 react-dom 就退回原地渲染，不至于整只桌宠不出来。
     */
    let createPortal = null;
    try {
      createPortal = require('react-dom')?.createPortal ?? null;
    } catch {
      createPortal = null;
    }
    const module = { exports: {} };

    const NS = 'dsh-pet-brain';
    const name = 'pet-brain';
    const inject = ['slots'];

    /** 自证通道：把「浏览器这边走到哪一步了」回传给宿主，排障时 curl /pet-brain/state 就能看 */
    const ping = (stage, detail) => {
      try {
        fetch('/pet-brain/ping', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage, detail: detail == null ? '' : String(detail) }),
        }).catch(() => {});
      } catch {
        /* 排障通道本身不许抛 */
      }
    };

    ping('bundle', typeof window + '/' + String(window?.location?.pathname ?? ''));
    // 拿不到 react-dom 就得退回原地渲染，那时候会被祖先的层叠上下文/隐藏样式困住 —— 这条能一眼看出来
    ping('portal', typeof createPortal === 'function' ? 'ok' : 'missing');
    try {
      window.addEventListener('error', (e) => ping('window.error', e?.message || String(e?.error ?? e)));
      window.addEventListener('unhandledrejection', (e) => ping('window.reject', String(e?.reason ?? e)));
    } catch {
      /* 非浏览器环境跑单元测试时会走到这里 */
    }

    /** 拖拽/点击判定的阈值 */
    const CLICK_MOVE_PX = 6;
    const CLICK_MS = 350;
    /**
     * 动画 blob 缓存上限（2026-11-12 桌宠审计 中低 E）。
     * 52 个 webm 素材全加载一遍约 24MB；以前这个缓存只进不出，
     * 一直挂着。超过上限就踢掉最老的并 revokeObjectURL。
     * 与桌面版 renderer.js 的 BLOB_CACHE_MAX 保持一致。
     */
    const BLOB_CACHE_MAX = 24;
    /** 抛掷物理 */
    const GRAVITY = 2200;
    const RESTITUTION = 0.55;
    const WALL = 12;
    /**
     * 贴边时允许探出窗口的比例（0.35 = 最多三分之一个身子在窗口外）。
     * 注意：这不会真的让元素画到 Electron 窗口之外——那是窗口的裁剪范围，
     * 插件侧改不了。这里做的是「允许坐标越界」，拖回来就复原，
     * 视觉上就是贴着窗口边探出去一点。
     */
    const EDGE_OUT = 0.35;

    const S = {
      wrap: {
        position: 'fixed',
        zIndex: 2147480000,
        /*
         * visibility / opacity 必须显式写死。
         * shell.overlay 的祖先里有一层是 visibility:hidden（切换视图时会被设上），
         * 子元素不显式声明就会继承下来 —— 元素几何、video 全都正常，
         * 但人眼就是看不见。桌宠"消失"过好几次都是这个原因。
         */
        visibility: 'visible',
        opacity: 1,
        pointerEvents: 'auto',
        userSelect: 'none',
        touchAction: 'none',
        cursor: 'grab',
        willChange: 'left, top',
      },
      wrapDrag: { cursor: 'grabbing' },
      video: { display: 'block', width: '100%', height: '100%', pointerEvents: 'none' },
      /*
       * 配色统一走浅色卡片：跟旧挂件（dsh-whale-widget）一个路子。
       * 深色玻璃在深色界面上糊成一片，数字和字都跳不出来 —— 老大说丑就是这个原因。
       */
      badge: {
        position: 'absolute',
        left: '50%',
        bottom: -20,
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 999,
        background: 'rgba(255,255,255,.94)',
        border: '1px solid rgba(32,49,112,.14)',
        color: '#2b3a63',
        fontSize: 10.5,
        lineHeight: '15px',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        pointerEvents: 'auto',
        cursor: 'pointer',
        boxShadow: '0 3px 10px rgba(20,34,80,.16)',
      },
      /** 卡片统一底板：白底 + 深蓝字 + 柔和投影，跟旧挂件的菜单/泡泡一致 */
      card: {
        boxSizing: 'border-box',
        background: 'rgba(255,255,255,.97)',
        border: '1px solid rgba(32,49,112,.14)',
        borderRadius: 14,
        boxShadow: '0 14px 36px rgba(20,34,80,.2), 0 2px 6px rgba(20,34,80,.1)',
        color: '#2b3a63',
        cursor: 'default',
      },
      /** 右键菜单：贴在角色上方 */
      menu: {
        position: 'absolute',
        right: 0,
        bottom: '100%',
        marginBottom: 12,
        minWidth: 158,
        padding: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        zIndex: 2,
      },
      menuItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '8px 10px',
        borderRadius: 9,
        border: 'none',
        background: 'transparent',
        color: '#2b3a63',
        fontSize: 12.5,
        fontWeight: 500,
        textAlign: 'left',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      menuSep: { height: 1, background: 'rgba(32,49,112,.12)', margin: '4px 6px' },
      /** 面板小标题 */
      cardTitle: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 11.5,
        letterSpacing: '.06em',
        color: '#8b99bb',
        marginBottom: 2,
      },
      /** 心情大数字 */
      score: { display: 'flex', alignItems: 'baseline', gap: 7 },
      scoreNum: { fontSize: 30, fontWeight: 800, lineHeight: 1, color: '#2b3a63', letterSpacing: '-.02em' },
      scoreUnit: { fontSize: 11, color: '#8b99bb', fontWeight: 500 },
      scoreBand: {
        fontSize: 11.5,
        fontWeight: 700,
        color: '#3d5bd9',
        background: 'rgba(61,91,217,.1)',
        borderRadius: 999,
        padding: '2px 9px',
      },
      dimRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#4a5a80' },
      dimName: { width: 32, flexShrink: 0, fontWeight: 500 },
      dimTrack: {
        flex: 1,
        height: 6,
        borderRadius: 999,
        background: 'rgba(32,49,112,.1)',
        overflow: 'hidden',
      },
      dimFill: { height: '100%', borderRadius: 999, background: 'linear-gradient(90deg,#4c7bff,#8a6bff)' },
      dimVal: { width: 18, textAlign: 'right', flexShrink: 0, color: '#8b99bb', fontVariantNumeric: 'tabular-nums' },
      /** 统计行：左边灰字，右边深色数字 */
      statRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
      statKey: { fontSize: 11.5, color: '#8b99bb' },
      statVal: { fontSize: 13, fontWeight: 600, color: '#2b3a63', fontVariantNumeric: 'tabular-nums' },
      /** 说话气泡：白底圆角 + 尾巴，字用旧挂件那支深蓝 #3d4f7d */
      bubbleBox: {
        position: 'relative',
        maxWidth: 244,
        minWidth: 56,
        padding: '10px 14px',
        borderRadius: 16,
        background: 'rgba(255,255,255,.98)',
        border: '1px solid rgba(32,49,112,.13)',
        color: '#3d4f7d',
        fontSize: 13,
        fontWeight: 500,
        lineHeight: 1.62,
        boxShadow: '0 12px 30px rgba(20,34,80,.2), 0 2px 6px rgba(20,34,80,.1)',
        wordBreak: 'break-word',
        pointerEvents: 'none',
        animation: 'dsh-pet-brain-pop .16s cubic-bezier(.2,1.4,.4,1)',
      },
      bubbleTail: {
        position: 'absolute',
        left: '50%',
        bottom: -5,
        width: 10,
        height: 10,
        marginLeft: -5,
        background: 'rgba(255,255,255,.98)',
        borderRight: '1px solid rgba(32,49,112,.13)',
        borderBottom: '1px solid rgba(32,49,112,.13)',
        transform: 'rotate(45deg)',
        borderRadius: 2,
        pointerEvents: 'none',
      },
      bubbleWrap: {
        position: 'absolute',
        left: '50%',
        bottom: '100%',
        transform: 'translate(-50%, -14px)',
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 3,
      },
      panel: {
        position: 'absolute',
        left: '50%',
        bottom: '100%',
        transform: 'translate(-50%, -14px)',
        width: 322,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        zIndex: 4,
        animation: 'dsh-pet-brain-pop .16s cubic-bezier(.2,1.4,.4,1)',
      },
      panelTitle: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 11.5,
        letterSpacing: '.05em',
        color: '#8b99bb',
      },
      log: {
        maxHeight: 210,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingRight: 2,
      },
      msgUser: {
        alignSelf: 'flex-end',
        background: 'linear-gradient(180deg,#4f7dff,#3f68e0)',
        color: '#fff',
        borderRadius: '14px 14px 4px 14px',
        padding: '7px 11px',
        maxWidth: '84%',
        fontSize: 13,
        lineHeight: 1.55,
        wordBreak: 'break-word',
        boxShadow: '0 3px 10px rgba(63,104,224,.28)',
      },
      msgPet: {
        alignSelf: 'flex-start',
        background: '#f2f5fd',
        border: '1px solid rgba(32,49,112,.08)',
        color: '#2b3a63',
        borderRadius: '14px 14px 14px 4px',
        padding: '7px 11px',
        maxWidth: '84%',
        fontSize: 13,
        lineHeight: 1.55,
        wordBreak: 'break-word',
      },
      msgWho: { fontSize: 10.5, color: '#8b99bb', marginBottom: 3, marginLeft: 2 },
      row: { display: 'flex', gap: 7, alignItems: 'center' },
      input: {
        flex: 1,
        minWidth: 0,
        background: '#f6f8fe',
        border: '1px solid rgba(32,49,112,.14)',
        borderRadius: 11,
        color: '#2b3a63',
        padding: '9px 11px',
        fontSize: 13,
        outline: 'none',
      },
      btn: {
        border: 'none',
        borderRadius: 10,
        background: '#4d7cff',
        color: '#fff',
        padding: '8px 13px',
        fontSize: 12.5,
        fontWeight: 600,
        cursor: 'pointer',
        boxShadow: '0 3px 10px rgba(77,124,255,.3)',
      },
      hint: { opacity: 0.6, fontSize: 11.5, textAlign: 'center', color: '#8b99bb', padding: '6px 0' },
    };

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    /** 主动说话的本地语料：按心情档位分组，不调用模型，零成本 */
    const BAND_LINES = {
      delighted: ['今天心情好到冒泡 🐟', '嘿嘿，现在状态特别好', '想干点什么，趁现在'],
      happy: ['这会儿挺舒服的', '在呢，有事喊我', '要不要一起干点活'],
      ok: ['我在这儿蹲着呢', '平稳的一天，也不错', '没事，你忙你的'],
      heartache: ['有点提不起劲…', '今天有点闷', '想趴一会儿'],
      sad: ['不太开心…', '有点难过', '算了，不说了'],
      unknown: ['在这儿呢', '嗯？', '我在'],
    };

    const NIGHT_LINES = ['这么晚还没睡？', '夜深了，别熬太狠', '困了就早点休息'];
    const MORNING_LINES = ['早，新的一天', '醒了？', '早上好'];
    const NOON_LINES = ['吃过饭没', '中午了，歇会儿吧'];

    /** 桌面上说的话：长数字串（账号/手机号）一律不引用 */
    function safeMemoryText(text) {
      const t = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!t || /\d{5,}/.test(t)) return '';
      return t;
    }

    /** 拼一句适合现在说的话；返回空串表示这次不说 */
    function idleLine(mood, recent, name) {
      const hour = new Date().getHours();
      const roll = Math.random();
      // 三成概率引用一条最近记住的事 —— 这是"智能感"最直接的来源
      if (roll < 0.3 && Array.isArray(recent) && recent.length > 0) {
        const text = safeMemoryText(pick(recent)?.text);
        if (text.length >= 4) {
          const cut = text.length > 26 ? `${text.slice(0, 26)}…` : text;
          return `我还记着：${cut}`;
        }
      }
      if (roll < 0.42) {
        if (hour >= 0 && hour < 5) return pick(NIGHT_LINES);
        if (hour >= 6 && hour < 10) return pick(MORNING_LINES);
        if (hour >= 11 && hour < 14) return pick(NOON_LINES);
      }
      const band = mood?.band?.id ?? 'unknown';
      const pool = BAND_LINES[band] ?? BAND_LINES.unknown;
      return pick(pool);
    }

    function Pet() {
      const [cfg, setCfg] = useState(null);
      // 初始就摆在右下角：不能等 config 回来才定位，否则 config 一失败桌宠就永远在屏幕外看不见
      const [pos, setPos] = useState(() => ({
        x: Math.max(200, (window.innerWidth || 1280) - 190),
        y: Math.max(160, (window.innerHeight || 800) - 130),
      }));
      const [dragging, setDragging] = useState(false);
      const [anim, setAnim] = useState('待机呼吸休闲');
      const [loop, setLoop] = useState(true);
      const [videoUrl, setVideoUrl] = useState('');
      const [mood, setMood] = useState(null);
      const [personaName, setPersonaName] = useState('');
      const [bubble, setBubble] = useState('');
      const [bubbleAt, setBubbleAt] = useState(0);
      const [chatOpen, setChatOpen] = useState(false);
      const [log, setLog] = useState([]);
      const [draft, setDraft] = useState('');
      const [busy, setBusy] = useState(false);
      /** 右键菜单 / 心情详情面板 / 主动说话开关 / 最近记忆 */
      const [menuOpen, setMenuOpen] = useState(false);
      const [showDims, setShowDims] = useState(false);
      const [recent, setRecent] = useState([]);
      /** 共享大脑里的说话风格（自称/口头禅/默认表情），本地拼句也跟着它走 */
      const [voice, setVoice] = useState(null);
      const [quiet, setQuiet] = useState(() => {
        try {
          return window.localStorage.getItem('pet-brain:quiet') === '1';
        } catch {
          return false;
        }
      });
      const [scale, setScale] = useState(() => {
        try {
          const v = Number(window.localStorage.getItem('pet-brain:scale'));
          return Number.isFinite(v) && v >= 180 && v <= 520 ? v : 320;
        } catch {
          return 320;
        }
      });
      /** 余额与用量（来自宿主 /pet-brain/usage，60s 缓存） */
      const [usage, setUsage] = useState(null);
      const [showUsage, setShowUsage] = useState(false);
      const usageBusy = useRef(false);
      /**
       * 桌面助手（独立 Electron 窗口，飘在操作系统桌面上）是否在跑。
       * 它在跑的时候客户端里这个就不画了 —— 同一只宠物摆两份纯属添乱。
       * 想用回客户端内版本，右键菜单「关掉桌面助手」就行。
       */
      const [deskAlive, setDeskAlive] = useState(false);
      /**
       * 桌面助手是否在跑（给"自检探针"用）。探针每 8 秒跑一次，
       * 桌面助手活着时客户端这只本来就不画，元素当然是 null ——
       * 之前这里会被当成"桌宠丢了"，每 8 秒往宿主的 ping 环里灌一条
       * rect.missing，把桌面助手真正的证据挤出去。所以先立个门槛。
       */
      const deskActiveRef = useRef(false);

      const blobCache = useRef(new Map());
      /** 冒个泡（气泡 12s 自动消失）。定义得早，轮询/主动说话/菜单都要用 */
      const say = useCallback((text) => {
        if (!text) return;
        setBubble(text);
        // 换 key 让入场动画重播：同一句话再冒一次也能再弹一下
        setBubbleAt(Date.now());
      }, []);
      const videoRef = useRef(null);
      const wrapRef = useRef(null);
      const inputRef = useRef(null);
      /** 物理循环跑在 rAF 里，读 state 会拿到旧闭包，所以位置另存一份 ref */
      const posRef = useRef({ x: pos.x, y: pos.y });
      const moveTo = useCallback((x, y) => {
        posRef.current = { x, y };
        setPos({ x, y });
      }, []);
      /** 拖拽/物理：用 ref 存，避免每帧 setState 引起重渲染 */
      const drag = useRef({ active: false, dx: 0, dy: 0, x0: 0, y0: 0, t0: 0, moved: 0 });
      const phys = useRef({ vx: 0, vy: 0, raf: 0 });
      const animRef = useRef({ name: '待机呼吸休闲' });
      const moodBandRef = useRef('');
      const lastBandSayRef = useRef(0);
      /** 当前心情可用的动作池（宿主按七维算出来，见 lib/index.js 的 actionPool） */
      const moodPoolRef = useRef([]);

      // ---- 动画加载 ---------------------------------------------------------
      const playAnim = useCallback(
        async (animName, opts = {}) => {
          if (!animName) return;
          const wantLoop = opts.loop !== false;
          animRef.current = { name: animName, loop: wantLoop };
          setLoop(wantLoop);
          const cache = blobCache.current;
          let url = cache.get(animName);
          if (!url) {
            try {
              const res = await fetch(`/pet-brain/anim/${encodeURIComponent(animName)}.webm`);
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              url = URL.createObjectURL(await res.blob());
              cache.set(animName, url);
              // 2026-11-12（桌宠审计 中低 E）：以前这个缓存只进不出，
              // 52 个动画全加载一遍就是 ~24MB 的 blob 一直挂在内存里。
              // 现在超过上限就把最老的踢掉，并且 revokeObjectURL 真回收。
              if (cache.size > BLOB_CACHE_MAX) {
                const oldest = cache.keys().next().value;
                if (oldest && oldest !== animName) {
                  const stale = cache.get(oldest);
                  cache.delete(oldest);
                  if (stale) {
                    try { URL.revokeObjectURL(stale); } catch (e) { /* 忽略 */ }
                  }
                }
              }
            } catch (e) {
              console.warn('[dsh-pet-brain] 动画加载失败', animName, e);
              ping('anim.fail', `${animName} :: ${e?.message ?? e}`);
              return;
            }
          }
          setAnim(animName);
          setVideoUrl(url);
          ping('anim.ok', animName);
        },
        [],
      );

      const backToIdle = useCallback(() => {
        if (cfg) playAnim(cfg.animations.idle, { loop: true });
      }, [cfg, playAnim]);

      // ---- 初始化：拉配置 + 定位 --------------------------------------------
      useEffect(() => {
        let alive = true;
        let rectTimer = 0;
        ping('mount.v2');
        fetch('/pet-brain/config')
          .then((r) => r.json())
          .then((data) => {
            if (!alive || !data?.ok) {
              ping('config.bad', JSON.stringify(data)?.slice(0, 300));
              return;
            }
            ping('config.ok');
            setCfg(data);
            const home = {
              x: Math.max(180, window.innerWidth - 230),
              y: Math.max(240, window.innerHeight - 210),
            };
            posRef.current = home;
            setPos(home);
            const probeRect = () => {
              try {
                // 桌面助手在画，客户端这只本来就不存在 —— 不是"丢了"，别报
                if (deskActiveRef.current) return;
                const el = wrapRef.current;
                if (!el) {
                  ping('rect.missing');
                  return;
                }
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                // 视口中心那个点到底命中的是谁 —— 被别的层盖住时这里不会是 DIV
                const cx = Math.round(r.x + r.width / 2);
                const cy = Math.round(r.y + r.height / 2);
                const hit = document.elementFromPoint(cx, cy);
                ping(
                  'rect',
                  JSON.stringify({
                    x: Math.round(r.x),
                    y: Math.round(r.y),
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                    display: cs.display,
                    visibility: cs.visibility,
                    opacity: cs.opacity,
                    position: cs.position,
                    zIndex: cs.zIndex,
                    parent: el.parentElement?.tagName ?? '',
                    portaled: el.parentElement === document.body,
                    hit: hit ? `${hit.tagName}.${hit.className || '-'}`.slice(0, 40) : null,
                    // 命中的是不是自己 —— 被别的浮层盖住时这里是 false，肉眼看到的就是"没出现"
                    hitSelf: hit ? hit === el || el.contains(hit) : false,
                    parentRect: (() => {
                      const pr = el.parentElement?.getBoundingClientRect();
                      return pr ? [Math.round(pr.width), Math.round(pr.height)] : null;
                    })(),
                    inner: [window.innerWidth, window.innerHeight],
                    videos: document.querySelectorAll('video').length,
                    vSrc: (videoRef.current?.currentSrc ?? '').slice(0, 24),
                    vReady: videoRef.current?.readyState ?? -1,
                    vNet: videoRef.current?.networkState ?? -1,
                    inDoc: document.body.contains(el),
                    ancestors: (() => {
                      const out = [];
                      let n = el.parentElement;
                      let d = 0;
                      while (n && d < 6) {
                        const c = getComputedStyle(n);
                        out.push(
                          `${n.tagName}.${c.overflow}/${c.transform === 'none' ? '-' : 'T'}/${c.display}`,
                        );
                        n = n.parentElement;
                        d++;
                      }
                      return out;
                    })(),
                  }),
                );
              } catch (e) {
                ping('rect.error', String(e?.message ?? e));
              }
            };
            setTimeout(probeRect, 700);
            // 持续自检：桌宠"看着没了"的时候，直接看最近一次上报就知道是被藏了还是被盖了
            rectTimer = setInterval(probeRect, 8000);
          })
          .catch((e) => console.warn('[dsh-pet-brain] 配置拉取失败', e));
        return () => {
          alive = false;
          clearInterval(rectTimer);
        };
      }, []);

      useEffect(() => {
        if (cfg) playAnim(cfg.animations.idle, { loop: true });
      }, [cfg, playAnim]);

      // ---- 心情轮询：档位变化才换动作，避免打断正在播的小动作 ---------------
      useEffect(() => {
        if (!cfg) return undefined;
        let alive = true;
        const tick = async () => {
          try {
            const res = await fetch('/pet-brain/state');
            const data = await res.json();
            if (!alive || !data?.ok) return;
            setMood(data.mood);
            setPersonaName(data.persona?.name ?? '');
            if (Array.isArray(data.recent)) setRecent(data.recent);
            if (data.voice) setVoice(data.voice);
            // 宿主会给一池「按当前心情挑出来的动作」，每轮都能换，不再钉死一个
            const pool = Array.isArray(data.actions) && data.actions.length > 0 ? data.actions : [];
            if (pool.length > 0) moodPoolRef.current = pool;
            const band = data.mood?.band?.id ?? '';
            if (band !== '' && band !== moodBandRef.current) {
              const prev = moodBandRef.current;
              moodBandRef.current = band;
              // 只在待机时被心情驱动；正在播别的动作就等它播完
              if (animRef.current.name === cfg.animations.idle) {
                playAnim(pool.length > 0 ? pick(pool) : data.action || cfg.animations.idle, { loop: false });
              }
              // 心情换档时说一句（首次只做初始化，不吭声；10 分钟内不重复唠叨）
              if (prev !== '' && !quiet && Date.now() - lastBandSayRef.current > 600_000) {
                lastBandSayRef.current = Date.now();
                const line = pick(BAND_LINES[band] ?? BAND_LINES.unknown);
                if (line) say(line);
              }
            }
          } catch {
            /* 宿主重启期间静默 */
          }
        };
        void tick();
        const timer = setInterval(tick, cfg.pollMs ?? 2000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [cfg, playAnim, quiet, say]);

      // ---- 闲置小动作：心情好才频繁，心情差就老实待着 ------------------------
      useEffect(() => {
        if (!cfg) return undefined;
        let timer = 0;
        const schedule = () => {
          const m = mood?.mood ?? 60;
          const base = m >= 72 ? 14_000 : m >= 55 ? 22_000 : 34_000;
          const wait = base + Math.random() * 14_000;
          timer = setTimeout(() => {
            if (!drag.current.active && animRef.current.name === cfg.animations.idle) {
              // 七成按共享大脑给的心情池演（会换着来），三成走通用小动作
              const moodPool = moodPoolRef.current;
              let name = '';
              if (moodPool.length > 0 && Math.random() < 0.7) {
                name = pick(moodPool);
              } else {
                const pool = [...(cfg.animations.small ?? [])];
                if (Math.random() < 0.12 && cfg.animations.eat) {
                  const eats = Array.isArray(cfg.animations.eat) ? cfg.animations.eat : [cfg.animations.eat];
                  pool.push(...eats);
                }
                name = pool.length > 0 ? pick(pool) : '';
              }
              if (name) playAnim(name, { loop: false });
            }
            schedule();
          }, wait);
        };
        schedule();
        return () => clearTimeout(timer);
      }, [cfg, mood, playAnim]);

      // ---- 主动说话：心情 + 时段 + 记忆，本地拼句，不花 LLM -------------------
      useEffect(() => {
        if (!cfg || quiet) return undefined;
        let timer = 0;
        const schedule = () => {
          const wait = 70_000 + Math.random() * 150_000;
          timer = setTimeout(() => {
            // 正在被拖、聊天面板开着、或者已经有气泡，就不打扰
            if (!drag.current.active && !chatOpen && bubble === '') {
              let line = idleLine(mood, recent, personaName);
              // 共享大脑里设的默认表情贴句尾，本地拼句也跟它保持一致
              if (line && voice?.emoji && !line.includes(voice.emoji)) line += voice.emoji;
              if (line) {
                say(line);
                // 说话配个小动作，别干站着
                if (animRef.current.name === cfg.animations.idle) {
                  const pool = cfg.animations.small ?? [];
                  if (pool.length > 0 && Math.random() < 0.6) playAnim(pick(pool), { loop: false });
                }
              }
            }
            schedule();
          }, wait);
        };
        schedule();
        return () => clearTimeout(timer);
      }, [cfg, quiet, chatOpen, bubble, mood, recent, personaName, voice, say, playAnim]);

      // ---- 物理 --------------------------------------------------------------
      const stopPhys = () => {
        if (phys.current.raf) cancelAnimationFrame(phys.current.raf);
        phys.current.raf = 0;
      };

      const step = useCallback(() => {
        const p = phys.current;
        if (!p.raf) return;
        const now = performance.now();
        const last = p.last ?? now;
        const dt = Math.min(0.05, (now - last) / 1000);
        p.last = now;
        p.vy += GRAVITY * dt;
        let nextX = posRef.current.x + p.vx * dt;
        let nextY = posRef.current.y + p.vy * dt;
        const maxX = window.innerWidth - WALL;
        const maxY = window.innerHeight - WALL;
        if (nextX < WALL) {
          nextX = WALL;
          p.vx = Math.abs(p.vx) * RESTITUTION;
        } else if (nextX > maxX) {
          nextX = maxX;
          p.vx = -Math.abs(p.vx) * RESTITUTION;
        }
        if (nextY < WALL) {
          nextY = WALL;
          p.vy = Math.abs(p.vy) * RESTITUTION;
        } else if (nextY > maxY) {
          nextY = maxY;
          p.vy = -Math.abs(p.vy) * RESTITUTION;
          p.vx *= 0.86;
          if (Math.abs(p.vy) < 40) p.vy = 0;
          if (Math.abs(p.vx) < 6) p.vx = 0;
        }
        posRef.current = { x: nextX, y: nextY };
        setPos({ x: nextX, y: nextY });
        if (Math.abs(p.vx) < 2 && Math.abs(p.vy) < 30 && nextY >= maxY - 1) {
          stopPhys();
          if (animRef.current.name === (cfg?.animations.drag ?? '')) backToIdle();
          return;
        }
        p.raf = requestAnimationFrame(step);
      }, [cfg, backToIdle]);

      const startPhys = useCallback(
        (vx, vy) => {
          stopPhys();
          // raf 先占位成非 0（step 用它判断"还在跑"），拿到真 id 后覆盖
          phys.current = { vx, vy, raf: 1, last: performance.now() };
          phys.current.raf = requestAnimationFrame(step);
        },
        [step],
      );

      // ---- 指针交互 ----------------------------------------------------------
      const onPointerDown = useCallback(
        (e) => {
          if (e.button !== 0) return;
          stopPhys();
          drag.current = {
            active: true,
            dx: e.clientX - pos.x,
            dy: e.clientY - pos.y,
            x0: e.clientX,
            y0: e.clientY,
            t0: performance.now(),
            moved: 0,
            lastX: e.clientX,
            lastY: e.clientY,
            lastT: performance.now(),
            vx: 0,
            vy: 0,
          };
          setDragging(true);
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* 部分环境不支持捕获，忽略 */
          }
          if (cfg) playAnim(cfg.animations.drag, { loop: true });
        },
        [pos.x, pos.y, cfg, playAnim, stopPhys],
      );

      const onPointerMove = useCallback((e) => {
        const d = drag.current;
        if (!d.active) return;
        d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.x0, e.clientY - d.y0));
        const now = performance.now();
        const dt = Math.max(1, now - d.lastT) / 1000;
        d.vx = (e.clientX - d.lastX) / dt;
        d.vy = (e.clientY - d.lastY) / dt;
        d.lastX = e.clientX;
        d.lastY = e.clientY;
        d.lastT = now;
        // 允许贴到窗口边缘时探出去一部分（见 EDGE_OUT）：坐标可以越过视口边界，
        // 超出的像素会被 Electron 窗口裁掉，但拖回来立刻复原，不会丢失。
        const outX = (scale / 2) * EDGE_OUT;
        const outY = (scale * 9 / 32) * EDGE_OUT;
        moveTo(
          clamp(e.clientX - d.dx, -outX, window.innerWidth + outX),
          clamp(e.clientY - d.dy, -outY, window.innerHeight + outY),
        );
      }, [moveTo]);

      const onPointerUp = useCallback(
        (e) => {
          const d = drag.current;
          if (!d.active) return;
          d.active = false;
          setDragging(false);
          const dur = performance.now() - d.t0;
          const isClick = d.moved < CLICK_MOVE_PX && dur < CLICK_MS;
          if (isClick) {
            if (cfg) playAnim(pick(cfg.animations.click ?? [cfg.animations.idle]), { loop: false });
            setChatOpen((v) => !v);
            return;
          }
          const vx = clamp(d.vx * 0.55, -2600, 2600);
          const vy = clamp(d.vy * 0.55, -2200, 2200);
          if (Math.abs(vx) > 40 || Math.abs(vy) > 40) {
            startPhys(vx, vy);
            return;
          }
          // 轻轻放下就贴边：靠左吸左、靠右吸右，中间就原地待机。
          // 吸附位置故意比"完全贴住"再往外一点，让它看起来挂在窗口边上（见 EDGE_OUT）。
          const W = window.innerWidth;
          const half = scale / 2;
          const outEdge = half * EDGE_OUT;
          const cur = posRef.current;
          if (cur.x < W / 3) moveTo(half - outEdge, cur.y);
          else if (cur.x > (W * 2) / 3) moveTo(W - half + outEdge, cur.y);
          if (cfg) playAnim(cfg.animations.idle, { loop: true });
        },
        [cfg, playAnim, startPhys, moveTo, scale],
      );

      // ---- 右键菜单 ----------------------------------------------------------
      const onContextMenu = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        setChatOpen(false);
        setMenuOpen((v) => !v);
      }, []);

      /**
       * 点空白处收起菜单。
       * 注意必须用**冒泡**阶段（第三参 false）：capture 阶段会在按钮自己收到
       * pointerdown 之前先把菜单从 DOM 里摘掉，按钮的 onClick 就永远等不到了。
       * 菜单内部的 pointerdown 已 stopPropagation，所以点到菜单不会关。
       */
      useEffect(() => {
        if (!menuOpen) return undefined;
        const close = () => setMenuOpen(false);
        const t = setTimeout(() => document.addEventListener('pointerdown', close, false), 0);
        return () => {
          clearTimeout(t);
          document.removeEventListener('pointerdown', close, false);
        };
      }, [menuOpen]);

      const persist = useCallback((key, value) => {
        try {
          window.localStorage.setItem(`pet-brain:${key}`, String(value));
        } catch {
          /* 无痕模式写不进去，忽略 */
        }
      }, []);

      const toggleQuiet = useCallback(() => {
        setQuiet((v) => {
          persist('quiet', v ? '0' : '1');
          return !v;
        });
      }, [persist]);

      const bumpScale = useCallback(
        (delta) => {
          setScale((v) => {
            const next = clamp(v + delta, 180, 520);
            persist('scale', next);
            return next;
          });
        },
        [persist],
      );

      const randomAction = useCallback(() => {
        if (!cfg) return;
        const pool = [
          ...moodPoolRef.current,
          ...(cfg.animations.small ?? []),
          ...(cfg.animations.click ?? []),
          ...(cfg.animations.whale ?? []),
          ...(cfg.animations.gift ? [cfg.animations.gift] : []),
          ...(cfg.animations.surprise ? [cfg.animations.surprise] : []),
        ];
        if (pool.length > 0) playAnim(pick(pool), { loop: false });
        setMenuOpen(false);
      }, [cfg, playAnim]);

      /** 摸摸头：卖萌动画 + 一句回应 */
      const patHead = useCallback(() => {
        if (cfg) playAnim(pick(cfg.animations.click ?? [cfg.animations.idle]), { loop: false });
        const band = mood?.band?.id ?? 'unknown';
        const replies = {
          delighted: ['嘿嘿嘿 🐟', '再摸一下嘛', '今天特别开心'],
          happy: ['舒服～', '嗯嗯', '摸摸头收下了'],
          ok: ['嗯？', '咋了', '在呢'],
          heartache: ['唉…', '别闹', '让我缓缓'],
          sad: ['别碰…', '让我待会儿', '……'],
          unknown: ['嗯？', '在呢'],
        };
        say(pick(replies[band] ?? replies.unknown));
        setMenuOpen(false);
      }, [cfg, playAnim, mood, say]);

      const recallOne = useCallback(() => {
        const m = Array.isArray(recent) ? pick(recent) : null;
        const text = safeMemoryText(m?.text);
        say(text ? `我记得：${text.length > 40 ? `${text.slice(0, 40)}…` : text}` : '暂时没想起什么');
        setMenuOpen(false);
      }, [recent, say]);

      /** 拉余额/用量。失败就保留上一次的数，UI 显示"—"。 */
      const fetchUsage = useCallback(async (force = false) => {
        if (usageBusy.current) return;
        usageBusy.current = true;
        try {
          const res = await fetch(`/pet-brain/usage${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
          const data = await res.json();
          if (data && typeof data === 'object') setUsage(data);
        } catch {
          /* 宿主没起来就算了，不打扰老大 */
        } finally {
          usageBusy.current = false;
        }
      }, []);

      /** 开机拉一次，之后每 5 分钟一次（宿主侧还有 60s 缓存，不会把上游打爆） */
      useEffect(() => {
        if (!cfg) return undefined;
        void fetchUsage(false);
        const t = setInterval(() => void fetchUsage(false), 300_000);
        return () => clearInterval(t);
      }, [cfg, fetchUsage]);

      /** 用量面板开着的时候 30s 刷一次 */
      useEffect(() => {
        if (!showUsage) return undefined;
        const t = setInterval(() => void fetchUsage(false), 30_000);
        return () => clearInterval(t);
      }, [showUsage, fetchUsage]);

      /**
       * 桌面助手在跑就把客户端内这只收起来。
       * 查得勤一点（5s）：老大在桌面助手里点「关掉」之后，客户端内这只应该很快回来。
       */
      useEffect(() => {
        let stop = false;
        const check = async () => {
          try {
            const res = await fetch('/pet-brain/desktop', { cache: 'no-store' });
            const data = await res.json();
            const alive = Boolean(data?.desktop?.alive ?? data?.alive);
            deskActiveRef.current = alive;
            if (!stop) setDeskAlive(alive);
          } catch {
            deskActiveRef.current = false;
            if (!stop) setDeskAlive(false);
          }
        };
        void check();
        const t = setInterval(check, 5_000);
        return () => {
          stop = true;
          clearInterval(t);
        };
      }, []);

      // ---- 气泡自动消失 ------------------------------------------------------
      useEffect(() => {
        if (!bubble) return undefined;
        const t = setTimeout(() => setBubble(''), 12_000);
        return () => clearTimeout(t);
      }, [bubble]);

      useEffect(() => {
        if (chatOpen) setTimeout(() => inputRef.current?.focus(), 30);
      }, [chatOpen]);

      // ---- 发送 --------------------------------------------------------------
      const send = useCallback(async () => {
        const text = draft.trim();
        if (text === '' || busy) return;
        setDraft('');
        setBusy(true);
        const history = log.slice(-6).map((m) => ({ role: m.role, content: m.text }));
        setLog((prev) => [...prev, { role: 'user', text }]);
        if (cfg) playAnim(cfg.animations.thinking, { loop: true });
        try {
          const res = await fetch('/pet-brain/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, history }),
          });
          const data = await res.json();
          if (!data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
          setLog((prev) => [...prev, { role: 'assistant', text: data.reply }]);
          setBubble(data.reply);
          // 聊完共享大脑可能已经改了心情：立刻同步，别等 2s 轮询
          if (data.mood) setMood(data.mood);
          if (cfg) playAnim(data.action || cfg.animations.idle, { loop: false });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setBubble(`（说不上话：${msg}）`);
          setLog((prev) => [...prev, { role: 'assistant', text: `（说不上话：${msg}）` }]);
          backToIdle();
        } finally {
          setBusy(false);
        }
      }, [draft, busy, log, cfg, playAnim, backToIdle]);

      const onKeyDown = useCallback(
        (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
          if (e.key === 'Escape') setChatOpen(false);
        },
        [send],
      );

      const moodLabel = mood?.band?.label ?? '';
      const moodNum = mood?.mood;
      const width = scale;

      const statusText = useMemo(() => {
        if (!moodLabel) return personaName ? `🐟 ${personaName}` : '🐟';
        const pct = typeof moodNum === 'number' ? Math.round(moodNum) : '?';
        return `🐟 ${moodLabel} ${pct}`;
      }, [moodLabel, moodNum, personaName]);

      const dimRows = useMemo(() => {
        const dims = mood?.dims ?? {};
        return (cfg?.dims ?? []).map((d) => ({
          key: d.key,
          label: d.label,
          value: Number(dims[d.key] ?? 0),
        }));
      }, [cfg, mood]);

      /*
       * 菜单只放"必须点两下才能做的事"。
       * 摸摸头（双击）、心情（点徽章）、大小（滚轮）都已经有直接操作，
       * 回忆/人设这些是共享大脑自己在管，不重复摆一遍。
       */
      const menuItems = [
        { icon: '💬', label: '聊两句', run: () => { setMenuOpen(false); setChatOpen(true); } },
        { icon: '🎲', label: '随便动动', run: randomAction },
        { icon: '💰', label: showUsage ? '收起余额' : '看看余额', run: () => { setShowUsage((v) => !v); setShowDims(false); setMenuOpen(false); } },
        null,
        { icon: quiet ? '🔊' : '🔇', label: quiet ? '多说点' : '安静点', run: () => { toggleQuiet(); setMenuOpen(false); } },
      ];

      /*
       * 身体交给桌面助手（独立 Electron 透明置顶窗口）去渲染，客户端这边不再画。
       * 之前两只一起显示：一只在客户端窗口里（点不动、还和桌面上那只重叠），
       * 一只飘在桌面上，容易分不清到底在点哪个。现在只留桌面那只。
       *
       * 2026-11-11：但桌面那只可能不在 —— 进程被杀、启动失败、用户刚点过「关掉」。
       * 以前这里无条件 return null，结果两头都空：桌面上没有，客户端里也没有，
       * 老大只能重启。现在只在「桌面助手确实活着」时才让位，它没跑就由客户端顶上。
       * 注意这行必须在所有 hook 之后 —— 提前 return
       * 会让下次渲染的 hook 数量对不上，React 直接抛错把整个 shell 搞挂。
       */
      if (deskAlive) return null;

      const tree = h(
        'div',
        {
          ref: wrapRef,
          style: {
            ...S.wrap,
            ...(dragging ? S.wrapDrag : null),
            left: pos.x - width / 2,
            top: pos.y - (width * 9) / 32,
            width,
            height: (width * 9) / 16,
          },
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          onContextMenu,
          onDoubleClick: patHead,
          // 滚轮直接改大小：比在菜单里点「变大/变小」顺手
          onWheel: (e) => {
            if (chatOpen || showUsage || showDims) return;
            e.stopPropagation();
            bumpScale(e.deltaY < 0 ? 40 : -40);
          },
          title: '点一下聊天 · 右键菜单 · 双击摸摸头 · 拖走可以甩',
        },
        h(
          'video',
          {
            ref: videoRef,
            style: S.video,
            src: videoUrl || undefined,
            autoPlay: true,
            muted: true,
            loop,
            playsInline: true,
            onEnded: () => {
              if (!animRef.current.loop) backToIdle();
            },
            onLoadedData: () => {
              const v = videoRef.current;
              ping('video.ok', `w=${v?.videoWidth} h=${v?.videoHeight} url=${(videoUrl || '').slice(0, 18)}`);
            },
            onError: () => {
              const v = videoRef.current;
              ping('video.err', `code=${v?.error?.code} msg=${v?.error?.message ?? ''}`);
            },
          },
          null,
        ),
        h(
          'div',
          {
            style: S.badge,
            title: '点一下看七维心情',
            onPointerDown: (e) => e.stopPropagation(),
            onPointerUp: (e) => e.stopPropagation(),
            onClick: (e) => {
              e.stopPropagation();
              setShowDims((v) => !v);
              setShowUsage(false);
            },
          },
          statusText,
        ),
        menuOpen
          ? h(
              'div',
              {
                style: { ...S.card, ...S.menu },
                onPointerDown: (e) => e.stopPropagation(),
                onPointerUp: (e) => e.stopPropagation(),
                onContextMenu: (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                },
              },
              ...menuItems.map((it, i) =>
                it === null
                  ? h('div', { key: `sep-${i}`, style: S.menuSep }, null)
                  : h(
                      'button',
                      {
                        key: it.label,
                        type: 'button',
                        style: S.menuItem,
                        onPointerEnter: (e) => {
                          e.currentTarget.style.background = 'rgba(61,91,217,.09)';
                        },
                        onPointerLeave: (e) => {
                          e.currentTarget.style.background = 'transparent';
                        },
                        onClick: it.run,
                      },
                      h('span', null, it.icon),
                      h('span', null, it.label),
                    ),
              ),
            )
          : null,
        showDims
          ? h(
              'div',
              {
                style: { ...S.card, ...S.menu, minWidth: 212, padding: 12, gap: 8 },
                onPointerDown: (e) => e.stopPropagation(),
                onPointerUp: (e) => e.stopPropagation(),
                onContextMenu: (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                },
              },
              h(
                'div',
                { style: S.cardTitle },
                h('span', null, '心情'),
                h(
                  'span',
                  { style: { fontVariantNumeric: 'tabular-nums' } },
                  `${typeof moodNum === 'number' ? Math.round(moodNum) : '?'}/100`,
                ),
              ),
              h(
                'div',
                { style: S.score },
                h('span', { style: S.scoreNum }, String(typeof moodNum === 'number' ? Math.round(moodNum) : '?')),
                h('span', { style: S.scoreBand }, moodLabel || '未知'),
              ),
              h('div', { style: S.menuSep }, null),
              ...dimRows.map((d) =>
                h(
                  'div',
                  { key: d.key, style: S.dimRow },
                  h('span', { style: S.dimName }, d.label),
                  h(
                    'div',
                    { style: S.dimTrack },
                    h('div', { style: { ...S.dimFill, width: `${clamp(d.value * 10, 0, 100)}%` } }, null),
                  ),
                  h('span', { style: S.dimVal }, String(Math.round(d.value))),
                ),
              ),
            )
          : null,
        showUsage
          ? h(
              'div',
              {
                style: { ...S.card, ...S.menu, minWidth: 216, padding: 12, gap: 9 },
                onPointerDown: (e) => e.stopPropagation(),
                onPointerUp: (e) => e.stopPropagation(),
                onContextMenu: (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                },
              },
              h(
                'div',
                { style: S.cardTitle },
                h('span', null, 'DeepSeek 余额'),
                h(
                  'button',
                  {
                    type: 'button',
                    title: '刷新',
                    style: {
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      fontSize: 13,
                      lineHeight: 1,
                      padding: 2,
                      color: '#8b99bb',
                    },
                    onClick: () => void fetchUsage(true),
                  },
                  '🔄',
                ),
              ),
              h(
                'div',
                { style: S.score },
                h(
                  'span',
                  { style: { ...S.scoreNum, fontSize: 27 } },
                  usage && usage.balance !== null && usage.balance !== undefined
                    ? `¥${Number(usage.balance).toFixed(2)}`
                    : '—',
                ),
                h(
                  'span',
                  { style: S.scoreUnit },
                  usage?.ok ? (usage.discount ? '优惠时段' : '标准价时段') : usage ? '取不到' : '读取中',
                ),
              ),
              usage?.ok === false && usage?.error
                ? h(
                    'div',
                    { style: { fontSize: 11, color: '#c0563f', lineHeight: 1.5, wordBreak: 'break-word' } },
                    String(usage.error).slice(0, 90),
                  )
                : null,
              h('div', { style: S.menuSep }, null),
              h(
                'div',
                { style: S.statRow },
                h('span', { style: S.statKey }, '今日已用'),
                h('span', { style: S.statVal }, usage?.today != null ? `¥${Number(usage.today).toFixed(3)}` : '—'),
              ),
              h(
                'div',
                { style: S.statRow },
                h('span', { style: S.statKey }, '近 7 天'),
                h('span', { style: S.statVal }, usage?.week != null ? `¥${Number(usage.week).toFixed(3)}` : '—'),
              ),
              h(
                'div',
                { style: { fontSize: 10.5, color: '#9aa6c4', lineHeight: 1.5 } },
                '按余额差值累计，不是逐条账单',
              ),
            )
          : null,
        bubble && !chatOpen
          ? h(
              'div',
              { key: `bubble-${bubbleAt}`, style: S.bubbleWrap },
              h(
                'div',
                { style: S.bubbleBox },
                bubble,
                h('div', { style: S.bubbleTail }, null),
              ),
            )
          : null,
        chatOpen
          ? h(
              'div',
              {
                style: { ...S.card, ...S.panel },
                onPointerDown: (e) => e.stopPropagation(),
                onPointerUp: (e) => e.stopPropagation(),
                onContextMenu: (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                },
              },
              h(
                'div',
                { style: S.panelTitle },
                h('span', null, personaName || '桌宠', moodLabel ? ` · ${moodLabel}` : ''),
                h(
                  'button',
                  {
                    type: 'button',
                    title: '收起',
                    style: {
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      fontSize: 13,
                      lineHeight: 1,
                      padding: 2,
                      color: '#9aa6c4',
                    },
                    onClick: () => setChatOpen(false),
                  },
                  '✕',
                ),
              ),
              log.length > 0
                ? h(
                    'div',
                    { style: S.log },
                    ...log.map((m, i) =>
                      h(
                        'div',
                        { key: i, style: { display: 'flex', flexDirection: 'column' } },
                        h(
                          'div',
                          { style: { ...S.msgWho, alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start' } },
                          m.role === 'user' ? '你' : personaName || '桌宠',
                        ),
                        h('div', { style: m.role === 'user' ? S.msgUser : S.msgPet }, m.text),
                      ),
                    ),
                  )
                : h('div', { style: S.hint }, '说句话试试（Enter 发送，Esc 关闭）'),
              h(
                'div',
                { style: S.row },
                h('input', {
                  ref: inputRef,
                  style: S.input,
                  value: draft,
                  placeholder: busy ? '在想…' : '说点什么…',
                  onChange: (e) => setDraft(e.target.value),
                  onKeyDown,
                }),
                h('button', { style: S.btn, onClick: () => void send(), disabled: busy }, busy ? '…' : '发送'),
              ),
            )
          : null,
      );
      return createPortal ? createPortal(tree, document.body) : tree;
    }

    /**
     * 注入一次关键帧。内联样式写不了 @keyframes，但气泡和面板的入场动画离不开它。
     * 用固定 id 保证热重载后不会越插越多。
     */
    const STYLE_ID = 'dsh-pet-brain-style';
    function ensureStyle() {
      try {
        if (document.getElementById(STYLE_ID)) return;
        const el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = [
          '@keyframes dsh-pet-brain-pop{from{opacity:0;transform:translateY(5px) scale(.965)}to{opacity:1;transform:none}}',
          '@keyframes dsh-pet-brain-breathe{0%,100%{opacity:.55}50%{opacity:1}}',
        ].join('\n');
        document.head.appendChild(el);
      } catch {
        /* 拿不到 document 就算了，动画降级成静态 */
      }
    }

    function apply(ctx) {
      ping('apply', typeof ctx?.slots?.inject);
      ensureStyle();
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register(
          { name: 'shell.overlay', id: NS, order: 1001 },
          () => h(Pet, {}),
        );
      });
      ping('apply.done');
    }

    module.exports = { apply, inject, name };
    return module.exports;
  };
}

window.__ModuleLoader__.load({
  id: 'dsh-pet-brain',
  factory: makeFactory(),
});
