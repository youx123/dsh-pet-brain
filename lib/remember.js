/**
 * 桌宠对话 → 共享大脑记忆写回
 *
 * 为什么要这层：共享大脑的 summarize 只总结「主会话」，桌宠是独立进程、
 * 独立 sessionId，主会话里发生的事它看得见，但桌宠这边说的话主会话收不到。
 * 这一层把桌宠对话里值得留下来的话，按共享大脑的模块口径写回去，
 * 下一轮（包括主会话）就能召回到 —— 两边共用同一份 memory.json。
 *
 * 口径与共享大脑一致：module 取 cognition / emotion / instinct / bottomline，
 * 走 POST /api/dsh-shared-brain/mutate 的 addItem，
 * 那边会自动做密钥脱敏（redactSecrets）和扁平库同步。
 */

/** 记忆模块白名单（共享大脑 MEMORY_MODULES 的口径） */
const MEMORY_MODULES = new Set(['cognition', 'emotion', 'instinct', 'bottomline']);

/** 底线类：涉及操作限制、硬规矩 */
const BOTTOMLINE_RULES = [
  /不许|不能|别再|不准|禁止|严禁|千万?别|别做|不要做|安全|隐私|保密|删掉|删除/,
  /一定要|必须|只能|只能做|规则是/,
];

/** 情感类：涉及感情、关系、情绪 */
const EMOTION_RULES = [
  /喜欢你|爱你|爱你呀|想你|想你了|在乎你|宠你|抱抱|亲亲|陪我|陪伴/,
  /讨厌你|生气|好气|难过|伤心|委屈|孤单|寂寞|失落|烦死|崩溃|心疼你/,
  /开心|高兴|哈哈|嘻嘻|太棒|好耶|爽|舒服|幸福/,
];

/** 本能类：反复出现的偏好、习惯 */
const INSTINCT_RULES = [
  /我喜[欢欢]|我爱吃|我不吃|我不喜欢|我怕|我讨厌|我不喝|我习惯/,
  /以后(都|别|要|我|你|就|说)|每次都|每次别|从来(不|没)|永远都|一直都|千万别/,
];

/** 写进记忆前先过一遍：这些东西不值得占记忆库 */
const NOISE_RULES = [
  /^[\s\p{P}\p{S}]+$/u, // 纯标点符号
  /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u, // 纯 emoji
  /^(在吗|在不在|嗯+|哦+|哈+|嘿|喂|hi|hello|test|测试)$/i, // 无信息寒暄
];

/** 超过这个长度的对话不适合塞进记忆条目（模型会把长文当指令念） */
const MAX_TEXT = 300;

const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
};

/** 进程内去重：同一句话不重复写 */
const seen = new Set();

/**
 * 判一句话值不值得记、记到哪个模块。
 * @param {string} text 老大说的话
 * @returns {{module:string, weight:number, lifetime:string, ttlMs:number, pinned:boolean, reason:string}|null}
 */
export function classifyChat(text) {
  const t = String(text ?? '').trim();
  if (t.length < 4) return null;
  if (t.length > MAX_TEXT) return null;
  for (const re of NOISE_RULES) if (re.test(t)) return null;

  const hit = (rules) => rules.some((re) => re.test(t));

  if (hit(BOTTOMLINE_RULES)) {
    return {
      module: 'bottomline',
      weight: 0.9,
      lifetime: 'permanent',
      ttlMs: 0,
      pinned: false,
      reason: '命中硬规矩',
    };
  }
  if (hit(EMOTION_RULES)) {
    return {
      module: 'emotion',
      weight: 0.72,
      lifetime: 'permanent',
      ttlMs: 0,
      pinned: false,
      reason: '命中情感表达',
    };
  }
  if (hit(INSTINCT_RULES)) {
    return {
      module: 'instinct',
      weight: 0.68,
      lifetime: 'permanent',
      ttlMs: 0,
      pinned: false,
      reason: '命中稳定偏好',
    };
  }
  return {
    module: 'cognition',
    weight: 0.55,
    lifetime: 'temporary',
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    pinned: false,
    reason: '一般信息',
  };
}

/**
 * 把一句对话写回共享大脑。
 * @param {object} opts
 * @param {string} opts.origin DSH webServer origin（loopback）
 * @param {string} opts.text 老大说的话
 * @param {string} [opts.reply] 桌宠的回复（只作日志，不进记忆）
 * @returns {Promise<{ok:boolean, module?:string, note?:string, error?:string}>}
 */
export async function rememberChat({ origin, text, reply = '' }) {
  const t = String(text ?? '').trim();
  const cls = classifyChat(t);
  if (!cls) return { ok: false, error: 'not worth remembering' };

  const key = hash(`${cls.module}|${t}`);
  if (seen.has(key)) return { ok: false, error: 'duplicate' };
  seen.add(key);
  // 只保留最近 500 条去重记录，别无限涨
  if (seen.size > 500) {
    const first = seen.values().next().value;
    seen.delete(first);
  }

  const body = {
    action: 'addItem',
    module: cls.module,
    text: `老大跟桌宠说：${t}`,
    weight: cls.weight,
    lifetime: cls.lifetime,
    ttlMs: cls.ttlMs,
    pinned: cls.pinned,
  };

  try {
    const res = await fetch(`${origin}/api/dsh-shared-brain/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      return { ok: false, module: cls.module, error: data?.error || `http ${res.status}` };
    }
    return { ok: true, module: cls.module, note: data?.note || '' };
  } catch (e) {
    return { ok: false, module: cls.module, error: String(e?.message || e) };
  }
}

export { MEMORY_MODULES };
