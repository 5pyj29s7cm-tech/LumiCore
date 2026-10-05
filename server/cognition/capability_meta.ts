import type { ActionIntentAnalysis } from './normalized_action_intent';
import { isRetiredOperationModeRequest, type OperationMode } from './operation_modes';
import {
  formatCnCurrentOperationModeResponse,
  formatCnOperationModeInventoryResponse,
} from '../regions/packs/cn/capability_meta_messages';
import { normalizeActionIntent } from './normalized_action_intent';
import {
  LUMI_MEETING_CAPTURE_SURFACE,
} from '../../shared/operation_modes';

export interface CapabilityMetaResponseInput {
  text: string;
  operationMode?: OperationMode | string;
  source?: string;
}

const CAPABILITY_SUBJECT_RE =
  /(?:\u5de5\u5177|\u6280\u80fd|\u80fd\u529b|\u6743\u9650|\u52a9\u624b\u6a21\u5f0f|\u52a9\u7406\u6a21\u5f0f|\u81ea\u4e3b\u6a21\u5f0f|\u4f1a\u8bdd|\u6302\u8f7d|\u8def\u7531|\b(?:tools?|skills?|capabilit(?:y|ies)|permissions?|assistant\s+mode|autonomous\s+mode|session|routing)\b)/iu;

const CAPABILITY_META_QUESTION_RE =
  /(?:\u600e\u4e48|\u5982\u4f55|\u600e\u6837|\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u662f\u4e0d\u662f|\u662f\u5426|\u80fd\u4e0d\u80fd|\u53ef\u4e0d\u53ef\u4ee5|\u8981\u600e\u4e48|\u600e\u6837\u624d\u80fd|\u53ea\u6709|\u53ea\u6302\u8f7d|\u6ca1\u6302\u8f7d|\u672a\u6302\u8f7d|\u6ca1\u5e26|\u6ca1\u5f00\u542f|\u4e0d\u53ef\u7528|\u600e\u4e48\u7528|\u600e\u4e48\u8c03\u7528|\b(?:how|why|can|could|is|are|do|does|only|enable|access|available|mounted|loaded|permission)\b)/iu;

const CAPABILITY_ACCESS_RE =
  /(?:\u4f7f\u7528|\u8c03\u7528|\u5f00\u542f|\u542f\u7528|\u5207\u6362|\u6302\u8f7d|\u8bbf\u95ee|\u9009\u4e2d|\u66b4\u9732|\u53ea\u6709|\u6ca1\u6709|\u6ca1\u5e26|\u4e0d\u53ef\u7528|\b(?:use|uses|using|call|enable|access|select|expose|mount|load|available)\b)/iu;

const SELF_INTRODUCTION_META_RE =
  /(?:\u81ea\u6211\u4ecb\u7ecd|\u4ecb\u7ecd(?:\u4e00\u4e0b)?\u4f60\u81ea\u5df1|\u4ecb\u7ecd\u4f60\u662f\u8c01|\u4f60\u662f\u8c01.{0,40}\u80fd\u505a\u4ec0\u4e48|\u50cf\u7b2c\u4e00\u6b21\u9762\u5bf9\u65b0\u7528\u6237|introduce\s+yourself|who\s+are\s+you.{0,80}what\s+can\s+you\s+do)/iu;

