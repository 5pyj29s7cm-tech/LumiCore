import fs from 'fs';
import path from 'path';
import { ToolRegistry } from '../tools/registry';
import { ToolExecutionRecord, ToolContext, LLMUsage } from '../tools/types';
import { NormalizedMessage, makeLLMCall, makeLLMCallStreaming, StreamCallback } from './providers';
import { recordTokenUsage } from './token_tracker';
import { recordWorkflow, WorkflowStep } from '../skills/worklog';
import { recordLatency } from '../monitor/latency_store';
import { guardCompletionClaims } from '../work_product/completion_guard';

export interface LLMConfig {
  provider: 'deepseek' | 'gemini' | 'openai' | 'anthropic' | 'qwen' | 'ark' | 'ollama' | 'lmstudio' | 'xiaomi' | 'kimi' | 'glm' | 'relay' | 'auto';
  model: string;
  maxTokens?: number;
  userId?: string;
  domain?: string;
  orgId?: string;
}

export interface LLMResult {
  text: string;
  toolCalls: ToolExecutionRecord[];
  usageRecords: LLMUsageRecord[];
}

export interface LLMUsageRecord {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const DEFAULT_TOOL_RESULT_MODEL_LIMIT = 5_000;
const TOOL_RESULT_LIMITS: Record<string, number> = {
  desktop_list_files: 2_500,
  list_directory: 2_500,
  search_files: 4_000,
  grep_files: 5_000,
  read_file: 6_000,
  read_files_batch: 7_000,
  extract_document_text: 8_000,
  read_docx: 6_000,
  read_pdf: 6_000,
  ocr_image_file: 6_000,
  floorplan_extract_geometry: 8_000,
  capability_research: 8_000,
  authority_research: 12_000,
  authority_research_save: 4_000,
  self_extension_plan: 8_000,
  usage_get_summary: 6_000,
  lumi_constitution: 6_000,
  work_product_plan: 6_000,
  work_product_verify: 6_000,
  adapter_registry_list: 8_000,
  adapter_health_check: 6_000,
  external_app_list_adapters: 6_000,
  lumi_sleep_cycle: 6_000,
  lumi_sleep_status: 3_000,
  ocr_screen: 4_000,
  ocr_region: 4_000,
};

function compactStringForModel(value: string, limit: number, label: string): string {
  const text = value || '';
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.72);
  const tail = Math.max(800, limit - head - 240);
  return [
    text.slice(0, head),
    `\n\n[${label} compacted for model context: ${text.length} characters total. Kept the beginning and end. Use smaller reads or file paths for more detail.]\n\n`,
    text.slice(-tail),
  ].join('');
}

export function compactToolResultForModel(toolName: string, value: string): string {
  const limit = TOOL_RESULT_LIMITS[toolName] || DEFAULT_TOOL_RESULT_MODEL_LIMIT;
  return compactStringForModel(value, limit, 'Tool result');
}

function messageContentLength(content: NormalizedMessage['content']): number {
  if (typeof content === 'string') return content.length;
  if (!content) return 0;
  return content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 1200), 0);
}

function compactMessageContent(
  content: NormalizedMessage['content'],
  limit: number,
  label: string,
): NormalizedMessage['content'] {
  if (typeof content === 'string') return compactStringForModel(content, limit, label);
  if (!content) return content;
  return content.map(part => {
    if (part.type !== 'text') return part;
    return { ...part, text: compactStringForModel(part.text, limit, label) };
  });
}

