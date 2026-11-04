/**
 * 共享大脑只读适配层（host 半侧）。
 *
 * 只依赖**数据契约**，不 import dsh-shared-brain 的代码：对方 package exports 只有 "."
 * （整个 apply 入口），import 会执行副作用。这里只读它落盘的状态：
 *   $DSH_HOME/storages/dsh-shared-brain/{emotion,memory,persona,modules}.json
 *
 * 读盘用 mtime 缓存：文件没变就不重复解析（memory.json 已经 100KB+，1s 轮询不能每次全解）。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** DSH 用户根：与 dsh-pet 等扩展包同一口径（DSH_HOME 优先，其次 ~/.dsh） */
export function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return join(homedir(), '.dsh');
}

/** 共享大脑状态目录 */
export function sharedDir() {
  return join(dshHome(), 'storages', 'dsh-shared-brain');
}

/** mtime 缓存表：path -> { mtimeMs, size, value } */
const cache = new Map();

/**
 * 读一个 JSON 状态文件（mtime+size 未变则复用上次解析结果）。
 * 文件不存在/解析失败一律返回 undefined——共享大脑没装或还没写过状态时，桌宠要能降级跑。
 */
function readJsonCached(path) {
  try {
    const st = statSync(path);
    const hit = cache.get(path);
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return undefined;
  }
}

/** 一次性取回共享大脑的四份状态（缺哪份都行） */
export function readShared() {
  const dir = sharedDir();
  return {
    dir,
    emotion: readJsonCached(join(dir, 'emotion.json')),
    memory: readJsonCached(join(dir, 'memory.json')),
    persona: readJsonCached(join(dir, 'persona.json')),
    modules: readJsonCached(join(dir, 'modules.json')),
  };
}

// ---------------------------------------------------------------------------
// 人设
// ---------------------------------------------------------------------------

/**
 * 当前生效的人设。persona.json = { current: '<id>', personas: [{id,name,text,bundled}] }
 * @returns {{ id: string, name: string, text: string } | undefined}
 */
export function currentPersona(snap) {
  const p = snap?.persona;
  if (!p || !Array.isArray(p.personas)) return undefined;
  const picked = p.personas.find((x) => x && x.id === p.current) ?? p.personas[0];
  if (!picked) return undefined;
  return {
    id: String(picked.id ?? ''),
    name: String(picked.name ?? picked.id ?? '桌宠'),
    text: String(picked.text ?? ''),
  };
}

// ---------------------------------------------------------------------------
// 心情
// ---------------------------------------------------------------------------

/** 七维情绪（顺序固定，前端按这个顺序显示） */
export const DIM_KEYS = ['happy', 'calm', 'sweet', 'heartache', 'worry', 'sad', 'jealous'];
export const DIM_LABELS = {
  happy: '开心',
  calm: '平静',
  sweet: '甜',
  heartache: '心疼',
  worry: '担心',
  sad: '难过',
  jealous: '吃醋',
};

/**
 * 心情档位：mood 0~100 → 语义带。
 *
 * ★ 这里的分档跟共享大脑 lib/emotion.js 的 moodBand() 完全一致（delighted /
 * happy / ok / heartache / sad），**不要自造档位名** —— 共享大脑的表情禁忌表
 * （BAND_EMOJI）和主动互动决策（decideProactive）都按这套 key 走，
 * 桌宠要是另起一套名，表情建议和语气建议就对不上了。
 */
export function bandOf(mood) {
  const m = Number(mood);
  if (!Number.isFinite(m)) return { id: 'unknown', label: '未知' };
  if (m >= 80) return { id: 'delighted', label: '欢喜' };
  if (m >= 62) return { id: 'happy', label: '开心' };
  if (m >= 42) return { id: 'ok', label: '一般' };
  if (m >= 25) return { id: 'heartache', label: '心疼' };
  return { id: 'sad', label: '难过' };
}

/**
 * 挑一条心情状态。
 * 桌宠不是某个具体会话的延伸，但要"跟着老大现在的状态走"——默认取最近更新过的那条。
 * @param emotion emotion.json 的内容
 * @param preferSession 指定会话 id（留空 = 取最新）
 */
export function pickMood(emotion, preferSession) {
  const states = emotion?.states;
  if (!states || typeof states !== 'object') return undefined;
  const list = Object.values(states).filter((s) => s && typeof s === 'object');
  if (list.length === 0) return undefined;
  let picked;
  if (typeof preferSession === 'string' && preferSession !== '') {
    picked = states[preferSession];
  }
  picked ??= list.reduce((a, b) => (Number(b.updatedAt ?? 0) >= Number(a.updatedAt ?? 0) ? b : a));
  const mood = Number(picked.mood);
  const dims = {};
  for (const k of DIM_KEYS) dims[k] = Number(picked.dims?.[k] ?? 0);
  return {
    sessionId: String(picked.sessionId ?? ''),
    mood: Number.isFinite(mood) ? Math.round(mood * 10) / 10 : 70,
    band: bandOf(mood),
    dims,
    reason: String(picked.lastReason ?? ''),
    confidence: Number(picked.lastConfidence ?? 0),
    delta: Number(picked.lastDelta ?? 0),
    updatedAt: Number(picked.updatedAt ?? 0),
  };
}

