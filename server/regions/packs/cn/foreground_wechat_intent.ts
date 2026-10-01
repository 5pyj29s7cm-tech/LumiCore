/** Advisory argument extraction for the existing foreground WeChat adapter. */

import { normalizeActionIntent } from '../../../cognition/normalized_action_intent';

function cleanWeChatSlot(value: string): string {
  return String(value || '')
    .replace(/^[\s,.\u3002\uFF0C\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]+/u, '')
    .replace(/[\s,.\u3002\uFF0C\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]+$/u, '')
    .trim();
}

function cleanWeChatContactSlot(value: string): string {
  return cleanWeChatSlot(value)
    .split(/["'\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f]/u)[0]
    .trim();
}

function stripWeChatTaskPrefix(value: string): string {
  let text = String(value || '').trim();
  for (let i = 0; i < 4; i += 1) {
    const next = text
      .replace(/^(?:\u8bf7|\u9ebb\u70e6|\u5e2e\u6211|\u5e2e\u5fd9|\u66ff\u6211|\u4f60\u6765|\u76f4\u63a5|\u73b0\u5728)\s*/u, '')
      .replace(/^(?:\u6253\u5f00|\u6253\u5f00\u4e00\u4e0b|\u542f\u52a8|\u7528|\u5728)?\s*(?:wechat|weixin|\u5fae\u4fe1)(?:\u91cc|\u4e0a|\u4e2d)?\s*/iu, '')
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

function extractQuotedWeChatText(text: string): string {
  const quoted = String(text || '').match(/["'\u201c\u2018\u300c\u300e]([^"'\u201d\u2019\u300d\u300f]{1,1000})["'\u201d\u2019\u300d\u300f]/u);
  return cleanWeChatSlot(quoted?.[1] || '');
}

function extractDirectedWeChatContact(userTask: string): string {
  const text = String(userTask || '');
  const patterns = [
    /\u53d1\u7ed9\s*([^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})/u,
    /\u7ed9\s*([^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})\s*(?:\u53d1\u9001|\u53d1|\u56de\u590d|\u8bf4|\u544a\u8bc9)/u,
    /\u56de\u590d\s*([^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})/u,
    /(?:to|message|reply)\s+([A-Za-z0-9_\-\u4e00-\u9fff]{1,32})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const contact = cleanWeChatContactSlot(match?.[1] || '');
    if (contact) return contact;
  }
  return '';
}

function cleanDirectedWeChatMessage(value: string): string {
  return cleanWeChatSlot(value)
    .replace(/^(?:\u4e00\u6761|\u4e00\u4e2a)?(?:\u5fae\u4fe1|\u6d88\u606f|\u5185\u5bb9|\u8bdd)\s*/u, '')
    .trim();
}

function extractDirectedWeChatMessage(userTask: string): string {
  const original = String(userTask || '').trim();
  const quoted = extractQuotedWeChatText(original);
  if (quoted) return quoted;

  const text = stripWeChatTaskPrefix(original);
  const messagePatterns = [
    /(?:\u7f16\u8f91|\u5199|\u51c6\u5907)\s*(?:\u4e00\u6761|\u4e00\u4e2a)?(?:\u5fae\u4fe1|\u6d88\u606f)?\s*([\s\S]{1,1000}?)\s*\u53d1\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}/u,
    /\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}\s*(?:\u53d1\u9001|\u53d1|\u56de\u590d|\u8bf4|\u544a\u8bc9)\s*([\s\S]{1,1000})/u,
    /\u53d1\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}\s*([\s\S]{1,1000})/u,
    /(?:\u53d1\u9001|\u53d1)\s*([\s\S]{1,1000}?)\s*\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}(?:\s|$)/u,
    /\u56de\u590d\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}\s*([\s\S]{1,1000})/u,
    /(?:\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u53d1\u9001|\u53d1)\s*([\s\S]{1,1000})/u,
    /(?:send|message|reply)\s+(?:to\s+)?[A-Za-z0-9_\-\u4e00-\u9fff]{0,32}\s*:?\s*([\s\S]{1,1000})/iu,
  ];

  for (const pattern of messagePatterns) {
    const match = text.match(pattern);
    const message = cleanDirectedWeChatMessage(match?.[1] || '');
    if (message) return message;
  }

  return '';
}

function isDirectedWeChatSend(text: string): boolean {
  return /(?:\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}\s*(?:\u53d1\u9001|\u53d1|\u56de\u590d|\u8bf4|\u544a\u8bc9))|(?:\u53d1\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})|(?:(?:\u53d1\u9001|\u53d1)\s*[\s\S]{1,200}?\s*\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})/u.test(text);
}

