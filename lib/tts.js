/**
 * dsh-pet-brain —— 桌宠说话的嗓子（宿主侧）
 *
 * 共享大脑的 voice.style.speech 里本来就写着「音色 晓伊 / 语速 0.98 / 音调 0.98」，
 * 但那只是拼进提示词给人看的文字，从来没有代码拿它去合成。这里补上真正的合成：
 *   modules.json 的 speech 参数 → Edge TTS（微软朗读接口，免 key）→ MP3 字节
 *
 * 三条边界：
 *   1. 合成失败绝不拖垮说话：返回 null，调用方照旧只显示文字。
 *   2. 同一句话不重复合成：按「参数 + 文本」做指纹缓存，最多 80 条 / 12MB。
 *   3. 串行：msedge-tts 一个实例一条 WebSocket，并发会互相踩，这里排队。
 */
import { createHash } from 'node:crypto';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { readShared } from './brain.js';

const DEFAULT_SPEECH = {
  voiceId: 'zh-CN-XiaoyiNeural',
  voiceName: '晓伊',
  // 2026-11-13 老大定的「甜版」：音高 +10%、语速 +4%，跟共享大脑 modules.json 的
  // voice.style.speech 保持一致；这里只是共享大脑读不到时的兜底。
  rate: 1.04,
  pitch: 1.1,
  volume: 1,
};

const MAX_CACHE_ENTRIES = 80;
const MAX_CACHE_BYTES = 12 * 1024 * 1024;
const SYNTH_TIMEOUT_MS = 20000;
const MAX_TEXT = 300;

const cache = new Map();
let cacheBytes = 0;
let tts = null;
let ttsVoice = '';
let queue = Promise.resolve();

const clampNum = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** 音色参数：读共享大脑，读不到就退回默认的晓伊 */
export function speechParams(modules = null) {
  const mods = modules ?? readShared()?.modules ?? null;
  const s = mods?.voice?.style?.speech;
  const voiceId =
    typeof s?.voiceId === 'string' && s.voiceId.trim() !== '' ? s.voiceId.trim() : DEFAULT_SPEECH.voiceId;
  const voiceName =
    typeof s?.voiceName === 'string' && s.voiceName.trim() !== '' ? s.voiceName.trim() : DEFAULT_SPEECH.voiceName;
  return {
    voiceId,
    voiceName,
    rate: clampNum(s?.rate, 0.5, 2, DEFAULT_SPEECH.rate),
    pitch: clampNum(s?.pitch, 0.5, 2, DEFAULT_SPEECH.pitch),
    volume: clampNum(s?.volume, 0, 2, DEFAULT_SPEECH.volume),
  };
}

/** 0.98 → "-2%"，1.1 → "+10%"：Edge 的 rate/pitch 收相对百分比 */
function relative(value, fallback) {
  const pct = Math.round((clampNum(value, 0.5, 2, fallback) - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

function prosodyOf(params) {
  return {
    rate: relative(params.rate, DEFAULT_SPEECH.rate),
    pitch: relative(params.pitch, DEFAULT_SPEECH.pitch),
    volume: relative(params.volume, DEFAULT_SPEECH.volume),
  };
}

function fingerprint(text, params) {
  const p = prosodyOf(params);
  return createHash('sha1')
    .update(`${params.voiceId}|${p.rate}|${p.pitch}|${p.volume}|${text}`)
    .digest('hex');
}

function remember(key, buf) {
  cache.set(key, buf);
  cacheBytes += buf.length;
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const old = cache.get(oldest.value);
    cache.delete(oldest.value);
    cacheBytes -= old?.length ?? 0;
  }
}

function ensureClient(voiceId) {
  if (!tts) tts = new MsEdgeTTS();
  return tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3).then(() => {
    ttsVoice = voiceId;
  });
}

function collect(audioStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => reject(new Error('合成超时')), SYNTH_TIMEOUT_MS);
    audioStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    audioStream.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    audioStream.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function synthesizeOnce(text, params) {
  if (!tts || ttsVoice !== params.voiceId) await ensureClient(params.voiceId);
  const { audioStream } = tts.toStream(text, prosodyOf(params));
  return collect(audioStream);
}

/**
 * 念之前先把表情摘掉（2026-11-13 老大要求：表情不用说，只说文字）。
 * renderer 那边已经过滤过一遍，这里是兜底：页面里那只宠物、聊天面板的朗读
 * 都可能直接打这个端点，别让 🐟 念成「鱼」或者一串乱码。
 */
const EMOJI_WORD =
  /[（(\[【]\s*(?:偷笑|笑死|大笑|笑哭|笑|哭|流泪|叹气|无语|沉默|汗|尴尬|赞|点赞|比心|耶|抱抱|加油|鼓掌|思考|疑惑|惊讶|吃瓜|狗头|喵|嗷|哼|得意|委屈|可爱|开心|难过|生气)[^\u4e00-\u9fa5]{0,2}\s*[)）\]】]/g;

export function speakable(text) {
  const s = String(text ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // markdown 图片
    .replace(/https?:\/\/\S+/g, ' ') // 网址
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu, ' ')
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, ' ') // 肤色修饰
    .replace(EMOJI_WORD, ' ')
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
  // 只剩标点符号就不值得开口
  if (!/[\p{L}\p{N}]/u.test(s)) return '';
  return s.slice(0, MAX_TEXT);
}

/**
 * 说一句话，拿回 MP3 字节；说不了就 null。
 * @param {string} text
 * @param {{voiceId?: string, rate?: number, pitch?: number, volume?: number}} [params]
 * @returns {Promise<Buffer|null>}
 */
export async function speak(text, params = speechParams()) {
  const clean = speakable(text);
  if (clean === '') return null;
  const key = fingerprint(clean, params);
  const hit = cache.get(key);
  if (hit) return hit;

  const run = async () => {
    const cached = cache.get(key);
    if (cached) return cached;
    let buf = await synthesizeOnce(clean, params);
    if (!buf || buf.length === 0) {
      // 复用的连接可能已经断了：丢掉实例重来一次
      tts?.close?.();
      tts = null;
      ttsVoice = '';
      buf = await synthesizeOnce(clean, params);
    }
    if (!buf || buf.length === 0) return null;
    remember(key, buf);
    return buf;
  };

  const task = queue.then(run, run);
  queue = task.then(
    () => undefined,
    () => undefined,
  );
  try {
    const buf = await task;
    if (buf) return buf;
  } catch (err) {
    console.warn(`[dsh-pet-brain] 语音合成失败：${err?.message ?? err}`);
    tts?.close?.();
    tts = null;
    ttsVoice = '';
  }
  return null;
}

/** 给状态面板看的：现在用的是哪个嗓子、缓存多大 */
export function ttsStatus() {
  const params = speechParams();
  return {
    engine: 'edge-tts',
    voiceId: params.voiceId,
    voiceName: params.voiceName,
    rate: params.rate,
    pitch: params.pitch,
    volume: params.volume,
    cacheEntries: cache.size,
    cacheBytes,
  };
}
