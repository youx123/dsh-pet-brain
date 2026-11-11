/**
 * 心情 → 动画的映射（纯逻辑，不碰宿主、不读盘）。
 *
 * 2026-11-11 从 index.js 抽出来：原来这套表挂在插件入口上，
 * 想写单测就得 import 整个插件，会拖起宿主依赖。抽成独立模块之后
 * 只依赖 brain.js 的 DIM_KEYS，能单独跑。
 *
 * 三层判定，从细到粗：
 *   1. 两维同时突出（≥4）→ COMBO_ACTIONS 组合池（「又开心又想撒娇」）
 *   2. 单维突出（≥4）     → DIM_TIERS 按强度分 strong(≥7) / mild(4~6)
 *   3. 都不突出           → BAND_ACTIONS 按 mood 档位
 */

import { DIM_KEYS } from './brain.js';

/**
 * 心情档位 → 动作（真实文件名，全部在 assets/webm 里）。
 * 键与 brain.js 的 bandOf 一一对应。
 */
export const BAND_ACTIONS = {
  delighted: ['工作状态-雀跃庆祝', '轻快摇摆舞', '放烟花', '原地跳跃抓碎头顶物品', '点击回应-开心跃动'],
  happy: ['点击回应-开心跃动', '点击回应-元气挥手', '可爱宅舞', '荡秋千', '吃糖葫芦'],
  ok: ['悠闲哼歌', '超大伸懒腰', '摇扇纳凉', '撸猫', '照镜子', '写代码'],
  heartache: ['碎碎念-发呆碎碎念', '原地小憩沉眠', '哈欠连天', '深度思考碎碎念'],
  sad: ['原地小憩沉眠', '工作状态-垂头叹气冒汗', '深度思考碎碎念', '东张西望'],
  unknown: ['待机呼吸休闲', '东张西望', '原地漂浮踏步'],
};

/**
 * 七维某一维突出时，再按**强度**分两档挑动作。
 *
 * 以前只有一个 DIM_HOT = 6 的硬门槛：实测共享大脑判出来的维度多在 3~5，
 * 永远够不到 6，于是桌宠永远退回「按 mood 分档」的粗粒度动作 ——
 * 4 分的「有点担心」和 9 分的「非常担心」演的是同一套。
 *
 * 现在 4 分就算突出，7 分以上走 strong 池（幅度更大的动作），
 * 4~6 走 mild 池（收着演）。两档的差别在动作幅度，不是换情绪。
 */
export const DIM_TIERS = {
  happy: {
    strong: ['放烟花', '原地跳跃抓碎头顶物品', '点击回应-挠痒咯咯笑', '轻快摇摆舞'],
    mild: ['点击回应-元气挥手', '开心小跑', '可爱宅舞', '点击回应-开心跃动'],
  },
  calm: {
    strong: ['超大伸懒腰', '摇扇纳凉', '撸猫', '原地小憩沉眠'],
    mild: ['悠闲哼歌', '照镜子', '原地漂浮踏步', '待机呼吸休闲'],
  },
  sweet: {
    strong: ['收红包', '点击回应-害羞惊讶', '点击回应-挠痒咯咯笑'],
    mild: ['可爱宅舞', '点击回应-害羞惊讶', '照镜子'],
  },
  heartache: {
    strong: ['碎碎念-发呆碎碎念', '原地小憩沉眠', '深度思考碎碎念'],
    mild: ['东张西望', '哈欠连天', '工作状态-思考冒泡'],
  },
  worry: {
    strong: ['工作状态-原地踱步张望', '侧身急躁跑', '深度思考碎碎念'],
    mild: ['工作状态-思考冒泡', '东张西望', '原地漂浮踏步'],
  },
  sad: {
    strong: ['工作状态-垂头叹气冒汗', '原地小憩沉眠', '碎碎念-发呆碎碎念'],
    mild: ['哈欠连天', '东张西望', '深度思考碎碎念'],
  },
  jealous: {
    strong: ['玩游戏气急败坏', '用鲸鱼尾巴拍打地面', '点击回应-傲娇生气'],
    mild: ['点击回应-傲娇生气', '照镜子', '东张西望'],
  },
};

/**
 * 两维同时突出时的组合动作 —— 单看哪一维都不够准。
 * 键是「维度|维度」，按字母序拼（happy|sweet 和 sweet|happy 都认）。
 */
export const COMBO_ACTIONS = {
  'happy|sweet': ['收红包', '点击回应-害羞惊讶', '点击回应-挠痒咯咯笑'],
  'calm|happy': ['荡秋千', '摇扇纳凉', '轻快摇摆舞'],
  'heartache|sweet': ['点击回应-害羞惊讶', '碎碎念-发呆碎碎念'],
  'calm|sweet': ['收红包', '照镜子', '撸猫'],
  'happy|worry': ['工作状态-雀跃庆祝', '点击回应-元气挥手'],
  'sad|worry': ['工作状态-垂头叹气冒汗', '深度思考碎碎念', '原地小憩沉眠'],
  'heartache|sad': ['原地小憩沉眠', '碎碎念-发呆碎碎念', '哈欠连天'],
  'heartache|jealous': ['点击回应-傲娇生气', '碎碎念-发呆碎碎念'],
  'jealous|worry': ['侧身急躁跑', '玩游戏气急败坏'],
};

/** 维度值达到这个数就算「突出」（共享大脑七维 0~10 量级） */
export const DIM_HOT = 4;
/** 到这个数走 strong 池：动作幅度更大，不是换情绪 */
export const DIM_STRONG = 7;

/**
 * 按维度值从高到低排，值相同就按 DIM_KEYS 的固定顺序，
 * 免得每次启动「开心」和「平静」谁先谁后不一样。
 */
export function rankedDims(mood) {
  const dims = mood?.dims ?? {};
  const list = [];
  for (const key of DIM_KEYS) {
    const value = Number(dims[key] ?? 0);
    if (Number.isFinite(value) && value > 0) list.push({ key, value });
  }
  list.sort((a, b) => b.value - a.value || DIM_KEYS.indexOf(a.key) - DIM_KEYS.indexOf(b.key));
  return list;
}

/**
 * 心情 → 动作签名。
 * 返回 `{ band, top, tier, pool }`，`top` 是参与判定的维度（方便 /state 排障）。
 */
export function moodSignature(mood) {
  const bandId = typeof mood?.band === 'string' ? mood.band : mood?.band?.id ?? 'unknown';
  if (!mood) return { band: 'unknown', top: [], tier: 'band', pool: BAND_ACTIONS.unknown };
  const ranked = rankedDims(mood);
  const first = ranked[0];
  if (first && first.value >= DIM_HOT) {
    const second = ranked[1];
    if (second && second.value >= DIM_HOT) {
      const comboKey = [first.key, second.key].sort().join('|');
      if (COMBO_ACTIONS[comboKey]) {
        return { band: bandId, top: [first.key, second.key], tier: 'combo', pool: COMBO_ACTIONS[comboKey] };
      }
    }
    const tier = DIM_TIERS[first.key];
    if (tier) {
      const strong = first.value >= DIM_STRONG;
      return {
        band: bandId,
        top: [first.key],
        tier: strong ? 'strong' : 'mild',
        pool: strong ? tier.strong : tier.mild,
      };
    }
  }
  return {
    band: bandId,
    top: first ? [first.key] : [],
    tier: 'band',
    pool: BAND_ACTIONS[bandId] ?? BAND_ACTIONS.unknown,
  };
}

/** 只要动作池时用这个（渲染端每次拿一批候选，自己挑一个播）。 */
export function actionPool(mood) {
  return moodSignature(mood).pool;
}
