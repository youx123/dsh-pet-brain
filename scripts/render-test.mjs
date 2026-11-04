/**
 * 离线渲染测试：不启动 DSH，把 client 半侧真跑一遍 render，检查渲染树。
 *
 * 重点抓两类问题（这两类在客户端里都是"白屏/样式整个塌掉"，而且浏览器控制台看不到）：
 *   1. 渲染时抛异常（比如引用了没定义的变量）；
 *   2. 样式对象里出现 undefined —— 通常是 S.xxx 写错名字，React 会静默忽略该属性。
 *
 * 用法：node scripts/render-test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

/* ---------- 极简 React 运行时 ---------- */

let hookIndex = 0;
const stateSlots = [];
const refSlots = [];
/** 指定第几个 useState 返回什么值（用来强行打开各个面板） */
let stateOverrides = {};

function resetHooks() {
  hookIndex = 0;
  // 必须清空：否则上一个用例 override 打开的面板会残留到下一个用例，测出来的节点数全是错的
  stateSlots.length = 0;
  refSlots.length = 0;
}

/** 记录每个 useState 的初始值，方便确认 index 与业务字段的对应关系 */
const stateInit = [];

const react = {
  createElement(type, props, ...children) {
    const flat = [];
    const push = (c) => {
      if (Array.isArray(c)) c.forEach(push);
      else if (c !== null && c !== undefined) flat.push(c);
    };
    children.forEach(push);
    return { type, props: props ?? {}, children: flat };
  },
  useState(init) {
    const i = hookIndex++;
    const fallback = typeof init === 'function' ? init() : init;
    stateInit[i] = stateInit[i] ?? fallback;
    if (!(i in stateSlots)) stateSlots[i] = fallback;
    if (i in stateOverrides) stateSlots[i] = stateOverrides[i];
    return [
      stateSlots[i],
      (v) => {
        stateSlots[i] = typeof v === 'function' ? v(stateSlots[i]) : v;
      },
    ];
  },
  useEffect() {
    hookIndex++;
    // 不执行副作用：真实环境里它们会发请求、挂监听，这里只关心渲染结果
  },
  useRef(init) {
    const i = hookIndex++;
    if (!(i in refSlots)) refSlots[i] = { current: init };
    return refSlots[i];
  },
  useCallback(fn) {
    hookIndex++;
    return fn;
  },
  useMemo(fn) {
    const i = hookIndex++;
    if (!(i in stateSlots)) stateSlots[i] = fn();
    return stateSlots[i];
  },
};

/* ---------- 极简 DOM / window ---------- */

const document = {
  body: { appendChild() {}, contains: () => true },
  head: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  addEventListener() {},
  removeEventListener() {},
};

const sandbox = {
  window: {
    innerWidth: 1536,
    innerHeight: 912,
    addEventListener() {},
    removeEventListener() {},
  },
  document,
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
  cancelAnimationFrame: clearTimeout,
  fetch: () => Promise.reject(new Error('render-test: no network')),
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  localStorage: { getItem: () => null, setItem() {} },
};
sandbox.window.document = document;
sandbox.window.localStorage = sandbox.localStorage;

let loaded = null;
sandbox.window.__ModuleLoader__ = {
  load({ id, factory }) {
    loaded = { id, factory };
  },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
if (!loaded) throw new Error('没有调用 __ModuleLoader__.load');

const require = (name) => {
  if (name === 'react') return react;
  throw new Error(`unexpected require(${name})`);
};

const mod = loaded.factory(require);

/* ---------- 抓注册出来的组件 ---------- */

let element = null;
mod.apply({
  slots: {
    // 真实宿主会把生成器跑起来；这里手动 next 一次，跟 inject 的语义一致
    inject(_name, gen) {
      const it = gen();
      it.next();
    },
    register(_meta, factory) {
      // factory 返回的是 h(Pet, {}) 这个元素，组件函数在 element.type 上
      element = factory();
    },
  },
});

const Pet = element?.type;
if (typeof Pet !== 'function') throw new Error('apply 没有注册组件');

/* ---------- 渲染并体检 ---------- */

function walk(node, path, problems) {
  if (node === null || node === undefined || typeof node !== 'object') return 0;
  if (Array.isArray(node)) {
    return node.reduce((n, c, i) => n + walk(c, `${path}[${i}]`, problems), 0);
  }
  let count = 1;
  const style = node.props?.style;
  if (style && typeof style === 'object') {
    for (const [k, v] of Object.entries(style)) {
      if (v === undefined) problems.push(`${path} 的 style.${k} 是 undefined`);
    }
  }
  for (let i = 0; i < (node.children?.length ?? 0); i++) {
    count += walk(node.children[i], `${path}.${node.type}[${i}]`, problems);
  }
  return count;
}

function collect(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((c) => collect(c, out));
    return out;
  }
  if (node.type) out.push(node);
  (node.children ?? []).forEach((c) => collect(c, out));
  return out;
}

