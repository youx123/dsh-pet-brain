/**
 * dsh-pet-brain —— 宿主半侧（Cordis 插件）
 *
 * 定位：一只**有大脑**的桌宠。大脑就是 dsh-shared-brain：
 *   - 人设：读它当前的 persona（persona.json）
 *   - 心情：读它按会话维护的情绪状态（emotion.json），按档位驱动动作
 *   - 记忆：读 memory.json，按老大这句话做相关性召回，**每轮重新拼 system prompt**
 *
 * 它不 import 共享大脑的代码（对方 exports 只有整个 apply 入口，import 会执行副作用），
 * 只读它落盘的状态文件；文件缺失时降级成"没有大脑的普通桌宠"，不崩。
 *
 * 路由（前缀 /pet-brain，仅 loopback）：
 *   GET  /pet-brain/config        动画池 / 尺寸 / 轮询间隔
 *   GET  /pet-brain/state         当前心情 + 人设 + 建议动作（前端 1s 轮询）
 *   POST /pet-brain/chat          { text, history? } → { reply, mood, ... }
 *   GET  /pet-brain/anim/<名>.webm 动画素材（白名单，防路径穿越）
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  DIM_KEYS,
  DIM_LABELS,
  bottomline,
  buildSystem,
  cleanReply,
  bandOf,
  currentPersona,
  dshHome,
  moodAction,
  pickMood,
  readShared,
  recallMemories,
  recentMemories,
  voiceStyle,
} from './brain.js';
import { expandHits } from './graph-recall.js';
import { appendChatLog, lastUserText, readChatLog, readHostFollow, recentSpeech, writeHostFollow } from './chatlog.js';
import { getUsage } from './usage.js';
import { rememberChat } from './remember.js';
import { freshMemoryEntries } from './memory-watch.js';
import { desktopStatus, startDesktop, stopDesktop } from './desktop.js';
import {
  PET_SESSION_KEY,
  decideProactive,
  dayEndOf,
  historyOf,
  hostPulse,
  inTimeWindow,
  proposeEmoji,
  randomizeInterval,
  rememberTopic,
  rollDay,
  saveHistory,
  TONE_HINTS,
} from './proactive.js';

const ROUTE_PREFIX = '/pet-brain';
const TAG = '[dsh-pet-brain]';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEBM_DIR = join(HERE, '..', 'assets', 'webm');

/** 前端轮询间隔（ms）：心情变化不算高频，2s 足够，省得每秒读盘 */
const POLL_MS = 2000;
/** 聊天单次超时（ms） */
const CHAT_TIMEOUT_MS = 60_000;
/** 一次请求最多带几轮历史 */
const MAX_HISTORY = 8;
/** 桌宠默认宽度（px，1620 视口下约 1/4 屏宽） */
const PET_SIZE = 462;
/** 桌宠那个"看得见"的会话叫什么名字（改名失败不影响用） */
const PET_SESSION_TITLE = '桌宠 · 小深';
/** 通过真实会话问一句，最多等多久（会话要跑工具，比直连 LLM 慢） */
const SESSION_REPLY_TIMEOUT_MS = 90 * 1000;

/**
 * 桌宠自己的主动互动节奏。
 *
 * 为什么跟共享大脑主会话不一样：
 *   - 主会话那套 `maxPerDay: 3` + 额度均匀铺开，是防"在对话里刷屏"的；
 *     桌宠是桌面角落的一只小东西，说一句冒个泡就没了，不需要那么严。
 *   - 照搬的结果就是：一天说满 3 次后彻底哑掉，老大看着就是"根本不互动"。
 * 所以这里关掉每日额度（maxPerDay: 0），只留一道安静期当刹车。
 */
const PET_PACING = {
  quietPeriodMs: 20 * 60 * 1000,
  maxPerDay: 0,
};

/**
 * 跟随共享大脑主会话开口的节拍。
 *
 * 共享大脑在主会话里主动搭话，桌宠这边要跟着冒个泡 —— 老大在主界面看到它
 * 说话，回头看桌宠一声不吭，就等于两边没连上。
 *
 * 但"跟着接"不能只看时间窗：
 *   - 只看时间窗（原来 3 分钟）→ 共享大脑今天额度用完、隔一小时才说一句，
 *     桌宠永远等不到那个窗口，看着就是"没联动"。
 *   - 不记水位线 → 每次轮询都接一遍，屏幕上全是话。
 * 所以这里两样都要：窗口放宽到 15 分钟，另外用 host-follow.json 记下
 * "哪一条已经接过"。
 */
const PET_HOST_FOLLOW_WINDOW_MS = 15 * 60 * 1000;
/** 跟随共享大脑时的最小间隔：别主会话说一句、桌宠就跟着说一句，那样更吵。 */
const PET_FOLLOW_GAP_MS = 45 * 1000;

/**
 * 桌面助手的「用户意愿」标记。
 *
 * 老大要的是两件不同的事：
 *   1. 正常重启客户端/宿主之后，它应该还在；
 *   2. 自己点了「关掉桌面助手」，下次别再自己爬回来。
 * 所以落一个 closedByUser 来区分：只有用户主动关过，才不自动拉起。
 */
const desktopPrefsFile = () => join(dshHome(), 'dsh-pet-brain', 'desktop.json');

function desktopPrefs() {
  try {
    const j = JSON.parse(readFileSync(desktopPrefsFile(), 'utf8'));
    return { closedByUser: j?.closedByUser === true, closedAt: Number(j?.closedAt) || 0 };
  } catch {
    return { closedByUser: false, closedAt: 0 };
  }
}

