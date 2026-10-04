
import { type AudioSession } from "./session";
// ── Module-level TTS echo tracker (shared with wake detector) ──

function normalizeEchoText(text: string): string {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}


/** Sequence-aware overlap avoids the false positives caused by shared character sets. */
function bigramDiceSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < a.length - 1; index += 1) {
    const gram = a.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  let intersection = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const gram = b.slice(index, index + 2);
    const count = counts.get(gram) || 0;
    if (count <= 0) continue;
    intersection += 1;
    counts.set(gram, count - 1);
  }
  return (2 * intersection) / ((a.length - 1) + (b.length - 1));
}


const MAX_ECHO_ENTRIES = 50;

const recentTtsTexts: { text: string; until: number; scope: string }[] = [];


export function voiceEchoScope(session: Pick<AudioSession, 'userId' | 'sessionId'>): string {
  return `${session.userId || 'anonymous'}:${session.sessionId || 'no-session'}`;
}


/** Record a TTS sentence for echo cancellation (shared with wake detector). */
export function addEchoText(text: string, scope = ''): void {
  const normalizedLength = normalizeEchoText(text).length;
  const retentionMs = Math.min(45_000, Math.max(12_000, 8_000 + normalizedLength * 180));
  recentTtsTexts.push({ text, scope, until: Date.now() + retentionMs });
  if (recentTtsTexts.length > MAX_ECHO_ENTRIES) recentTtsTexts.shift();
}


/** Check if a transcript matches recent TTS output (speaker → mic echo). */
export function isEchoText(transcript: string, includeShortFragments = false, scope = ''): boolean {
  const now = Date.now();
  // Purge stale entries
  for (let i = recentTtsTexts.length - 1; i >= 0; i--) {
    if (recentTtsTexts[i].until <= now) recentTtsTexts.splice(i, 1);
  }
  if (recentTtsTexts.length === 0) return false;
  const tNorm = normalizeEchoText(transcript);
  if (tNorm.length < 2) return false;
  if (tNorm.length < 4 && !includeShortFragments) return false;
  for (const r of recentTtsTexts) {
    if (scope && r.scope !== scope) continue;
    const recent = normalizeEchoText(r.text);
    if (!recent) continue;
    if (recent.includes(tNorm) || tNorm.includes(recent)) return true;
    const lengthRatio = Math.min(tNorm.length, recent.length) / Math.max(tNorm.length, recent.length);
    if (lengthRatio >= 0.45 && bigramDiceSimilarity(tNorm, recent) >= 0.72) return true;
  }
  return false;
}


function normalizeSpeechText(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[。！？.!?，,、；;：:“”"'‘’（）()\[\]【】~～]/g, '')
    .toLowerCase();
}


export function isPureInterruptCommand(text: string): boolean {
  const normalized = normalizeSpeechText(text);
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  return /^(停|停下|停止|停止任务|终止任务|取消任务|打断|闭嘴|别说|不要说|先别说|别讲|不要讲|等下|等一下|暂停|好了|行了|够了|停一下|停一停|先停|先停一下|别说了|不要说了|先别说了|别讲了|不要讲了|打断一下|等我一下|暂停一下|可以了|不用说了|先这样|stop|stoptask|canceltask|wait|pause|interrupt|holdon|shutup)$/.test(normalized);
}


export function isVoiceCallEndCommand(text: string): boolean {
  const normalized = normalizeSpeechText(text);
  // Ending the call is a transport command. It must not enter the LLM/tool
  // pipeline or wait for speaker verification after the user has asked out.
  // i18n-allow: Chinese voice transport-command recognition; not user-visible copy.
  return /^(?:(?:关闭|结束|挂断|退出|停止)(?:语音)?(?:通话|电话|聊天|会话|对话|通道)|(?:语音)?(?:通话|电话|聊天|会话|对话|通道)(?:关闭|结束|挂断|退出)|endcall|hangup|closevoicecall|stopvoicecall)$/u.test(normalized);
}


/**
 * Keep the priority transport lane model-free without treating Lumi's own
 * loudspeaker echo as a user stop. Scope matching isolates simultaneous voice
 * sessions; the active-TTS flag leaves the same words usable after playback.
 */
export function isEchoedImmediateVoiceControl(
  text: string,
  ttsActive: boolean,
  scope = '',
): boolean {
  if (!ttsActive) return false;
  if (!isPureInterruptCommand(text) && !isVoiceCallEndCommand(text)) return false;
  return isEchoText(text, true, scope);
}
