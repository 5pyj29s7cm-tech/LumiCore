import type { OperationMode } from './operation_modes';
import { formatCnCapabilityMetaResponse } from '../regions/packs/cn/capability_meta_messages';
import { normalizeActionIntent } from './normalized_action_intent';

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

const INDEPENDENT_IMMEDIATE_ACTION_RE =
  /(?:^|[\uff0c,\u3002\uff1b;\uff01\uff1f!?]\s*)(?:(?:\u8bf7|\u73b0\u5728|\u9a6c\u4e0a|\u7acb\u5373|\u76f4\u63a5|\u7136\u540e|\u63a5\u7740|\u540c\u65f6|\u5e76\u4e14|\u5e2e\u6211|\u7ed9\u6211)\s*)+(?:\u6253\u5f00|\u542f\u52a8|\u8fd0\u884c|\u6267\u884c|\u67e5\u8be2|\u641c\u7d22|\u8bfb\u53d6|\u521b\u5efa|\u5199\u5165|\u53d1\u9001|\u63d0\u4ea4|\u53d1\u5e03|\u5207\u6362|\u6f14\u793a|\u5c55\u793a|\u64cd\u4f5c|\u5904\u7406|\u7ee7\u7eed|\u91cd\u8bd5)|(?:\u4ecb\u7ecd|\u81ea\u6211\u4ecb\u7ecd).{0,28}(?:\u5e76|\u540c\u65f6|\u7136\u540e|\u8fb9.{0,8}\u8fb9).{0,12}(?:\u6f14\u793a|\u5c55\u793a|\u6253\u5f00|\u64cd\u4f5c)|(?:^|[,.!?;]\s*)(?:(?:please|now|immediately|then|also)\s+)+(?:open|launch|run|execute|search|read|create|write|send|submit|publish|switch|show|demonstrate|operate|continue|resume|retry)\b/iu;

const PURE_CAPABILITY_EXPLANATION_FORM_RE =
  /(?:\u5982\u4f55|\u600e\u4e48|\u600e\u6837).{0,36}(?:\u4f7f\u7528|\u8c03\u7528|\u5f00\u542f).{0,24}(?:\u5de5\u5177|\u6280\u80fd)|\bhow\b.{0,48}\b(?:use|using|call|access|enable)\b.{0,32}\b(?:tools?|skills?|capabilit(?:y|ies))\b/iu;

function hasConcreteExecutionIntent(text: string): boolean {
  const normalized = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!normalized) return false;
  if (INDEPENDENT_IMMEDIATE_ACTION_RE.test(normalized)) return true;
  if (PURE_CAPABILITY_EXPLANATION_FORM_RE.test(normalized)) return false;
  const intent = normalizeActionIntent(normalized);
  return ![
    'none',
    'status_query',
    'correction_explanation',
    'client_state',
  ].includes(intent.kind) && intent.operation !== 'status';
}

export function isSelfIntroductionMetaQuestion(text: string): boolean {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return SELF_INTRODUCTION_META_RE.test(normalized)
    && !hasConcreteExecutionIntent(normalized);
}

/**
 * Capability access questions describe Lumi's execution model. They are not
 * requests to run a tool, change modes, inspect client state, or create work.
 */
