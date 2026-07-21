/**
 * Natural Language Task Chainer
 *
 * "帮我把昨天的会议纪要整理成PPT" → plan → execute tool chain → synthesize response.
 * Plan-first, execute-next — more reliable than iterative tool calling for office workflows.
 */
import { NormalizedMessage, makeLLMCall } from '../llm/providers';
import { isToolNameAllowedByPolicy, toolRegistry } from '../tools/registry';
import { ToolExecutionRecord, ToolContext } from '../tools/types';
import { routeToolsForTurn } from '../cognition/tool_router';
import type { ToolPolicy } from '../personality/types';

export interface ChainerPlan {
  goal: string;
  steps: Array<{
    description: string;        // human-readable description of what this step does
    toolName: string;            // tool to call
    toolArgs: Record<string, any>; // arguments for the tool
    dependsOnOutput?: string;   // how this step uses previous step's output
  }>;
}

export interface ChainerResult {
  plan: ChainerPlan;
  stepResults: Array<{ step: number; tool: string; output: string; success: boolean }>;
  finalResponse: string;
  toolRecords: ToolExecutionRecord[];
}

interface LlmGetters {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI: () => any;
  getAnthropic: () => any;
  getQwen: () => any;
}

// Map from user intent domain to tool category filters
const DOMAIN_TOOL_HINTS: Record<string, string[]> = {
  office:  ['search_files', 'read_file', 'write_file', 'list_directory',
            'create_docx', 'create_xlsx',
            'merge_pdf', 'pdf_to_text', 'read_pdf',
            'create_ppt', 'create_pdf',
            'calendar_create', 'calendar_today', 'upcoming_events',
            'web_search', 'url_fetch',
            'translate', 'ocr_screen', 'ocr_region', 'read_clipboard', 'write_clipboard',
            'create_note', 'list_notes',
            'stock_search', 'stock_quote', 'stock_kline', 'market_index', 'stock_news',
            'email_assistant',
            'shorten_url', 'generate_qrcode', 'get_weather'],
  create:  ['create_docx', 'create_xlsx', 'create_ppt', 'create_pdf',
            'merge_pdf', 'pdf_to_text',
            'code_execution', 'generate_image',
            'generate_qrcode', 'shorten_url'],
  search:  ['web_search', 'url_fetch', 'search_files', 'list_directory', 'read_file',
            'list_notes', 'stock_search', 'stock_quote', 'market_index', 'stock_news',
            'get_weather'],
  file:    ['search_files', 'read_file', 'write_file', 'list_directory',
            'merge_pdf', 'pdf_to_text', 'read_pdf',
            'create_docx', 'create_xlsx', 'create_pdf',
            'ocr_screen', 'ocr_region',
            'read_docx', 'read_xlsx', 'extract_document_text'],
};

const DIRECT_DESKTOP_RELAY_TOOLS = new Set([
  'client_action',
  'desktop_capability_status',
  'desktop_system_info',
  'desktop_list_files',
  'desktop_list_apps',
  'desktop_path_info',
  'desktop_open',
  'desktop_show_lumi_window',
  'desktop_run_command',
  'desktop_active_window',
  'desktop_running_processes',
  'desktop_capture_screen',
  'desktop_clipboard_read',
  'desktop_clipboard_write',
  'desktop_idle_time',
  'desktop_poll_activity',
  'desktop_mouse_move',
  'desktop_mouse_click',
  'desktop_mouse_drag',
  'desktop_mouse_click_at',
  'desktop_mouse_double_click_at',
  'desktop_mouse_right_click_at',
  'desktop_keyboard_type',
  'desktop_keyboard_press',
  'desktop_set_wallpaper_mode',
  'desktop_cursor_glow_show',
  'desktop_cursor_glow_update',
  'desktop_cursor_glow_click',
  'desktop_cursor_glow_hide',
]);

export function filterChainerToolNamesByPolicy(
  toolNames: string[],
  policy?: ToolPolicy,
): string[] {
  if (!policy) return [];
  return toolNames.filter(name => isToolNameAllowedByPolicy(name, policy));
}