function compactMessagesForModel(messages: NormalizedMessage[]): NormalizedMessage[] {
  const compacted = messages.map((m) => {
    const roleLimit =
      m.role === 'system' ? 16_000 :
      m.role === 'user' ? 10_000 :
      m.role === 'tool' ? 4_000 :
      6_000;
    return {
      ...m,
      content: compactMessageContent(m.content, roleLimit, `${m.role} message`),
      reasoningContent: m.reasoningContent ? compactStringForModel(m.reasoningContent, 2_000, 'reasoning') : m.reasoningContent,
    };
  });

  let total = compacted.reduce((sum, m) => sum + messageContentLength(m.content), 0);
  const maxTotal = 80_000;
  if (total <= maxTotal) return compacted;

  // Preserve the newest tool-call exchange, but squeeze old context aggressively.
  const protectFrom = Math.max(0, compacted.length - 8);
  for (let i = 0; i < protectFrom && total > maxTotal; i++) {
    const before = messageContentLength(compacted[i].content);
    if (before <= 900) continue;
    compacted[i] = {
      ...compacted[i],
      content: compactMessageContent(compacted[i].content, 900, `${compacted[i].role} message`),
    };
    total += messageContentLength(compacted[i].content) - before;
  }

  return compacted;
}

function collectArtifactRefs(text: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /[A-Za-z]:\\[^\n\r"'<>|]+?\.(?:dxf|dwg|svg|pdf|docx|xlsx|pptx|md|txt|json|csv|png|jpe?g|webp|html)/gi,
    /https?:\/\/[^\s"'<>]+/gi,
  ];
  for (const re of patterns) {
    for (const match of text.match(re) || []) refs.add(match.trim());
  }
  return Array.from(refs).slice(0, 8);
}

function getPrimaryUserText(messages: NormalizedMessage[]): string {
  const rawContent = messages.find(m => m.role === 'user')?.content || '';
  if (typeof rawContent === 'string') return rawContent;
  if (!Array.isArray(rawContent)) return '';
  return rawContent
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join(' ');
}

function buildIterationLimitSummary(executionLog: ToolExecutionRecord[]): string {
  if (executionLog.length === 0) return 'Maximum tool call iterations reached.';

  const artifacts = collectExistingArtifacts(executionLog).slice(0, 8);

  const recentSteps = executionLog.slice(-8).map((record, index) => {
    const status = record.error ? `failed: ${record.error}` : 'done';
    return `${index + 1}. ${record.name} - ${status}`;
  });

  return [
    'Maximum tool call iterations reached before Lumi could write the final answer.',
    '',
    'What completed:',
    ...recentSteps,
    artifacts.length > 0 ? '' : '',
    artifacts.length > 0 ? 'Verified generated files:' : '',
    ...artifacts.map(artifact => `- ${artifact.path} (${formatBytes(artifact.size)}, from ${artifact.sourceTool})`),
    '',
    artifacts.length > 0
      ? 'The task can be continued from these verified files/results instead of starting over.'
      : 'No verified generated file was detected in this tool run. Continue from the current user request or ask for the current file/path.',
  ].filter(Boolean).join('\n');
}

interface ReadyArtifact {
  path: string;
  kind: 'cad' | 'ppt' | 'document' | 'image' | 'preview' | 'other';
  size: number;
  sourceTool: string;
}

const ARTIFACT_PATH_RE =
  /[A-Za-z]:\\[^\n\r"'<>|]+?\.(?:dxf|dwg|svg|pdf|docx|xlsx|pptx|md|txt|json|csv|png|jpe?g|webp|html)/gi;

const ARTIFACT_PRODUCER_TOOL_RE =
  /^(write_file|create_ppt|create_docx|create_pdf|cad_generate_dxf|generate_.*(?:dxf|ppt|file)|export_|save_|document_)/i;

function normalizeArtifactPath(raw: string): string {
  return path.normalize(String(raw || '').trim().replace(/[)\].,;，。；]+$/g, ''));
}

function artifactKind(filePath: string): ReadyArtifact['kind'] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.dxf' || ext === '.dwg') return 'cad';
  if (ext === '.pptx' || ext === '.ppt') return 'ppt';
  if (ext === '.svg') return 'preview';
  if (ext === '.pdf' || ext === '.docx' || ext === '.xlsx' || ext === '.md' || ext === '.txt' || ext === '.csv') return 'document';
  if (['.png', '.jpg', '.jpeg', '.webp', '.html'].includes(ext)) return 'image';
  return 'other';
}