function isNonCommandWeChatStatement(text: string): boolean {
  const compact = String(text || '').replace(/\s+/gu, '');
  if (!compact) return false;
  // Negative factual statements contain the same words as a send command but
  // must never be converted into an external side effect.
  if (/^(?:\u6211)?(?:\u6ca1\u6709|\u6ca1|\u5e76\u672a|\u4ece\u672a|\u4e0d\u662f|\u5e76\u4e0d\u662f).{0,100}(?:\u53d1\u7ed9|\u53d1\u9001\u7ed9|\u7ed9.{0,24}\u53d1)/u.test(compact)) return true;
  if (/^(?:\u6211)?(?:\u6ca1\u6709|\u6ca1|\u5e76\u672a|\u4ece\u672a).{0,40}\u8ba9\u4f60.{0,40}(?:\u53d1|\u56de\u590d|\u544a\u8bc9)/u.test(compact)) return true;
  if (/^(?:\u4e3a\u4ec0\u4e48|\u600e\u4e48|\u662f\u4e0d\u662f|\u6709\u6ca1\u6709|\u521a\u624d|\u521a\u521a|\u4e4b\u524d).{0,100}(?:\u53d1\u7ed9|\u53d1\u9001|\u56de\u590d).{0,40}(?:\u5417|\u4ec0\u4e48|\u4e3a\u4ec0\u4e48|\u8c01|\u4e86\u6ca1\u6709)?[\u3002\uFF01\uFF1F.!?]*$/u.test(compact)) return true;
  return false;
}

function extractWeChatInquiry(userTask: string): { contact: string; message: string } | null {
  const text = String(userTask || '');
  const inquiryMatches = Array.from(text.matchAll(
    /(?:\u95ee(?:\u4e00\u4e0b)?|\u8be2\u95ee)\s*([^\s\uFF0C\u3002\uFF01\uFF1F,.!?\uFF1A:]{1,24}?)(\u5728\u5e72\u561b|\u5728\u505a\u4ec0\u4e48|\u5e72\u561b|\u505a\u4ec0\u4e48|\u5fd9\u4ec0\u4e48|\u73b0\u5728\u600e\u4e48\u6837|\u6709\u6ca1\u6709\u7a7a)/gu,
  ));
  const latestInquiry = inquiryMatches[inquiryMatches.length - 1];
  if (!latestInquiry) return null;

  // A later explicit correction such as "我让你问阿露，不是问阿洛" owns
  // the recipient, while the earlier inquiry still supplies the message.
  const correctionMatches = Array.from(text.matchAll(
    /(?:\u6211\u8ba9\u4f60|\u8ba9\u4f60|\u5e94\u8be5|\u6539\u6210|\u662f\u8981|\u8981)\s*\u95ee(?:\u4e00\u4e0b)?\s*([^\s\uFF0C\u3002\uFF01\uFF1F,.!?]{1,12}?)(?=\uFF0C|,|\u3002|\.|\u4e0d\u662f|\u800c\u4e0d\u662f|$)/gu,
  ));
  const latestCorrection = correctionMatches[correctionMatches.length - 1];
  let contact = String(latestCorrection?.[1] || latestInquiry[1] || '').trim();
  const spellingCorrections = Array.from(text.matchAll(
    /\u6211\u8bf4\u7684\s*([^\s\uFF0C\u3002\uFF01\uFF1F,.!?]{1,12})\s*\u662f\s*[^\s\uFF0C\u3002\uFF01\uFF1F,.!?]{0,12}\u7684\s*([\u3400-\u9fff])\s*[\uFF0C,]?\s*\u4e0d\u662f\s*[^\s\uFF0C\u3002\uFF01\uFF1F,.!?]{0,12}\u7684\s*[\u3400-\u9fff]/gu,
  ));
  const latestSpellingCorrection = spellingCorrections[spellingCorrections.length - 1];
  const spokenName = String(latestSpellingCorrection?.[1] || '').trim();
  const correctedCharacter = String(latestSpellingCorrection?.[2] || '').trim();
  if (spokenName && correctedCharacter && (contact === spokenName || String(latestInquiry[1] || '').trim() === spokenName)) {
    contact = `${spokenName.slice(0, -1)}${correctedCharacter}`;
  }
  const shortSpellingCorrections = Array.from(text.matchAll(
    /[^\s\uFF0C\u3002\uFF01\uFF1F,.!?]{1,16}\u7684([\u3400-\u9fff])\s*\u4e0d\u662f[^\s\uFF0C\u3002\uFF01\uFF1F,.!?]{1,16}\u7684([\u3400-\u9fff])/gu,
  ));
  const latestShortSpellingCorrection = shortSpellingCorrections[shortSpellingCorrections.length - 1];
  const shortCorrectedCharacter = String(latestShortSpellingCorrection?.[1] || '').trim();
  const shortRejectedCharacter = String(latestShortSpellingCorrection?.[2] || '').trim();
  if (
    shortCorrectedCharacter
    && shortRejectedCharacter
    && contact.endsWith(shortRejectedCharacter)
  ) {
    contact = `${contact.slice(0, -1)}${shortCorrectedCharacter}`;
  }
  const message = String(latestInquiry[2] || '').trim().replace(/[\u3002\uFF01\uFF1F.!?]+$/u, '');
  if (!contact || !message) return null;
  return { contact, message: `${message}\uFF1F` };
}

