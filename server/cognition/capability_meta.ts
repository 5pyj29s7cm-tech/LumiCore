import type { OperationMode } from './operation_modes';
import { formatCnCapabilityMetaResponse } from '../regions/packs/cn/capability_meta_messages';

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

/**
 * Capability access questions describe Lumi's execution model. They are not
 * requests to run a tool, change modes, inspect client state, or create work.
 */
export function isCapabilityMetaQuestion(text: string): boolean {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || !CAPABILITY_SUBJECT_RE.test(normalized)) return false;
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

export function buildCapabilityMetaResponse(input: CapabilityMetaResponseInput): string | null {
  if (!isCapabilityMetaQuestion(input.text)) return null;

  const mode = String(input.operationMode || 'assistant').toLowerCase();
  const commandCenter = input.source === 'command-center-chat';
  if (!isChinese(input.text)) {
    const modeLine = mode === 'assistant'
      ? 'You are already in Assistant mode, which has the full foreground tool, skill, browser, app, file, desktop, and team permissions.'
      : mode === 'autonomous'
        ? 'You are in Autonomous mode, which includes Assistant permissions plus continuous background execution.'
        : mode === 'chat'
          ? 'You are in Chat mode; a clear action request automatically promotes that turn to Assistant before execution.'
          : 'Meeting is a voice-capture surface; real action follows the same Assistant/Autonomous execution policy.';
    const entryLine = commandCenter
      ? 'The text panel beside the command-center office is Lumi\'s text entry; there is no second text screen to switch to.'
      : 'Give the complete task directly in the current conversation.';
    return [
      modeLine,
      entryLine,
      'Lumi selects only the relevant tools for each turn to reduce routing noise. That subset is not the installed capability inventory and does not mean other tools are disabled.',
      'If the correct tool is not selected for a clear task, that is a Lumi routing failure—not a setting you need to change.',
    ].join('\n');
  }

  return formatCnCapabilityMetaResponse(mode, commandCenter);
}