/* 让面板真的有内容可渲染，而不是一堆 "—" 和空数组 */
const CFG = {
  pollMs: 2000,
  size: 320,
  animations: { idle: ['待机呼吸休闲'], small: ['撸猫', '照镜子'] },
  dims: [
    { key: 'happy', label: '开心' },
    { key: 'calm', label: '平静' },
    { key: 'sweet', label: '甜' },
    { key: 'heartache', label: '心疼' },
    { key: 'worry', label: '担心' },
    { key: 'sad', label: '难过' },
    { key: 'jealous', label: '吃醋' },
  ],
};
const MOOD = {
  mood: 74,
  band: { id: 'good', label: '愉快' },
  dims: { happy: 6, calm: 3, sweet: 1, heartache: 0, worry: 2, sad: 0, jealous: 1 },
  updatedAt: Date.now(),
};
/*
 * hook 顺序（改 client.js 的 useState 顺序就得同步这里）：
 * 0 cfg / 6 mood / 10 chatOpen / 11 log / 14 menuOpen / 15 showDims
 * 16 recent / 17 voice / 18 quiet / 19 scale / 20 usage / 21 showUsage
 */
const BASE = { 0: CFG, 6: MOOD, 16: [{ text: '老大喜欢短句' }], 17: { address: '在下', emoji: '🐟' } };

const cases = [
  { name: '默认态', overrides: { ...BASE } },
  { name: '说话气泡', overrides: { ...BASE, 8: '我在这儿蹲着呢 🐟' } },
  { name: '右键菜单', overrides: { ...BASE, 14: true } },
  { name: '心情面板', overrides: { ...BASE, 15: true } },
  {
    name: '余额面板',
    overrides: {
      ...BASE,
      20: { ok: true, balance: 206.17, today: 1.6, week: 12.3, discount: false },
      21: true,
    },
  },
  { name: '聊天面板', overrides: { ...BASE, 10: true, 11: [{ role: 'user', text: '在吗' }, { role: 'pet', text: '在的' }] } },
];

if (process.env.RENDER_DEBUG) {
  stateOverrides = {};
  resetHooks();
  try {
    Pet();
  } catch (e) {
    console.log('渲染异常：', e.message);
  }
  stateInit.forEach((v, i) => {
    let shown;
    try {
      shown = JSON.stringify(v);
    } catch {
      shown = String(v);
    }
    console.log(`state[${i}] ${typeof v} ${(shown ?? '').slice(0, 48)}`);
  });
  process.exit(0);
}

let failed = 0;
for (const c of cases) {
  try {
    stateOverrides = c.overrides;
    resetHooks();
    const tree = Pet();
    const problems = [];
    const nodes = walk(tree, 'root', problems);
    const all = collect(tree, []);
    const videos = all.filter((n) => n.type === 'video').length;
    const styleProps = all.filter((n) => n.props?.style && typeof n.props.style === 'object').length;
    /* 按钮必须真接上 onClick —— 渲染得出来但点不动的按钮，在客户端里根本看不出来 */
    const buttons = all.filter((n) => n.type === 'button');
    const deadButtons = buttons.filter((n) => typeof n.props?.onClick !== 'function');
    if (deadButtons.length > 0) {
      problems.push(`${deadButtons.length} 个 button 没有 onClick：${deadButtons.map((b) => b.children?.[1] ?? b.children?.[0] ?? '?').join(' / ')}`);
    }
    if (problems.length > 0) {
      failed++;
      console.error(`✗ ${c.name}：${problems.length} 处样式值为 undefined`);
      problems.slice(0, 8).forEach((p) => console.error('   ', p));
    } else {
      console.log(`✓ ${c.name}：节点 ${nodes} / 样式块 ${styleProps} / video ${videos} / 按钮 ${buttons.length} / style 无 undefined`);
    }
  } catch (e) {
    failed++;
    console.error(`✗ ${c.name}：渲染抛异常 —— ${e.message}`);
    console.error(String(e.stack).split('\n').slice(1, 4).join('\n'));
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个渲染用例失败`);
  process.exit(1);
}
console.log('\n全部渲染用例通过');