function compactChainerOutput(value: string, limit = 5000): string {
  const text = value || '';
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.72);
  const tail = Math.max(500, limit - head - 180);
  return [
    text.slice(0, head),
    `\n\n[Workflow step output compacted: ${text.length} characters total. Use file paths or narrower extraction for full content.]\n\n`,
    text.slice(-tail),
  ].join('');
}

function getDomainHints(userTask: string): string[] | undefined {
  const t = userTask.toLowerCase();
  if (/文件|文档|pdf|ppt|表格|报告|整理|汇总|合并|提取/i.test(t)) return DOMAIN_TOOL_HINTS.file;
  if (/搜索|查询|找|搜|什么|多少|怎么|查/i.test(t)) return DOMAIN_TOOL_HINTS.search;
  if (/创建|制作|做|生成|写|画|新建/i.test(t)) return DOMAIN_TOOL_HINTS.create;
  if (/股票|行情|报价|k线|板块|大盘|涨|跌|股价|财经/i.test(t)) return undefined; // use all tools, stockbot handles it
  if (/邮件|翻译|日历|日程|二维码|短链接|天气|笔记/i.test(t)) return DOMAIN_TOOL_HINTS.office;
  return undefined;
}

// ── Planning phase ──

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

function isWeChatReadTask(text: string): boolean {
  if (isDirectedWeChatSend(text)) return false;
  if (/\u53d1\u9001|\u53d1\u7ed9|\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\bsend\b/iu.test(text)) return false;
  return /(?:wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f).*(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u804a\u5929\u5185\u5bb9|\u804a\u5929\u8bb0\u5f55|\u603b\u7ed3)|(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u603b\u7ed3).*(?:wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f)/iu.test(text);
}

function extractWeChatReadContact(userTask: string): string {
  const text = stripWeChatTaskPrefix(String(userTask || ''));
  const patterns = [
    /(?:\u6211\u548c|\u548c|\u8ddf|\u4e0e)\s*([^\s,\u7684\u6700\u8fd1\u804a\u5929\u5185\u5bb9\u8bb0\u5f55\u6d88\u606f\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})\s*(?:\u7684)?(?:\u6700\u8fd1)?(?:\u7684)?(?:\u804a\u5929|\u6d88\u606f|\u5bf9\u8bdd)/u,
    /(?:\u770b\u770b|\u67e5\u770b|\u8bfb\u53d6|\u603b\u7ed3)\s*([^\s,\u7684\u6700\u8fd1\u804a\u5929\u5185\u5bb9\u8bb0\u5f55\u6d88\u606f\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})\s*(?:\u7684)?(?:\u6700\u8fd1)?(?:\u7684)?(?:\u804a\u5929|\u6d88\u606f|\u5bf9\u8bdd|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9)/u,
    /(?:chat|messages?)\s+(?:with|from)\s+([A-Za-z0-9_\-\u4e00-\u9fff]{1,32})/iu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const contact = cleanWeChatContactSlot(match?.[1] || '');
    if (contact) return contact;
  }
  return '';
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
  if (isNonCommandWeChatStatement(text)) return null;
  const inquiry = extractWeChatInquiry(text);
  const isWeChatTask = /wechat|weixin|\u5fae\u4fe1/i.test(text);
  const directedSend = isDirectedWeChatSend(text);
  const looksLikeWeChatFollowup = /\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u53d1\u665a\u5b89/u.test(text);
  const wantsSend = Boolean(inquiry) || /send|message|reply|\u53d1\u9001|\u53d1\u7ed9|\u53d1\u665a\u5b89|\u7ed9[^\s,锛屻€?!?锛侊紵]{1,24}\u53d1|\u4f60\u6765\u53d1|\u76f4\u63a5\u53d1|\u56de\u590d/u.test(text);
  if (!(isWeChatTask || looksLikeWeChatFollowup || directedSend) || !(wantsSend || directedSend)) return null;

  return {
    contact: extractWeChatContact(text),
    message: extractWeChatMessage(text),
    applicationTarget: 'wechat',
    useVirtualCursor: true,
  };
}

