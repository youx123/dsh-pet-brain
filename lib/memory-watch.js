/**
 * 记忆"新鲜度"跟踪 —— 判断哪些记忆是刚进库的。
 *
 * 为什么不能用 updatedAt：
 * 共享大脑的跨端同步是整份合并，每同步一次都会把条目的 updatedAt 全部刷新。
 * 实测 179 条记忆的 updatedAt 全是"5 分钟前"，用它判断"刚学会"等于全库都新鲜。
 *
 * 所以这里记一本自己的账：见过哪些 id、第一次见到是什么时候。
 * 库里冒出一个没见过的 id = 真的新学到的（桌宠自己写回的、主会话写的、别的设备同步过来的都算）。
 *
 * 落盘位置：$DSH_HOME/dsh-pet-brain/memory-watch.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dshHome } from './brain.js';

/** 登记过的 id 最多留这么多条，超了从最老的开始丢 */
const MAX_SEEN = 4000;
/** 超过这么久没见过面的登记记录可以扔掉（不影响"已见过"判断，只是省体积） */
const KEEP_MS = 7 * 24 * 3600 * 1000;

export function watchFile() {
  return join(dshHome(), 'dsh-pet-brain', 'memory-watch.json');
}

function readWatch() {
  try {
    const raw = JSON.parse(readFileSync(watchFile(), 'utf8'));
    if (raw && typeof raw === 'object' && raw.seen && typeof raw.seen === 'object') return raw;
  } catch {
    /* 没有 / 坏了都当第一次 */
  }
  return null;
}

function writeWatch(data) {
  try {
    mkdirSync(dirname(watchFile()), { recursive: true });
    writeFileSync(watchFile(), JSON.stringify(data), 'utf8');
  } catch (e) {
    console.warn('[dsh-pet-brain] 记忆新鲜度账本写盘失败：' + String(e?.message ?? e));
  }
}

function prune(seen, now, bootAt) {
  const ids = Object.keys(seen);
  // 先按时间剪（首次登记的那批不算"刚学会"，也不参与按时间的剪枝）
  for (const id of ids) {
    const at = Number(seen[id] ?? 0);
    if (at === bootAt) continue;
    if (now - at > KEEP_MS) delete seen[id];
  }
  // 还是太多就优先丢非首次登记的老条目
  const rest = Object.keys(seen);
  if (rest.length > MAX_SEEN) {
    rest
      .sort((a, b) => {
        const ba = Number(seen[a] ?? 0) === bootAt ? 0 : 1;
        const bb = Number(seen[b] ?? 0) === bootAt ? 0 : 1;
        if (ba !== bb) return ba - bb;
        return Number(seen[a] ?? 0) - Number(seen[b] ?? 0);
      })
      .slice(0, rest.length - MAX_SEEN)
      .forEach((id) => delete seen[id]);
  }
  return seen;
}

/**
 * 返回"第一次见到、且见到时间在 minutes 之内"的记忆 id 集合。
 * 首次运行会把现有条目全部登记为已见（不会把整个库当成新学的）。
 *
 * @param {object} memory memory.json 内容
 * @param {object} [options]
 * @param {number} [options.minutes=30] 多久之内算刚学会
 * @param {number} [options.now=Date.now()]
 * @returns {Set<string>}
 */
export function freshMemoryIds(memory, { minutes = 30, now = Date.now() } = {}) {
  const entries = Array.isArray(memory?.entries) ? memory.entries : [];
  const cur = readWatch();

  if (!cur) {
    // 第一次跑：全登记成"已见过"，别让整个库都冒成新记忆
    const seen = {};
    for (const e of entries) if (e?.id) seen[e.id] = now;
    writeWatch({ version: 1, bootstrappedAt: now, seen, updatedAt: now });
    return new Set();
  }

  const seen = { ...(cur.seen || {}) };
  const fresh = new Set();
  let changed = false;
  for (const e of entries) {
    const id = e?.id;
    if (!id) continue;
    if (!(id in seen)) {
      seen[id] = now;
      fresh.add(id);
      changed = true;
    }
  }

  if (changed) {
    writeWatch({
      version: 1,
      bootstrappedAt: cur.bootstrappedAt ?? now,
      seen: prune(seen, now, Number(cur.bootstrappedAt ?? now)),
      updatedAt: now,
    });
  }

  const since = now - minutes * 60 * 1000;
  const bootAt = Number(cur.bootstrappedAt ?? -1);
  const out = new Set();
  for (const id of fresh) out.add(id);
  for (const [id, at] of Object.entries(seen)) {
    const t = Number(at);
    // 首次登记的那一批代表"装插件之前就在库里的旧记忆"，永远不算刚学会
    if (t === bootAt) continue;
    if (t >= since) out.add(id);
  }
  return out;
}

/**
 * 直接拿到"刚学会"的条目，按第一次见到的时间倒序。
 *
 * @param {object} memory
 * @param {object} [options]
 * @param {number} [options.minutes=30]
 * @param {number} [options.limit=4]
 * @param {number} [options.now]
 */
export function freshMemoryEntries(memory, { minutes = 30, limit = 4, now = Date.now() } = {}) {
  const entries = Array.isArray(memory?.entries) ? memory.entries : [];
  if (entries.length === 0) return [];
  const ids = freshMemoryIds(memory, { minutes, now });
  if (ids.size === 0) return [];
  const alive = (e) => {
    if (!e || typeof e.text !== 'string' || e.text.trim() === '') return false;
    if (e.module === 'bottomline' || e.archived === true) return false;
    if (e.lifetime === 'temporary' && Number(e.expiresAt ?? 0) > 0 && Number(e.expiresAt) < now) return false;
    return true;
  };
  return entries
    .filter((e) => e && ids.has(e.id) && alive(e))
    .slice(0, limit)
    .map((e) => ({ id: String(e.id), text: String(e.text).trim(), module: String(e.module ?? '') }));
}