const OPERATION_MODE_INVENTORY_RE =
  /(?:(?:\u4f60|lumi|\u5ba2\u6237\u7aef|\u4e3b\u7a0b\u5e8f|\u7cfb\u7edf).{0,10})?(?:(?:\u4e00\u5171|\u603b\u5171|\u76ee\u524d).{0,4})?(?:(?:\u6709|\u652f\u6301|\u63d0\u4f9b).{0,4})?(?:\u591a\u5c11|\u51e0|\u54ea\u4e9b|\u54ea\u51e0|\u4ec0\u4e48)(?:\u79cd|\u4e2a)?(?:\u8fd0\u884c|\u64cd\u4f5c|\u6743\u9650|\u5de5\u4f5c)?\u6a21\u5f0f|(?:\u8fd0\u884c|\u64cd\u4f5c|\u6743\u9650|\u5de5\u4f5c)?\u6a21\u5f0f.{0,10}(?:\u6709)?(?:\u591a\u5c11|\u51e0|\u54ea\u4e9b|\u54ea\u51e0|\u5206\u522b|\u5217\u51fa|\u6e05\u5355)|\b(?:how\s+many|what|which|list(?:\s+all)?|available|supported)\b.{0,48}\b(?:operation|runtime|permission|client)?\s*modes?\b|\b(?:operation|runtime|permission|client)\s+modes?\b.{0,40}\b(?:how\s+many|what|which|list|available|supported)\b/iu;

const CURRENT_OPERATION_MODE_RE =
  /(?:(?:\u4f60|lumi|\u5ba2\u6237\u7aef|\u4e3b\u7a0b\u5e8f|\u7cfb\u7edf).{0,8})?(?:\u73b0\u5728|\u5f53\u524d).{0,10}(?:\u662f|\u5904\u4e8e|\u7528\u7684)?[^\u3002\uff01\uff1f.!?\n]{0,6}(?:\u4ec0\u4e48|\u54ea\u4e2a|\u54ea\u79cd)(?:\u8fd0\u884c|\u6743\u9650|\u5de5\u4f5c)?\u6a21\u5f0f|(?:\u4f60|lumi).{0,10}(?:\u662f\u4e0d\u662f|\u662f\u5426|\u662f|\u5904\u4e8e).{0,6}(?:\u7eaf\u804a\u5929|\u804a\u5929|\u52a9\u624b|\u52a9\u7406|\u81ea\u4e3b|\u4f1a\u8bae)(?:\u6a21\u5f0f)?|\b(?:what|which)\s+(?:operation|runtime|permission)?\s*mode\s+(?:are\s+you|is\s+lumi|is\s+the\s+client)\s+(?:in|using)\b|\b(?:are\s+you|is\s+lumi|is\s+the\s+client)\b.{0,32}\b(?:chat|assistant|autonomous|meeting)\s+mode\b/iu;

const OPERATION_MODE_CONFIRMATION_RE =
  /(?:\u4f60|\u6211|lumi|\u5ba2\u6237\u7aef|\u4e3b\u7a0b\u5e8f|\u7cfb\u7edf|\u73b0\u5728|\u5f53\u524d).{0,16}(?:\u662f\u4e0d\u662f|\u662f\u5426|\u4e0d\u662f|\u662f|\u5904\u4e8e|\u7528\u7684).{0,8}(?:\u7eaf\u804a\u5929|\u804a\u5929|\u52a9\u624b|\u52a9\u7406|\u81ea\u4e3b|\u4f1a\u8bae)(?:\u6a21\u5f0f)?|^(?:\u73b0\u5728|\u5f53\u524d)?(?:\u662f\u4e0d\u662f|\u662f\u5426|\u4e0d\u662f|\u662f).{0,6}(?:\u7eaf\u804a\u5929|\u804a\u5929|\u52a9\u624b|\u52a9\u7406|\u81ea\u4e3b|\u4f1a\u8bae)(?:\u6a21\u5f0f)?(?:\u5417|\u4e48|\uff1f|\?)?$|\b(?:are|aren't|is|isn't)\s+(?:you|lumi|the\s+client)\b.{0,32}\b(?:chat|assistant|autonomous|meeting)\s+mode\b/iu;

