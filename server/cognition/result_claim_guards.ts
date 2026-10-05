import type { ToolExecutionRecord } from '../tools/types';
import { parseReceiptObject, toolRecordTerminalPayload } from '../tools/receipt_payload';
import { normalizeActionIntent } from './normalized_action_intent';
import { toolRecordSucceeded } from './task_execution_ledger';
import { buildMediaArtifactReceipt } from '../socket/media_artifact_receipt';
import { documentReadMatchesRequestedTarget, isSuccessfulExactDocumentRead, extractDesktopLaunchTarget, extractPrimaryTaskText, extractSimpleDesktopOpenTarget, hasMediaPlaybackEvidence, hasMediaPauseEvidence, hasRequestedDesktopOpenEvidence, requiresMediaPlaybackAction } from './action_contract';
import { isMediaPauseRequest } from './media_intent';
import { CN_EXECUTION_EVIDENCE_MESSAGES } from '../regions/packs/cn/execution_evidence_messages';
import { hasRequestedArtifactMutation, isCurrentClientDiagnosticRequest, isDiagnosticOrRepairRequest } from './tool_intent';
import { formatVerifiedTaskResultForReadability } from './reply_style';
import { containsCompactToolEvidenceMarker } from '../conversation/summary_grounding';
import { CN_RESULT_GROUNDING_MESSAGES } from '../regions/packs/cn/voice_fast_path_messages';
import { formatCnUnsupportedToolExecutionClaim } from '../regions/packs/cn/messaging_messages';
import { hasImmediateExecutionPromise } from './execution_claims';
import { CN_UNVERIFIED_CLIENT_STATE_CLAIM } from '../regions/packs/cn/capability_meta_messages';
import { type LumiResultFinalizerInput, type LumiResultFinalizerResult } from "./result_finalizer_types";
import { resultTaskText, isVerifiedCurrentTurnRecord, taskActionContract, hasResultCoreActionEvidence, isChineseText, isInternalRuntimeWorkNarration, recordMatchesCurrentTurnIdentity, parseActionReceipt } from "./result_finalizer_support";
import { isVerifiedPrimaryDesktopOpen } from "./result_desktop_presenter";

type RealWorldClaimKind =
  | 'communication'
  | 'reminder'
  | 'playback'
  | 'open'
  | 'file_mutation'
  | 'media_artifact'
  | 'runtime_configuration';

export function realWorldClaimKind(value: string): RealWorldClaimKind | '' {
  const text = String(value || '').trim();
  if (!text) return '';
  // Do not turn denials, hypotheticals, quotations, or explanations of the
  // policy into positive execution claims.
  const positive = text
    .replace(/[“”][^“”\r\n]{0,240}[“”]/gu, ' ')
    .replace(/[‘’][^‘’\r\n]{0,240}[‘’]/gu, ' ')
    .replace(/"[^"\r\n]{0,240}"/gu, ' ')
    .split(/[\n。！!]+/u)
    .map(clause => clause.trim())
    // i18n-allow: Chinese negated/hypothetical execution-claim recognition; not user-visible copy.
    .filter(clause => clause
      && !/[？?]/u.test(clause)
      && !/^(?:没有|没|未|并未|不能|无法|如果|假如|例如|比如|假设)|(?:没有|并未|未曾|不能|不应|不可).{0,16}(?:完成|发送|创建|打开|播放|执行)|\b(?:did\s+not|didn't|cannot|can't|if|for\s+example)\b/iu.test(clause) // i18n-allow: reviewed execution-claim input recognition.
      && !/(?:你|他|她|它|用户|模型|系统|文档|消息).{0,10}(?:说|声称|表示|写着|显示|回复|提到).{0,24}(?:已|已经|成功)|\b(?:you|they|the\s+(?:model|system|message|document))\s+(?:said|claimed|reported|shows?)\b/iu.test(clause)) // i18n-allow: reviewed reported-speech input recognition.
    .join('\n');
  if (!positive) return '';
  // i18n-allow: Concrete generated-media and delivered-image claim recognition.
  if (/(?:已经|已|成功).{0,18}(?:生成|制作|创建).{0,36}(?:图片|图像|视频)|(?:请查看|展示给|这是|以下).{0,30}(?:图片|图像|视频)|\b(?:generated|created).{0,36}(?:image|picture|video)\b/iu.test(positive)
    && /!\[[^\]]*\]\(|https?:\/\/|(?:已经|已|成功).{0,18}(?:生成|制作|创建)/iu.test(positive)) return 'media_artifact'; // i18n-allow: Concrete artifact-delivery recognition.
  // i18n-allow: Chinese real-world execution-claim recognition; not user-visible copy.
  if (/(?:已|已经|成功).{0,14}(?:发送|发出|上传|提交|发布|送达)|(?:发送|上传|提交|发布)成功|\b(?:sent|uploaded|submitted|published|delivered)\b/iu.test(positive)) return 'communication';
  // i18n-allow: Chinese reminder-creation claim recognition; not user-visible copy.
  if (/(?:已|已经|成功).{0,16}(?:创建|设置|新建).{0,12}(?:提醒|定时|日程|计划|任务)|(?:提醒|定时任务|日程).{0,16}(?:已创建|已设置)|\b(?:reminder|schedule|calendar).{0,24}(?:created|set)\b/iu.test(positive)) return 'reminder';
  // i18n-allow: Chinese media-state claim recognition; not user-visible copy.
  if (/(?:播放|暂停).{0,12}(?:已|已经|启动|开始|成功|正在)|(?:已|已经|成功).{0,12}(?:播放|暂停)|(?:音量|声音)\s*(?:已经)?\s*(?:调到|设为|设置为)?\s*\d{1,3}\s*%?|\b(?:playing|playback started|volume\s*(?:is|set to)?\s*\d+)\b/iu.test(positive)) return 'playback';
  // i18n-allow: Chinese file-mutation claim recognition; not user-visible copy.
  if (/(?:已|已经|成功).{0,12}(?:复制|保存|写入|删除|移动)|(?:复制|保存|写入|删除|移动)成功|\b(?:copied|saved|written|deleted|moved)\b/iu.test(positive)) return 'file_mutation';
  // i18n-allow: Chinese launch/open claim recognition; not user-visible copy.
  if (
    /(?:已|已经|成功).{0,12}(?:打开|启动)|(?:打开|启动)成功|\b(?:opened|launched)\b/iu.test(positive)
    && !/(?:打开|启动)(?:了)?(?:思路|话题|心扉|眼界|想象|局面|新篇章)|\bopen(?:ed)?\s+(?:my\s+)?(?:mind|thinking|perspective)\b/iu.test(positive) // i18n-allow: reviewed abstract-expression input recognition.
  ) return 'open';
  // i18n-allow: Chinese runtime-provider claim recognition; not user-visible copy.
  if (/(?:Lumi[-\s‑]?Neutral\s*v?2|(?:当前|现在|这次|始终|一直|实际)?[^。！？!?\n]{0,24}(?:音色|声线|TTS|STT|语音|模型|提供商|供应商|云端)[^。！？!?\n]{0,36}(?:使用|采用|调用|接入|来自|切到|切换到|是|为)[^。！？!?\n]{0,36}(?:本地|云端|官方|relay|GPT[- ]?SoVITS|CosyVoice|Lumi[-\s‑]?Neutral|long[a-z0-9_-]+))/iu.test(positive)) return 'runtime_configuration';
  return '';
}