/** 心情 → 建议动作（动作名必须是包里真实存在的 webm 文件名） */
export function moodAction(mood) {
  const band = bandOf(mood?.mood).id;
  switch (band) {
    case 'delighted':
      return '工作状态-雀跃庆祝';
    case 'happy':
      return '点击回应-开心跃动';
    case 'ok':
      return '悠闲哼歌';
    case 'heartache':
      return '工作状态-垂头叹气冒汗';
    default:
      return '原地小憩沉眠';
  }
}

// ---------------------------------------------------------------------------
// 记忆召回
// ---------------------------------------------------------------------------

const CJK = /[\u4e00-\u9fff]/;

/**
 * 把一段文本切成检索词：中文取 2-gram（单字太容易误撞），英文/数字取整词。
 * 去重后返回数组。
 */
function tokens(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  // 中文 2-gram
  const cjk = s.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  // 英文/数字词
  for (const w of s.match(/[a-z0-9_.\-]{2,}/g) ?? []) out.add(w);
  return [...out];
}

/**
 * 按当前输入召回相关记忆。
 *
 * 打分 = 命中词数 × 条目权重 × 置顶加成；同分时新的优先。
 * 只取 cognition / emotion / instinct 三类：bottomline 是硬约束，由 buildSystem 单独精简注入，
 * 不参与召回（否则一句闲聊也会把整段底线顶到最前面）。
 *
 * @param {string} query 用户这句话
 * @param {object} memory memory.json 内容
 * @param {number} limit 最多几条
 */
export function recallMemories(query, memory, limit = 5) {
  const entries = memory?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const now = Date.now();
  const qs = tokens(query);
  if (qs.length === 0) {
    // 没有可检索的词（比如"嗯"）：给最近更新的高权重条目，不做相关性判断
    return [...entries]
      .filter((e) => e && e.module !== 'bottomline')
      .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
      .slice(0, Math.min(limit, 3))
      .map(shapeEntry);
  }
  const scored = [];
  for (const e of entries) {
    if (!e || typeof e.text !== 'string' || e.module === 'bottomline') continue;
    if (e.lifetime === 'temporary' && Number(e.expiresAt ?? 0) > 0 && Number(e.expiresAt) < now) continue;
    const hay = tokens(`${e.text} ${Array.isArray(e.tags) ? e.tags.join(' ') : ''}`);
    const set = new Set(hay);
    let hits = 0;
    for (const q of qs) if (set.has(q)) hits += 1;
    if (hits === 0) continue;
    const weight = Number.isFinite(Number(e.weight)) ? Number(e.weight) : 0.5;
    const pin = e.pinned === true ? 1.6 : 1;
    scored.push({ e, score: hits * (0.4 + weight) * pin });
  }
  scored.sort((a, b) => b.score - a.score || Number(b.e.updatedAt ?? 0) - Number(a.e.updatedAt ?? 0));
  return scored.slice(0, limit).map((x) => shapeEntry(x.e));
}

/** 最近更新的几条记忆（给桌面闲聊用，不做相关性检索） */
export function recentMemories(memory, limit = 3) {
  const entries = memory?.entries;
  if (!Array.isArray(entries)) return [];
  const now = Date.now();
  return [...entries]
    .filter((e) => {
      if (!e || typeof e.text !== 'string' || e.module === 'bottomline') return false;
      if (e.lifetime === 'temporary' && Number(e.expiresAt ?? 0) > 0 && Number(e.expiresAt) < now) return false;
      return true;
    })
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
    .slice(0, limit)
    .map(shapeEntry);
}

function shapeEntry(e) {
  return {
    id: String(e.id ?? ''),
    text: String(e.text ?? ''),
    module: String(e.module ?? ''),
    weight: Number(e.weight ?? 0.5),
    pinned: e.pinned === true,
  };
}

/** 从 memory.json 里挑出底线条目（精简后随 system prompt 注入，保证桌宠也守底线） */
export function bottomline(memory, limit = 3) {
  const entries = memory?.entries;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e && e.module === 'bottomline' && typeof e.text === 'string')
    .sort((a, b) => Number(b.weight ?? 0) - Number(a.weight ?? 0))
    .slice(0, limit)
    .map((e) => String(e.text).trim());
}

// ---------------------------------------------------------------------------
// 系统提示词拼装
// ---------------------------------------------------------------------------