const OPERATION_MODE_REVERSE_CURRENT_RE =
  /(?:(?:\u4f60|lumi|\u5ba2\u6237\u7aef|\u4e3b\u7a0b\u5e8f|\u7cfb\u7edf).{0,6}(?:\u73b0\u5728|\u5f53\u524d)?|(?:\u73b0\u5728|\u5f53\u524d)|(?:\u8fd0\u884c|\u6743\u9650|\u5de5\u4f5c))\u6a21\u5f0f.{0,8}(?:\u662f)?(?:\u4ec0\u4e48|\u54ea\u4e2a|\u54ea\u79cd)|\b(?:what|which)\s+(?:operation|runtime|permission)?\s*mode\s+(?:are\s+you|is\s+lumi|is\s+the\s+client)\b.{0,20}\b(?:in|using)\b/iu;

const OPERATION_MODE_LIST_RE =
  /(?:\u8bf7)?(?:\u5217\u51fa|\u4ecb\u7ecd|\u8bf4\u8bf4|\u544a\u8bc9\u6211)(?:\u4e00\u4e0b)?(?:\u6240\u6709|\u5168\u90e8|\u53ef\u7528|\u652f\u6301\u7684)(?:\u8fd0\u884c|\u64cd\u4f5c|\u6743\u9650|\u5de5\u4f5c)?\u6a21\u5f0f|\blist\s+(?:all|available|supported)\s+(?:operation|runtime|permission|client)?\s*modes?\b/iu;

// Users often challenge a previous count instead of asking "how many"
// directly (for example, "不是只有三个模式吗" or "七种模式对吗"). Treat
// that as the same factual taxonomy question so a model cannot defend or
// repeat an invented count.
const OPERATION_MODE_COUNT_ASSERTION_RE =
  /(?:(?:\u4e00|\u4e8c|\u4e24|\u4e09|\u56db|\u4e94|\u516d|\u4e03|\u516b|\u4e5d|\u5341|\d+)(?:\u4e2a|\u79cd)?)\s*(?:\u8fd0\u884c|\u64cd\u4f5c|\u6743\u9650|\u5de5\u4f5c)?\u6a21\u5f0f(?:\u662f\u4ec0\u4e48|\u6709\u4ec0\u4e48|\u5206\u522b|\u5bf9\u5417|\u5bf9\u4e0d\u5bf9|\u6b63\u786e\u5417|\u5417|\u5462|\u5427|[?\uff1f])|(?:\u4e0d\u662f|\u662f\u4e0d\u662f|\u96be\u9053|\u53ea\u6709|\u4e00\u5171|\u603b\u5171|\u5230\u5e95|\u7a76\u7adf|\u8bf4\u7684).{0,18}(?:\u4e00|\u4e8c|\u4e24|\u4e09|\u56db|\u4e94|\u516d|\u4e03|\u516b|\u4e5d|\u5341|\d+)(?:\u4e2a|\u79cd)?\s*(?:\u8fd0\u884c|\u64cd\u4f5c|\u6743\u9650|\u5de5\u4f5c)?\u6a21\u5f0f/iu;

const INDEPENDENT_IMMEDIATE_ACTION_RE =
  /(?:^|[\uff0c,\u3002\uff1b;\uff01\uff1f!?]\s*)(?:(?:\u8bf7|\u73b0\u5728|\u9a6c\u4e0a|\u7acb\u5373|\u76f4\u63a5|\u7136\u540e|\u63a5\u7740|\u540c\u65f6|\u5e76\u4e14|\u5e2e\u6211|\u7ed9\u6211)\s*)+(?:\u6253\u5f00|\u542f\u52a8|\u8fd0\u884c|\u6267\u884c|\u67e5\u8be2|\u641c\u7d22|\u8bfb\u53d6|\u521b\u5efa|\u5199\u5165|\u53d1\u9001|\u63d0\u4ea4|\u53d1\u5e03|\u5207\u6362|\u6f14\u793a|\u5c55\u793a|\u64cd\u4f5c|\u5904\u7406|\u7ee7\u7eed|\u91cd\u8bd5)|(?:\u4ecb\u7ecd|\u81ea\u6211\u4ecb\u7ecd).{0,28}(?:\u5e76|\u540c\u65f6|\u7136\u540e|\u8fb9.{0,8}\u8fb9).{0,12}(?:\u6f14\u793a|\u5c55\u793a|\u6253\u5f00|\u64cd\u4f5c)|(?:^|[,.!?;]\s*)(?:(?:please|now|immediately|then|also)\s+)+(?:open|launch|run|execute|search|read|create|write|send|submit|publish|switch|show|demonstrate|operate|continue|resume|retry)\b/iu;

