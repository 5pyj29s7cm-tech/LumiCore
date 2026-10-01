// ── Sentiment ────────────────────────────────────────────────────────────────

export interface SentimentResult {
  valence: number;       // -1 (very negative) to +1 (very positive)
  urgency: number;       // 0 (calm) to 1 (panicked/urgent)
  frustration: number;   // 0 (neutral) to 1 (very frustrated)
}

// Positive keywords (Chinese + English)
const POSITIVE: Array<[RegExp, number]> = [
  [/谢谢|感谢|多谢|太棒了|很好|不错|太好了|完美|厉害|优秀|棒|赞/i, 0.4],
  [/thanks?|thank\s*you|thx|great|awesome|perfect|amazing|excellent|love\s*it/i, 0.4],
  [/哈哈|呵呵|笑|开心|高兴|愉快|喜欢|❤|😊|😄|👍|\!{2,}/, 0.35],
  [/lol|lmao|haha|happy|glad|wonderful|fantastic|brilliant/i, 0.35],
  [/good\s*job|well\s*done|nice|sweet|cool/i, 0.3],
];

// Negative / Frustration keywords
const NEGATIVE: Array<[RegExp, number]> = [
  [/烦|讨厌|恶心|垃圾|狗屎|操|妈的|该死|shit|fuck|damn|wtf|awful|terrible|horrible/i, 0.55],
  [/不行|不对|错了|错误|失败|坏了|崩溃|不能|无法|怎么搞的/i, 0.3],
  [/not\s*working|doesn't\s*work|broken|bug|crash|error|fail|wrong|useless/i, 0.3],
  [/烦躁|沮丧|头疼|崩溃了|受不了|无语|无奈/i, 0.4],
  [/算了|不管了|不弄了|放弃了|give\s*up|never\s*mind|forget\s*it/i, 0.25],
];

// Urgency keywords
const URGENT: Array<[RegExp, number]> = [
  [/快|急|马上|立刻|赶紧|赶紧|迅速|紧急|urgent|asap|hurry|quick|fast|immediate/i, 0.4],
  [/救命|help\!|emergency|now\!|right\s*now/i, 0.6],
  [/\bsos\b/i, 0.7],
  [/\!{2,}/, 0.3],
  [/怎么办|怎么办？|how\s*do\s*i\??/i, 0.25],
];

export function extractSentiment(text: string): SentimentResult {
  let valenceScore = 0;
  let urgencyScore = 0;
  let frustrationScore = 0;

  // Scan positive
  for (const [regex, weight] of POSITIVE) {
    if (regex.test(text)) {
      valenceScore += weight;
      break; // one match per category
    }
  }

  // Scan negative
  for (const [regex, weight] of NEGATIVE) {
    if (regex.test(text)) {
      valenceScore -= weight;
      frustrationScore += weight;
      break;
    }
  }

  // Scan urgent
  for (const [regex, weight] of URGENT) {
    if (regex.test(text)) {
      urgencyScore += weight;
      break;
    }
  }

  // ALL CAPS signals urgency/frustration (for English text)
  const alphaChars = text.replace(/[^a-zA-Z]/g, '');
  if (alphaChars.length > 10) {
    const upperRatio = (alphaChars.match(/[A-Z]/g) || []).length / alphaChars.length;
    if (upperRatio > 0.7) {
      urgencyScore = Math.max(urgencyScore, 0.25);
      frustrationScore += 0.1;
    }
  }

  // Multiple question marks = urgency
  const questionMarkCount = (text.match(/\?|？/g) || []).length;
  if (questionMarkCount >= 3) {
    urgencyScore += 0.2;
  }

  // Short angry messages
  if (text.trim().length < 8 && frustrationScore > 0.3) {
    urgencyScore += 0.1;
    valenceScore -= 0.1;
  }

  return {
    valence: clamp(valenceScore, -1, 1),
    urgency: clamp(urgencyScore, 0, 1),
    frustration: clamp(frustrationScore, 0, 1),
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
