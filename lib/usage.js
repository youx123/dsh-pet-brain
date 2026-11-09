/**
 * usage.js —— 余额与用量（精简版记账）
 *
 * 取数只有一条路：DSH 凭据服务里的 DEEPSEEK_API_KEY → GET https://api.deepseek.com/user/balance。
 * 和 dsh-whale-widget 的做法一致（那边还有 34 个厂商模板和账号登录回退，这里不做）。
 *
 * 今日已用 = 余额差分累计：每次刷新拿到新余额，若比上次低就把差额加进当天账本。
 * 这不是精确账单（充值、赠金过期都会干扰），但足够回答"今天大概花掉多少"。
 *
 * 账本落盘位置：$DSH_HOME/dsh-pet-brain/usage.json
 *   { date, lastBalance, todayUsage, history: { 'YYYY-MM-DD': 元 }, updatedAt }
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dshHome } from './brain.js';
import { writeJsonAtomic } from './atomic.js';

const TAG = '[dsh-pet-brain]';
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const FETCH_TIMEOUT_MS = 8000;
/** 余额缓存多久（ms）—— 前端 2s 轮询一次，不能每次都打上游 */
const CACHE_MS = 60_000;
/** 账本保留多少天 */
const KEEP_DAYS = 90;

let cache = { at: 0, value: null };

export const usageFile = () => join(dshHome(), 'dsh-pet-brain', 'usage.json');

const dayKey = (d = new Date()) => {
  // 北京时间，好跟老大看到的日期对上
  const t = new Date(d.getTime() + 8 * 3600_000);
  return t.toISOString().slice(0, 10);
};

const numOr = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/** 账本损坏时不让插件崩：备份坏文件，返回空账本 */
function readLedger() {
  const p = usageFile();
  const empty = () => ({ date: dayKey(), lastBalance: null, todayUsage: 0, history: {} });
  if (!existsSync(p)) return empty();
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return empty();
    return {
      date: typeof parsed.date === 'string' ? parsed.date : dayKey(),
      lastBalance: numOr(parsed.lastBalance),
      todayUsage: Number(parsed.todayUsage) || 0,
      history: parsed.history && typeof parsed.history === 'object' ? parsed.history : {},
      updatedAt: parsed.updatedAt ?? null,
    };
  } catch (e) {
    try {
      const bak = p + '.corrupt-' + Date.now() + '.bak';
      writeFileSync(bak, readFileSync(p));
      console.error(`${TAG} 用量账本损坏（${e?.code || e?.message}）→ 已备份 ${bak}，按空账本重建`);
    } catch {
      /* 备份失败也不许影响主流程 */
    }
    return empty();
  }
}

function writeLedger(ledger) {
  const p = usageFile();
  try {
    // 丢掉太老的历史
    const cutoff = dayKey(new Date(Date.now() - KEEP_DAYS * 86400_000));
    const history = {};
    for (const [k, v] of Object.entries(ledger.history || {})) {
      if (k >= cutoff) history[k] = v;
    }
    writeJsonAtomic(p, { ...ledger, history, updatedAt: new Date().toISOString() }, { pretty: true });
  } catch (e) {
    console.error(`${TAG} 用量账本写入失败：${e?.code || e?.message}`);
  }
}

/** 从响应体里挑出余额条目（官方可能给多条，优先 CNY） */
function pickBalanceInfo(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.find((x) => String(x?.currency || '').toUpperCase() === 'CNY') ?? list[0];
}

async function fetchBalance(ctx) {
  let cred = null;
  try {
    cred = await ctx.credentials?.resolve?.('DEEPSEEK_API_KEY');
  } catch (e) {
    return { ok: false, code: 'NO_KEY', error: '凭据读取失败：' + String(e?.message || e).slice(0, 120) };
  }
  if (!cred?.value) return { ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY' };

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + cred.value },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (!res.ok) {
      lastErr = new Error('HTTP ' + res.status);
      if (res.status < 500) break; // 4xx 重试也没用
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' };
    }
    const info = pickBalanceInfo(data?.balance_infos);
    const total = numOr(info?.total_balance);
    if (!info || total === null) return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' };
    return {
      ok: true,
      total,
      bonus: numOr(info.granted_balance),
      recharge: numOr(info.topped_up_balance),
      currency: String(info.currency || 'CNY'),
      at: Date.now(),
    };
  }
  return {
    ok: false,
    code: 'HTTP',
    error: '余额接口请求失败：' + String(lastErr?.message || lastErr).slice(0, 160),
  };
}

/** 现在是优惠时段吗：官方规则是北京时间 00:30–08:30 */
export function discountNow(now = new Date()) {
  const h = now.getHours();
  const m = now.getMinutes();
  const mins = h * 60 + m;
  return mins >= 30 && mins < 8 * 60 + 30;
}

/**
 * 拉一次用量（带 60s 缓存）。
 * 永不抛错：上游挂了就返回 { ok:false, error }，前端显示"—"。
 */
export async function getUsage(ctx, { force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < CACHE_MS) return cache.value;

  const led = readLedger();
  const today = dayKey();

  // 跨天了：把昨天的数挪进历史，今天从 0 起
  if (led.date !== today) {
    if (led.todayUsage > 0) led.history[led.date] = Number((led.history[led.date] || 0) + led.todayUsage);
    led.date = today;
    led.todayUsage = 0;
  }

  const bal = await fetchBalance(ctx);

  if (bal.ok) {
    // 余额差分 → 今日已用。充值会让余额变高，那种情况不计负数，只更新基准。
    if (led.lastBalance !== null && bal.total < led.lastBalance) {
      led.todayUsage += led.lastBalance - bal.total;
    }
    led.lastBalance = bal.total;
    writeLedger(led);
  }

  const week = (() => {
    let sum = 0;
    for (let i = 0; i < 7; i++) {
      const k = new Date(Date.now() - i * 86400_000);
      sum += Number(led.history[dayKey(k)] || 0);
    }
    return sum;
  })();

  const value = {
    ok: bal.ok,
    error: bal.ok ? null : bal.error,
    currency: bal.ok ? bal.currency : 'CNY',
    balance: bal.ok ? bal.total : null,
    bonus: bal.ok ? bal.bonus : null,
    recharge: bal.ok ? bal.recharge : null,
    today: Number(led.todayUsage.toFixed(4)),
    week: Number((week + led.todayUsage).toFixed(4)),
    discount: discountNow(),
    at: bal.ok ? bal.at : null,
    fetchedAt: now,
  };
  cache = { at: now, value };
  return value;
}