const PURE_CAPABILITY_EXPLANATION_FORM_RE =
  /(?:\u5982\u4f55|\u600e\u4e48|\u600e\u6837).{0,36}(?:\u4f7f\u7528|\u8c03\u7528|\u5f00\u542f).{0,24}(?:\u5de5\u5177|\u6280\u80fd)|\bhow\b.{0,48}\b(?:use|using|call|access|enable)\b.{0,32}\b(?:tools?|skills?|capabilit(?:y|ies))\b/iu;

function hasConcreteExecutionIntent(text: string, analysis?: ActionIntentAnalysis): boolean {
  const normalized = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!normalized) return false;
  if (INDEPENDENT_IMMEDIATE_ACTION_RE.test(normalized)) return true;
  if (PURE_CAPABILITY_EXPLANATION_FORM_RE.test(normalized)) return false;
  const intent = normalizeActionIntent(normalized, analysis);
  return ![
    'none',
    'status_query',
    'correction_explanation',
    'client_state',
  ].includes(intent.kind) && intent.operation !== 'status';
}

export function isSelfIntroductionMetaQuestion(text: string, analysis?: ActionIntentAnalysis): boolean {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return SELF_INTRODUCTION_META_RE.test(normalized)
    && !hasConcreteExecutionIntent(normalized, analysis);
}

export function isOperationModeInventoryQuestion(text: string, analysis?: ActionIntentAnalysis): boolean {
  const normalized = String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (hasConcreteExecutionIntent(normalized, analysis)) return false;
  if (CURRENT_OPERATION_MODE_RE.test(normalized) || OPERATION_MODE_CONFIRMATION_RE.test(normalized)) {
    return false;
  }
  if (OPERATION_MODE_REVERSE_CURRENT_RE.test(normalized)) return false;
  return OPERATION_MODE_INVENTORY_RE.test(normalized)
    || OPERATION_MODE_LIST_RE.test(normalized)
    || OPERATION_MODE_COUNT_ASSERTION_RE.test(normalized);
}

export function isCurrentOperationModeQuestion(text: string, analysis?: ActionIntentAnalysis): boolean {
  const normalized = String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!normalized || hasConcreteExecutionIntent(normalized, analysis)) return false;
  // A meeting, an assistant or ordinary conversation is not itself a question
  // about operating modes. Require the actual subject before using a canned
  // answer; otherwise separate sentences can accidentally satisfy the regex.
  if (!/(?:\u6a21\u5f0f|\bmodes?\b)/iu.test(normalized)) return false;
  return Boolean(
    CURRENT_OPERATION_MODE_RE.test(normalized)
    || OPERATION_MODE_CONFIRMATION_RE.test(normalized)
    || OPERATION_MODE_REVERSE_CURRENT_RE.test(normalized)
  );
}

export function isOperationModeMetaQuestion(text: string, analysis?: ActionIntentAnalysis): boolean {
  return isOperationModeInventoryQuestion(text, analysis) || isCurrentOperationModeQuestion(text, analysis);
}

/**
 * Capability access questions describe Lumi's execution model. They are not
 * requests to run a tool, change modes, inspect client state, or create work.
 */