export function isCapabilityMetaQuestion(text: string): boolean {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (hasConcreteExecutionIntent(normalized)) return false;
  if (isSelfIntroductionMetaQuestion(normalized)) return true;
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

export function buildCapabilityMetaResponse(input: CapabilityMetaResponseInput): string | null {
  if (isSelfIntroductionMetaQuestion(input.text)) {
    if (!isChinese(input.text)) {
      return [
        'Hello, I am Lumi, a privately deployed local intelligent agent that works with you through conversation, memory, models, skills, tools, desktop applications, and other authorized agents.',
        'Within your authorization, I can understand and continue tasks, organize files and knowledge, create work products, call the relevant registered skills and tools, and operate identity-verified desktop applications. Whether a particular provider or application is available is checked at execution time; this answer does not claim that any specific service is connected now.',
        'I cannot promise that a model never makes mistakes, that a third-party service is always online, that every knowledge file has been fully absorbed, or that a changing desktop interface will always be recognized. External sending, publishing, submission, payment, and signing require final confirmation, and I do not report completion without a real receipt or visible verification.',
        'To assign work, state the goal, the exact object or material, the expected result, prohibited actions, and the acceptance standard. If information is missing, say what may remain pending instead of letting me guess.',
        'If I do not know how to proceed or execution fails, I first identify the actual blocker, inspect available evidence, retry only when safe and idempotent, and switch to another authorized method when appropriate. If permission, credentials, business judgment, or an irreversible action is required, I stop and ask you instead of pretending the work succeeded.',
      ].join('\n\n');
    }
    return [
      '\u4f60\u597d\uff0c\u6211\u662f Lumi\uff0c\u662f\u79c1\u6709\u5316\u90e8\u7f72\u5728\u672c\u5730\u8bbe\u5907\u4e0a\u7684\u667a\u80fd\u4f53\u3002\u6211\u4e0d\u53ea\u8d1f\u8d23\u804a\u5929\uff0c\u4e5f\u4f1a\u5728\u4f60\u7684\u6388\u6743\u8303\u56f4\u5185\uff0c\u901a\u8fc7\u8bb0\u5fc6\u3001\u6a21\u578b\u3001\u6280\u80fd\u3001\u5de5\u5177\u3001\u684c\u9762\u7a0b\u5e8f\u548c\u5176\u4ed6\u667a\u80fd\u4f53\u5e2e\u4f60\u5904\u7406\u5de5\u4f5c\u3002',
      '\u6211\u80fd\u7406\u89e3\u5e76\u7ee7\u7eed\u4efb\u52a1\uff0c\u6574\u7406\u6587\u4ef6\u548c\u77e5\u8bc6\uff0c\u751f\u6210\u5de5\u4f5c\u6210\u679c\uff0c\u9009\u62e9\u5f53\u524d\u4efb\u52a1\u771f\u6b63\u9700\u8981\u7684\u6280\u80fd\u4e0e\u5de5\u5177\uff0c\u5e76\u64cd\u4f5c\u901a\u8fc7\u8eab\u4efd\u5339\u914d\u7684\u684c\u9762\u5e94\u7528\u3002\u67d0\u4e2a\u670d\u52a1\u6216\u8f6f\u4ef6\u5f53\u4e0b\u662f\u5426\u53ef\u7528\uff0c\u8981\u5728\u6267\u884c\u65f6\u4ee5\u5b9e\u9645\u63a2\u6d4b\u548c\u56de\u6267\u4e3a\u51c6\uff1b\u8fd9\u6b21\u7eaf\u4ecb\u7ecd\u4e0d\u4f1a\u865a\u6784\u4efb\u4f55\u5df2\u8fde\u63a5\u670d\u52a1\u3002',
      '\u6211\u4e0d\u80fd\u4fdd\u8bc1\u6a21\u578b\u6c38\u4e0d\u72af\u9519\u3001\u7b2c\u4e09\u65b9\u670d\u52a1\u6c38\u8fdc\u5728\u7ebf\u3001\u6240\u6709\u77e5\u8bc6\u6587\u4ef6\u90fd\u5df2\u5b8c\u5168\u5438\u6536\uff0c\u6216\u8005\u4e0d\u65ad\u53d8\u5316\u7684\u684c\u9762\u754c\u9762\u603b\u80fd\u4e00\u6b21\u8bc6\u522b\u6b63\u786e\u3002\u53d1\u9001\u3001\u53d1\u5e03\u3001\u63d0\u4ea4\u3001\u4ed8\u6b3e\u548c\u7b7e\u7f72\u7b49\u5bf9\u5916\u52a8\u4f5c\u9700\u8981\u6700\u7ec8\u786e\u8ba4\uff1b\u6ca1\u6709\u771f\u5b9e\u56de\u6267\u6216\u53ef\u89c1\u9a8c\u8bc1\uff0c\u6211\u4e0d\u4f1a\u8bf4\u5df2\u5b8c\u6210\u3002',
      '\u7ed9\u6211\u4ea4\u4ee3\u4efb\u52a1\u65f6\uff0c\u6700\u597d\u8bf4\u6e05\u4e94\u4ef6\u4e8b\uff1a\u76ee\u6807\u3001\u51c6\u786e\u7684\u5bf9\u8c61\u6216\u6750\u6599\u3001\u671f\u671b\u7ed3\u679c\u3001\u7981\u6b62\u52a8\u4f5c\u3001\u9a8c\u6536\u6807\u51c6\u3002\u4fe1\u606f\u4e0d\u9f50\u65f6\uff0c\u4e5f\u53ef\u4ee5\u76f4\u63a5\u544a\u8bc9\u6211\u54ea\u4e9b\u5185\u5bb9\u5141\u8bb8\u4fdd\u7559\u201c\u5f85\u786e\u8ba4\u201d\uff0c\u907f\u514d\u6211\u81ea\u884c\u731c\u6d4b\u3002',
      '\u9047\u5230\u4e0d\u4f1a\u6216\u6267\u884c\u5931\u8d25\u7684\u4e8b\uff0c\u6211\u4f1a\u5148\u67e5\u6e05\u771f\u5b9e\u963b\u585e\u548c\u73b0\u6709\u8bc1\u636e\uff0c\u53ea\u5728\u5b89\u5168\u3001\u5e42\u7b49\u65f6\u91cd\u8bd5\uff0c\u6709\u5408\u9002\u7684\u6388\u6743\u65b9\u6848\u65f6\u518d\u6362\u8def\u5f84\u3002\u5982\u679c\u5361\u5728\u6743\u9650\u3001\u5bc6\u94a5\u3001\u4e1a\u52a1\u5224\u65ad\u6216\u4e0d\u53ef\u9006\u52a8\u4f5c\uff0c\u6211\u4f1a\u505c\u4e0b\u8bf4\u660e\u5e76\u8bf7\u4f60\u51b3\u5b9a\uff0c\u800c\u4e0d\u662f\u5047\u88c5\u6210\u529f\u3002',
    ].join('\n\n');
  }
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