function saveDesktopPrefs(next) {
  try {
    mkdirSync(join(dshHome(), 'dsh-pet-brain'), { recursive: true });
    const merged = { ...desktopPrefs(), ...next };
    writeFileSync(desktopPrefsFile(), JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (e) {
    console.warn(`${TAG} 写 desktop.json 失败：${e?.message || e}`);
    return null;
  }
}

/**
 * 心情档位 → 动作（真实文件名，全部在 assets/webm 里）。
 * 键与 brain.js 的 bandOf 一一对应。
 */
const BAND_ACTIONS = {
  delighted: ['工作状态-雀跃庆祝', '轻快摇摆舞', '放烟花', '原地跳跃抓碎头顶物品', '点击回应-开心跃动'],
  happy: ['点击回应-开心跃动', '点击回应-元气挥手', '可爱宅舞', '荡秋千', '吃糖葫芦'],
  ok: ['悠闲哼歌', '超大伸懒腰', '摇扇纳凉', '撸猫', '照镜子', '写代码'],
  heartache: ['碎碎念-发呆碎碎念', '原地小憩沉眠', '哈欠连天', '深度思考碎碎念'],
  sad: ['原地小憩沉眠', '工作状态-垂头叹气冒汗', '深度思考碎碎念', '东张西望'],
  unknown: ['待机呼吸休闲', '东张西望', '原地漂浮踏步'],
};

/**
 * 七维里某一维**特别突出**时的专属动作（优先于档位）。
 * 共享大脑每次判定的 dims 里，超过 DIM_HOT 的维度算"突出"，
 * 这样桌宠的表情就不只是"开心/难过"两档，而是能演出具体情绪。
 */
const DIM_ACTIONS = {
  happy: ['点击回应-开心跃动', '可爱宅舞', '轻快摇摆舞'],
  calm: ['悠闲哼歌', '撸猫', '照镜子'],
  sweet: ['点击回应-害羞惊讶', '收红包', '点击回应-挠痒咯咯笑'],
  heartache: ['碎碎念-发呆碎碎念', '原地小憩沉眠'],
  worry: ['工作状态-原地踱步张望', '东张西望', '深度思考碎碎念'],
  sad: ['哈欠连天', '工作状态-垂头叹气冒汗', '碎碎念-发呆碎碎念'],
  jealous: ['点击回应-傲娇生气', '玩游戏气急败坏'],
};

/** 维度值达到这个数才算"突出"（共享大脑七维 0~10 量级） */
const DIM_HOT = 6;

/** 已打包的动画池（按用途分组；名字必须是 assets/webm 下的真实文件名） */
const ANIMATIONS = {
  idle: '待机呼吸休闲',
  turn: '东张西望',
  drag: '被鼠标拖拽悬空反馈',
  click: ['点击回应-开心跃动', '点击回应-元气挥手', '点击回应-害羞惊讶', '点击回应-傲娇生气', '点击回应-挠痒咯咯笑'],
  small: [
    '悠闲哼歌',
    '超大伸懒腰',
    '哈欠连天',
    '写代码',
    '鲸鱼吐泡泡特效',
    '撸猫',
    '照镜子',
    '摇扇纳凉',
    '吹气球',
    '踢毽子',
    '螃蟹走路',
    '原地漂浮踏步',
    '三球抛接',
    '原地敲击桌面互动',
    '侧身急躁跑',
  ],
  eat: ['吃白饭', '吃糖葫芦', '吃冰淇淋融化', '吃饭·碗饭', '吃饭团', '期待开饭'],
  sleep: ['原地小憩沉眠', '睡觉-开始', '睡觉-循环', '睡觉-起来'],
  /**
   * 走位用的动作。素材本身全是原地动画，"从 A 走到 B" 靠主进程按动画
   * 播放时间插值位移（照抄上游 dsh-pet 的 motion/walk.ts）。
   * 侧身急躁跑 画面里自带一段横向位移，放这儿会跟窗口位移打架，
   * 所以只当情绪动作用（在 small 组里），不当走位动作。
   */
  walk: ['开心小跑', '螃蟹走路', '原地漂浮踏步'],
  thinking: '工作状态-思考冒泡',
  working: '工作状态-忙碌点按',
  success: ['工作状态-雀跃庆祝', '放烟花', '轻快摇摆舞'],
  error: '工作状态-垂头叹气冒汗',
  gift: '拆礼物',
  surprise: '被吓一跳',
  whale: ['蓝鲸现世', '用鲸鱼尾巴拍打地面', '鲸鱼吐泡泡特效'],
};

/** 启动时扫一次素材目录：既做 /config 的清单，也做 /anim 的白名单 */
function listAnimations() {
  const names = new Set();
  for (const value of Object.values(ANIMATIONS)) {
    for (const n of Array.isArray(value) ? value : [value]) names.add(n);
  }
  const available = new Set();
  try {
    for (const f of readdirSync(WEBM_DIR)) {
      if (f.toLowerCase().endsWith('.webm')) available.add(f.slice(0, -5));
    }
  } catch (e) {
    console.warn(`${TAG} 素材目录读不到：${WEBM_DIR}（${e instanceof Error ? e.message : String(e)}）`);
  }
  for (const n of names) {
    if (!available.has(n)) console.warn(`${TAG} 缺少动画素材：${n}.webm`);
  }
  return available;
}

/**
 * 往素材白名单里补扫一遍目录。
 * 素材可能在插件启动之后才被拷进来（上游更新、用户自己换素材），
 * 启动时扫的名单认不出来时补扫一次，省得每次都要重启宿主。
 */
function rescanAnimations(target) {
  try {
    for (const f of readdirSync(WEBM_DIR)) {
      if (f.toLowerCase().endsWith('.webm')) target.add(f.slice(0, -5));
    }
  } catch (e) {
    console.warn(`${TAG} 素材目录读不到：${WEBM_DIR}（${e instanceof Error ? e.message : String(e)}）`);
  }
  return target;
}

/**
 * 当前心情 → 可选动作池。
 * 七维里有"突出"的维度（> DIM_HOT）就用那一维的专属池，否则退回档位池。
 * 这样共享大脑判出「吃醋」或「担心」时，桌宠演的不是笼统的"低落"。
 */
function actionPool(mood) {
  if (!mood) return BAND_ACTIONS.unknown;
  const dims = mood.dims ?? {};
  let hotKey = '';
  let hotVal = DIM_HOT;
  for (const [k, v] of Object.entries(dims)) {
    if (typeof v === 'number' && v > hotVal) {
      hotVal = v;
      hotKey = k;
    }
  }
  if (hotKey && DIM_ACTIONS[hotKey]) return DIM_ACTIONS[hotKey];
  const bandId = typeof mood.band === 'string' ? mood.band : mood.band?.id;
  return BAND_ACTIONS[bandId] ?? BAND_ACTIONS.unknown;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

/** 懒加载宿主提供的 dsh-llm 模块（拿不到就降级成宽松拍平，不让插件加载失败） */
let llmKit;
async function loadLlmKit() {
  if (llmKit !== undefined) return llmKit;
  try {
    const m = await import('@deepseek-ai/dsh-llm');
    llmKit = {
      BlockAssembler: m.BlockAssembler,
      createUserMessage: m.createUserMessage,
      createAssistantMessage: m.createAssistantMessage,
    };
    if (typeof m.BlockAssembler !== 'function' || typeof m.createUserMessage !== 'function') llmKit = null;
  } catch (e) {
    console.warn(`${TAG} dsh-llm 不可用，改用宽松解析：${e instanceof Error ? e.message : String(e)}`);
    llmKit = null;
  }
  return llmKit;
}

/** 宽松拍平：拿不到 BlockAssembler 时，从 chunk 里尽量抠出正文 */
function looseText(chunks) {
  let out = '';
  for (const c of chunks) {
    if (typeof c === 'string') {
      out += c;
      continue;
    }
    if (!c || typeof c !== 'object') continue;
    const d = c.delta;
    if (d && typeof d === 'object' && typeof d.text === 'string') {
      out += d.text;
      continue;
    }
    if (typeof c.text === 'string' && (c.type === 'text' || c.type === 'text-delta' || c.type === undefined)) {
      out += c.text;
    }
  }
  return out.trim();
}

/**
 * 跑一次桌宠对话。
 * @param {object} ctx 宿主上下文
 * @param {string} system 本轮 system prompt（人设+心情+召回记忆）
 * @param {{role:'user'|'assistant',content:string}[]} history
 * @param {string} userText
 */
async function generateChat(ctx, system, history, userText) {
  const llm = ctx.llm;
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, message: 'LLM 服务不可用' };
  }
  const sel = ctx.agentDefaultModel?.currentSelection?.();
  if (!sel || !sel.provider || !sel.model) {
    return { ok: false, message: '当前对话未配置模型' };
  }
  const kit = await loadLlmKit();
  const messages = [];
  for (const m of history) {
    if (!m || typeof m.content !== 'string' || m.content.trim() === '') continue;
    if (kit) {
      messages.push(
        m.role === 'user'
          ? kit.createUserMessage({ content: [{ type: 'text', text: m.content }], source: { kind: 'user' } })
          : kit.createAssistantMessage({
              content: [{ type: 'text', text: m.content }],
              source: { provider: sel.provider, model: sel.model },
            }),
      );
    } else {
      messages.push({ role: m.role, content: [{ type: 'text', text: m.content }] });
    }
  }
  if (kit) {
    messages.push(kit.createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } }));
  } else {
    messages.push({ role: 'user', content: [{ type: 'text', text: userText }] });
  }

  const options = {
    provider: sel.provider,
    model: sel.model,
    // 独立调用身份：桌宠聊天不写进主会话，但 dsh-llm 要求带一个 sessionId
    sessionId: 'pet-brain',
    messages,
    system,
    temperature: 1,
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  };

  const collected = [];
  try {
    for await (const chunk of llm.stream(options)) collected.push(chunk);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }

  if (kit) {
    const assembler = new kit.BlockAssembler();
    for (const c of collected) assembler.push(c);
    const text = assembler
      .blocks()
      .filter((b) => b && b.type === 'text')
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('')
      .trim();
    if (text === '') return { ok: false, message: '模型未返回文本' };
    return { ok: true, text };
  }
  const text = looseText(collected);
  if (text === '') return { ok: false, message: '模型未返回文本' };
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * 桌面助手（独立 Electron 进程）用 file:// 页面 fetch 这些端点，
 * 属于跨域请求，必须给 CORS 头，否则 helper 里一个请求都发不出去。
 * 只在本机 loopback 上放开，不额外扩大暴露面。
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS,
  });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendWebm(res, file) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }
  res.writeHead(200, {
    'content-type': 'video/webm',
    'content-length': String(size),
    'cache-control': 'public, max-age=86400',
    ...CORS,
  });
  const stream = createReadStream(file);
  stream.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export const name = 'pet-brain';
