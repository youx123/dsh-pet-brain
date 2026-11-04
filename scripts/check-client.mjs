/**
 * 冒烟测试：模拟浏览器的 __ModuleLoader__，验证 client 半侧能正确被装载。
 * 只验证 bundle 形状与工厂函数可执行，不真渲染（无 DOM）。
 * 用法：node scripts/check-client.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

let loaded = null;
const sandbox = {
  window: {},
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
  cancelAnimationFrame: clearTimeout,
  fetch: () => Promise.reject(new Error('no network in smoke test')),
  document: { createElement: () => ({ style: {}, appendChild() {} }), head: { appendChild() {} } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
};
sandbox.window.__ModuleLoader__ = {
  load({ id, factory }) {
    loaded = { id, factory };
  },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });

if (!loaded) {
  console.error('✗ 没有调用 __ModuleLoader__.load');
  process.exit(1);
}
console.log('✓ loader.load 被调用，id =', loaded.id);

// 假 react / react-jsx-runtime：只要不抛就够了
const fakeReact = new Proxy(
  {
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (f) => f,
    useMemo: (f) => f(),
  },
  { get: (t, k) => (k in t ? t[k] : () => null) },
);
const fakeJsx = new Proxy({}, { get: () => () => null });
const require = (name) => {
  if (name === 'react') return fakeReact;
  if (name === 'react/jsx-runtime' || name === 'react/jsx-dev-runtime') return fakeJsx;
  throw new Error(`unexpected require(${name})`);
};

const mod = loaded.factory(require);
console.log('✓ 工厂执行成功，导出键 =', Object.keys(mod).join(', '));
if (typeof mod.apply !== 'function') throw new Error('缺少 apply');
if (!mod.inject) throw new Error('缺少 inject');
console.log('✓ inject =', JSON.stringify(mod.inject), ' name =', mod.name ?? '(未命名)');

// 跑一遍 apply，确认 slots 注册路径没问题
const registered = [];
const ctx = {
  slots: {
    inject(name, gen) {
      const it = gen();
      let r = it.next();
      while (!r.done) {
        registered.push(r.value);
        r = it.next();
      }
    },
    register(meta, render) {
      registered.push({ meta, render });
      return () => {};
    },
  },
  effect: (fn) => {
    const d = fn();
    return typeof d === 'function' ? d : () => {};
  },
};
mod.apply(ctx);
console.log('✓ apply 执行成功，注册项 =', registered.length);
for (const r of registered) console.log('   -', JSON.stringify(r?.meta ?? r));