export function isExecutionClaimGuardTurn(input: LumiResultFinalizerInput, contractApplies: boolean): boolean {
  if (contractApplies || (input.toolRecords || []).length > 0) return true;
  if (
    input.flow?.completionEvidenceNeeded === true
    || input.flow?.clientActionOnlyTurn === true
    || input.flow?.selfRepairTurn === true
  ) return true;
  const task = resultTaskText(input).trim();
  // A terse confirmation can carry an already server-bound action even though
  // it has no standalone action contract of its own.
  return /^(?:嗯|对|是|好|好的|可以|确认|继续|执行|重试|yes|ok(?:ay)?|confirm|continue|retry)[，,。.!！\s]*(?:对|是|的)?[，,。.!！\s]*$/iu.test(task); // i18n-allow: reviewed terse action-followup input recognition.
}

export function isFirstPersonConcreteRealWorldClaim(value: string, kind: RealWorldClaimKind): boolean {
  const text = String(value || '').trim();
  // Completed playback, generated output and a named application do not need
  // an explicit 'I'. Chinese routinely omits that subject in task replies.
  if (kind === 'media_artifact') return true;
  if (kind === 'playback' && /(?:视频|第一集|第\d+集|音乐|歌曲|播放器)|\b(?:video|episode|music|song|player)\b/iu.test(text)) return true; // i18n-allow: Media subject recognition.
  if (kind === 'open' && /(?:网页|网站|首页|浏览器|客户端|爱奇艺|优酷|网易云|WPS)|\b(?:browser|website|app|application)\b/iu.test(text)) return true; // i18n-allow: Concrete application subject recognition.
  if (!/(?:^|[\s，,。；;！!])(?:我|我们)(?=[^\s，,。；;！!])|\b(?:I|we|Lumi)\b/iu.test(text)) return false; // i18n-allow: reviewed first-person claim recognition.
  if (kind === 'communication') {
    return /(?:给|向|发到|上传到|提交到|发布到).{1,40}|(?:文件|文档|消息|邮件|帖子|链接).{0,16}(?:发送|上传|提交|发布)|\b(?:sent|uploaded|submitted|published)\b.{0,40}\b(?:file|document|message|email|post|link|to)\b/iu.test(text); // i18n-allow: reviewed communication-target recognition.
  }
  if (kind === 'file_mutation') {
    return /(?:文件|文档|目录|文件夹|表格|合同|报告|[A-Za-z0-9_ -]+\.[A-Za-z0-9]{1,12}|[A-Za-z]:[\\/]).{0,24}(?:复制|保存|写入|删除|移动)|(?:复制|保存|写入|删除|移动).{0,24}(?:文件|文档|目录|文件夹|表格|合同|报告|[A-Za-z0-9_ -]+\.[A-Za-z0-9]{1,12}|[A-Za-z]:[\\/])/iu.test(text); // i18n-allow: reviewed file-target recognition.
  }
  if (kind === 'open') {
    return /(?:打开|启动).{0,24}(?:浏览器|网页|网站|应用|程序|客户端|文件|文档|窗口|设置|[A-Za-z0-9_ -]+\.[A-Za-z0-9]{1,12}|https?:\/\/)|\b(?:opened|launched)\b.{0,40}\b(?:browser|page|site|app|application|client|file|document|window|settings)\b/iu.test(text); // i18n-allow: reviewed open-target recognition.
  }
  if (kind === 'playback') return /(?:音乐|歌曲|播放器|音量|声音|\d{1,3}\s*%|\b(?:music|song|player|volume)\b)/iu.test(text); // i18n-allow: reviewed playback-target recognition.
  if (kind === 'reminder') return /(?:提醒|定时|日程|计划|\b(?:reminder|schedule|calendar)\b)/iu.test(text); // i18n-allow: reviewed reminder-target recognition.
  return /(?:音色|声线|TTS|STT|语音|模型|提供商|供应商|Lumi[-\s‑]?Neutral|GPT[- ]?SoVITS|CosyVoice|relay|long[a-z0-9_-]+)/iu.test(text); // i18n-allow: reviewed runtime-provider recognition.
}

