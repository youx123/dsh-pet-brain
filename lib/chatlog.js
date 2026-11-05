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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dshHome } from './brain.js';

const MAX_LINES = 60;

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
      kind: entry?.kind === 'proactive' ? 'proactive' : 'chat',
      text: text.slice(0, 200),
      at: Number.isFinite(entry?.at) ? entry.at : Date.now(),
    });
    log.lines = log.lines.slice(-MAX_LINES);
    const file = chatLogFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(log, null, 2), 'utf8');
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
