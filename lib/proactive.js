/**
 * 主动互动决策层（共享大脑口径的桌宠适配版）。
 *
 * 为什么有这层：
 *   共享大脑的 lib/proactive-mood.js 里已经有一套很成熟的决策 —— 安静期、
 *   每日额度均匀铺开、低落时更关心但有次数上限、话题轮换。它是纯函数，
 *   但共享大脑的 package.json 只导出 "."（整个 apply 入口），import 它的
 *   内部文件会执行 apply 副作用，会把整个插件挂起来两次。
 *   所以这里按**同一口径**实现一份，喂给它的数据全部来自共享大脑落盘：
 *     - 情绪信号：emotion.json 的 states[最新会话].mood + .dims
 *     - 配置：modules.json 的 agentive（含 agentive.mood 覆盖）
 *     - 历史：storages/dsh-shared-brain/proactive-history.json
 *
 * 与共享大脑的差异（都是刻意为之）：
 *   1. 共享大脑的主动互动绑在主会话 sessionId 上，桌宠是独立进程没有会话，
 *      所以桌宠用固定 key 'pet' 存在同一份 history 里 —— 搭话历史、每日额度、
 *      关心次数跟主会话共用一套口径。
 *   2. 共享大脑决策完是让模型生成一段话；桌宠这边除了说话还要选动作，
 *      所以额外返回 tone → 动作池的映射建议，由渲染侧执行。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome } from './brain.js';

/** 桌宠在共享大脑历史里的固定会话键。 */
export const PET_SESSION_KEY = 'pet';

// ────────────────────────────────────────────────────────────────────
// 一、情绪语义（与共享大脑 lib/emotion.js 完全对齐）
// ────────────────────────────────────────────────────────────────────

/** 七维键，顺序与共享大脑 DIMS 一致。 */
export const DIMS = [
  ['happy', '开心'],
  ['calm', '踏实'],
  ['sweet', '甜蜜'],
  ['heartache', '心疼'],
  ['worry', '担心'],
  ['sad', '难过'],
  ['jealous', '吃醋'],
];

/** 心情分 → 档位。键名沿用共享大脑 moodBand 的 key，别自造。 */
export function moodBand(mood) {
  const m = Number(mood);
  if (!Number.isFinite(m)) return { key: 'ok', label: '一般' };
  if (m >= 80) return { key: 'delighted', label: '欢喜' };
  if (m >= 62) return { key: 'happy', label: '开心' };
  if (m >= 42) return { key: 'ok', label: '一般' };
  if (m >= 25) return { key: 'heartache', label: '心疼' };
  return { key: 'sad', label: '难过' };
}

/** 属于「低落」倾向的维度。 */
const LOW_DIMS = new Set(['heartache', 'worry', 'sad']);
/** 属于「高昂」倾向的维度。 */
const HIGH_DIMS = new Set(['happy', 'sweet']);

// ────────────────────────────────────────────────────────────────────
// 二、配置（共享大脑 PROACTIVE_MOOD_DEFAULTS 的默认值）
// ────────────────────────────────────────────────────────────────────

export const PROACTIVE_MOOD_DEFAULTS = {
  enabled: true,
  lowMood: 45,
  highMood: 78,
  quietPeriodMs: 30 * 60 * 1000,
  maxPerDay: 3,
  lowIntervalFactor: 0.5,
  highIntervalFactor: 0.7,
  maxConcernsPerSession: 1,
  allowConcern: true,
  allowShare: true,
};