function extractWeChatContact(userTask: string): string {
  const directedContact = extractDirectedWeChatContact(userTask);
  const inquiry = extractWeChatInquiry(userTask);
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (directedContact && /^(?:他|她|它|对方|那个人)$/u.test(String(inquiry?.contact || '').trim())) {
    return directedContact;
  }
  if (inquiry?.contact) return inquiry.contact;
  if (directedContact) return directedContact;
  const text = String(userTask || '');
  const patterns = [
    /\u53d1\u7ed9\s*([^\s,，。.!?！？]{1,24})/u,
    /\u7ed9\s*([^\s,，。.!?！？]{1,24})\s*\u53d1/u,
    /to\s+([A-Za-z0-9_\-\u4e00-\u9fff]{1,24})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function extractWeChatMessage(userTask: string): string {
  const inquiry = extractWeChatInquiry(userTask);
  if (inquiry?.message) return inquiry.message;
  const directedMessage = extractDirectedWeChatMessage(userTask);
  if (directedMessage) return directedMessage;

  const text = String(userTask || '').trim();
  if (/\u665a\u5b89/u.test(text)) {
    return '\u665a\u5b89\uff0c\u65e9\u70b9\u4f11\u606f\uff0c\u613f\u4f60\u4eca\u665a\u7761\u4e2a\u597d\u89c9\u3002';
  }
  const quoted = text.match(/[“"]([^”"]{1,500})[”"]/u);
  if (quoted?.[1]) return quoted[1].trim();
  return text
    .replace(/^(?:\u5fae\u4fe1)?\s*(?:\u5e2e\u6211|\u4f60\u6765|\u76f4\u63a5)?\s*(?:\u7f16\u8f91|draft|prepare|send|message|reply)?/iu, '')
    .replace(/\u53d1\u7ed9\s*[^\s,，。.!?！？]{1,24}/u, '')
    .trim() || text;
}

export function buildForegroundWeChatSendArgs(userTask: string): Record<string, any> | null {
  const text = String(userTask || '');
  const normalizedIntent = normalizeActionIntent(text);
  if (['external_ai_history', 'messaging_read', 'correction_explanation', 'status_query', 'client_navigation', 'client_state'].includes(normalizedIntent.kind)) return null;
  if (isNonCommandWeChatStatement(text)) return null;
  const inquiry = extractWeChatInquiry(text);
  if (normalizedIntent.kind !== 'messaging_send' && !inquiry) return null;
  const isWeChatTask = /wechat|weixin|\u5fae\u4fe1/i.test(text);
  const directedSend = isDirectedWeChatSend(text);
  const looksLikeWeChatFollowup = /\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u53d1\u665a\u5b89/u.test(text);
  const wantsSend = Boolean(inquiry) || /send|message|reply|\u53d1\u9001|\u53d1\u7ed9|\u53d1\u665a\u5b89|\u7ed9[^\s,锛屻€?!?锛侊紵]{1,24}\u53d1|\u4f60\u6765\u53d1|\u76f4\u63a5\u53d1|\u56de\u590d/u.test(text);
  if (!(isWeChatTask || looksLikeWeChatFollowup || directedSend) || !(wantsSend || directedSend)) return null;

  const contact = extractWeChatContact(text) || normalizedIntent.target;
  const message = extractWeChatMessage(text) || normalizedIntent.payload;
  // An external commit is never inferred against whichever chat happens to
  // be focused. Both the immutable recipient and payload must be resolved.
  if (!contact || !message) return null;
  return {
    contact,
    message,
    applicationTarget: 'wechat',
    useVirtualCursor: true,
  };
}
