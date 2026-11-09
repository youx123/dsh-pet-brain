/**
 * 桌宠自己的「最近说过什么」账本。
 *
 * 为什么要有这个：
 * - 共享大脑的 proactive-history.json 只记「今天说了几句、什么时候说的、用过哪些话题」，
 *   不记内容 → 桌宠主动开口时不知道自己上一句说了什么，容易重复。
 * - 跟老大聊的内容也只进 memory.json（那是给检索用的），不在上下文里，
 *   所以桌宠接不上话。
 *
 * 这里把最近几十条对话落到 ~/.dsh/dsh-pet-brain/chat-log.json，
 * 主动开口时把最近几句塞进提示里，避免复读、也让它说得连贯。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome } from './brain.js';
import { writeJsonAtomic } from './atomic.js';

const MAX_LINES = 60;

/** 账本里一行的类型：聊天 / 主动开口 / 本地短句（气泡里先顶一句的那种） */
const KINDS = new Set(['chat', 'proactive', 'local']);

export function chatLogFile() {
  return join(dshHome(), 'dsh-pet-brain', 'chat-log.json');
}

/** 读账本；坏了就当空账本，别因为一个坏文件把桌宠整死。 */
export function readChatLog() {
  const file = chatLogFile();
  try {
    if (!existsSync(file)) return { version: 1, lines: [] };
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const lines = Array.isArray(raw?.lines) ? raw.lines : [];
    return {
      version: 1,
      lines: lines
        .filter((l) => l && typeof l.text === 'string' && l.text.trim() !== '')
        .slice(-MAX_LINES),
    };
  } catch {
    return { version: 1, lines: [] };
  }
}

/** 记一句。role: 'user' | 'assistant'；kind: 'chat' | 'proactive' */
export function appendChatLog(entry) {
  try {
    const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
    if (!text) return false;
    const log = readChatLog();
    log.lines.push({
      role: entry?.role === 'user' ? 'user' : 'assistant',
      kind: KINDS.has(entry?.kind) ? entry.kind : 'chat',
      text: text.slice(0, 200),
      at: Number.isFinite(entry?.at) ? entry.at : Date.now(),
    });
    log.lines = log.lines.slice(-MAX_LINES);
    writeJsonAtomic(chatLogFile(), log, { pretty: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 最近几句「我方」说过的话（assistant 侧），用来提示模型别复读。
 * 返回形如 ['「老大，今天天不错。」', '「吃上饭啦～」']
 */
export function recentSpeech(limit = 3, log = readChatLog()) {
  const mine = log.lines.filter((l) => l.role === 'assistant').slice(-Math.max(0, limit));
  return mine.map((l) => `「${l.text}」`);
}

/** 最近一条用户说的话（老大刚说了什么） */
export function lastUserText(log = readChatLog()) {
  for (let i = log.lines.length - 1; i >= 0; i -= 1) {
    if (log.lines[i].role === 'user') return log.lines[i].text;
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * 「共享大脑主会话上次开口」的水位线
 *
 * 桌宠要跟着共享大脑接话，得知道两件事：
 *   1. 共享大脑最近一次开口是什么时候（hostPulse 读共享大脑的账本）
 *   2. 这一条我有没有已经接过（否则每次轮询都接一遍，屏幕上全是话）
 *
 * 之前没有第 2 条，判定只剩一个时间窗，于是要么一直不接（共享大脑
 * 超过窗口才说话 → 桌宠永远等不到），要么接个没完。这里把水位线记下来。
 * ------------------------------------------------------------------ */

export function hostFollowFile() {
  return join(dshHome(), 'dsh-pet-brain', 'host-follow.json');
}

/** 已跟随到哪一条共享大脑的开口了（附带"这一条试了几次"） */
export function readHostFollow() {
  try {
    const raw = JSON.parse(readFileSync(hostFollowFile(), 'utf8'));
    return {
      lastSeenAt: Number.isFinite(raw?.lastSeenAt) ? raw.lastSeenAt : 0,
      attempts: Number.isFinite(raw?.attempts) ? raw.attempts : 0,
      attemptAt: Number.isFinite(raw?.attemptAt) ? raw.attemptAt : 0,
    };
  } catch {
    return { lastSeenAt: 0, attempts: 0, attemptAt: 0 };
  }
}

/** 记下「这一条我已经接过了」 */
export function writeHostFollow(at, { attempts = 0, attemptAt = 0 } = {}) {
  try {
    writeJsonAtomic(hostFollowFile(), {
      lastSeenAt: Number(at) || 0,
      attempts,
      attemptAt,
      updatedAt: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 接茬失败记一笔。
 *
 * 为什么需要：接茬失败时不推水位线，渲染端就会一直以为"这条还没接"，
 * 每 60 秒重试一次 —— 共享大脑开口后的 15 分钟窗口里能重试十几次，
 * 每次都是一次 LLM 调用。这里给同一轮最多试 2 次，超了就把水位线推过去。
 */
export function noteFollowAttempt(at) {
  const prev = readHostFollow();
  const same = Number(prev.attemptAt) === Number(at);
  const attempts = same ? prev.attempts + 1 : 1;
  const giveUp = attempts >= 2;
  const ok = writeHostFollow(giveUp ? at : prev.lastSeenAt, { attempts: giveUp ? 0 : attempts, attemptAt: at });
  return { ok, attempts, giveUp };
}