/** 共享大脑的基准间隔与抖动系数（lib/proactive.js 同值）。 */
export const DEFAULT_PROACTIVE_INTERVAL_MS = 15 * 60 * 1000;
export const PROACTIVE_INTERVAL_JITTER = 0.5;
export const MIN_PROACTIVE_INTERVAL_MS = 60 * 1000;
export const MAX_PROACTIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 规整配置：null / undefined / 空串 = 没填，用默认值；只有真数字才夹紧。 */
export function normalizeProactiveMoodConfig(raw) {
  const base = { ...PROACTIVE_MOOD_DEFAULTS };
  if (!raw || typeof raw !== 'object') return base;
  if (typeof raw.enabled === 'boolean') base.enabled = raw.enabled;
  const num = (key, min, max, fallback) => {
    if (raw[key] === null || raw[key] === undefined || raw[key] === '') return fallback;
    const value = Number(raw[key]);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  };
  base.lowMood = num('lowMood', 0, 100, base.lowMood);
  base.highMood = num('highMood', 0, 100, base.highMood);
  base.quietPeriodMs = num('quietPeriodMs', 0, 24 * 3600 * 1000, base.quietPeriodMs);
  base.maxPerDay = num('maxPerDay', 0, 50, base.maxPerDay);
  base.lowIntervalFactor = num('lowIntervalFactor', 0.1, 2, base.lowIntervalFactor);
  base.highIntervalFactor = num('highIntervalFactor', 0.1, 2, base.highIntervalFactor);
  base.maxConcernsPerSession = num('maxConcernsPerSession', 0, 10, base.maxConcernsPerSession);
  if (typeof raw.allowConcern === 'boolean') base.allowConcern = raw.allowConcern;
  if (typeof raw.allowShare === 'boolean') base.allowShare = raw.allowShare;
  return base;
}

/** 基准间隔夹紧。 */
export function clampProactiveInterval(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return DEFAULT_PROACTIVE_INTERVAL_MS;
  return Math.min(MAX_PROACTIVE_INTERVAL_MS, Math.max(MIN_PROACTIVE_INTERVAL_MS, value));
}

/**
 * 随机化间隔 —— 共享大脑的做法：base × (1 ± jitter)。
 * 老大明确说过「间隔时间改为随机的情况」，这里就是那个随机。
 */
export function randomizeInterval(baseMs, rand = Math.random) {
  const base = clampProactiveInterval(baseMs);
  const delta = base * PROACTIVE_INTERVAL_JITTER;
  return Math.round(base - delta + rand() * delta * 2);
}

// ────────────────────────────────────────────────────────────────────
// 三、话题库（共享大脑 proactive-mood.js 的 TOPIC_LIBRARY 同款结构）
// ────────────────────────────────────────────────────────────────────

export const TOPIC_LIBRARY = [
  { key: 'greeting', label: '随口招呼' },
  { key: 'progress', label: '问问进展' },
  { key: 'pending', label: '有件事想提' },
  { key: 'rest', label: '提醒歇会儿' },
  { key: 'weather', label: '闲聊天气' },
  { key: 'memory', label: '翻旧账' },
];

export const CONCERN_TOPICS = [
  { key: 'concern-tired', label: '问问他累不累' },
  { key: 'concern-mood', label: '关心他心情' },
  { key: 'concern-stuck', label: '问他是不是卡住了' },
];

export const SHARE_TOPICS = [
  { key: 'share-win', label: '分享个小进展' },
  { key: 'share-good', label: '报个好消息' },
];

