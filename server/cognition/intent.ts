/**
 * Legacy intent classifier — read-only routing telemetry.
 *
 * These categories are compatibility hints for traces, analytics, and prompt
 * context. They never authorize a tool, select a terminal response, or replace
 * the model's respond-versus-act decision over the current capability manifest.
 */

import { isUserCorrectionOrExplanationQuestion } from './tool_intent';

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

// ── Intent Categories ────────────────────────────────────────────────────────

export type IntentCategory =
  | 'command'       // Operational: open, list, run, create, delete
  | 'question'      // Information seeking
  | 'conversation'  // Casual chat, greeting, small talk
  | 'code'          // Code: read, write, fix, refactor, review
  | 'web'           // Web: search, fetch URL
  | 'file'          // File operations: read, list, find
  | 'system'        // System info, status
  | 'agent'         // Agent management: create, configure, list
  | 'analysis'      // Deep analysis: compare, evaluate, summarize, research
  | 'unknown';      // Fallback — needs LLM

export interface IntentResult {
  category: IntentCategory;
  confidence: number;       // 0–1
  entities: Record<string, string>;  // Extracted entities (file names, URLs, queries, etc.)
  subIntent?: string;       // e.g. for command: "open", "create", "delete"
  needsLLM: boolean;        // Whether this intent requires LLM text generation
  directToolCall?: {        // Legacy tool candidate; advisory only
    name: string;
    args: Record<string, any>;
  };
}

// ── Greeting / Small Talk Patterns ──
const GREETINGS = [
  /^(hi|hey|hello|你好|嗨|您好|喂|在吗|早上好|下午好|晚上好|good\s*(morning|afternoon|evening|night))[!！。.]*$/i,
  /^(lumi|Lumi)[!！。.]*$/,
  /^你(好|在|在吗|是谁|叫什么)/,
];

const SMALL_TALK = [
  /^(谢谢|感谢|多谢|thanks?|thank\s*you|thx)[!！。.]*$/i,
  /^(再见|拜拜|bye|goodbye|see\s*you|回头见|下次见)[!！。.]*$/i,
  /^(怎么样|如何|好吗|好吗？|ok\??|okay\??)$/i,
  /^(哈哈|呵呵|笑|有趣|好玩|有意思)/,
  /^(嗯|哦|好|ok|好的|知道了|明白了|懂了)/i,
];

// ── Command Patterns ──
const COMMAND_PATTERNS: Array<{ regex: RegExp; subIntent: string; tool?: string }> = [
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  { regex: /^(?:(?:请|麻烦|请你|帮我|你帮我|给我|我要|我想)\s*)?(打开|启动|运行|开启|launch|open|start|run)\s*(程序|应用|app|软件)?\s*(.+)/i, subIntent: 'open', tool: 'desktop_open' },
  { regex: /(打开|浏览|访问|open)\s*(网页|网站|url|链接|link|网址)?\s*(https?:\/\/\S+)/i, subIntent: 'open_url', tool: 'desktop_open' },
  { regex: /(关闭|退出|停止|kill|stop|exit|quit|关掉)\s*(.+)/i, subIntent: 'close' },
  { regex: /(创建|新建|create|make|new|添加|add)\s*(文件|文件夹|目录|file|folder|dir)?\s*(.+)/i, subIntent: 'create', tool: 'write_file' },
  { regex: /(删除|移除|delete|remove|rm)\s*(文件|文件夹|目录)?\s*(.+)/i, subIntent: 'delete' },
  { regex: /(列出|显示|查看|list|show|display|ls|dir)\s*(桌面|desktop|文件|files?|目录|文件夹)/i, subIntent: 'list_files', tool: 'desktop_list_files' },
  { regex: /(截屏|截图|screenshot|capture)/i, subIntent: 'screenshot' },
];

function isSimpleDirectOpenTarget(target: string): boolean {
  const normalized = String(target || '').trim();
  if (!normalized) return false;
  // The regex classifier is intentionally fast, but it must never turn the
  // entire remainder of a multi-step request into one app/file name. Complex
  // requests need the normal planner so every requested outcome is preserved.
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  return !/(?:然后|接着|随后|之后|并且|同时|打开后|启动后|运行后|看一下|看下|看看|查看|检查|读取|分析|统计|记住|画图|画出来|绘制|生成|创建|新建|修改|编辑|保存|导出|登录|搜索|发送|发布|播放|执行脚本|运行脚本|问一下|询问|回复|告诉|[，,；;].{0,80}(?:在|用|去|再|把|将)|\b(?:then|after|inspect|read|analy[sz]e|count|remember|draw|draft|create|generate|edit|save|export|login|search|send|publish|play|script|ask|reply|tell)\b)/iu.test(normalized);
}