function collectPathStrings(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 5 || value == null || out.size > 40) return;

  if (typeof value === 'string') {
    for (const match of value.match(ARTIFACT_PATH_RE) || []) {
      out.add(normalizeArtifactPath(match));
    }
    if (/^[A-Za-z]:\\/.test(value) && path.extname(value)) {
      out.add(normalizeArtifactPath(value));
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPathStrings(item, out, depth + 1);
    return;
  }

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (typeof nested === 'string' && /(path|file|output|artifact)/i.test(key)) {
        out.add(normalizeArtifactPath(nested));
      }
      collectPathStrings(nested, out, depth + 1);
    }
  }
}

function collectExistingArtifacts(executionLog: ToolExecutionRecord[]): ReadyArtifact[] {
  const byPath = new Map<string, ReadyArtifact>();
  for (const record of executionLog) {
    if (record.error || !record.result) continue;
    if (!ARTIFACT_PRODUCER_TOOL_RE.test(record.name) && !/work_product_verify/i.test(record.name)) continue;

    const paths = new Set<string>();
    try {
      collectPathStrings(JSON.parse(record.result), paths);
    } catch {
      collectPathStrings(record.result, paths);
    }

    for (const candidate of paths) {
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile() || stat.size <= 0) continue;
        if (!byPath.has(candidate)) {
          byPath.set(candidate, {
            path: candidate,
            kind: artifactKind(candidate),
            size: stat.size,
            sourceTool: record.name,
          });
        }
      } catch {}
    }
  }
  return Array.from(byPath.values());
}

