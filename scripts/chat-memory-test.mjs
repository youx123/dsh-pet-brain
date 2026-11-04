const ORIGIN = process.argv[2] || 'http://127.0.0.1:60600';

const cases = [
  { text: '老大我最喜欢你陪着我了，以后不许把我晾着', expect: ['bottomline', 'emotion', 'instinct'] },
  { text: '我讨厌别人半夜给我发消息，太烦了', expect: ['emotion', 'instinct', 'cognition'] },
  { text: '记得以后我说要聊天的时候你就陪着我聊', expect: ['instinct', 'cognition', 'bottomline'] },
  { text: '在吗', expect: [] },
];

for (const c of cases) {
  const r = await fetch(`${ORIGIN}/pet-brain/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ text: c.text }),
  });
  const j = await r.json();
  await new Promise((x) => setTimeout(x, 400));
  console.log(`\n「${c.text}」`);
  console.log(`  回复: ${(j.reply || j.error || '').slice(0, 90)}`);
}

await new Promise((x) => setTimeout(x, 2500));
const { readFileSync } = await import('node:fs');
const p = 'C:/Users/13176/.dsh/storages/dsh-shared-brain/memory.json';
const j = JSON.parse(readFileSync(p, 'utf8'));
const hits = j.entries.filter((e) => /桌宠说/.test(e.text || ''));
console.log(`\n=== 共享大脑里「桌宠说」条目：${hits.length} 条 ===`);
for (const e of hits.slice(-6)) {
  console.log(` - [${e.module}] w=${e.weight} ${e.lifetime} pinned=${e.pinned} | ${e.text}`);
}