export function buildForegroundWeChatReadArgs(userTask: string): Record<string, any> | null {
  const text = String(userTask || '');
  if (!isWeChatReadTask(text)) return null;
  return {
    contact: extractWeChatReadContact(text),
    applicationTarget: 'wechat',
    useSearch: Boolean(extractWeChatReadContact(text)),
    maxMessages: 8,
  };
}

function buildDeterministicPlan(userTask: string, availableTools: Array<{ name: string }>): ChainerPlan | null {
  const hasTool = (name: string) => availableTools.some(tool => tool.name === name);
  const readArgs = buildForegroundWeChatReadArgs(userTask);
  if (readArgs && hasTool('wechat_read_recent_chat')) {
    return {
      goal: '\u901a\u8fc7\u5df2\u8fd0\u884c\u7684\u5fae\u4fe1\u524d\u53f0\u8bfb\u53d6\u6700\u8fd1\u53ef\u89c1\u804a\u5929\u5185\u5bb9',
      steps: [
        {
          description: '\u590d\u7528\u5fae\u4fe1\u7a97\u53e3\uff0c\u5b9a\u4f4d\u76ee\u6807\u4f1a\u8bdd\u5e76\u7528\u622a\u56fe/OCR\u8bfb\u53d6\u53ef\u89c1\u804a\u5929',
          toolName: 'wechat_read_recent_chat',
          toolArgs: readArgs,
        },
      ],
    };
  }
  const sendArgs = buildForegroundWeChatSendArgs(userTask);
  if (!sendArgs || !hasTool('wechat_send_message')) return null;

  return {
    goal: '\u901a\u8fc7\u5df2\u8fd0\u884c\u7684\u5fae\u4fe1\u524d\u53f0\u53d1\u9001\u666e\u901a\u6d88\u606f',
    steps: [
      {
        description: '\u590d\u7528\u5fae\u4fe1\u7a97\u53e3\uff0c\u7528\u865a\u62df\u5149\u6807\u805a\u7126\u8f93\u5165\u533a\u5e76\u53d1\u9001\u6d88\u606f',
        toolName: 'wechat_send_message',
        toolArgs: sendArgs,
      },
    ],
  };
}

async function planTask(
  userTask: string,
  availableTools: Array<{ name: string; description: string; parameters: Record<string, any> }>,
  provider: string,
  model: string,
  userId: string,
  llmGetters: LlmGetters,
): Promise<ChainerPlan> {
  const toolListText = availableTools
    .map(t => `- ${t.name}: ${t.description}`)
    .join('\n');

  const planPrompt = `Tools available:\n${toolListText}\n\nTask: ${userTask}\n\nPlan the minimum steps needed. Use exact tool parameter names. If one step depends on a previous step's output, note it in dependsOnOutput.\n\nOutput JSON:\n{
  "goal": "one-line summary",
  "steps": [{ "description": "...", "toolName": "...", "toolArgs": {}, "dependsOnOutput": "" }]
}
}`;

  const messages: NormalizedMessage[] = [
    { role: 'user', content: planPrompt },
  ];

  try {
    const result = await makeLLMCall(
      messages,
      [],
      { provider: provider as any, model, userId, maxTokens: 1500 },
      llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
    );

    const text = result.text || '';
    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const plan = JSON.parse(jsonMatch[0]);
      // Validate structure
      if (!plan.goal || !Array.isArray(plan.steps)) {
        throw new Error('Invalid plan structure');
      }
      return {
        goal: plan.goal,
        steps: plan.steps.map((s: any) => ({
          description: s.description || `Call ${s.toolName}`,
          toolName: s.toolName,
          toolArgs: s.toolArgs || {},
          dependsOnOutput: s.dependsOnOutput || '',
        })),
      };
    }
    throw new Error(`No JSON found in plan response: ${text.slice(0, 200)}`);
  } catch (err: any) {
    // Fallback: create a single-step plan from the task
    console.warn('[NLChainer] Plan fallback:', err.message);
    return {
      goal: userTask,
      steps: [],
    };
  }
}

// ── Execution phase ──