export function isCapabilityMetaQuestion(text: string, analysis?: ActionIntentAnalysis): boolean {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (isRetiredOperationModeRequest(normalized)) return true;
  if (hasConcreteExecutionIntent(normalized, analysis)) return false;
  if (isSelfIntroductionMetaQuestion(normalized, analysis)) return true;
  if (isOperationModeMetaQuestion(normalized, analysis)) return true;
  if (!normalized || !CAPABILITY_SUBJECT_RE.test(normalized)) return false;
  // A no-tool clause is often an execution boundary attached to a substantive
  // question (for example, "do not call tools; explain how you would verify
  // opening Calculator"). It must not become the subject of the turn and
  // trigger the canned capability/mode answer merely because the sentence also
  // contains words such as "how" or "permissions".
  const explicitNoToolBoundary =
    /(?:\u4e0d\u8981|\u522b|\u65e0\u9700|\u4e0d\u7528|\u4e0d\u5f97|\u7981\u6b62).{0,20}(?:\u8c03\u7528|\u4f7f\u7528|\u5f00\u542f).{0,8}(?:\u5de5\u5177|\u6280\u80fd|\u63d2\u4ef6)|\b(?:do\s+not|don'?t|without)\s+(?:call(?:ing)?|use|using|run(?:ning)?)\s+(?:any\s+)?(?:tools?|skills?|plugins?)\b/iu;
  if (explicitNoToolBoundary.test(normalized)) return false;
  if (/(?:\u521a\u624d|\u521a\u521a|\u4e0a\u6b21|\u4e0a\u4e00\u8f6e|\u6ca1.{0,12}\u6210\u529f|\u5931\u8d25|\u62a5\u9519|\u5361\u4f4f|\u4e3a\u4ec0\u4e48.{0,20}\u6ca1.{0,12}(?:\u6267\u884c|\u8c03\u7528)|\b(?:earlier|last\s+time|failed|error|stuck|didn'?t\s+(?:run|call))\b)/iu.test(normalized)) {
    return false;
  }

  const asksAboutMode =
    /(?:\u4f60\u73b0\u5728|\u5f53\u524d|\u8fd9\u4e0d|\u4e0d\u662f).{0,18}(?:\u52a9\u624b|\u52a9\u7406|\u81ea\u4e3b).{0,8}(?:\u6a21\u5f0f)?(?:\u5417|\u4e48|\uff1f|\?)?/u.test(normalized)
    || /\b(?:are|aren't|isn't)\s+(?:you|lumi).{0,24}(?:assistant|autonomous)\s+mode\b/i.test(normalized);
  if (asksAboutMode) return true;

  return CAPABILITY_META_QUESTION_RE.test(normalized)
    && CAPABILITY_ACCESS_RE.test(normalized);
}

function isChinese(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

export function buildOperationModeMetaResponse(input: CapabilityMetaResponseInput, analysis?: ActionIntentAnalysis): string | null {
  const normalizedText = String(input.text || '').replace(/\s+/g, ' ').trim();
  if (isRetiredOperationModeRequest(normalizedText)) return isChinese(normalizedText)
    ? formatCnOperationModeInventoryResponse()
    : 'Lumi uses one core for conversation, tasks and learning. There are no modes to switch; tell me what you would like to do.';
  if (!normalizedText || hasConcreteExecutionIntent(normalizedText, analysis)) return null;
  const inventoryQuestion = isOperationModeInventoryQuestion(normalizedText, analysis);
  const currentQuestion = isCurrentOperationModeQuestion(normalizedText, analysis);
  if (!inventoryQuestion && !currentQuestion) return null;

  const mode = String(input.operationMode || 'assistant').toLowerCase();
  if (isChinese(normalizedText)) {
    return inventoryQuestion
      ? formatCnOperationModeInventoryResponse()
      : formatCnCurrentOperationModeResponse(mode);
  }

  if (!inventoryQuestion && mode === LUMI_MEETING_CAPTURE_SURFACE.id) {
    return 'Meeting transcription is active. It is a temporary capture surface; Lumi has no selectable conversation or execution modes.';
  }
  return 'Lumi is one personal core for conversation, task execution, memory and learning. There are no Chat, Assistant or Autonomous modes to select. Background work follows your enabled workflows, schedules and permissions; meeting transcription is a separate capture function.';
}