/**
 * Architectural contract for natural-language turns. Regex classification is
 * retained as shadow telemetry only; execution authority stays with the model
 * and the policy-filtered capability manifest.
 */
export const LEGACY_INTENT_CLASSIFIER_AUTHORITY = 'advisory' as const;

export function legacyIntentCanOwnNaturalLanguageDecision(): false {
  return false;
}

const NEGATED_COMMAND_PREFIX_RE =
  /(?:\b(?:do\s+not|don't|never|must\s+not|without)\b|\u7981\u6b62|\u4e0d\u8981|\u4e0d\u51c6|\u4e0d\u5f97|\u4e0d\u7528|\u65e0\u9700|\u907f\u514d|\u52ff|\u522b)[^,.;!?\n\r\uFF0C\u3002\uFF1B\uFF01\uFF1F]{0,36}$/iu;

function isNegatedCommandMatch(text: string, match: RegExpMatchArray): boolean {
  const start = typeof match.index === 'number' ? match.index : text.indexOf(match[0]);
  if (start <= 0) return false;
  const prefix = text.slice(Math.max(0, start - 64), start);
  const clausePrefix = prefix.split(/[,.;!?\n\r\uFF0C\u3002\uFF1B\uFF01\uFF1F]/u).pop() || '';
  return NEGATED_COMMAND_PREFIX_RE.test(clausePrefix);
}

// ── Question Patterns ──
const QUESTION_PATTERNS = [
  /^(什么|什么是|what\s+is|who\s+is|where\s+is|when\s+is|why\s+is|how\s+to|怎么|如何|为什么|怎样)/i,
  /\?|？/,
];

// ── Code Patterns ──
const CODE_PATTERNS: Array<{ regex: RegExp; subIntent: string }> = [
  { regex: /(修复|fix|debug|解决|bug)\s*(这个|那个|一下)?\s*(bug|错误|问题|error|issue)?/i, subIntent: 'fix' },
  { regex: /(重构|refactor|重写|rewrite|优化|optimize)\s*(代码|code|这个|那个)?/i, subIntent: 'refactor' },
  { regex: /(实现|implement|开发|develop|添加功能|add\s+feature)\s*(这个|那个|一下)?/i, subIntent: 'implement' },
  { regex: /(解释|explain|说明|这段代码|这个文件|这段)/i, subIntent: 'explain' },
  { regex: /(审查|review|检查|check)\s*(代码|code|这个|那个)?/i, subIntent: 'review' },
  { regex: /(?:写|编写|新增|添加|补充|运行|执行|跑).{0,6}(?:单元|集成|端到端|回归|自动化)?测试|(?:单元|集成|端到端|回归|自动化)测试|\b(?:write|add|run|execute)\s+(?:unit\s+|integration\s+|e2e\s+|regression\s+)?tests?\b/i, subIntent: 'test' },
  { regex: /(提交|commit|push)\s*(代码|code|修改|changes?)?/i, subIntent: 'commit' },
];

// ── Web Patterns ──
const WEB_PATTERNS = [
  { regex: /(搜索|查找|search|find|查一下|搜一下|帮我搜)\s*(.+)/i, subIntent: 'web_search' },
  { regex: /(获取|fetch|抓取|读取)\s*(这个|那个)?\s*(网页|网站|url|链接|page)\s*(.+)/i, subIntent: 'url_fetch' },
];

// ── File Patterns ──
const FILE_PATTERNS = [
  { regex: /(读取|查看|显示|read|show|cat|打开)\s*(文件|file)\s*(.+)/i, subIntent: 'read_file' },
  { regex: /(搜索|查找|find|grep|search)\s*(在|in)?\s*(代码|code|文件|files?)\s*(中|里)?\s*(.+)/i, subIntent: 'grep' },
  { regex: /(写|write|保存|save|创建)\s*(文件|file|到)\s*(.+)/i, subIntent: 'write_file' },
];

// ── System Patterns ──
const SYSTEM_PATTERNS = [
  /^(系统|system)\s*(信息|info|状态|status|配置|config)/i,
  /(cpu|内存|memory|磁盘|disk|硬盘|空间|storage)/i,
  /(版本|version|升级|update|更新)/i,
];

// ── Agent Patterns ──
const AGENT_PATTERNS = [
  /(代理|agent|角色|personality|人格|助手)\s*(列表|list|创建|create|切换|switch|删除|delete|管理|manage)/i,
  /(create|make|new)\s*(agent|代理|助手|角色)/i,
];

const FOREGROUND_MESSAGING_SEND_RE =
  /(?:wechat|weixin|\u5fae\u4fe1).*(?:\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u5e2e\u6211\u53d1|\u53d1\u9001|\u53d1\u7ed9|\u53d1)|(?:\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u5e2e\u6211\u53d1|\u53d1\u9001|\u53d1\u7ed9|\u53d1).*(?:wechat|weixin|\u5fae\u4fe1)|(?:\u7ed9[^\s,，。?!！？]{1,24}\u53d1[^\n]{0,80})|(?:\u53d1[^\n]{0,80}\u7ed9[^\s,，。?!！？]{1,24})/iu;

const SHORT_FOREGROUND_SEND_FOLLOWUP_RE =
  /^(?:\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u53d1\u5427|\u53d1\u665a\u5b89|\u76f4\u63a5\u53d1\u665a\u5b89)\s*[\s\S]{0,40}$/u;

const FOREGROUND_MESSAGING_READ_RE =
  /(?:wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f).*(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u804a\u5929\u5185\u5bb9|\u804a\u5929\u8bb0\u5f55|\u603b\u7ed3)|(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u603b\u7ed3).*(?:wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f)/iu;

function isForegroundMessagingSendIntent(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (/(?:\u8349\u7a3f|\u5148\u5199|\u7f16\u8f91\u4e00\u4e0b|\u4e0d\u8981\u53d1|\bdraft\b)/iu.test(normalized)) return false;
  return FOREGROUND_MESSAGING_SEND_RE.test(normalized) || SHORT_FOREGROUND_SEND_FOLLOWUP_RE.test(normalized);
}

function isForegroundMessagingReadIntent(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (isForegroundMessagingSendIntent(normalized)) return false;
  return FOREGROUND_MESSAGING_READ_RE.test(normalized);
}

export function classifyIntent(input: string): IntentResult {
  const text = input.trim();
  if (!text) {
    return { category: 'unknown', confidence: 0, entities: {}, needsLLM: true };
  }

  if (isForegroundMessagingReadIntent(text)) {
    return {
      category: 'command',
      confidence: 0.9,
      entities: {},
      subIntent: 'messaging_read',
      needsLLM: true,
    };
  }

  if (isForegroundMessagingSendIntent(text)) {
    return {
      category: 'command',
      confidence: 0.9,
      entities: {},
      subIntent: 'messaging_send',
      needsLLM: true,
    };
  }

  // 1. Greetings — pure conversation, high confidence
  for (const pattern of GREETINGS) {
    if (pattern.test(text)) {
      return {
        category: 'conversation',
        confidence: 0.95,
        entities: {},
        needsLLM: true, // LLM generates the greeting response, but Lumi already knows it's a greeting
      };
    }
  }

  // 2. Small talk
  for (const pattern of SMALL_TALK) {
    if (pattern.test(text)) {
      return {
        category: 'conversation',
        confidence: 0.85,
        entities: {},
        needsLLM: true,
      };
    }
  }

  // 2.5 Questions/corrections about Lumi's prior behaviour must win over
  // action keywords contained inside the quoted or questioned behaviour.
  if (isUserCorrectionOrExplanationQuestion(text)) {
    return {
      category: 'question',
      confidence: 0.9,
      entities: {},
      subIntent: 'explain_prior_behavior',
      needsLLM: true,
    };
  }

  // 3. Commands — many can skip LLM entirely
  for (const { regex, subIntent, tool } of COMMAND_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      if (isNegatedCommandMatch(text, match)) continue;
      const target = (match[match.length - 1] || '').trim();
      if (
        subIntent === 'open' &&
        /^(?:\u72b6\u6001|\u60c5\u51b5|\u4fe1\u606f|state\b|status\b)/iu.test(target)
      ) {
        continue;
      }
      const result: IntentResult = {
        category: 'command',
        confidence: 0.85,
        entities: { target },
        subIntent,
        needsLLM: true, // Default: let LLM handle
      };

      // Certain commands can skip LLM entirely
      if (tool && subIntent === 'open' && isSimpleDirectOpenTarget(target)) {
        const urlPattern = /^https?:\/\//i;
        result.directToolCall = {
          name: tool,
          args: { target: target, url: urlPattern.test(target) ? target : undefined },
        };
        result.needsLLM = false; // Lumi routes directly, no LLM needed
      }

      if (tool && subIntent === 'list_files') {
        result.directToolCall = { name: tool, args: {} };
        result.needsLLM = false;
      }

      return result;
    }
  }

  // 4. Web search
  for (const { regex, subIntent } of WEB_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      const query = (match[match.length - 1] || '').trim();
      return {
        category: 'web',
        confidence: 0.8,
        entities: { query },
        subIntent,
        needsLLM: true, // LLM helps format search results
      };
    }
  }

  // 5. Code operations
  for (const { regex, subIntent } of CODE_PATTERNS) {
    if (regex.test(text)) {
      return {
        category: 'code',
        confidence: 0.75,
        entities: {},
        subIntent,
        needsLLM: true, // Code work always needs LLM
      };
    }
  }

  // 6. File operations
  for (const { regex, subIntent } of FILE_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      const filePath = (match[match.length - 1] || '').trim();
      return {
        category: 'file',
        confidence: 0.8,
        entities: { filePath },
        subIntent,
        needsLLM: true,
      };
    }
  }

  // 7. System queries
  for (const pattern of SYSTEM_PATTERNS) {
    if (pattern.test(text)) {
      return {
        category: 'system',
        confidence: 0.75,
        entities: {},
        subIntent: 'info',
        directToolCall: { name: 'get_system_info', args: {} },
        needsLLM: false, // System info is deterministic, no LLM needed
      };
    }
  }

  // 8. Agent management
  for (const pattern of AGENT_PATTERNS) {
    if (pattern.test(text)) {
      return {
        category: 'agent',
        confidence: 0.75,
        entities: {},
        subIntent: 'manage',
        needsLLM: true,
      };
    }
  }

  // 9. Analysis — deep reasoning tasks
  const ANALYSIS_PATTERNS = [
    /(分析|对比|评估|总结|归纳|调研|复盘|深入|思考|权衡|比较|解析)/,
  ];
  for (const pattern of ANALYSIS_PATTERNS) {
    if (pattern.test(text)) {
      return {
        category: 'analysis',
        confidence: 0.7,
        entities: {},
        needsLLM: true,
      };
    }
  }

  // 10. Questions
  for (const pattern of QUESTION_PATTERNS) {
    if (pattern.test(text)) {
      return { category: 'question', confidence: 0.6, entities: {}, needsLLM: true };
    }
  }

  // 11. Default: unknown, needs LLM
  // Short messages are likely conversational
  if (text.length < 20) {
    return { category: 'conversation', confidence: 0.4, entities: {}, needsLLM: true };
  }

  return { category: 'unknown', confidence: 0.3, entities: {}, needsLLM: true };
}