async function executePlan(
  plan: ChainerPlan,
  executeTool: (name: string, args: Record<string, any>) => Promise<string>,
  context?: ToolContext,
  onStep?: (step: number, total: number, description: string) => void,
  replanFn?: (failedStep: { toolName: string; args: Record<string, any>; error: string }) => Promise<{ toolName: string; args: Record<string, any> } | null>,
): Promise<Array<{ step: number; tool: string; output: string; success: boolean }>> {
  const results: Array<{ step: number; tool: string; output: string; success: boolean }> = [];
  let accumulatedContext = '';

  for (let i = 0; i < plan.steps.length; i++) {
    if (context?.isCancelled?.()) break;

    const step = plan.steps[i];
    onStep?.(i + 1, plan.steps.length, step.description);

    // Merge accumulated context into args where relevant
    const enrichedArgs = { ...step.toolArgs };
    if (step.dependsOnOutput && results.length > 0) {
      const lastResult = results[results.length - 1];
      if (lastResult.success) {
        const previousOutput = compactChainerOutput(lastResult.output);
        // Inject previous output where the tool likely needs it
        enrichedArgs.context = previousOutput;
        enrichedArgs.previousOutput = previousOutput;
        // For tools that need file paths, try to extract from previous output
        const fileMatch = lastResult.output.match(/(?:path|文件|saved to|created|输出)[:\s]+([^\s,，\n]+)/i);
        if (fileMatch && !enrichedArgs.filePath) {
          enrichedArgs.filePath = fileMatch[1];
        }
      }
    }

    try {
      console.log(`[NLChainer] Step ${i + 1}/${plan.steps.length}: ${step.toolName}`, JSON.stringify(enrichedArgs).slice(0, 200));
      const output = await executeTool(step.toolName, enrichedArgs);
      results.push({ step: i + 1, tool: step.toolName, output: compactChainerOutput(output, 12000), success: true });
      accumulatedContext += `\n## Step ${i + 1}: ${step.description}\n${compactChainerOutput(output)}\n`;
    } catch (err: any) {
      console.warn(`[NLChainer] Step ${i + 1} failed:`, err.message);

      let recovered = false;
      if (replanFn) {
        try {
          const alternative = await replanFn({
            toolName: step.toolName,
            args: step.toolArgs,
            error: err.message,
          });
          if (alternative?.toolName) {
            console.log(`[NLChainer] Replan: trying "${alternative.toolName}" instead of "${step.toolName}"`);
            const altOutput = await executeTool(alternative.toolName, { ...enrichedArgs, ...alternative.args });
            results.push({ step: i + 1, tool: alternative.toolName, output: compactChainerOutput(altOutput, 12000), success: true });
            accumulatedContext += `\n## Step ${i + 1}: ${step.description} (recovered via ${alternative.toolName})\n${compactChainerOutput(altOutput)}\n`;
            recovered = true;
          }
        } catch (replanErr: any) {
          console.warn(`[NLChainer] Replan also failed:`, replanErr.message);
        }
      }

      if (!recovered) {
        results.push({ step: i + 1, tool: step.toolName, output: err.message, success: false });
        break;
      }
    }
  }

  return results;
}

// ── Synthesis phase ──

async function synthesizeResponse(
  userTask: string,
  plan: ChainerPlan,
  stepResults: Array<{ step: number; tool: string; output: string; success: boolean }>,
  provider: string,
  model: string,
  userId: string,
  llmGetters: LlmGetters,
): Promise<string> {
  const failures = stepResults.filter(r => !r.success);
  if (failures.length > 0) {
    const first = failures[0];
    return [
      '\u8fd9\u6b21\u6ca1\u6709\u5b8c\u6210\uff0c\u6211\u5728\u6267\u884c\u8fc7\u7a0b\u4e2d\u9047\u5230\u4e86\u963b\u585e\u3002',
      `\u963b\u585e\u6b65\u9aa4: ${first.tool}`,
      `\u539f\u56e0: ${first.output.slice(0, 300)}`,
      '\u6211\u4e0d\u4f1a\u628a\u8fd9\u79cd\u5931\u8d25\u94fe\u8def\u8bf4\u6210\u5df2\u7ecf\u5b8c\u6210\u3002',
    ].join('\n');
  }

  const resultsSummary = stepResults
    .map(r => `Step ${r.step} (${r.tool}): ${r.success ? 'OK' : 'FAILED'}\n${r.output.slice(0, 500)}`)
    .join('\n\n');

  const synthPrompt = `Summarize the results of this workflow naturally. Mention what was done, present key findings, and flag any failed steps with a suggested workaround. Match the user's language.\n\nTask: ${userTask}\n\nResults:\n${resultsSummary}`;

  const messages: NormalizedMessage[] = [
    { role: 'user', content: synthPrompt },
  ];

  try {
    const result = await makeLLMCall(
      messages,
      [],
      { provider: provider as any, model, userId, maxTokens: 1000 },
      llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
    );
    return result.text || buildSimpleSummary(stepResults);
  } catch {
    return buildSimpleSummary(stepResults);
  }
}