function isOnDesktop(filePath: string): boolean {
  const normalized = path.normalize(filePath).toLowerCase();
  return /\\desktop\\/.test(normalized) || /\\桌面\\/.test(normalized);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function artifactLabel(artifact: ReadyArtifact): string {
  if (artifact.kind === 'cad') return 'CAD图纸';
  if (artifact.kind === 'ppt') return 'PPT装修方案';
  if (artifact.kind === 'preview') return '预览图';
  if (artifact.kind === 'document') return '文档';
  if (artifact.kind === 'image') return '图片';
  return '文件';
}

function buildReadyWorkProductSummary(messages: NormalizedMessage[], executionLog: ToolExecutionRecord[]): string | null {
  const task = getPrimaryUserText(messages);
  const wantsCad = /\b(cad|dxf|dwg)\b|(?:CAD|DXF|DWG|图纸|平面图|户型图|建筑平面)/i.test(task);
  const wantsPpt = /\b(pptx?|powerpoint)\b|(?:PPT|PowerPoint)/i.test(task);
  const wantsDesktop = /\bdesktop\b|桌面/i.test(task);
  const wantsArtifact = wantsCad || wantsPpt || /\b(file|save|export|output)\b|(?:文件|保存|导出|输出|生成|创建)/i.test(task);
  if (!wantsArtifact) return null;

  const artifacts = collectExistingArtifacts(executionLog);
  const hasCad = artifacts.some(artifact => artifact.kind === 'cad');
  const hasPpt = artifacts.some(artifact => artifact.kind === 'ppt');
  if (wantsCad && !hasCad) return null;
  if (wantsPpt && !hasPpt) return null;
  if (!wantsCad && !wantsPpt && artifacts.length === 0) return null;

  const requiredArtifacts = artifacts.filter(artifact =>
    (wantsCad && artifact.kind === 'cad') ||
    (wantsPpt && artifact.kind === 'ppt') ||
    (!wantsCad && !wantsPpt)
  );
  if (wantsDesktop && requiredArtifacts.some(artifact => !isOnDesktop(artifact.path))) return null;

  const displayArtifacts = artifacts
    .filter(artifact =>
      artifact.kind === 'cad' ||
      artifact.kind === 'ppt' ||
      artifact.kind === 'preview' ||
      (!wantsCad && !wantsPpt)
    )
    .slice(0, 8);
  const failedCount = executionLog.filter(record => record.error).length;
  const isZh = /[\u3400-\u9fff]/.test(task);

  if (!isZh) {
    return [
      'Generated and verified these files exist:',
      ...displayArtifacts.map(artifact => `- ${artifactLabel(artifact)}: ${artifact.path} (${formatBytes(artifact.size)})`),
      failedCount ? `${failedCount} failed tool call(s) were ignored because they were not completion evidence.` : '',
      'Stopping the tool loop now because the requested work product is present.',
    ].filter(Boolean).join('\n');
  }

  return [
    '已生成并确认这些文件存在：',
    ...displayArtifacts.map(artifact => `- ${artifactLabel(artifact)}：${artifact.path}（${formatBytes(artifact.size)}）`),
    failedCount ? `另有 ${failedCount} 个工具调用失败，未作为完成依据。` : '',
    '我已在产物满足后停止继续调用工具，避免重复执行。',
  ].filter(Boolean).join('\n');
}

function filterToolDeclarationsForPolicy(
  declarations: ReturnType<ToolRegistry['getToolDeclarations']>,
  context?: ToolContext,
): ReturnType<ToolRegistry['getToolDeclarations']> {
  const policy = context?.toolPolicy;
  if (!policy) return declarations;
  if (policy.forbiddenTools?.includes('*')) return [];

  const allowed = new Set(policy.allowedTools || []);
  const forbidden = new Set(policy.forbiddenTools || []);
  return declarations.filter((declaration) => {
    const name = declaration.function.name;
    if (forbidden.has(name)) return false;
    if (allowed.has('*')) return true;
    return allowed.has(name);
  });
}

export async function runWithTools(
  messages: NormalizedMessage[],
  toolRegistry: ToolRegistry,
  config: LLMConfig,
  onToolCall?: (record: ToolExecutionRecord) => void,
  maxIterations: number = 5,
  getDeepSeek?: () => any,
  getGemini?: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  onStreamChunk?: StreamCallback,
  context?: ToolContext,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<LLMResult> {
  const executionLog: ToolExecutionRecord[] = [];
  const usageRecords: LLMUsageRecord[] = [];
  const conversationHistory: NormalizedMessage[] = [...messages];

  // Auto-detect hybrid mode: if provider is 'auto' and Ollama is available, use local→cloud dispatch
  const effectiveProvider = config.provider === 'auto' && getOllama?.()
    ? 'auto'  // Keep as 'auto' for the dispatch logic below
    : config.provider;

  const effectiveMaxIterations = Math.max(0, Math.min(maxIterations, context?.toolPolicy?.maxIterations ?? maxIterations));
  for (let iteration = 0; iteration < effectiveMaxIterations; iteration++) {
    // Check for cancellation between iterations
    if (context?.isCancelled?.()) {
      return {
        text: 'Task was cancelled by the user.',
        toolCalls: executionLog,
        usageRecords,
      };
    }
    const toolDeclarations = filterToolDeclarationsForPolicy(toolRegistry.getToolDeclarations(), context);

    const llmStart = Date.now();
    const modelMessages = compactMessagesForModel(conversationHistory);
    const response = onStreamChunk
      ? await makeLLMCallStreaming(
          modelMessages,
          toolDeclarations,
          config,
          onStreamChunk,
          getDeepSeek || (() => null),
          getGemini || (() => null),
          getOpenAI || (() => null),
          getAnthropic || (() => null),
          getQwen || (() => null),
          getOllama || (() => null),
          getLmStudio || (() => null),
          getArk || (() => null),
          getXiaomi || (() => null),
          getKimi || (() => null),
          getGlm || (() => null),
          getRelay || (() => null),
        )
      : await makeLLMCall(
          modelMessages,
          toolDeclarations,
          config,
          getDeepSeek || (() => null),
          getGemini || (() => null),
          getOpenAI || (() => null),
          getAnthropic || (() => null),
          getQwen || (() => null),
          getOllama || (() => null),
          getLmStudio || (() => null),
          getArk || (() => null),
          getXiaomi || (() => null),
          getKimi || (() => null),
          getGlm || (() => null),
          getRelay || (() => null),
        );
    recordLatency('llm', Date.now() - llmStart);

    // Collect usage from this LLM call
    if (response.usage) {
      usageRecords.push({
        provider: config.provider,
        model: config.model,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
      });
    }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      recordWorkflowIfToolsUsed(executionLog, messages, config.userId);
      const guarded = guardCompletionClaims({
        task: getPrimaryUserText(messages),
        response: response.text || 'No response.',
        toolCalls: executionLog,
        source: context?.source,
      });
      return {
        text: guarded.text,
        toolCalls: executionLog,
        usageRecords,
      };
    }

    const normalizedToolCalls = response.toolCalls.map((tc, index) => ({
      ...tc,
      id: tc.id || `call_${iteration}_${index}_${Date.now().toString(36)}`,
    }));

    // Check for duplicate tool calls (prevents infinite loops within maxIterations)
    const lastAssistantMsg = conversationHistory
      .filter(m => m.role === 'assistant')
      .slice(-1)[0];
    if (lastAssistantMsg?.toolCalls) {
      const sameTools = lastAssistantMsg.toolCalls.every((tc, i) =>
        normalizedToolCalls[i] &&
        tc.name === normalizedToolCalls[i].name &&
        JSON.stringify(tc.arguments) === JSON.stringify(normalizedToolCalls[i].arguments)
      );
      if (sameTools && lastAssistantMsg.toolCalls.length === normalizedToolCalls.length) {
        recordWorkflowIfToolsUsed(executionLog, messages, config.userId);
        const fallbackText = response.text || 'The same tools were called repeatedly. Breaking the loop to prevent infinite execution.';
        const guarded = guardCompletionClaims({
          task: getPrimaryUserText(messages),
          response: fallbackText,
          toolCalls: executionLog,
          source: context?.source,
        });
        return {
          text: guarded.text,
          toolCalls: executionLog,
          usageRecords,
        };
      }
    }

    conversationHistory.push({
      role: 'assistant',
      content: response.text,
      toolCalls: normalizedToolCalls,
      reasoningContent: response.reasoningContent,
    });

    for (const tc of normalizedToolCalls) {
      let result: string;
      let error: string | undefined;

      try {
        context?.onToolStart?.({ id: tc.id, name: tc.name, arguments: tc.arguments });
      } catch {}

      try {
        result = await toolRegistry.execute(tc.name, tc.arguments, context);
      } catch (e: any) {
        result = '';
        error = e.message;
      }

      const record: ToolExecutionRecord = {
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        result,
        error,
      };
      executionLog.push(record);
      onToolCall?.(record);

      conversationHistory.push({
        role: 'tool',
        content: error ? `Error: ${error}` : compactToolResultForModel(tc.name, result),
        toolCallId: tc.id,
        name: tc.name,
      });
    }

    const readyWorkProduct = buildReadyWorkProductSummary(messages, executionLog);
    if (readyWorkProduct) {
      recordWorkflowIfToolsUsed(executionLog, messages, config.userId);
      return {
        text: readyWorkProduct,
        toolCalls: executionLog,
        usageRecords,
      };
    }
  }

  recordWorkflowIfToolsUsed(executionLog, messages, config.userId);
  const readyWorkProduct = buildReadyWorkProductSummary(messages, executionLog);
  if (readyWorkProduct) {
    return {
      text: readyWorkProduct,
      toolCalls: executionLog,
      usageRecords,
    };
  }
  return {
    text: buildIterationLimitSummary(executionLog),
    toolCalls: executionLog,
    usageRecords,
  };
}

/** Record workflow from tool execution trace, if any tools were actually called */
function recordWorkflowIfToolsUsed(
  executionLog: ToolExecutionRecord[],
  messages: NormalizedMessage[],
  userId?: string,
): void {
  if (executionLog.length === 0) return;
  const rawContent = messages.find(m => m.role === 'user')?.content || '';
  const userMsg = typeof rawContent === 'string' ? rawContent : Array.isArray(rawContent) ? rawContent.filter(c => c.type === 'text').map(c => (c as any).text).join(' ') : '';
  const safeMsg = userMsg || '';
  recordWorkflow({
    userId: userId || 'anonymous',
    userIntent: safeMsg.slice(0, 200),
    toolSequence: executionLog.map(e => ({
      name: e.name,
      args: e.arguments,
      resultSummary: (e.result || e.error || '').slice(0, 200),
    })),
    conversationExcerpt: safeMsg.slice(0, 500),
  });
}

// ── Vision Integration ──

/** Parse screenshot relay result — handles JSON wrapper { image_base64, format, width, height } or raw base64 */
export function parseScreenshotBase64(relayResult: string): { base64: string; mime: string } {
  try {
    const parsed = JSON.parse(relayResult);
    if (parsed.image_base64) {
      return {
        base64: parsed.image_base64,
        mime: parsed.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      };
    }
  } catch {}
  // Fallback: raw base64 string (legacy)
  return { base64: relayResult, mime: 'image/png' };
}

/** Analyze a screenshot with a vision-capable model. */
export async function analyzeScreen(
  imageBase64: string,
  query: string,
  config: { provider: string; model: string; userId?: string; maxTokens?: number },
  getDeepSeek?: () => any,
  getGemini?: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<string> {
  const { base64, mime } = parseScreenshotBase64(imageBase64);

  // Determine which vision model to use
  let provider = config.provider;
  let model = config.model;

  // Qwen and Ark have specific vision models — auto-switch when using chat models
  if (provider === 'qwen' && !model.includes('vl')) {
    // qwen-plus/qwen-max/qwen-turbo → qwen-vl-max for vision
    model = 'qwen-vl-max';
  } else if (provider === 'ark' && !model.includes('vision')) {
    // doubao-1-5-pro/lite → doubao-1-5-vision-pro for vision
    model = 'doubao-1-5-vision-pro-32k';
  } else if (provider === 'deepseek') {
    throw new Error('DeepSeek does not support vision. Choose a separate vision model in Settings → LLM Providers → Vision Model.');
  }

  const messages: NormalizedMessage[] = [
    {
      role: 'system',
      content: 'You are a screen reader AI. Analyze the screenshot and answer the user\'s question about what is visible on screen. Describe UI elements, text content, error messages, and anything relevant to the query. Be thorough but concise.',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: query },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } },
      ],
    },
  ];

  const result = await makeLLMCall(
    messages, [],
    { provider: provider as any, model, maxTokens: config.maxTokens || 1000, userId: config.userId },
    getDeepSeek || (() => null), getGemini || (() => null),
    getOpenAI, getAnthropic, getQwen, getOllama, getLmStudio, getArk,
    getXiaomi, getKimi, getGlm, getRelay,
  );
  if (config.userId) {
    recordTokenUsage(config.userId, provider, model, result.usage, `vision_screen_${Date.now()}`, 'vision');
  }

  return result.text || 'Vision analysis returned no text.';
}

/** Run a multimodal conversation with vision-capable models. */
export async function runWithVision(
  messages: NormalizedMessage[],
  config: LLMConfig,
  getDeepSeek?: () => any,
  getGemini?: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<string> {
  const result = await makeLLMCall(messages, [], config, getDeepSeek || (() => null), getGemini || (() => null), getOpenAI, getAnthropic, getQwen, getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay);
  return result.text || '';
}