function normalizedClaimSlot(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/^[\s“”‘’"']+|[\s“”‘’"'，。！？!?]+$/gu, '')
    .trim();
}

function messagingReceiptMatchesRequestedTarget(
  record: ToolExecutionRecord,
  taskText: string,
): boolean {
  const payload = parseReceiptObject(toolRecordTerminalPayload(record)) || {};
  if (payload.targetMatched === true || payload.verification?.targetMatched === true) return true;
  const expectedIntent = normalizeActionIntent(taskText);
  const expectedTarget = normalizedClaimSlot(expectedIntent.kind === 'messaging_send'
    ? expectedIntent.target
    : '');
  const candidates = [
    record.arguments?.contact,
    record.arguments?.recipient,
    record.arguments?.target,
    record.arguments?.to,
    payload.contact,
    payload.recipient,
    payload.target,
  ].map(normalizedClaimSlot).filter(Boolean);
  if (String(record.name || '') === 'wechat_send_file') {
    const requestedFile = taskText.match(/([^\\/\s，。！？!?]+\.[A-Za-z0-9]{1,12})/u)?.[1];
    const acknowledgedFile = String(payload.fileName || payload.filename || '').trim();
    if (requestedFile && acknowledgedFile && normalizedClaimSlot(requestedFile) === normalizedClaimSlot(acknowledgedFile)) {
      return true;
    }
    const acknowledgedStem = acknowledgedFile.replace(/\.[^.\\/]+$/u, '');
    if (acknowledgedStem.length >= 2 && normalizedClaimSlot(taskText).includes(normalizedClaimSlot(acknowledgedStem))) {
      return true;
    }
  }
  if (expectedTarget) return candidates.some(candidate => candidate === expectedTarget);
  const normalizedTask = normalizedClaimSlot(taskText);
  return candidates.some(candidate => candidate.length >= 2 && normalizedTask.includes(candidate));
}

export function hasVerifiedEvidenceForRealWorldClaim(
  input: LumiResultFinalizerInput,
  kind: RealWorldClaimKind,
): boolean {
  const taskText = resultTaskText(input);
  const hasExplicitTurnIdentity = Boolean(String(input.taskId || '').trim() || String(input.requestId || '').trim());
  const records = (input.toolRecords || []).filter(record => (
    isVerifiedCurrentTurnRecord(input, record)
    || (!hasExplicitTurnIdentity && toolRecordSucceeded(record))
  ));
  if (records.length === 0) return false;
  const contract = taskActionContract(input);

  if (kind === 'media_artifact') {
    const urls = Array.from(input.responseText.matchAll(/https?:\/\/[^\s<>"')\]]+/gu), match => match[0]);
    return records.some(record => {
      const artifactReceipt = buildMediaArtifactReceipt(record.name, record.arguments, toolRecordTerminalPayload(record), record.error);
      return artifactReceipt && urls.every(url => artifactReceipt.artifacts.some(artifact => artifact.url === url || artifact.path === url));
    });
  }

  if (kind === 'open') {
    const requestedTarget = extractDesktopLaunchTarget(taskText)
      || extractSimpleDesktopOpenTarget(taskText)
      || taskText.match(/https?:\/\/[^\s，。；;！？!?<>"]+/iu)?.[0] || '';
    return Boolean(requestedTarget) && records.some(record => (
      isVerifiedPrimaryDesktopOpen(record, requestedTarget)
      || (
        record.name === 'browser_open_task'
        && parseReceiptObject(toolRecordTerminalPayload(record))?.opened === true
        && hasRequestedDesktopOpenEvidence([record], taskText, requestedTarget)
      )
    ));
  }
  if (kind === 'playback') {
    if (isMediaPauseRequest(taskText)) return hasMediaPauseEvidence(records, taskText, { requestId: input.requestId, taskId: input.taskId });
    return requiresMediaPlaybackAction(taskText)
      && hasMediaPlaybackEvidence(records, taskText, { requestId: input.requestId, taskId: input.taskId });
  }
  if (kind === 'communication') {
    if (!['messaging_send', 'public_post'].includes(contract.kind)) return false;
    if (!hasResultCoreActionEvidence(input, contract, records, taskText)) return false;
    if (contract.kind === 'public_post') return true;
    return records.some(record => (
      /^(?:wechat_send_message|wechat_send_file)$/i.test(String(record.name || ''))
      && messagingReceiptMatchesRequestedTarget(record, taskText)
    ));
  }
  if (kind === 'file_mutation') {
    return ['artifact_work', 'desktop_operation'].includes(contract.kind)
      && hasResultCoreActionEvidence(input, contract, records, taskText);
  }
  if (kind === 'reminder') {
    return records.some(record => {
      if (!/^(?:reminder_create|calendar_event_create|schedule_create|task_create)$/i.test(String(record.name || ''))) {
        return false;
      }
      const payload = parseReceiptObject(toolRecordTerminalPayload(record)) || {};
      const status = String(payload.status || payload.verification?.status || '').toLowerCase();
      return payload.created === true || /^(?:created|scheduled|verified|completed)$/.test(status);
    });
  }

  // Runtime configuration reads and mutations have several specialized
  // grounders earlier in this finalizer. A generic settings/client-state read
  // must never be promoted here into proof of a model or voice switch.
  return false;
}

export function unsupportedRealWorldClaim(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const kind = realWorldClaimKind(input.responseText);
  if (!kind) return null;
  const verified = hasVerifiedEvidenceForRealWorldClaim(input, kind);
  if (verified) return null;
  const zh = isChineseText(resultTaskText(input)) || isChineseText(input.responseText);
  const text = zh
    ? kind === 'communication'
      ? CN_EXECUTION_EVIDENCE_MESSAGES.unsupportedCommunicationClaim
      : kind === 'reminder'
        ? CN_EXECUTION_EVIDENCE_MESSAGES.unsupportedReminderClaim
        : kind === 'playback'
          ? CN_EXECUTION_EVIDENCE_MESSAGES.unsupportedPlaybackClaim
          : kind === 'file_mutation'
            ? CN_EXECUTION_EVIDENCE_MESSAGES.unsupportedFileMutationClaim
            : kind === 'open'
              ? CN_EXECUTION_EVIDENCE_MESSAGES.unsupportedOpenClaim
              : kind === 'runtime_configuration'
                ? CN_EXECUTION_EVIDENCE_MESSAGES.unsupportedRuntimeConfigurationClaim
                : CN_EXECUTION_EVIDENCE_MESSAGES.unsupportedRealWorldClaim
    : 'No verified receipt from this task and turn supports that execution claim.';
  return {
    text,
    blocked: true,
    reason: `${taskActionContract(input).kind}: unsupported current-turn real-world claim: ${kind}.`,
  };
}

export const VERIFIED_DOCUMENT_OBSERVATION_TOOL_RE = /^(?:read_file|read_files_batch|read_pdf|read_docx|read_xlsx|pdf_to_text|extract_document_text|ocr_image_file)$/iu;

export function groundedVerifiedDocumentObservation(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const task = resultTaskText(input);
  // i18n-allow: Chinese read-only document intent recognition; not user-visible copy.
  if (!/(?:读取|阅读|查看|看看|分析|审查|审阅|总结|概括|附件|文件|文档|PDF|\b(?:read|review|inspect|analy[sz]e|summari[sz]e|attachment|document|file)\b)/iu.test(task)) {
    return null;
  }
  // i18n-allow: Chinese document-mutation intent recognition; not user-visible copy.
  if (hasRequestedArtifactMutation(task)) {
    return null;
  }
  const record = [...(input.toolRecords || [])].reverse().find(candidate => (
    VERIFIED_DOCUMENT_OBSERVATION_TOOL_RE.test(String(candidate.name || ''))
    && isVerifiedCurrentTurnRecord(input, candidate)
    && isSuccessfulExactDocumentRead(candidate)
    && documentReadMatchesRequestedTarget(candidate, task, input.flow?.acceptedTaskTarget, input.flow?.currentAttachmentPaths)
  ));
  if (!record) return null;
  // A successful read cannot erase a downstream delivery/claim failure.
  // In particular, preserve a blocked shared-loop verdict instead of saving
  // its "not complete" text under a completed assistant receipt.
  if (input.completionGuard?.blocked) return { ...input.completionGuard };
  const response = String(input.responseText || '').trim();
  if (unsupportedRealWorldClaim(input)) return null;
  const unusableNarration = !response
    || isInternalRuntimeWorkNarration(response)
    // i18n-allow: Chinese stale/internal blocked-result recognition; not user-visible copy.
    || /(?:^|\n)\s*(?:状态\s*[：:]\s*(?:受阻|失败)|这(?:次|项操作)还没完成|没有取得可用的分析结果)|(?:尚未|还没|没有|未能|无法).{0,16}(?:完成|算出|计算|给出结果)|\b(?:blocked|execution_recovery_incomplete|not (?:yet )?complete|no (?:usable )?result)\b/iu.test(response);
  // A verified read is terminal for a plain read/view request. It is only an
  // intermediate step when the user asked Lumi to interpret or synthesize the
  // document and no usable analysis prose was produced.
  // i18n-allow: Chinese document-analysis intent recognition; not user-visible copy.
  const instruction = [extractPrimaryTaskText(task), input.flow?.rootTaskText || ''].join('\n');
  const calculationRequested = /(?:计算|重算|算出|金额|总额|合计|\b(?:calculat\w*|recalculat\w*|total|multiply)\b)/iu.test(instruction); // i18n-allow: document calculation intent.
  const analysisRequested = calculationRequested || /(?:分析|审查|审阅|总结|概括|提炼|解读|\b(?:review|analy[sz]e|summari[sz]e|interpret|synthesize)\b)/iu.test(instruction);
  const calculationOutput = /(?:金额|总额|合计|总计|结果|[=×]|\b(?:amount|total|result)\b)[^\r\n]{0,100}(?:\d|[零一二三四五六七八九十百千万])|^\s*[-+]?\d+(?:\.\d+)?\s*(?:元|美元|USD|CNY)?[。.!！]?\s*$/iu.test(response); // i18n-allow: returned calculation data, not tool-count or path digits.
  const onlyReadAcknowledgment = /^(?:(?:已|已经|成功|完成|文件|内容|数据|读取|阅读|查看|检查|核验|验证|完毕|任务|操作|read|file|content|verified|completed|successfully|done)|[\s。.!！,，:：;；-])+$/iu.test(response);
  const rawReadOnly = response.replace(/\s+/gu, '') === String(record.result || '').replace(/\s+/gu, '');
  const analysisMissing = analysisRequested && (unusableNarration || onlyReadAcknowledgment || rawReadOnly || (calculationRequested && !calculationOutput));
  return {
    text: unusableNarration || analysisMissing
      ? analysisMissing
        ? (isChineseText(task)
            ? CN_EXECUTION_EVIDENCE_MESSAGES.verifiedDocumentReadWithoutAnalysis
            : 'The file content was read successfully, but no analysis result was generated. Only the read step is verified; the overall analysis is not complete.')
        : (isChineseText(task)
            ? CN_EXECUTION_EVIDENCE_MESSAGES.verifiedDocumentObservation
            : 'The file content was read successfully.')
      : formatVerifiedTaskResultForReadability(response),
    blocked: analysisMissing,
    reason: analysisMissing
      ? 'Verified document read completed, but no usable analysis was generated.'
      : 'Grounded read-only document observation from a verified current-turn receipt.',
  };
}

export function leakedLegacyToolProtocol(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  const raw = String(input.responseText || '').trim();
  if (containsCompactToolEvidenceMarker(raw)) {
    return {
      text: isChineseText(resultTaskText(input)) || isChineseText(raw)
        ? CN_RESULT_GROUNDING_MESSAGES.actionNotStarted
        : 'No verified execution result supports this response.',
      blocked: true,
      reason: 'Model output contained a reserved server receipt marker.',
    };
  }
  const hasXmlProtocol = /<(?:function_calls|tool_calls|invoke)\b/i.test(raw);
  const hasFencedToolProtocol = /```\s*(?:tool|tools|tool_call|tool_calls|function_call|function_calls)\b/i.test(raw);
  // i18n-allow: Chinese internal tool-protocol recognition; not user-visible copy.
  const hasBracketProtocol = /\[(?:[^\]\r\n]{1,48})\]\s*[A-Za-z][A-Za-z0-9_.:-]{1,127}\s*\([^\r\n)]*\)|\[(?:调用|call(?:ing)?|tool)\s+[A-Za-z][A-Za-z0-9_.:-]{1,127}\s*\](?:\s*\{)?/iu.test(raw);
  if (!hasXmlProtocol && !hasFencedToolProtocol && !hasBracketProtocol) return null;
  const names = Array.from(raw.matchAll(/<invoke\s+name=["']([^"']+)["']/gi), match => match[1]);
  const clientStateRequested = names.includes('client_get_state');
  const chinese = isChineseText(resultTaskText(input));
  const text = chinese
    ? clientStateRequested
      ? CN_RESULT_GROUNDING_MESSAGES.clientStateProtocolBlocked
      : CN_RESULT_GROUNDING_MESSAGES.toolProtocolBlocked
    : clientStateRequested
      ? 'I could not read the current client state, so I will not expose an internal tool request as the answer.'
      : 'The tool request was not executed; its internal protocol text was blocked.';
  return {
    text,
    blocked: true,
    reason: 'Legacy tool-call protocol leaked into assistant text.',
    notification: {
      type: 'work_product_guard',
      level: 'warning',
      message: 'Legacy tool-call protocol leaked into assistant text.',
    },
  };
}

function claimedExecutedToolNames(text: string): { asserted: boolean; toolNames: string[] } {
  const raw = String(text || '');
  const clauses: string[] = [];
  const patterns = [
    /(?:\u8fd0\u884c|\u8c03\u7528|\u6267\u884c|\u4f7f\u7528)\u4e86[^\u3002\uff01\uff1f\n\r)]{0,180}/gu,
    /\b(?:I|we|Lumi)\s+(?:have\s+)?(?:ran|called|executed|used)\b[^.!?\n\r)]{0,180}/gi,
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      const prefix = raw.slice(Math.max(0, (match.index || 0) - 28), match.index || 0);
      if (/(?:\u6ca1\u6709|\u5e76\u672a|\u672a\u66fe|\u4e0d\u80fd|\u4e0d\u5e94|\u4e0d\u8981|\u5e76\u975e|did\s+not|didn't|cannot|can't|must\s+not|never)\s*$/i.test(prefix)) continue;
      clauses.push(match[0]);
    }
  }
  const toolNames = Array.from(new Set(clauses.flatMap(clause =>
    Array.from(clause.matchAll(/`([A-Za-z][A-Za-z0-9_.:-]{1,127})`/g), match => match[1])
  )));
  return { asserted: clauses.length > 0, toolNames };
}

export function unsupportedToolExecutionClaim(input: LumiResultFinalizerInput): string | null {
  const claim = claimedExecutedToolNames(input.responseText);
  if (!claim.asserted) return null;
  const actualNames = new Set((input.toolRecords || []).map(record => String(record.name || '')));
  const missing = claim.toolNames.length > 0
    ? claim.toolNames.filter(name => !actualNames.has(name))
    : (actualNames.size === 0 ? ['tool execution evidence'] : []);
  if (missing.length === 0) return null;
  if (isChineseText(resultTaskText(input)) || isChineseText(input.responseText)) {
    return formatCnUnsupportedToolExecutionClaim(missing[0] === 'tool execution evidence' ? [] : missing);
  }
  return [
    missing[0] === 'tool execution evidence'
      ? 'No actual tool execution was recorded for this turn.'
      : `No actual tool call was recorded for: ${missing.join(', ')}.`,
    'I cannot present an unrecorded action as executed; the real tools must run before I report their results.',
  ].join('\n');
}

export function unsupportedToolModeClaim(input: LumiResultFinalizerInput): string | null {
  const response = String(input.responseText || '');
  // i18n-allow: Chinese unsupported-mode claim recognition; not user-visible copy.
  const claimsInventedMode = /(?:已(?:经)?|现在|已经成功).{0,18}(?:切换|切到|进入|开启).{0,32}(?:Fetcher|System\s*Diagnostics|工具可用(?:模式|状态)|诊断工具模式)/iu.test(response);
  if (!claimsInventedMode) return null;
  const hasModeReceipt = (input.toolRecords || []).some(record => (
    !record.error
    && (
      /^(?:set_client_mode|operation_mode)$/i.test(String(record.name || ''))
      || (
        /^client_action$/i.test(String(record.name || ''))
        && /^set_client_mode$/i.test(String(record.arguments?.action || ''))
      )
    )
    && String(record.result || '').trim()
  ));
  if (hasModeReceipt) return null;
  return isChineseText(resultTaskText(input)) || isChineseText(response)
    ? CN_EXECUTION_EVIDENCE_MESSAGES.inventedToolMode
    : 'No such mode switch occurred. Fetcher/System Diagnostics is not a user-selectable runtime mode; the tools actually declared for this turn are authoritative.';
}

function hasVerifiedOngoingExecutionReceipt(input: LumiResultFinalizerInput): boolean {
  const records = input.toolRecords || [];
  const task = resultTaskText(input);
  // i18n-allow: Reviewed multilingual runtime-status query recognition; not user-visible copy.
  const explicitRuntimeStatusQuery = /(?:任务|工作|后台|运行).{0,24}(?:状态|进度|还在|是否|怎么样)|(?:状态|进度).{0,24}(?:任务|工作|后台|运行)|\b(?:status|progress|still\s+running|active\s+(?:task|work|run))\b/iu.test(task);
  return records.some(record => {
    if (
      !toolRecordSucceeded(record)
      || record.terminalVerification?.status === 'failed'
    ) return false;
    if (!recordMatchesCurrentTurnIdentity(input, record)) return false;
    const payload = parseReceiptObject(toolRecordTerminalPayload(record));
    if (!payload) return false;
    const status = String(
      payload.status
      || payload.task?.status
      || payload.run?.status
      || '',
    ).trim().toLowerCase();
    const name = String(record.name || '');
    if (name === 'runtime_work_status') {
      return explicitRuntimeStatusQuery
        && status === 'active'
        && Number(payload.activeCount || 0) > 0;
    }
    if (!/(?:work_takeover|autonomy|scheduler|background|runtime_work|task_(?:create|start|run|resume))/i.test(name)) {
      return false;
    }
    const durableIdentity = String(
      payload.taskId
      || payload.runId
      || payload.jobId
      || payload.task?.id
      || record.taskId
      || '',
    ).trim();
    return Boolean(durableIdentity)
      && /^(?:active|running|executing|in_progress)$/.test(status);
  });
}

export function unsupportedOngoingExecutionClaim(
  input: LumiResultFinalizerInput,
  includeActionPlans = true,
): string | null {
  const response = String(input.responseText || '').trim();
  if (!response) return null;
  const task = resultTaskText(input);
  const actionRequested = taskActionContract(input).applies
    || isDiagnosticOrRepairRequest(task)
    || input.flow?.completionEvidenceNeeded === true
    || (input.toolRecords || []).length > 0;
  // i18n-allow: Chinese execution-plan recognition; not user-visible copy.
  const claimsPendingAction = /(?:^|[\n\u3002\uff01\uff1f.!?])\s*(?:(?:\u597d|\u597d\u7684|\u53ef\u4ee5|\u884c)[\uff0c,\s]*)?(?:(?:\u6211|\u8ba9\u6211|\u8fd9\u8fb9)?\s*(?:\u5148|\u73b0\u5728|\u9a6c\u4e0a|\u7acb\u5373|\u63a5\u4e0b\u6765|\u7ee7\u7eed)\s*(?:\u770b\u770b|\u67e5\u770b|\u68c0\u67e5|\u8bfb\u53d6|\u6253\u5f00|\u6267\u884c|\u5904\u7406|\u91cd\u542f|\u4fee\u590d|\u6062\u590d|\u8c03\u7528|\u5f00\u59cb)|(?:\u6211|\u8fd9\u8fb9)\s*\u6b63\u5728\s*(?:\u770b|\u67e5|\u8bfb|\u6253\u5f00|\u6267\u884c|\u5904\u7406|\u91cd\u542f|\u4fee\u590d|\u6062\u590d))|\b(?:let\s+me|i(?:'ll|\s+will|\s+am\s+going\s+to)|first\s+i(?:'ll|\s+will))\b[^.!?\n]{0,100}\b(?:check|inspect|read|open|execute|handle|restart|repair|recover|start)\b/iu.test(response);
  // The terminal candidate may also end in a bare status phrase such as
  // “正在执行——”. At finalization that wording is truthful only when a durable
  // background execution receipt still reports an active run.
  // i18n-allow: Reviewed multilingual execution-status recognition; not user-visible copy.
  const claimsStandaloneOngoing = /(?:^|[\n。！？.!?])\s*正在\s*(?:执行|操作|处理|调用|修复|重启)[—\-\s。！!]*$/iu.test(response);
  // General first-person execution promises are handled by the shared
  // completion guard below, which already excludes quoted explanations and
  // reflective self-assessment. This narrow check covers the distinct false
  // claim seen in production: inventing that an internal "tool chain" was
  // restored even though this turn has no tool receipt.
  // i18n-allow: Chinese execution-claim recognition; not user-visible copy.
  const claimsInventedToolChain = /工具(?:链|链路)[^。！？!?\n]{0,20}(?:已经)?(?:恢复|可用)|\btool(?:ing)?\s+(?:chain|pipeline)[^.!?\n]{0,30}\b(?:restored|available|working)\b/iu.test(response);
  const claimsExecutionActivity = claimsPendingAction || claimsStandaloneOngoing;
  // An unknown/short user utterance must not make a concrete immediate action
  // promise exempt from checking simply because routing classified it as chat.
  // i18n-allow: Immediate externally observable action promise, not quoted advice.
  const concreteImmediatePromise = hasImmediateExecutionPromise(response);
  if (concreteImmediatePromise && !(input.toolRecords || []).length) {
    return isChineseText(response) ? CN_RESULT_GROUNDING_MESSAGES.actionNotStarted : 'No action started in this turn.';
  }
  if (concreteImmediatePromise && includeActionPlans && !hasVerifiedOngoingExecutionReceipt(input)) {
    return isChineseText(response) ? CN_RESULT_GROUNDING_MESSAGES.executionEndedWithoutCompletion
      : 'This attempt ended without verified completion; no background execution is running.';
  }
  if (!claimsInventedToolChain && !(includeActionPlans && actionRequested && claimsExecutionActivity)) return null;
  if (claimsExecutionActivity && hasVerifiedOngoingExecutionReceipt(input)) return null;
  const attemptedButEnded = (input.toolRecords || []).length > 0;
  return isChineseText(resultTaskText(input)) || isChineseText(response)
    ? claimsInventedToolChain
      ? CN_RESULT_GROUNDING_MESSAGES.unverifiedExecutionActivity
      : attemptedButEnded
        ? CN_RESULT_GROUNDING_MESSAGES.executionEndedWithoutCompletion
        : CN_RESULT_GROUNDING_MESSAGES.actionNotStarted
    : claimsInventedToolChain
      ? 'No new execution started in this turn; the draft response mixed in an older task.'
      : attemptedButEnded
        ? 'This foreground attempt has ended without verified goal completion; it is not still executing.'
        : 'No tool execution started in this turn. The response described a plan, not an action or result.';
}

export function unsupportedToolAvailabilityExcuse(input: LumiResultFinalizerInput): string | null {
  const response = String(input.responseText || '');
  // A correct explanation may explicitly deny the fictional state (for
  // example, "the routed subset does not mean tools are unmounted"). Remove
  // those denial clauses before looking for an unsupported availability claim.
  const availabilityClaimText = response.replace(
    /(?:\u4e0d\u4ee3\u8868|\u5e76\u4e0d\u4ee3\u8868|\u4e0d\u7b49\u4e8e|\u4e0d\u80fd\u8bf4\u660e|\u4e0d\u662f\u8bf4|does\s+not\s+mean|doesn'?t\s+mean)[^\u3002\uff01\uff1f.!?\n]{0,100}[\u3002\uff01\uff1f.!?]?/giu,
    '',
  );
  // Keep the state word close to the tool noun. A broad wildcard here makes
  // truthful plans such as “用桌面打开工具启动计算器，不打开替代软件” look as
  // if they claimed the tool itself was not open.
  // i18n-allow: Unsupported user-switchable tool-state excuse recognition; not user-visible copy.
  const claimsToolsAreOff = /(?:当前|现在|这轮|我这边|当前会话|这个会话)?[^。！？!?\n]{0,32}(?:工具|tool)(?:\s*(?:本身|列表|集合|状态|权限|能力|链路|路由|is|are)){0,2}[\s:：]*(?:没(?:有)?打开|未打开|没开启|未开启|不可用|没有开放|没(?:有)?挂载|未挂载|没带|只有|只(?:挂载|有)|not (?:open|enabled|available|mounted|loaded)|disabled)|(?:当前|现在|这轮|我这边|当前会话|这个会话)?[^。！？!?\n]{0,28}(?:只有|只(?:挂载|有)|没(?:有)?挂载|未挂载|没带)[^。！？!?\n]{0,20}(?:工具|tool)|(?:需要|要不要|可以)(?:我)?[^。！？!?\n]{0,28}(?:切换|切到|进入|开启)[^。！？!?\n]{0,24}(?:工具可用|工具模式|tool mode|tools? enabled)/iu.test(availabilityClaimText);
  if (!claimsToolsAreOff) return null;
  const actualUnavailableReceipt = (input.toolRecords || []).some(record => (
    String(record.error || '').trim()
    // i18n-allow: Chinese tool-error recognition pattern; not user-visible copy.
    && /(?:tool[^\n]{0,40}(?:unavailable|not found|not declared|disabled)|工具[^\n]{0,32}(?:不可用|未声明|不存在|已禁用))/iu.test(String(record.error || ''))
  ));
  if (actualUnavailableReceipt) return null;
  return isChineseText(resultTaskText(input)) || isChineseText(response)
    ? CN_EXECUTION_EVIDENCE_MESSAGES.inventedToolAvailability
    : 'No receipt shows that tools were disabled, and there is no user-switchable “tool available mode.” Lumi must resume the real tool route instead of shifting an internal routing failure to the user.';
}

export function unsupportedPriorDiagnosticClaim(input: LumiResultFinalizerInput): string | null {
  const task = resultTaskText(input);
  const response = String(input.responseText || '');
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const deniesDiagnostic = /(?:没有|没|并未|不是|不在|未曾|无法确认|不能确认)[^。！？!?\n]{0,32}(?:自检|健康检查|扫描|检查)|\b(?:did\s+not|didn't|wasn'?t|cannot\s+confirm)\b[^.!?\n]{0,80}\b(?:self[- ]?check|scan|diagnostic)/iu.test(response);
  if (deniesDiagnostic) return null;
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const claimsDiagnostic = /(?:刚才|刚刚|之前|上一轮|上一次)?[^。！？!?\n]{0,20}(?:在|已经|刚刚|跑了|执行了|进行了|做了)[^。！？!?\n]{0,48}(?:自检|健康检查|扫描\s*MCP|扫描.*技能|检查.*运行时)|\b(?:I|Lumi|we)\s+(?:was|were|have\s+been|had\s+been)?\s*(?:running|performing|doing)[^.!?\n]{0,80}\b(?:self[- ]?check|diagnostic|MCP\s+scan)/iu.test(response);
  if (!claimsDiagnostic) return null;

  // Only apply the prior-run guard when the task or answer actually points
  // backward in time. A current request such as "please run a self-check"
  // must still be allowed to summarize receipts produced in this turn.
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const priorTaskContext = /(?:刚才|刚刚|之前|上一轮|上一次|上轮)|(?:为什么|怎么|为何)[^。！？!?\n]{0,48}(?:这么久|那么久|半天|延迟|才[^。！？!?\n]{0,12}(?:回|答|回复|回应))|\b(?:earlier|previously|last\s+(?:turn|time)|prior\s+turn|why[^.!?]{0,60}(?:delay|took?\s+so\s+long))\b/iu.test(task);
  const currentDiagnosticRequest = !priorTaskContext
    && isCurrentClientDiagnosticRequest(task);
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const priorResponseContext = /(?:刚才|刚刚|之前|上一轮|上一次|上轮)|\b(?:earlier|previously|last\s+(?:turn|time)|was|were|had\s+been)\b/iu.test(response);
  if (!priorTaskContext && (!priorResponseContext || currentDiagnosticRequest)) return null;

  // Current-turn tool records cannot prove a claim about "just now" or a
  // previous turn: ToolExecutionRecord has no prior-turn identity/timestamp.
  // Explicit current self-check requests are grounded earlier by
  // formatClientDiagnosticResult; any remaining prior-run narrative is blocked.
  return isChineseText(resultTaskText(input)) || isChineseText(response)
    ? CN_RESULT_GROUNDING_MESSAGES.priorDiagnosticUnsupported
    : 'There is no verifiable client-diagnostic receipt for the prior turn. I cannot explain the delay as a self-check when no such check was recorded.';
}

export function unsupportedClientStateVerificationClaim(input: LumiResultFinalizerInput): string | null {
  const response = String(input.responseText || '').trim();
  if (!response) return null;
  // A conceptual answer may describe a compile-time product definition, but it
  // must not pretend that live client/runtime state was read or verified.
  const deniesVerification = /(?:\u6ca1\u6709|\u5e76\u672a|\u672a\u66fe|\u4e0d\u80fd|\u65e0\u6cd5|did\s+not|didn't|cannot|can't|was\s+not|wasn't)[^\u3002\uff01\uff1f.!?\n]{0,24}(?:\u9a8c\u8bc1|\u6838\u5b9e|\u786e\u8ba4|\u8bfb\u53d6|\u67e5\u8be2|verify|confirm|read|inspect|query)/iu.test(response);
  if (deniesVerification) return null;
  const verificationClaim = /(?:(?:\u5df2\u9a8c\u8bc1|\u5df2\u6838\u5b9e|\u7ecf\u6838\u5b9e|\u5df2\u786e\u8ba4|\u5df2\u8bfb\u53d6|\u5df2\u67e5\u8be2|\u67e5\u5230|verified|confirmed|read|queried|inspected)[^\u3002\uff01\uff1f.!?\n]{0,100}(?:client\.modes|\u5ba2\u6237\u7aef\u72b6\u6001|\u8fd0\u884c\u65f6\u72b6\u6001|\u5f53\u524d\u914d\u7f6e|client\s+state|runtime\s+state|current\s+configuration)|(?:client\.modes|\u5ba2\u6237\u7aef\u72b6\u6001|\u8fd0\u884c\u65f6\u72b6\u6001|\u5f53\u524d\u914d\u7f6e|client\s+state|runtime\s+state|current\s+configuration)[^\u3002\uff01\uff1f.!?\n]{0,100}(?:\u5df2\u9a8c\u8bc1|\u5df2\u6838\u5b9e|\u7ecf\u6838\u5b9e|\u5df2\u786e\u8ba4|\u5df2\u8bfb\u53d6|\u5df2\u67e5\u8be2|verified|confirmed|read|queried|inspected))/iu.test(response);
  if (!verificationClaim) return null;

  const hasRelevantReceipt = (input.toolRecords || []).some(record => (
    toolRecordSucceeded(record)
    && /^(?:client_get_state|client_health_check|client_capability_manifest|model_configuration_get)$/i.test(String(record.name || ''))
  ));
  if (hasRelevantReceipt) return null;

  return isChineseText(resultTaskText(input)) || isChineseText(response)
    ? CN_UNVERIFIED_CLIENT_STATE_CLAIM
    : 'No verifiable client-runtime receipt was recorded for this turn, so the current state cannot be described as verified. Product definitions may be stated directly; live state requires a real query receipt.';
}

function isWorkTaskLedgerTool(name: unknown): boolean {
  return /^(?:work_takeover_task_(?:create|get|list|update)|conversation_action_(?:task|receipt).*)$/iu
    .test(String(name || ''));
}

function hasVerifiedNonLedgerActionReceipt(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    if (record.error || isWorkTaskLedgerTool(record.name)) return false;
    if (record.terminalVerification?.status === 'verified') return true;
    if (
      record.envelope?.status === 'verified_success'
      && record.envelope.verification?.status === 'verified'
    ) return true;
    const receipt = parseActionReceipt(record.receipt);
    const receiptVerification = receipt?.terminalVerification?.status
      || receipt?.verification?.status;
    return receiptVerification === 'verified'
      || receipt?.status === 'verified_success'
      || receipt?.status === 'verified'
      || (receipt?.ok === true && receipt?.verified === true);
  });
}

function claimsPersistentTaskStepCompletion(responseText: string): boolean {
  const response = String(responseText || '').trim();
  if (!response) return false;
  const explicitlyIncomplete = /(?:\u5c1a\u672a|\u672a|\u6ca1\u6709|\u4e0d\u80fd|\u4e0d\u5e94|\u4e0d\u53ef)[^\u3002\uff01\uff1f.!?\n]{0,20}(?:\u5b8c\u6210|\u6807\u8bb0[^\u3002\uff01\uff1f.!?\n]{0,6}\u5b8c\u6210)|\b(?:not|isn'?t|wasn'?t|cannot|can't)\b[^.!?\n]{0,32}\b(?:complete|completed|done)\b/iu
    .test(response);
  if (explicitlyIncomplete) return false;
  return /(?:\u5df2\u7ecf|\u5df2)[^\u3002\uff01\uff1f.!?\n]{0,18}(?:\u5b8c\u6210|\u505a\u5b8c|\u63a8\u8fdb)|(?:\u5b8c\u6210|\u505a\u5b8c)\u4e86?\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+\u6b65|\b(?:completed|finished|done)\b/iu
    .test(response);
}

export function unsupportedLedgerOnlyWorkTaskCompletion(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const taskText = resultTaskText(input);
  if (!/\bwt_task_[A-Za-z0-9_-]+\b/u.test(taskText)) return null;
  if (!/(?:\u7ee7\u7eed|\u7eed\u63a5|\u6062\u590d|\u63a8\u8fdb|\u6267\u884c|\u5904\u7406|\u5b8c\u6210|\u505a\u5b8c)/u.test(taskText)) return null;
  if (!claimsPersistentTaskStepCompletion(input.responseText)) return null;
  const records = input.toolRecords || [];
  if (!records.some(record => isWorkTaskLedgerTool(record.name))) return null;
  if (hasVerifiedNonLedgerActionReceipt(records)) return null;

  const reason = 'Persistent task completion was claimed from ledger updates without a verified action receipt.';
  return {
    text: isChineseText(taskText) || isChineseText(input.responseText)
      ? CN_EXECUTION_EVIDENCE_MESSAGES.ledgerOnlyTaskCompletion
      : 'The task ledger proves only a bookkeeping update, not execution. No verified terminal receipt from a real action exists for this turn, so the step cannot be marked complete.',
    blocked: true,
    reason,
    notification: {
      type: 'work_product_guard',
      level: 'warning',
      message: reason,
    },
  };
}