function buildSimpleSummary(results: Array<{ step: number; tool: string; output: string; success: boolean }>): string {
  const successes = results.filter(r => r.success);
  const failures = results.filter(r => !r.success);
  let summary = `完成 ${successes.length}/${results.length} 个步骤。\n\n`;
  for (const r of successes) {
    summary += `✓ ${r.output.slice(0, 200)}\n`;
  }
  for (const r of failures) {
    summary += `✗ 步骤 ${r.step} (${r.tool}) 失败: ${r.output.slice(0, 100)}\n`;
  }
  return summary;
}

// ── Main entry point ──

export async function runNLChainer(
  userTask: string,
  config: {
    userId: string;
    provider: string;
    model: string;
    desktopRelay?: (tool: string, args: Record<string, any>) => Promise<string>;
    context?: ToolContext;
    onTool?: (record: ToolExecutionRecord) => void;
  },
  llmGetters: LlmGetters,
  onStep?: (step: number, total: number, description: string) => void,
): Promise<ChainerResult> {
  const registeredTools = toolRegistry.getToolDeclarations();
  const policyAllowedNames = new Set(filterChainerToolNamesByPolicy(
    registeredTools.map(tool => tool.function.name),
    config.context?.toolPolicy,
  ));
  const allTools = registeredTools.filter(tool => policyAllowedNames.has(tool.function.name));
  const domainHints = getDomainHints(userTask);
  const routed = routeToolsForTurn(userTask, allTools);

  // Filter tools: prefer the shared skill/tool router, then fall back to older domain hints.
  let availableDecls = allTools;
  if (routed.categories.length > 0 && routed.toolNames.length > 0) {
    const routedNames = new Set(routed.toolNames);
    availableDecls = allTools.filter(t => routedNames.has(t.function.name));
  } else if (domainHints) {
    const hintSet = new Set(domainHints);
    const filtered = allTools.filter(t => hintSet.has(t.function.name));
    if (filtered.length > 0) {
      // Include non-filtered tools that are always useful (like desktop tools)
      const alwaysUseful = allTools.filter(t =>
        /^desktop_|^computer_|^clipboard_/.test(t.function.name)
      );
      const allFiltered = [...filtered, ...alwaysUseful];
      // Deduplicate
      const seen = new Set<string>();
      availableDecls = allFiltered.filter(t => {
        if (seen.has(t.function.name)) return false;
        seen.add(t.function.name);
        return true;
      });
    }
  }

  // Dev-only ghost tool detection
  if (process.env.NODE_ENV !== 'production') {
    const registeredNames = new Set(registeredTools.map(d => d.function.name));
    for (const [domain, hints] of Object.entries(DOMAIN_TOOL_HINTS)) {
      const ghosts = hints.filter(h => !registeredNames.has(h));
      if (ghosts.length > 0) {
        console.warn(`[NLChainer] Ghost tools in DOMAIN_TOOL_HINTS.${domain}:`, ghosts);
      }
    }
  }

  // Unwrap from tool declaration format to plain { name, description, parameters }
  const availableTools = availableDecls.map(d => ({
    name: d.function.name,
    description: d.function.description,
    parameters: d.function.parameters,
  }));
  const availableToolNames = new Set(availableTools.map(tool => tool.name));

  // Phase 1: Plan
  const plan = buildDeterministicPlan(userTask, availableTools) ||
    await planTask(userTask, availableTools, config.provider, config.model, config.userId, llmGetters);

  // If plan failed to produce steps, return empty
  if (plan.steps.length === 0) {
    return {
      plan,
      stepResults: [],
      finalResponse: '',
      toolRecords: [],
    };
  }

  // Phase 2: Execute
  const replanFn = async (failedStep: { toolName: string; args: Record<string, any>; error: string }): Promise<{ toolName: string; args: Record<string, any> } | null> => {
    const prompt = `The tool "${failedStep.toolName}" failed with error: ${failedStep.error}
Original args: ${JSON.stringify(failedStep.args)}

Available tools:
${availableTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

Suggest the best alternative tool from the list above to accomplish the same goal. Output JSON:
{ "toolName": "...", "args": {...} }

If no suitable alternative exists, output: { "toolName": "" }`;

    try {
      const result = await makeLLMCall(
        [{ role: 'user', content: prompt }],
        [],
        { provider: config.provider as any, model: config.model, userId: config.userId, maxTokens: 400 },
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
      );
      const jsonMatch = result.text?.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const alt = JSON.parse(jsonMatch[0]);
        if (alt.toolName && availableToolNames.has(String(alt.toolName))) return alt;
      }
    } catch {
      // LLM replan failed — fall through to null
    }
    return null;
  };

  const executeTool = async (name: string, args: Record<string, any>): Promise<string> => {
    if (!availableToolNames.has(name)) {
      throw new Error(`Tool "${name}" is outside the inherited execution policy for this task.`);
    }
    const id = `chain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    config.onTool?.({ id, name, arguments: args, result: '' });
    // Handle desktop relay tools
    try {
      const output = config.desktopRelay && DIRECT_DESKTOP_RELAY_TOOLS.has(name)
        ? await config.desktopRelay(name, args)
        : await toolRegistry.execute(name, args, config.context);
      config.onTool?.({ id, name, arguments: args, result: output });
      return output;
    } catch (err: any) {
      config.onTool?.({ id, name, arguments: args, result: '', error: err?.message || String(err) });
      throw err;
    }
  };

  const stepResults = await executePlan(plan, executeTool, config.context, onStep, replanFn);

  // Phase 3: Synthesize
  const finalResponse = await synthesizeResponse(
    userTask, plan, stepResults,
    config.provider, config.model, config.userId,
    llmGetters,
  );

  return { plan, stepResults, finalResponse, toolRecords: [] };
}

/**
 * Quick check: is this task suitable for NL chaining?
 * Returns true if the task looks like an office workflow that might need multiple tools.
 */
export function shouldChainTask(userText: string): boolean {
  // Multi-step indicators in Chinese and English
  const chainPatterns = [
    /(?:生成|创建|制作|编写|写|输出|导出|保存).*(?:方案|报告|文档|文件|表格|PPT|ppt|PDF|pdf|DOCX|docx)/u,
    /(?:继续|接着|下一步|深化|完善).*(?:方案|报告|文档|文件|成果|设计|装修)/u,
    /(?:装修|室内|设计|CAD|cad|图纸|平面图|施工图).*(?:方案|文档|文件|输出|生成|保存|深化|材料|色彩|预算)/u,
    /然后/, /接着/, /之后/, /最后/, /再/, /并且/, /同时/,
    /then\s/, /after\s/, /and\s+also/, /then\s+create/, /then\s+save/,
    // Compound task patterns
    /查.*(?:并|然后|再|→).*/,
    /.*(?:做成|生成|创建|导出|保存为).*/,
    /(?:整理|汇总|合并|对比|分析).*(?:文件|文档|数据|报告)/,
    /.*(?:发|发送|推送|通知).*/,
  ];
  const wechatSendPattern = /(?:wechat|weixin|\u5fae\u4fe1).*(?:send|message|reply|\u53d1\u9001|\u53d1\u7ed9|\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u56de\u590d)|(?:send|message|reply|\u53d1\u9001|\u53d1\u7ed9|\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u56de\u590d).*(?:wechat|weixin|\u5fae\u4fe1)|\u76f4\u63a5\u53d1.*\u665a\u5b89|\u4f60\u6765\u53d1/u;
  return wechatSendPattern.test(userText) || chainPatterns.some(p => p.test(userText));
}