export const inject = [
  'webServer',
  'llm',
  'agentDefaultModel',
  'clientModules',
  'credentials',
  'agents',
  'sessionController',
  'workingDirectory',
];

export function apply(ctx) {
  const available = listAnimations();
  console.log(`${TAG} 已加载，素材 ${available.size} 个，共享大脑目录 ${join(dshHome(), 'storages', 'dsh-shared-brain')}`);

  // 浏览器半侧的自证通道：client 每一步都往这里 ping，
  // 出问题时只要 curl /pet-brain/state 就能看出它卡在哪一步，不必去翻浏览器控制台。
  const diag = { bootAt: Date.now(), pings: [] };

  /*
   * 工作状态：跟着 DSH 的 agent 跑。
   * 老大在忙 → 桌宠切工作动画、别闹；一轮干完 → 弹一句"歇会儿？"。
   * 这是 dsh-pet 的 work-status 那套，我们用宿主事件驱动，比它准。
   */
  const work = { status: 'idle', since: Date.now(), sessionId: '', turns: 0, errors: 0, lastEvent: '' };
  const WORK_ACTIONS = {
    think: '工作状态-思考冒泡',
    busy: '工作状态-忙碌点按',
    done: '工作状态-雀跃庆祝',
    fail: '工作状态-垂头叹气冒汗',
    idle: '工作状态-原地踱步张望',
  };
  const DIM_CN = {
    happy: '开心',
    calm: '平静',
    sweet: '甜',
    heartache: '心疼',
    worry: '担心',
    sad: '难过',
    jealous: '吃醋',
  };

  // 每个会话各自记一份忙闲，别让 A 会话结束把 B 会话的忙状态顶掉
  const busySessions = new Map();

  ctx.on('api-session/status', (sessionId, running) => {
    const id = String(sessionId ?? 'unknown');
    busySessions.set(id, Boolean(running));
    const anyRunning = [...busySessions.values()].some(Boolean);
    const next = anyRunning ? 'running' : 'idle';
    if (next === work.status) return;
    if (next === 'idle' && work.status === 'running') work.turns += 1;
    work.status = next;
    work.since = Date.now();
    work.sessionId = id;
    work.lastEvent = `status:${next}`;
  });

  ctx.on('agent/error', () => {
    work.errors += 1;
    work.lastEvent = 'error';
  });

  /**
   * 现场问 DSH：现在有 agent 正在跑吗？
   * ctx.agents.list() 返回的 Agent 实例带 status 字段（'running' | 'idle'），
   * 比事件订阅靠谱 —— 事件是 Scoped 的，插件 scope 里收不到别的会话。
   */
  const liveWork = () => {
    try {
      const list = ctx.agents?.list?.() ?? [];
      const running = list.filter((a) => a?.status === 'running');
      return {
        total: list.length,
        running: running.length,
        ids: running.map((a) => String(a?.id ?? '')).slice(0, 6),
      };
    } catch (e) {
      return { total: 0, running: 0, ids: [], error: String(e) };
    }
  };

  /** 忙的时候该做什么动作 */
  const workAction = () => {
    if (work.status !== 'running') return null;
    const secs = (Date.now() - work.since) / 1000;
    if (work.errors > 0 && secs < 30) return WORK_ACTIONS.fail;
    if (secs < 10) return WORK_ACTIONS.think;
    if (secs < 90) return WORK_ACTIONS.busy;
    return WORK_ACTIONS.idle;
  };

  // 排障：把 DSH 的浏览器模块图 dump 到磁盘，看本包到底有没有被并进 boot graph
  try {
    const graph = ctx.clientModules?.graph?.() ?? null;
    let clientPath = null;
    try {
      clientPath = ctx.clientModules?.clientPath?.('dsh-pet-brain') ?? null;
    } catch (e) {
      clientPath = `ERR ${String(e)}`;
    }
    writeFileSync(
      join(HERE, '..', 'debug-client-graph.json'),
      JSON.stringify(
        {
          at: Date.now(),
          clientPath,
          entries: graph?.entries?.map((e) => e.id) ?? null,
          batches: graph?.batches?.map((b) => ({ phase: b.phase, n: b.entries?.length, url: b.url })) ?? null,
          mine: graph?.entries?.find((e) => e.id === 'dsh-pet-brain') ?? null,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`${TAG} clientPath = ${clientPath}`);
  } catch (e) {
    try {
      writeFileSync(join(HERE, '..', 'debug-client-graph.json'), JSON.stringify({ error: String(e) }, null, 2));
    } catch {
      /* 排障失败不许影响插件 */
    }
  }

  /**
   * 现场问 DSH：浏览器模块图里还有没有我。
   * apply 那一刻图还没拼好（时序），所以只在有人显式 ?graph=1 问的时候才算。
   */
  const graphProbe = () => {
    try {
      const graph = ctx.clientModules?.graph?.() ?? null;
      const mine = graph?.entries?.find((e) => e.id === 'dsh-pet-brain') ?? null;
      return {
        total: graph?.entries?.length ?? 0,
        mine: mine ? { url: mine.url, rev: mine.rev } : null,
        clientPath: ctx.clientModules?.clientPath?.('dsh-pet-brain') ?? null,
      };
    } catch (e) {
      return { error: String(e) };
    }
  };

  /** 读一次大脑快照（不缓存：mtime 缓存已在读盘层做了） */
  const snap = (preferSession) => {
    const shared = readShared();
    // 忙闲判定放在这里顺手做掉：谁在跑、跑多久、这一轮干完了没
    const live = liveWork();
    const next = live.running > 0 ? 'running' : 'idle';
    if (next !== work.status) {
      if (next === 'idle' && work.status === 'running') work.turns += 1;
      work.status = next;
      work.since = Date.now();
      work.lastEvent = `status:${next}`;
    }
    return {
      persona: currentPersona(shared),
      mood: pickMood(shared.emotion, preferSession),
      memory: shared.memory,
      recent: recentMemories(shared.memory, 3),
      voice: voiceStyle(shared.modules),
      agentive: shared.modules?.agentive ?? null,
      // 共享大脑主会话的开口脉搏：渲染端轮询这个，发现"那边刚说了话、自己还没接"
      // 就去要一句，接上以后由 /speak 把水位线推上去。
      host: { ...hostPulse(), seenAt: Number(readHostFollow().lastSeenAt ?? 0) },
      work: {
        ...liveWork(),
        status: work.status,
        since: work.since,
        turns: work.turns,
        errors: work.errors,
        action: workAction(),
      },
    };
  };

  /**
   * 桌宠这一轮该不该开口 —— 两处端点（/proactive 与 /speak）共用同一套算法，
   * 免得"查询说该说、真去生成时又说不该说"这种前后不一致。
   *
   * 判定顺序：
   *   配置关 / 不在时间窗  → silent
   *   共享大脑主会话刚开过口 → speak（reason='follow-host'）
   *   否则走 decideProactive（安静期、心情、话题轮换）
   */
  const petTurn = (now = Date.now()) => {
    const base = snap();
    const agentive = base.agentive ?? {};
    const hist = rollDay(historyOf(PET_SESSION_KEY), now);
    const moodState = base.mood ? { mood: base.mood.mood, dims: base.mood.dims } : { mood: 70, dims: {} };
    const config = { ...(agentive.mood ?? {}), ...PET_PACING };
    const decided = decideProactive({ moodState, history: hist, config, now, dayEnd: dayEndOf(now) });
    const pulse = hostPulse(now);
    const sinceSelf = Number(hist.lastSpokeAt ?? 0) > 0 ? now - Number(hist.lastSpokeAt) : Infinity;
    // 共享大脑主会话刚开口、而且这一条我还没接过 → 跟着接一句。
    // 光看时间窗不够（窗口外的开口就永远等不到），光不看水位线又会接个没完。
    const seen = readHostFollow();
    const hostAt = Number(pulse.at ?? 0);
    const hostFresh = hostAt > 0 && hostAt > Number(seen.lastSeenAt ?? 0) && now - hostAt < PET_HOST_FOLLOW_WINDOW_MS;
    const follow = hostFresh && sinceSelf > PET_FOLLOW_GAP_MS;
    const enabled = agentive.enabled !== false;
    const inWindow = inTimeWindow(agentive.timeWindow, now);

    const gate = !enabled ? 'disabled' : !inWindow ? 'outside-window' : '';
    const action = gate ? 'silent' : follow ? 'speak' : decided.action;
    const reason = gate || (follow ? 'follow-host' : decided.reason);
    const intervalMs = randomizeInterval(agentive.intervalMs ?? 15 * 60 * 1000);

    return {
      base,
      agentive,
      hist,
      moodState,
      decided,
      pulse,
      enabled,
      inWindow,
      action,
      reason,
      follow,
      intervalMs,
      // 没到点的时候别死等 intervalMs：安静期一过就该能接上话
      retryMs: action === 'speak' ? intervalMs : Math.min(intervalMs, 90 * 1000),
      moodCfg: config,
      host: { at: hostAt, sinceMs: Number.isFinite(pulse.sinceMs) ? pulse.sinceMs : null, seenAt: Number(seen.lastSeenAt ?? 0), fresh: hostFresh },
    };
  };

  // ---- 可监控会话：把桌宠的聊天落进一个真实工作区会话 ----------------------
  /** 会话服务（Cordis 里可能没注入，用 ctx.get 软拿） */
  const sessionApi = () => ctx.get?.('sessionController') ?? ctx.sessionController ?? null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let petSessionId = '';
  /** 会话 id 落盘：插件重挂/宿主重启之后接着用同一个会话，别每次都新建一个 */
  const petSessionFile = () => join(dshHome(), 'dsh-pet-brain', 'session.json');
  const readPetSession = () => {
    try {
      const raw = JSON.parse(readFileSync(petSessionFile(), 'utf8'));
      return typeof raw?.sessionId === 'string' ? raw.sessionId : '';
    } catch {
      return '';
    }
  };
  const writePetSession = (id) => {
    try {
      mkdirSync(join(dshHome(), 'dsh-pet-brain'), { recursive: true });
      writeFileSync(petSessionFile(), JSON.stringify({ sessionId: id, updatedAt: Date.now() }, null, 2));
    } catch {
      /* 存不了下次再建一个，不影响功能 */
    }
  };
  /** 排障用：会话通道到底卡在哪一步 */
  const sessionDiag = { hasGet: null, hasApi: null, createOk: false, error: '', at: 0 };

  /** 拿一个能用的桌宠会话：没了就建一个（建出来的会话在客户端里看得见） */
  const ensurePetSession = async () => {
    const sc = sessionApi();
    const dump = () => {
      try {
        writeFileSync('C:/Users/13176/Documents/dsh-pet-brain/tmp/session-diag.json', JSON.stringify({ ...sessionDiag, id: petSessionId }, null, 2));
      } catch {
        /* 写不了诊断不影响功能 */
      }
    };
    sessionDiag.hasGet = typeof ctx.get === 'function';
    sessionDiag.hasApi = Boolean(sc?.create);
    sessionDiag.hasPrompt = Boolean(sc?.prompt);
    sessionDiag.ctxKeys = Object.keys(ctx ?? {}).filter((k) => /session|agent|workspace/i.test(k)).join(',');
    sessionDiag.at = Date.now();
    sessionDiag.step = 'S1-入口';
    if (!sc?.create) {
      sessionDiag.error = 'no sessionController.create';
      dump();
      return '';
    }
    if (!petSessionId) petSessionId = readPetSession();
    if (petSessionId) {
      try {
        await sc.state({ sessionId: petSessionId }, AbortSignal.timeout(4000));
        sessionDiag.error = '';
        dump();
        return petSessionId;
      } catch {
        petSessionId = '';
      }
    }
    let cwd = process.cwd();
    try {
      // 落在老大最近在用的那个工作区里，这样桌宠会话出现在他熟悉的列表下，
      // 而不是孤零零挂到 profile 目录上（按会话列表的顺序取第一条，就是最近活跃的）。
      const sessions = await sc.list({}, AbortSignal.timeout(5000));
      const items = sessions?.items ?? [];
      // 跳过"profile 目录下的会话"（那是桌宠自己建的、还有别的插件会话），
      // 只认真正的工作区路径 —— 这样会话才会出现在老大的工作区列表里。
      const isProfileDir = (p) => /[\\/]\.dsh[\\/]/i.test(String(p ?? ''));
      const recent = items.find((it) => typeof it?.cwd === 'string' && it.cwd && !isProfileDir(it.cwd));
      sessionDiag.candidates = items.slice(0, 4).map((it) => String(it?.cwd ?? '')).join(' | ');
      if (recent) cwd = recent.cwd;
      else {
        const reg = ctx.workspaceRegistry ?? ctx.get?.('workspaceRegistry');
        const first = (reg?.list?.() ?? []).find((w) => typeof w?.path === 'string' && w.path);
        if (first) cwd = first.path;
      }
    } catch (e) {
      sessionDiag.cwdError = String(e?.message || e);
    }
    sessionDiag.cwd = cwd;
    sessionDiag.step = 'S2-要创建';
    try {
      sessionDiag.step = 'S3-调create';
      const created = await sc.create.call(sc, { cwd });
      sessionDiag.step = 'S4-create返回';
      sessionDiag.raw = JSON.stringify(created ?? null).slice(0, 400);
      petSessionId = String(created?.sessionId ?? created?.value?.sessionId ?? '');
      sessionDiag.createOk = Boolean(petSessionId);
      sessionDiag.error = petSessionId ? '' : 'create returned no sessionId';
    } catch (e) {
      sessionDiag.error = 'create failed: ' + String(e?.message || e);
      sessionDiag.raw = String(e?.stack || '').slice(0, 400);
      dump();
      return '';
    }
    if (petSessionId) {
      try {
        await sc.rename({ sessionId: petSessionId, title: PET_SESSION_TITLE });
        sessionDiag.renamed = true;
      } catch (e) {
        sessionDiag.renamed = false;
        sessionDiag.renameError = String(e?.message || e);
      }
      console.log(TAG + ' 桌宠会话已建：' + petSessionId);
      writePetSession(petSessionId);
    }
    sessionDiag.step = 'S5-完成';
    dump();
    return petSessionId;
  };
  /**
   * 通过真实会话问一句，返回它说的话。
   *
   * 为什么要走会话：桌宠原来用固定 sessionId 直连 ctx.llm.stream，
   * 不出现在任何列表里，老大想看着它聊、随时接管都做不到。
   * 走会话之后这轮对话就在工作区里，能点开、能接着聊。
   *
   * 人设/心情/记忆仍然是我们自己拼好塞进这句里 —— 会话的 system prompt
   * 是 DSH 的，注入不了别人的，所以把"你是谁、现在什么心情、记得什么"
   * 作为前置说明写在消息开头。
   */
  const askViaSession = async ({ text, system }) => {
    const sc = sessionApi();
    if (!sc?.prompt) {
      try {
        let got = null;
        try {
          got = ctx.get ? ctx.get('sessionController') : null;
        } catch (e) {
          got = String(e?.message || e);
        }
        writeFileSync(
          join(tmpdir(), 'pet-session-diag.json'),
          JSON.stringify(
            {
              step: 'no-prompt',
              hasSc: Boolean(sc),
              scType: typeof sc,
              keys: sc ? Object.keys(sc).slice(0, 60) : [],
              ctxKeys: Object.keys(ctx ?? {})
                .filter((k) => /session|agent|workspace|remote/i.test(k))
                .join(','),
              gotType: typeof got,
            },
            null,
            2,
          ),
        );
      } catch {
        /* ignore */
      }
      return null;
    }
    const sessionId = await ensurePetSession();
    if (!sessionId) return null;

    const before = Number((await sc.state({ sessionId }, AbortSignal.timeout(5000)))?.cursor ?? 0);
    const requestId = `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    // 把桌宠的身份说明放在最前面：这不是"系统提示词"，是老大对它说的话的一部分，
    // 会话里的模型能看到，老大也能看到（可监控的前提就是别藏东西）。
    const body = system ? `${system}\n\n---\n\n老大：${text}` : text;
    await sc.prompt(
      { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: body }] },
      AbortSignal.timeout(10000),
    );

    // 等这一轮跑完：先等它开始跑，再等它停下
    const deadline = Date.now() + SESSION_REPLY_TIMEOUT_MS;
    let started = false;
    while (Date.now() < deadline) {
      let st = null;
      try {
        st = await sc.state({ sessionId }, AbortSignal.timeout(5000));
      } catch {
        break;
      }
      if (st?.running) started = true;
      else if (started || Number(st?.cursor ?? 0) > before) break;
      await sleep(350);
    }

    const waited = await sc.wait(
      { sessionId, timeoutMs: 8000, afterSeq: before, maxMessages: 40 },
      AbortSignal.timeout(15000),
    );
    const texts = [];
    for (const rec of waited?.output?.records ?? []) {
      if (rec?.type !== 'event') continue;
      const ev = rec.event;
      if (ev?.type !== 'assistant/message') continue;
      for (const b of ev?.data?.message?.content ?? []) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.push(b.text.trim());
      }
    }
    const reply = texts.join('\n').trim();
    return reply ? { text: reply, sessionId } : null;
  };

  const handle = async (req, res, pathname, searchParams) => {
    if (!isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: 'loopback only' });
      return;
    }
    const method = req.method ?? 'GET';

    // 桌面助手从 file:// 页面发 POST，浏览器会先来一发预检
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    if (pathname === `${ROUTE_PREFIX}/ping`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        payload = {};
      }
      const entry = {
        at: Date.now(),
        stage: String(payload?.stage ?? '?').slice(0, 40),
        detail: String(payload?.detail ?? '').slice(0, 600),
      };
      diag.pings.push(entry);
      if (diag.pings.length > 30) diag.pings.splice(0, diag.pings.length - 30);
      console.log(`${TAG} client-ping ${entry.stage}${entry.detail ? ' — ' + entry.detail : ''}`);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === `${ROUTE_PREFIX}/config`) {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return sendJson(res, 200, {
        ok: true,
        pollMs: POLL_MS,
        size: PET_SIZE,
        animations: ANIMATIONS,
        bandActions: BAND_ACTIONS,
        dims: DIM_KEYS.map((k) => ({ key: k, label: DIM_LABELS[k] })),
      });
    }

    /**
     * 主动互动决策。
     * GET  → 这一轮该不该说话、什么调子、聊什么、贴什么表情、下次多久
     * POST → 报告"我已经说了"，把历史写回共享大脑那份 proactive-history.json
     *   body: { spoke?: boolean, topic?: string, concern?: boolean }
     */
    if (pathname === `${ROUTE_PREFIX}/proactive`) {
      if (method === 'POST') {
        let payload;
        try {
          payload = JSON.parse((await readBody(req)) || '{}');
        } catch {
          payload = {};
        }
        const now = Date.now();
        let hist = rollDay(historyOf(PET_SESSION_KEY), now);
        if (payload?.spoke) {
          hist.lastSpokeAt = now;
          hist.spokeToday = Number(hist.spokeToday ?? 0) + 1;
          if (payload?.concern) hist.concerns = Number(hist.concerns ?? 0) + 1;
          if (payload?.topic) hist.usedTopics = rememberTopic(hist.usedTopics, String(payload.topic));
        }
        saveHistory(PET_SESSION_KEY, hist);
        return sendJson(res, 200, { ok: true, history: hist });
      }

      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });

      const now = Date.now();
      const t = petTurn(now);
      const decision = t.decided;
      const emoji = proposeEmoji({ moodState: t.moodState, signal: decision.signal, config: { limit: 3 } });

      return sendJson(res, 200, {
        ok: true,
        enabled: t.enabled,
        inWindow: t.inWindow,
        action: t.action,
        reason: t.reason,
        followHost: t.follow,
        host: {
          speaking: t.pulse.speaking,
          sinceMs: Number.isFinite(t.pulse.sinceMs) ? t.pulse.sinceMs : null,
          spokeToday: t.pulse.spokeToday,
        },
        tone: decision.tone,
        topic: decision.topic ?? null,
        intervalMs: t.intervalMs,
        retryMs: t.retryMs,
        intervalFactor: decision.intervalFactor,
        signal: {
          mood: decision.signal.mood,
          band: decision.signal.band,
          level: decision.signal.level,
          dominant: decision.signal.dominant,
          dominantValue: decision.signal.dominantValue,
        },
        emoji,
        history: {
          dayStamp: t.hist.dayStamp ?? null,
          spokeToday: Number(t.hist.spokeToday ?? 0),
          concerns: Number(t.hist.concerns ?? 0),
          lastSpokeAt: Number(t.hist.lastSpokeAt ?? 0),
          usedTopics: t.hist.usedTopics ?? [],
        },
        config: {
          intervalMs: t.agentive.intervalMs ?? null,
          timeWindow: t.agentive.timeWindow ?? null,
          mood: t.moodCfg,
        },
      });
    }

    /**
     * 桌宠主动开口。
     *
     * 整条链在这里闭环：
     *   共享大脑的情绪信号 + 自动互动配置 + 搭话历史
     *     → decideProactive 决定「说不说、什么调子、聊什么」
     *     → LLM 按这个调子 + 人设 + 召回记忆 生成一句话
     *     → 返回动作池（动作由 tone 挑）
     *   渲染器只负责把这句话显示出来，不自己编。
     */
    if (pathname === `${ROUTE_PREFIX}/speak`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        payload = {};
      }

      const now = Date.now();
      const t = petTurn(now);
      const { base, agentive, hist, moodState, decided: decision } = t;

      // 时间窗之外一律不主动 —— 共享大脑配的时段是硬约束
      if (!t.inWindow) {
        return sendJson(res, 200, { ok: true, action: 'silent', reason: 'outside-window', text: '', retryMs: t.retryMs });
      }
      if (!t.enabled) {
        return sendJson(res, 200, { ok: true, action: 'silent', reason: 'disabled', text: '', retryMs: t.retryMs });
      }

      // 渲染端发现"共享大脑刚开口、这一条我还没接过" → 明确要求跟一句
      const canFollow = payload?.follow === true && t.host?.fresh === true;

      // 强制要一句（渲染侧点了「随便说点什么」时用）
      if (t.action !== 'speak' && !payload?.force && !canFollow) {
        return sendJson(res, 200, {
          ok: true,
          action: 'silent',
          reason: t.reason,
          tone: t.follow ? 'light' : decision.tone,
          text: '',
          intervalMs: t.intervalMs,
          retryMs: t.retryMs,
          host: { speaking: t.pulse.speaking, sinceMs: Number.isFinite(t.pulse.sinceMs) ? t.pulse.sinceMs : null },
        });
      }

      // 这次算不算"跟着共享大脑接话"
      const isFollow = t.follow || canFollow;

      // 跟随共享大脑开口时，语气按当下心情自己挑，别沿用"没到点"时那个中性调
      const tone = isFollow ? (decision.signal?.level === 'low' ? 'soft' : 'light') : decision.tone;
      const toneHint = TONE_HINTS[tone] ?? TONE_HINTS.neutral;
      const topicLabel = decision.topic?.label ?? '';
      const emo = proposeEmoji({ moodState, signal: decision.signal, config: { limit: 1 } });

      // 让桌宠自己开口：把调子和话题塞进 system，人设/心情/记忆照常注入
      const topicLine = topicLabel ? `【这会儿想聊的事】${topicLabel}` : '';
      const opening = isFollow
        ? '老大那边刚被搭过话，你也想凑一句 —— 别复述那边说了什么，说你自己这会儿想到的。'
        : '没人跟你说话，你自己憋不住想讲一句。像桌宠那样自然开口，不是报告、不是复述指令。';
      const directive = [
        opening,
        `【语气】${toneHint}`,
        topicLine,
        '只说一句话，别超过 30 个字，不要解释，不要复述上面这些提示。',
      ]
        .filter(Boolean)
        .join('\n');

      // 别复读：把自己刚说过的话摆出来，让它另起一句
      const mine = recentSpeech(3);
      const his = lastUserText();
      const continuity = [
        mine.length ? `【你刚说过】${mine.join('、')} —— 别重复，换个说法重新起一句。` : '',
        his ? `【老大最近跟你说过】「${his}」` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const directHits = recallMemories(
        [topicLabel, decision.signal?.dominant ?? '', DIM_CN[decision.signal?.dominant] ?? '']
          .filter(Boolean)
          .join(' '),
        base.memory,
        3,
      );
      // 顺图补邻居：这些记忆在共享大脑的记忆图谱里还连着别的相关条目
      const memories = [...directHits, ...expandHits(directHits, 2, { entries: base.memory?.entries })];
      let freshList = [];

      const system = buildSystem({
        persona: base.persona,
        mood: base.mood,
        voice: base.voice,
        memories,
        fresh: (freshList = freshMemoryEntries(base.memory, { minutes: 30, limit: 3 })),
        rules: bottomline(base.memory, 2),
        extra: continuity ? `${directive}\n${continuity}` : directive,
      });

      const out = await generateChat(ctx, system, [], '（老大没说话，你主动开口）');
      if (!out.ok) {
        console.warn(`${TAG} 主动开口失败：${out.message}`);
        return sendJson(res, 200, { ok: true, action: 'silent', reason: 'llm-failed', text: '', error: out.message });
      }

      const replyText = cleanReply(out.text);
      // 记进自己的账本：下一句主动开口时就能避开重复
      appendChatLog({ role: 'assistant', kind: 'proactive', text: replyText, at: now });

      // 记一次到桌宠自己的账本（~/.dsh/dsh-pet-brain/proactive-history.json 的 'pet' 桶）。
      // 不写共享大脑那份：它会整份覆写，把桌宠的桶抹掉。
      const nextHist = { ...hist, lastSpokeAt: now, spokeToday: Number(hist.spokeToday ?? 0) + 1 };
      if (t.reason === 'concern') nextHist.concerns = Number(hist.concerns ?? 0) + 1;
      if (decision.topic?.key) nextHist.usedTopics = rememberTopic(hist.usedTopics, decision.topic.key);
      saveHistory(PET_SESSION_KEY, nextHist);

      // 跟着共享大脑接了话 → 把水位线推上去：这一条已经接过了，
      // 下次轮询不会再接一遍（否则共享大脑每说一句、桌宠就跟一句）。
      if (t.follow) writeHostFollow(t.host?.at ?? 0);

      return sendJson(res, 200, {
        ok: true,
        action: 'speak',
        reason: t.reason,
        followHost: t.follow,
        tone,
        topic: decision.topic ?? null,
        text: replyText,
        emoji: emo.keys?.[0] ?? null,
        emojiKeys: emo.keys ?? [],
        mood: base.mood ? { mood: base.mood.mood, band: base.mood.band } : null,
        // 回显这次进了 prompt 的"刚学会"记忆，方便核对「记忆写入立刻影响说话」有没有通
        fresh: freshList.map((m) => m.text),
        actions: actionPool(base.mood),
        intervalMs: randomizeInterval(agentive.intervalMs ?? 15 * 60 * 1000),
      });
    }

    /**
     * 桌宠那个"看得见"的会话现在长什么样。
     * 排障用：确认老大说的话真的进去了、模型真的回了、回的是什么。
     */
    if (pathname === `${ROUTE_PREFIX}/session`) {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const sc = sessionApi();
      const id = petSessionId || searchParams.get('id') || '';
      if (!sc || !id) return sendJson(res, 200, { ok: false, error: 'no session yet' });
      let state = null;
      try {
        state = await sc.state({ sessionId: id }, AbortSignal.timeout(5000));
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message || e) });
      }
      let records = [];
      try {
        const waited = await sc.wait({ sessionId: id, timeoutMs: 400, afterSeq: 0, maxMessages: 30 }, AbortSignal.timeout(10000));
        records = waited?.output?.records ?? [];
      } catch (e) {
        return sendJson(res, 200, { ok: true, id, state, records: [], note: String(e?.message || e) });
      }
      const events = records.filter((r) => r?.type === 'event').map((r) => r.event);
      const assistants = [];
      for (const ev of events) {
        if (ev?.type !== 'assistant/message') continue;
        const parts = [];
        for (const b of ev?.data?.message?.content ?? []) {
          if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim());
        }
        if (parts.length) assistants.push({ seq: ev.seq, text: parts.join('\n').slice(0, 400) });
      }
      const users = events
        .filter((ev) => ev?.type === 'user/message')
        .map((ev) => {
          const c = ev?.data?.content ?? ev?.data?.message?.content ?? [];
          const txt = (Array.isArray(c) ? c : []).filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
          return { seq: ev.seq, text: String(txt).slice(0, 200) };
        });
      return sendJson(res, 200, {
        ok: true,
        id,
        state,
        total: events.length,
        users: users.slice(-3),
        assistants: assistants.slice(-3),
        types: [...new Set(events.map((e) => e?.type))].slice(0, 20),
      });
    }

    if (pathname === `${ROUTE_PREFIX}/work`) {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const s = snap();
      return sendJson(res, 200, { ok: true, work: s.work });
    }

    if (pathname === `${ROUTE_PREFIX}/env`) {
      /*
       * 探测宿主跑在什么运行时里 —— 决定了「桌宠能不能飘出客户端窗口」这件事有没有得谈。
       * 只有在 Electron 主进程里才拿得到 BrowserWindow；DSH 若把 web server 放在 node 子进程里，
       * process.versions.electron 就是空的，那条路直接堵死。
       */
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      let hasBrowserWindow = false;
      let electronKeys = null;
      try {
        const { createRequire } = await import('node:module');
        const electron = createRequire(import.meta.url)('electron');
        hasBrowserWindow = typeof electron?.BrowserWindow === 'function';
        electronKeys = Object.keys(electron ?? {}).slice(0, 40);
      } catch (e) {
        electronKeys = `ERR ${e?.code || e?.message || 'unknown'}`;
      }
      return sendJson(res, 200, {
        ok: true,
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        chrome: process.versions.chrome ?? null,
        processType: process.type ?? null,
        platform: process.platform,
        pid: process.pid,
        hasBrowserWindow,
        electronKeys,
      });
    }

    if (pathname === `${ROUTE_PREFIX}/desktop`) {
      /*
       * 桌面助手（独立 Electron 进程）。
       *   GET  → 进程状态
       *   POST {action:'start'|'stop'|'restart'} → 起/停
       * origin 从这里现取：宿主每次重启端口都会变，helper 里写死的 URL 会失效。
       */
      if (method === 'GET') return sendJson(res, 200, desktopStatus());
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });

      let payload = {};
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        payload = {};
      }
      const action = String(payload?.action ?? 'start');

      if (action === 'close') {
        // 用户主动关的：记下来，下次宿主重启不再自动拉起
        saveDesktopPrefs({ closedByUser: true, closedAt: Date.now() });
        stopDesktop();
        return sendJson(res, 200, { ok: true, closedByUser: true, ...desktopStatus() });
      }
      if (action === 'stop') {
        // 只是这一次停掉，不改用户意愿（宿主重启后仍会自动回来）
        stopDesktop();
        return sendJson(res, 200, { ok: true, ...desktopStatus() });
      }
      if (action === 'restart') {
        stopDesktop();
        // Windows 上 kill 之后进程还要几百毫秒才真正退出；立刻再起会撞上
        // helper 的单实例锁（新进程拿不到锁 → 直接 quit，窗口永远不出现）
        await new Promise((r) => setTimeout(r, 900));
      }
      if (action !== 'start' && action !== 'restart') {
        return sendJson(res, 400, { ok: false, error: `unknown action ${action}` });
      }
      // 手动起来了 → 清掉「用户关过」的标记
      saveDesktopPrefs({ closedByUser: false, closedAt: 0 });

      let origin;
      try {
        origin = ctx.webServer.getOrigin();
      } catch (e) {
        return sendJson(res, 503, { ok: false, error: `webServer 还没监听：${e?.message || e}` });
      }
      const started = startDesktop({
        origin,
        width: Number(payload?.width) || PET_SIZE,
        // 排障用：传 panel:'chat'|'usage'|'mood' 让窗口起来后自动打开对应面板
        panel: typeof payload?.panel === 'string' ? payload.panel : '',
        // 排障用：自动在输入框里打一句话并点发送，验证按钮链路
        send: typeof payload?.send === 'string' ? payload.send : '',
        // 排障用：启动后自动跑一次「主动搭话」链路自检
        speak: payload?.speak === true,
        // 排障用：'probe' | 'speak' | 'throw'，起来就自动跑对应自检
        probe: typeof payload?.probe === 'string' ? payload.probe : '',
      });
      return sendJson(res, started.ok ? 200 : 500, { ...started, status: desktopStatus() });
    }

    if (pathname === `${ROUTE_PREFIX}/usage`) {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      // ?refresh=1 跳过 60s 缓存（用户点了「刷新」）
      const u = await getUsage(ctx, { force: searchParams.get('refresh') === '1' });
      return sendJson(res, 200, u);
    }

    if (pathname === `${ROUTE_PREFIX}/state`) {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const s = snap(searchParams.get('session') || undefined);
      return sendJson(res, 200, {
        ok: true,
        ts: Date.now(),
        persona: s.persona ? { name: s.persona.name } : null,
        mood: s.mood
          ? {
              mood: s.mood.mood,
              band: s.mood.band,
              dims: s.mood.dims,
              reason: s.mood.reason,
              updatedAt: s.mood.updatedAt,
            }
          : null,
        action: actionPool(s.mood)[0],
        actions: actionPool(s.mood),
        voice: s.voice ? { address: s.voice.address, emoji: s.voice.emoji, tone: s.voice.tone } : null,
        recent: s.recent,
        work: s.work,
        agentive: s.agentive,
        host: s.host,
        speech: (() => {
          const log = readChatLog();
          const mine = log.lines.filter((l) => l.role === 'assistant').slice(-3);
          return { count: log.lines.length, last: mine.map((l) => l.text) };
        })(),
        // 记忆库的"版本信息"：条数 + 最新一条的更新时间。
        // 老大刚说的话被写进去之后 newestAt 立刻变化 —— 用它可以确认
        // 「记忆写入 → 影响桌宠说话」这条链路真的通了，不用猜。
        memory: (() => {
          const entries = Array.isArray(s.memory?.entries) ? s.memory.entries : [];
          const newestAt = entries.reduce((mx, e) => Math.max(mx, Number(e?.updatedAt ?? 0)), 0);
          const fresh = freshMemoryEntries(s.memory, { minutes: 30, limit: 3 }).map((m) => m.text);
          return { total: entries.length, newestAt, fresh };
        })(),
        client: { bootAt: diag.bootAt, pings: diag.pings.slice(-14) },
        session: { id: petSessionId || null, diag: sessionDiag },
        ...(searchParams.get('graph') === '1' ? { graph: graphProbe() } : null),
      });
    }

    if (pathname === `${ROUTE_PREFIX}/chatlog`) {
      // 桌宠的会话账本：气泡里说的话、聊天面板里说的话、主动搭话，全在一份里。
      // 左键弹气泡和右键开聊天面板是同一个会话的两个视图，靠这个端点对齐。
      if (method === 'GET') {
        const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit')) || 60));
        const log = readChatLog();
        return sendJson(res, 200, { ok: true, lines: log.lines.slice(-limit) });
      }
      if (method === 'POST') {
        let payload;
        try {
          payload = JSON.parse((await readBody(req)) || '{}');
        } catch {
          payload = {};
        }
        const ok = appendChatLog({
          role: payload?.role === 'user' ? 'user' : 'assistant',
          kind: payload?.kind === 'proactive' ? 'proactive' : payload?.kind === 'local' ? 'local' : 'chat',
          text: payload?.text,
          at: Date.now(),
        });
        return sendJson(res, ok ? 200 : 400, { ok, error: ok ? undefined : 'empty text' });
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    if (pathname === `${ROUTE_PREFIX}/chat`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { ok: false, error: 'malformed JSON body' });
      }
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (text === '') return sendJson(res, 400, { ok: false, error: 'empty text' });
      const history = Array.isArray(payload?.history)
        ? payload.history
            .slice(-MAX_HISTORY)
            .map((m) => ({
              role: m?.role === 'assistant' ? 'assistant' : 'user',
              content:
                typeof m?.content === 'string' ? m.content : typeof m?.text === 'string' ? m.text : '',
            }))
            .filter((m) => m.content.trim() !== '')
        : [];

      const s = snap(payload?.session || searchParams.get('session') || undefined);
      const directHits = recallMemories(text, s.memory, 5);
      const memories = [...directHits, ...expandHits(directHits, 2, { entries: s.memory?.entries })];
      // 刚聊过什么：桌宠自己的账本（主动说的话也在这儿，不只是面板里的聊天记录）
      const logLines = readChatLog()
        .lines.slice(-6)
        .map((l) => `${l.role === 'user' ? '老大' : '我'}：${l.text}`)
        .join('\n');
      let freshChat = [];
      const system = buildSystem({
        persona: s.persona,
        mood: s.mood,
        voice: s.voice,
        memories,
        fresh: (freshChat = freshMemoryEntries(s.memory, { minutes: 30, limit: 4 })),
        rules: bottomline(s.memory, 2),
        extra: logLines ? `【刚刚聊过】\n${logLines}` : undefined,
      });
      const started = Date.now();
      // 先在真实工作区会话里跑（老大能在客户端里看着、随时接管）；
      // 会话这条路不通（没装上、被禁、超时）就退回自己直连 LLM 的老路，
      // 桌宠不能因为"要可监控"就哑掉。
      let viaSession = null;
      if (payload?.via !== 'direct') {
        try {
          viaSession = await askViaSession({ text, system });
        } catch (e) {
          console.warn(`${TAG} 会话通道失败，退回直连：${String(e?.message || e)}`);
          viaSession = null;
        }
      }
      let out;
      if (viaSession && viaSession.text) {
        out = { ok: true, text: viaSession.text };
      } else {
        out = await generateChat(ctx, system, history, text);
      }
      if (!out.ok) {
        console.warn(`${TAG} 聊天生成失败：${out.message}`);
        return sendJson(res, 502, { ok: false, error: out.message });
      }
      console.log(
        `${TAG} chat ok ${Date.now() - started}ms，注入记忆 ${memories.length} 条，心情 ${s.mood?.mood ?? '?'}${
          viaSession?.sessionId ? `，会话 ${viaSession.sessionId}` : ''
        }`,
      );
      const reply = cleanReply(out.text);
      // 记进桌宠自己的账本：主动开口时好知道自己刚聊过啥
      appendChatLog({ role: 'user', kind: 'chat', text });
      appendChatLog({ role: 'assistant', kind: 'chat', text: reply });
      // 写回共享大脑：主会话收不到桌宠这边说的话，这里补上（失败不影响聊天）
      try {
        const origin = ctx.webServer?.getOrigin?.();
        if (origin) {
          void rememberChat({ origin, text, reply }).then((r) => {
            if (r.ok) console.log(`${TAG} 记忆已写回：${r.module} · ${r.note}`);
            else if (r.error !== 'not worth remembering' && r.error !== 'duplicate') {
              console.warn(`${TAG} 记忆写回失败：${r.error}`);
            }
          });
        }
      } catch (e) {
        console.warn(`${TAG} 记忆写回异常：${String(e?.message || e)}`);
      }
      return sendJson(res, 200, {
        ok: true,
        reply,
        mood: s.mood
          ? { mood: s.mood.mood, band: s.mood.band, dims: s.mood.dims, updatedAt: s.mood.updatedAt }
          : null,
        action: actionPool(s.mood)[0],
        actions: actionPool(s.mood),
        memories: memories.map((m) => m.text),
        fresh: freshChat.map((m) => m.text),
      });
    }

    if (pathname.startsWith(`${ROUTE_PREFIX}/anim/`)) {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      let raw;
      try {
        raw = decodeURIComponent(pathname.slice(`${ROUTE_PREFIX}/anim/`.length));
      } catch {
        return sendJson(res, 400, { ok: false, error: 'bad path' });
      }
      const animName = raw.endsWith('.webm') ? raw.slice(0, -5) : raw;
      // 白名单：只认真实存在的文件名，杜绝 ../ 穿越。
      // 素材可能是插件跑起来之后才拷进来的（上游更新、用户自己换素材），
      // 启动时扫的那份名单会过期 —— 认不出来时补扫一次目录，比让人重启宿主靠谱。
      if (!available.has(animName)) {
        rescanAnimations(available);
        if (!available.has(animName)) return sendJson(res, 404, { ok: false, error: 'unknown animation' });
      }
      return sendWebm(res, join(WEBM_DIR, `${animName}.webm`));
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          let url;
          try {
            url = new URL(req.url ?? '/', 'http://127.0.0.1');
          } catch {
            sendJson(res, 400, { ok: false, error: 'bad url' });
            return;
          }
          handle(req, res, url.pathname, url.searchParams).catch((e) => {
            console.error(`${TAG} 路由异常：`, e);
            if (!res.writableEnded) sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
          });
        },
      }),
    'dsh-pet-brain: /pet-brain routes',
  );

  /*
   * 自动拉起桌面助手 —— 但尊重「用户主动关过」这件事。
   *
   * 为什么延迟一拍：apply 跑的时候 webServer 还没 listen，getOrigin() 会抛；
   * helper 一起来就打 /pet-brain/config，路由得先注册好。
   * 宿主端口每次重启都变，所以 origin 必须在拉起这一刻现取。
   */
  ctx.effect(() => {
    const timer = setTimeout(() => {
      if (desktopPrefs().closedByUser) {
        console.log(`${TAG} 桌面助手：上次是你自己关掉的，这次不自动起（要开就 POST /pet-brain/desktop {"action":"start"}）`);
        return;
      }
      try {
        const origin = ctx.webServer.getOrigin();
        const r = startDesktop({ origin, width: PET_SIZE });
        if (!r.ok) console.warn(`${TAG} 桌面助手没起来：${r.error}`);
        else console.log(`${TAG} 桌面助手已启动 pid=${r.pid} → ${origin}`);
      } catch (e) {
        console.warn(`${TAG} 桌面助手跳过：${e?.message || e}`);
      }
    }, 1500);
    // 插件卸载/宿主退出时把 helper 一起收掉，别留孤儿进程
    return () => {
      clearTimeout(timer);
      stopDesktop();
    };
  }, 'dsh-pet-brain: desktop helper');
}

// 供排障/测试：把档位映射表导出去
export { ANIMATIONS, BAND_ACTIONS, bandOf, moodAction };
