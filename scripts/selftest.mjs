/**
 * 自测：不启动 DSH，直接验证"读共享大脑 → 拼 system prompt"这条链路。
 * 用法：node scripts/selftest.mjs
 */
import { dshHome, sharedDir, snapshot, recallMemories, buildSystem, bottomline, voiceStyle, DIM_LABELS } from '../lib/brain.js';

console.log('DSH_HOME   :', dshHome());
console.log('共享大脑目录:', sharedDir());

const s = snapshot();
console.log('人设       :', s.persona ? `${s.persona.name}（${s.persona.id}，${s.persona.text.length} 字）` : '（没读到）');
if (s.mood) {
  console.log('心情       :', s.mood.mood, s.mood.band.label);
  console.log('七维       :', Object.entries(s.mood.dims).map(([k, v]) => `${DIM_LABELS[k] ?? k}${v}`).join(' '));
  console.log('最近原因   :', s.mood.reason.slice(0, 60) || '（空）');
} else {
  console.log('心情       : （没读到）');
}
console.log('记忆条数   :', Array.isArray(s.memory?.entries) ? s.memory.entries.length : 0);

const voice = voiceStyle(s.shared.modules);
console.log('声音风格   :', voice ? `语气「${voice.tone}」自称「${voice.address}」表情 ${voice.emoji} 口头禅 ${voice.tics.join('/')}` : '（没读到）');

const q = '桌宠插件 心情 记忆';
const recalled = recallMemories(q, s.memory, 3);
console.log(`\n召回「${q}」→ ${recalled.length} 条`);
for (const m of recalled) console.log(`  [${m.module}] ${m.text.slice(0, 70)}…`);

const system = buildSystem({
  persona: s.persona,
  mood: s.mood,
  voice,
  memories: recalled,
  rules: bottomline(s.memory, 2),
});
console.log('\n===== 本轮 system prompt =====');
console.log(system);