/** 挑话题，避开用过的。 */
export function pickTopic(options = {}) {
  const pool = Array.isArray(options.pool) && options.pool.length ? options.pool : TOPIC_LIBRARY;
  const used = Array.isArray(options.used) ? options.used : [];
  const exclude = Array.isArray(options.exclude) ? options.exclude : [];
  const fresh = pool.filter((t) => !used.includes(t.key) && !exclude.includes(t.key));
  const list = fresh.length ? fresh : pool.filter((t) => !exclude.includes(t.key));
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

/** 记下用过的话题，避免每次同一句。 */
export function rememberTopic(used, key) {
  const list = Array.isArray(used) ? used.slice() : [];
  if (key && !list.includes(key)) list.push(key);
  return list.slice(-12);
}

// ────────────────────────────────────────────────────────────────────
// 四、情绪信号
// ────────────────────────────────────────────────────────────────────

/**
 * 从情绪状态读出信号 —— 与共享大脑 readMoodSignal 同口径。
 * @param {object} moodState { mood, dims }
 * @param {object} config
 * @param {Array} emotions 情感记忆条目（可选，用于算 emotionBias）
 */
export function readMoodSignal(moodState, config = PROACTIVE_MOOD_DEFAULTS, emotions = []) {
  const cfg = normalizeProactiveMoodConfig(config);
  const mood = Number(moodState?.mood ?? 70);
  const band = moodBand(mood);
  const dims = moodState?.dims && typeof moodState.dims === 'object' ? moodState.dims : {};

  let dominant = '';
  let dominantValue = 0;
  for (const [key] of DIMS) {
    const value = Number(dims[key] ?? 0);
    if (value > dominantValue) {
      dominant = key;
      dominantValue = value;
    }
  }

  let level = 'neutral';
  if (cfg.enabled !== false) {
    if (mood < cfg.lowMood) level = 'low';
    else if (mood >= cfg.highMood) level = 'high';
    // 分数不低但情绪维度压倒性担心/难过 → 嘴上说没事，心里有事
    else if (dominantValue >= 25 && LOW_DIMS.has(dominant)) level = 'low';
    else if (dominantValue >= 30 && HIGH_DIMS.has(dominant)) level = 'high';
  }

  // 情感记忆里的负向情绪累积到 -0.9 → 也判低落
  const bias = emotionBiasOf(emotions);
  if (cfg.enabled !== false && level === 'neutral' && bias <= -0.9) level = 'low';

  return {
    band,
    mood,
    dominant,
    dominantValue,
    level,
    dims,
    emotionBias: bias,
    emotionHits: emotions.length,
  };
}

/**
 * 情感条目的极性偏置：负向情绪（讨厌/不悦/担心）累积到 -0.9 判低落。
 * 正向不改 level（关系好不代表要更亢奋）。
 */
export function emotionBiasOf(emotions = []) {
  const NEGATIVE = new Set(['dislike', 'hate', 'worry', 'resent']);
  const POSITIVE = new Set(['like', 'love', 'care', 'grateful']);
  let bias = 0;
  let hits = 0;
  for (const entry of emotions) {
    const sentiment = String(entry?.sentiment ?? entry?.module ?? '');
    if (NEGATIVE.has(sentiment)) {
      bias -= 0.5;
      hits += 1;
    } else if (POSITIVE.has(sentiment)) {
      bias += 0.2;
      hits += 1;
    }
  }
  return Math.max(-1, Math.min(1, bias));
}

// ────────────────────────────────────────────────────────────────────
// 五、决策
// ────────────────────────────────────────────────────────────────────

/**
 * 决定这一轮说不说话、什么调子、聊什么。
 * @param {object} input { moodState, history, config, now, dayEnd }
 * @returns {object} { action:'speak'|'silent', reason, tone, topic, intervalFactor, signal }
 */
export function decideProactive(input = {}) {
  const config = normalizeProactiveMoodConfig(input.config);
  const now = Number(input.now ?? Date.now());
  const history = input.history && typeof input.history === 'object' ? input.history : {};

  const signal = readMoodSignal(config.enabled ? input.moodState : null, config, input.emotions ?? []);

  const pending = Array.isArray(history.pending) ? history.pending.filter(Boolean) : [];
  const lastSpokeAt = Number(history.lastSpokeAt ?? 0);
  const sinceLast = lastSpokeAt > 0 ? now - lastSpokeAt : Infinity;
  const concerns = Number(history.concerns ?? 0);
  const hasConcern = config.allowConcern && concerns < config.maxConcernsPerSession;

  // 安静期是所有主动说话的闸门（包括关心和分享）。
  const concernGapFactor = concerns > 0 ? 4 : 0.5;
  const quietFactor =
    pending.length > 0 ? 0.5 : signal.level === 'low' ? concernGapFactor : signal.level === 'high' ? 0.7 : 1;
  const quietThreshold = config.quietPeriodMs * quietFactor;
  if (sinceLast < quietThreshold) {
    return {
      action: 'silent',
      reason: 'quiet-period',
      tone: signal.level === 'low' ? 'soft' : signal.level === 'high' ? 'upbeat' : 'neutral',
      topic: null,
      intervalFactor:
        signal.level === 'low' ? config.lowIntervalFactor : signal.level === 'high' ? config.highIntervalFactor : 1,
      signal,
    };
  }

  // 每日上限 —— 只有「低落时的关心」可以突破日常额度
  const spokeToday = Number(history.spokeToday ?? 0);
  const exempt = signal.level === 'low' && hasConcern;
  const overDaily = config.maxPerDay > 0 && spokeToday >= config.maxPerDay;
  if (overDaily && !exempt) {
    return { action: 'silent', reason: 'daily-limit', tone: 'neutral', topic: null, intervalFactor: 1, signal };
  }

  // 额度均匀铺开：别上午一口气说完、下午到夜里哑火
  if (!exempt && pending.length === 0 && config.maxPerDay > 0) {
    const remainingQuota = config.maxPerDay - spokeToday;
    const dayEndTs = Number(input.dayEnd ?? 0);
    if (remainingQuota > 0 && dayEndTs > now) {
      const evenGap = Math.max(config.quietPeriodMs, (dayEndTs - now) / remainingQuota);
      if (sinceLast < evenGap) {
        return { action: 'silent', reason: 'paced', tone: 'neutral', topic: null, intervalFactor: 1, signal };
      }
    }
  }

  // 有真待办 → 一定要说
  if (pending.length > 0) {
    const topic =
      pickTopic({
        pool: TOPIC_LIBRARY.filter((item) => item.key === 'pending' || item.key === 'progress'),
        used: history.usedTopics ?? [],
        exclude: ['pending'],
      }) ?? TOPIC_LIBRARY.find((item) => item.key === 'pending');
    return { action: 'speak', reason: 'pending', tone: 'neutral', topic, intervalFactor: 1, signal };
  }

  // 低落 → 关心
  if (signal.level === 'low') {
    if (hasConcern) {
      const topic = pickTopic({ pool: CONCERN_TOPICS, used: history.usedTopics ?? [] });
      return {
        action: 'speak',
        reason: 'concern',
        tone: 'soft',
        topic,
        intervalFactor: config.lowIntervalFactor,
        signal,
      };
    }
    // 关心额度用完 → 不闭嘴，退回中性节奏但语气放软
  }

  // 心情好 → 活跃
  if (signal.level === 'high' && config.allowShare) {
    const topic = pickTopic({
      pool: SHARE_TOPICS.length > 0 ? [...SHARE_TOPICS, ...TOPIC_LIBRARY] : TOPIC_LIBRARY,
      used: history.usedTopics ?? [],
    });
    return {
      action: 'speak',
      reason: 'share',
      tone: 'upbeat',
      topic,
      intervalFactor: config.highIntervalFactor,
      signal,
    };
  }

  // 中性 → 安静期已过，说一句
  const moodFactor =
    signal.level === 'low'
      ? config.lowIntervalFactor
      : signal.level === 'high'
        ? config.highIntervalFactor
        : 1;
  const topic = pickTopic({ pool: TOPIC_LIBRARY, used: history.usedTopics ?? [] });
  return {
    action: 'speak',
    reason: signal.level === 'low' ? 'concern-already' : 'routine',
    tone: signal.level === 'low' ? 'soft' : 'light',
    topic,
    intervalFactor: moodFactor,
    signal,
  };
}

/** 语气 → 给渲染侧的措辞说明（不给用户看，给动作/句子选择用）。 */
export const TONE_HINTS = {
  soft: '语气放轻一点，像随口关心一句，不要追问到底。',
  upbeat: '语气轻快一点，可以带点小得意。',
  warm: '语气温和，像老朋友。',
  light: '语气轻松，别一本正经。',
  neutral: '语气平常。',
};

// ────────────────────────────────────────────────────────────────────
// 六、表情亲和（共享大脑 emoji-affinity.js 的桌宠口径版）
// ────────────────────────────────────────────────────────────────────

/** 维度 → 表情偏好与禁忌。 */
export const DIM_EMOJI = {
  happy: { prefer: ['happy', 'laughing', 'star-eyes', 'cheer'], avoid: ['sad', 'crying', 'sigh'] },
  sweet: { prefer: ['heart', 'shy', 'touched', 'hug'], avoid: ['angry', 'eye-roll'] },
  calm: { prefer: ['neutral', 'nodding', 'okay'], avoid: ['overloaded', 'scared'] },
  worry: { prefer: ['sigh', 'please', 'thinking', 'peeking'], avoid: ['celebrate', 'cheer', 'applause', 'cool'] },
  sad: { prefer: ['sad', 'crying', 'sigh', 'hug'], avoid: ['celebrate', 'cheer', 'laughing', 'star-eyes', 'applause'] },
  heartache: { prefer: ['touched', 'hug', 'heart', 'please'], avoid: ['sarcastic', 'eye-roll', 'doge'] },
  jealous: { prefer: ['peeking', 'please', 'shy', 'sigh'], avoid: ['cool', 'celebrate'] },
};

/** 档位 → 表情基调。avoid 是硬禁忌，说错会伤人。 */
export const BAND_EMOJI = {
  delighted: {
    prefer: ['celebrate', 'star-eyes', 'cheer', 'applause', 'playful'],
    avoid: ['sad', 'crying', 'sigh', 'hurt'],
  },
  happy: {
    prefer: ['happy', 'laughing', 'nodding', 'approve', 'playful'],
    avoid: ['sad', 'crying', 'frustrated'],
  },
  ok: {
    prefer: ['neutral', 'okay', 'nodding', 'thinking', 'watching'],
    avoid: [],
  },
  heartache: {
    prefer: ['touched', 'hug', 'please', 'heart'],
    avoid: ['celebrate', 'cheer', 'applause', 'sarcastic', 'eye-roll', 'doge', 'laughing'],
  },
  sad: {
    prefer: ['sad', 'sigh', 'crying', 'hug', 'sorry'],
    avoid: ['celebrate', 'cheer', 'applause', 'laughing', 'star-eyes', 'cool', 'snickering', 'sarcastic'],
  },
};

const NEUTRAL_PREFER = ['neutral', 'okay', 'nodding', 'thinking', 'happy'];

/**
 * 提议这一轮该贴哪些表情。
 * 顺序：先「这个人此刻的情绪维度」，再「这个档位的基调」。
 * @param {object} input { moodState, signal, config, limit }
 */
export function proposeEmoji(input = {}) {
  const config = input.config && typeof input.config === 'object' ? input.config : {};
  const limit = Number(config.limit ?? 3);
  if (config.enabled === false || limit <= 0) {
    return { keys: [], avoid: [], limit, reason: '表情提示已关闭' };
  }
  const signal = input.signal && typeof input.signal === 'object' ? input.signal : null;
  const moodState = input.moodState && typeof input.moodState === 'object' ? input.moodState : null;

  const mood = Number(signal?.mood ?? moodState?.mood ?? 70);
  const band = String(signal?.band?.key ?? 'ok');
  const dims = signal?.dims ?? moodState?.dims ?? {};

  let dominant = '';
  let dominantValue = 0;
  for (const [key] of DIMS) {
    const value = Number(dims[key] ?? 0);
    if (value > dominantValue) {
      dominant = key;
      dominantValue = value;
    }
  }

  const bandRule = BAND_EMOJI[band] ?? BAND_EMOJI.ok;
  const dimRule = DIM_EMOJI[dominant] ?? null;

  const keys = [];
  const push = (list) => {
    for (const key of list ?? []) {
      if (!key || keys.includes(key)) continue;
      keys.push(key);
    }
  };
  push(dimRule?.prefer);
  push(bandRule.prefer);
  push(NEUTRAL_PREFER);

  const avoid = [];
  const pushAvoid = (list) => {
    for (const key of list ?? []) {
      if (!key || avoid.includes(key)) continue;
      avoid.push(key);
    }
  };
  pushAvoid(bandRule.avoid);
  pushAvoid(dimRule?.avoid);

  // 硬禁忌优先：踩到 avoid 的直接剔掉
  const safe = keys.filter((key) => !avoid.includes(key));
  return {
    keys: safe.slice(0, limit),
    avoid,
    dominant,
    band,
    mood,
    reason: `按${dimRule ? dominant : band}档挑的表情`,
  };
}

// ────────────────────────────────────────────────────────────────────
// 七、历史落盘（桌宠自己的账本）
// ────────────────────────────────────────────────────────────────────

/**
 * 历史文件路径 —— **放在桌宠自己的目录，不跟共享大脑共用那份**。
 *
 * 共享大脑的 proactive.js 用「启动时读进内存的快照」整份覆写
 * `storages/dsh-shared-brain/proactive-history.json`。它的内存快照里
 * 没有桌宠那个 'pet' 桶，于是每保存一次就把桌宠的记录整桶抹掉 ——
 * 表现为桌宠的每日额度计数归零、间隔判定失效，变得没完没了地搭话。
 *
 * 所以桌宠的账本自己存一份，格式跟它保持一致（dayStamp/spokeToday/
 * concerns/usedTopics/lastSpokeAt），将来真要合并桶也不会对不上字段。
 */
export function proactiveHistoryFile() {
  return join(dshHome(), 'dsh-pet-brain', 'proactive-history.json');
}

/** 读整份历史。 */
export function readProactiveHistory() {
  try {
    const file = proactiveHistoryFile();
    if (!existsSync(file)) return { version: 1, sessions: {}, updatedAt: 0 };
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return { version: 1, sessions: {}, updatedAt: 0 };
    if (!raw.sessions || typeof raw.sessions !== 'object') raw.sessions = {};
    return raw;
  } catch {
    return { version: 1, sessions: {}, updatedAt: 0 };
  }
}

/** 某个会话键的历史。 */
export function historyOf(sessionKey = PET_SESSION_KEY) {
  const all = readProactiveHistory();
  const entry = all.sessions?.[sessionKey];
  return entry && typeof entry === 'object' ? entry : {};
}

/** 写回某个会话键的历史。 */
export function saveHistory(sessionKey, entry) {
  const file = proactiveHistoryFile();
  // 共享大脑自己也会整份覆写这个文件（它用的是启动时的内存快照）。
  // 所以写完要回读校验：自己的桶被并发覆盖掉就再写一次。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const all = readProactiveHistory();
    all.sessions[sessionKey] = entry;
    all.version = all.version ?? 1;
    all.updatedAt = Date.now();
    try {
      writeFileSync(file, JSON.stringify(all, null, 2), 'utf8');
    } catch {
      /* 写不了就算了，不该因为记账失败把桌宠搞挂 */
      return entry;
    }
    const check = readProactiveHistory().sessions?.[sessionKey];
    if (check && check.lastSpokeAt === entry.lastSpokeAt) return entry;
  }
  return entry;
}