/** 时间段描述（桌宠的"现在几点"感） */
function timeContext(now = new Date()) {
  const h = now.getHours();
  const seg = h < 6 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 22 ? '晚上' : '深夜';
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${wd} ${pad(h)}:${pad(now.getMinutes())}（${seg}）`;
}

/**
 * 从 modules.json 里取"声音/说话风格"配置（共享大脑的 voice 模块）。
 * 注意 speech 那段是给语音合成用的物理参数，不该念给模型听，只保留文字风格。
 * @param {object} modules modules.json 内容
 */
export function voiceStyle(modules) {
  const v = modules?.voice;
  if (!v || v.enabled === false) return null;
  const s = v.style ?? {};
  const tics = Array.isArray(s.tics) ? s.tics.filter((t) => typeof t === 'string' && t.trim() !== '') : [];
  const tone = typeof s.tone === 'string' ? s.tone.trim() : '';
  const address = typeof s.address === 'string' ? s.address.trim() : '';
  const emoji = typeof s.emoji === 'string' ? s.emoji : '';
  if (!tone && tics.length === 0 && !address) return null;
  return { tone, tics, emoji, address };
}

/**
 * 拼桌宠这一轮的 system prompt。
 *
 * 与 dsh-pet 的差异就是本插件存在的理由：dsh-pet 的人设是静态配置字符串，
 * 这里的每一段都来自共享大脑的实时状态——人设、心情、召回的记忆每轮都重新取。
 *
 * @param {object} o
 * @param {{name:string,text:string}|undefined} o.persona 共享大脑当前人设
 * @param {object|undefined} o.mood pickMood 的结果
 * @param {Array} o.memories recallMemories 的结果
 * @param {string[]} o.rules bottomline 条目
 * @param {object|undefined} o.voice voiceStyle 的结果
 * @param {Date} [o.now]
 */
export function buildSystem({ persona, mood, memories = [], rules = [], voice, extra, now = new Date() }) {
  const parts = [];
  const who = persona?.name ?? '小深';
  parts.push(persona?.text?.trim() ? persona.text.trim() : `你叫${who}，是老大桌面上的一只小鲸鱼桌宠。`);
  parts.push(
    [
      '',
      '【你现在的身份】',
      `你是老大桌面上的一只桌宠，名字叫「${who}」。你不只是复读机：你有自己的情绪和小心思，` +
        '会撒娇、会吐槽、会主动关心老大在忙什么。',
      '说话短：一般 1~2 句，别写小作文；不用编号列表，不用「好的，我这就为您…」这种腔调。',
      '除非老大明确问起，不要提「人设」「提示词」「插件」「记忆库」这些词。',
    ].join('\n'),
  );

  if (voice) {
    const lines = ['', '【你的说话风格】（共享大脑里配的，跟着走，别念出来）'];
    if (voice.tone) lines.push(`语气：${voice.tone}`);
    if (voice.tics.length > 0) lines.push(`口头禅（偶尔用，别每句都挂）：${voice.tics.join('、')}`);
    if (voice.address) lines.push(`自称：${voice.address}`);
    if (voice.emoji) lines.push(`默认表情：${voice.emoji}`);
    parts.push(lines.join('\n'));
  }

  if (mood) {
    const dims = DIM_KEYS.map((k) => `${DIM_LABELS[k]}${mood.dims[k]}`).join(' ');
    const lines = [
      '',
      '【你现在的心情】（这会影响你的语气，不要逐条念出来）',
      `整体情绪 ${mood.mood}/100（${mood.band.label}）；七维：${dims}`,
    ];
    if (mood.reason) lines.push(`最近一次情绪波动的原因：${mood.reason}`);
    lines.push('心情好就活泼一点，心情低就安静一点、话少一点——但别演得太夸张。');
    parts.push(lines.join('\n'));
  }

  if (memories.length > 0) {
    parts.push(
      [
        '',
        '【和老大这次话题相关的记忆】（能用上就自然带出，别生硬地复述）',
        ...memories.map((m) => `- ${m.text}`),
      ].join('\n'),
    );
  }

  if (rules.length > 0) {
    parts.push(['', '【必须守住的底线】', ...rules.map((r) => `- ${r}`)].join('\n'));
  }

  // 额外指令（主动搭话时的语气/话题提示等）。放在底线之后、时间里，
  // 这样它离"最后一句"最近，模型不容易把提示当成聊天内容复述出来。
  if (extra && typeof extra === 'string' && extra.trim()) {
    parts.push(['', extra.trim()].join('\n'));
  }

  parts.push('', '【现在的时间】', timeContext(now));
  return parts.join('\n');
}

/** 取一次快照并整理成桌宠要用的形状（供 /state 与外层调用） */
export function snapshot({ preferSession } = {}) {
  const shared = readShared();
  const persona = currentPersona(shared);
  const mood = pickMood(shared.emotion, preferSession);
  return { shared, persona, mood, memory: shared.memory };
}