// ── Second-stage LLM classifier ────────────────────────────────────────────

const intentCache = new Map<string, IntentResult>();
const INTENT_CACHE_MAX = 200;

const CLASSIFIER_PROMPT = `Classify this user input into exactly one category. Return ONLY a JSON object.

Categories: command, question, conversation, code, web, file, system, agent, analysis

Rules:
- command: action requests (open, create, run, delete, start, stop, set, toggle)
- question: information seeking (what, how, why, when, where, who, explain, tell me about)
- conversation: casual chat, greetings, thanks, small talk, emotional expression
- code: programming, debugging, code review, refactoring
- web: web search, fetch URL, browse
- file: file reading, writing, listing, finding
- system: OS info, settings, status
- agent: AI agent management, creation, configuration
- analysis: deep reasoning, comparison, evaluation, summarization, research

Return: {"category":"...","confidence":0.X,"subIntent":"...","entities":{}}`;

export async function classifyIntentLLM(
  text: string,
  regexResult: IntentResult,
  llmCall: (prompt: string, userText: string) => Promise<string>,
): Promise<IntentResult> {
  // Only invoke LLM when regex confidence is below threshold
  if (regexResult.confidence >= 0.65) return regexResult;

  // Check cache
  const cached = intentCache.get(text);
  if (cached) return cached;

  try {
    const response = await llmCall(CLASSIFIER_PROMPT, text);
    const parsed = JSON.parse(response.trim());
    // Merge: prefer LLM category but don't lose regex direct tool calls
    const result: IntentResult = {
      category: parsed.category || regexResult.category,
      confidence: Math.max(parsed.confidence || 0.5, regexResult.confidence),
      entities: { ...regexResult.entities, ...(parsed.entities || {}) },
      subIntent: parsed.subIntent || regexResult.subIntent,
      needsLLM: regexResult.needsLLM !== false,
      directToolCall: regexResult.directToolCall,
    };

    // LRU eviction
    if (intentCache.size >= INTENT_CACHE_MAX) {
      const first = intentCache.keys().next().value;
      if (first) intentCache.delete(first);
    }
    intentCache.set(text, result);
    return result;
  } catch {
    // LLM classification failed, return regex result unchanged
    return regexResult;
  }
}