/** 翻到新的一天：昨天说的话归零。 */
export function rollDay(history, now = Date.now()) {
  const today = new Date(now);
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const out = { ...history };
  // 日期字段名跟共享大脑保持一致（它用 dayStamp，我早先自己写成了 day）。
  // 名字不一样的话，两边会各自把对方的计数清零 —— 每日上限就形同虚设。
  const stamp = typeof out.dayStamp === 'string'
    ? out.dayStamp
    : (typeof out.day === 'string' ? out.day : '');
  if (stamp !== key) {
    out.dayStamp = key;
    out.spokeToday = 0;
    out.concerns = 0;
    out.usedTopics = [];
  }
  delete out.day;
  return out;
}

/** 今天还剩多久（毫秒），用于额度均匀铺开。 */
export function dayEndOf(now = Date.now()) {
  const d = new Date(now);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

/** 时间窗判断（共享大脑 inTimeWindow 同口径）。 */
export function inTimeWindow(timeWindow, now = Date.now()) {
  if (!timeWindow || timeWindow.enabled === false) return true;
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const parse = (s) => {
    const [h, m] = String(s ?? '00:00')
      .split(':')
      .map((x) => Number(x) || 0);
    return h * 60 + m;
  };
  const start = parse(timeWindow.start);
  const end = parse(timeWindow.end);
  if (start === end) return true;
  return start < end ? cur >= start && cur <= end : cur >= start || cur <= end;
}
