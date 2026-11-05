/**
 * 让桌宠也能"顺图带邻居"。
 *
 * 共享大脑的召回在它自己进程里做（命中后顺着记忆图谱再捞一跳），桌宠走的是文件契约、
 * 自己实现的那套关键词匹配，所以吃不到这个好处。这里补上：读共享大脑落盘的 graph.json，
 * 按 memory → mentions → entity → mentions → memory 的二跳路径找邻居。
 *
 * 口径与共享大脑 `lib/memory-graph.js` 的 `expandWithNeighbors` 对齐：
 * 邻居分数一定低于直接命中（两跳各衰减一次、再乘桥梁系数），枢纽实体按 1/sqrt(度数) 阻尼，
 * 同一个实体最多贡献 maxPerEntity 条，免得「表情」这种高频词把名额占满。
 *
 * 只读不写：graph.json 是共享大脑的派生缓存，桌宠不改它。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULTS = {
  decay: 0.55,
  bridgeWeight: 0.6,
  maxPerEntity: 2,
  hubDamping: true,
};

/** graph.json 的 mtime+size 缓存（165 条记忆 = 500+ 节点，每轮都解析太亏） */
const cache = { path: '', mtimeMs: 0, size: 0, value: null };

/** 共享大脑状态目录（与 brain.js 同口径，但这里不 import 它，避免循环依赖） */
function sharedDirPath() {
  const env = process.env.DSH_HOME;
  const home = typeof env === 'string' && env.trim() !== '' ? env.trim() : join(homedir(), '.dsh');
  return join(home, 'storages', 'dsh-shared-brain');
}

/** 读图谱（缓存命中直接返回；文件不存在返回 null，桌宠照常降级跑） */
export function readGraph() {
  const path = join(sharedDirPath(), 'graph.json');
  try {
    const st = statSync(path);
    if (cache.value && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
      return cache.value;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    cache.path = path;
    cache.mtimeMs = st.mtimeMs;
    cache.size = st.size;
    cache.value = parsed;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 给已命中的记忆补上图谱邻居。
 *
 * @param {Array<{id:string,text:string,module:string,weight:number}>} hits recallMemories 的结果
 * @param {number} limit 最多补几条
 * @param {object} [options] decay / bridgeWeight / maxPerEntity / hubDamping
 * @returns {Array<{id,text,module,weight,pinned,viaEntity:string}>} 只返回**新增**的邻居
 */
export function expandHits(hits, limit = 2, options = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length === 0 || limit <= 0) return [];
  const graph = readGraph();
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return [];

  const opt = { ...DEFAULTS, ...options };
  const nodeById = new Map();
  for (const n of graph.nodes) if (n && n.id) nodeById.set(String(n.id), n);

  // 图节点只存了 label（正文被截到 60 字），完整文本回 memory.json 里取
  const entryById = new Map();
  for (const e of Array.isArray(options.entries) ? options.entries : []) {
    if (e && e.id) entryById.set(String(e.id), e);
  }

  // entity -> 提到它的记忆（"谁连到这个实体"）
  const mentionsOf = new Map();
  for (const e of graph.edges) {
    if (!e || e.kind !== 'mentions') continue;
    const from = nodeById.get(String(e.from));
    const to = nodeById.get(String(e.to));
    if (!from || !to) continue;
    const mem = from.type === 'memory' ? from : to.type === 'memory' ? to : null;
    const ent = from.type === 'entity' ? from : to.type === 'entity' ? to : null;
    if (!mem || !ent) continue;
    if (!mentionsOf.has(ent.id)) mentionsOf.set(ent.id, []);
    mentionsOf.get(ent.id).push({ memId: mem.id, weight: Number(e.weight) || 1 });
  }

  const known = new Set(list.map((h) => String(h?.id ?? '')));
  const scored = new Map();
  const perEntity = new Map();

  for (const hit of list) {
    const memNode = nodeById.get(String(hit?.id ?? ''));
    if (!memNode) continue;
    // 这条记忆提到的实体
    const entities = [];
    for (const e of graph.edges) {
      if (!e || e.kind !== 'mentions') continue;
      const from = nodeById.get(String(e.from));
      const to = nodeById.get(String(e.to));
      if (!from || !to) continue;
      if (from.type === 'entity' && String(to.id) === memNode.id) entities.push({ ent: from, weight: Number(e.weight) || 1 });
      else if (to.type === 'entity' && String(from.id) === memNode.id) entities.push({ ent: to, weight: Number(e.weight) || 1 });
    }
    let base = 1;
    for (const { ent, weight } of entities) {
      const linked = mentionsOf.get(ent.id) || [];
      const degree = linked.length;
      if (degree <= 1) continue;
      const damping = opt.hubDamping ? 1 / Math.sqrt(Math.max(1, degree)) : 1;
      let taken = perEntity.get(ent.id) ?? 0;
      for (const other of linked) {
        if (taken >= opt.maxPerEntity) break;
        if (other.memId === memNode.id || known.has(other.memId)) continue;
        const node = nodeById.get(other.memId);
        if (!node || node.archived === true) continue;
        const score = base * opt.decay * opt.decay * other.weight * opt.bridgeWeight * damping;
        const prev = scored.get(other.memId);
        if (!prev || prev.score < score) {
          scored.set(other.memId, { score, label: ent.label || ent.id, node });
        }
        taken += 1;
      }
      perEntity.set(ent.id, taken);
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ label, node }) => {
      const full = entryById.get(String(node.id));
      return {
        id: String(node.id),
        text: String(full?.text ?? node.label ?? '').trim(),
        module: String(full?.module ?? node.module ?? 'cognition'),
        weight: Number(full?.weight ?? node.weight ?? 0.5),
        pinned: (full?.pinned ?? node.pinned) === true,
        viaEntity: String(label),
      };
    })
    .filter((x) => x.text !== '');
}
