import fs from 'fs';
import path from 'path';
import { ToolExecutionRecord } from '../tools/types';
import {
  buildActionContract,
  claimsCurrentAppSaveCompletion,
  hasCoreActionEvidence,
  hasCurrentAppSaveEvidence,
  hasCurrentAppUiMutationEvidence,
  requiresCurrentAppUiMutation,
} from '../cognition/action_contract';
import { formatCnToolFailureDetail, isInternalExecutionDetail } from '../regions/packs/cn/voice_fast_path_messages';

export interface CompletionGuardResult {
  text: string;
  blocked: boolean;
  reason?: string;
  reasonCode?: 'successful_irrelevant_evidence';
}

function buildActionPromiseGuardedResponse(
  task: string,
  reason: string,
  failed: ToolExecutionRecord[],
): string {
  const isZh = /[\u3400-\u9fff]/.test(task);
  const clientSurfaceTask = isClientSurfaceTask(task);
  const desktopActionTask = isDesktopActionTask(task);
  const lastFailure = summarizeFailedToolCalls(failed, isZh);
  const confirmationBlocked = failed.some(call =>
    /requires user confirmation|requires confirmation|user confirmation|\u7528\u6237\u786e\u8ba4|\u9700\u8981\u786e\u8ba4/i.test(toolFailureDetail(call))
  );

  if (!isZh) {
    if (clientSurfaceTask) {
      return [
        `I have not actually operated the Lumi client yet: ${reason}`,
        lastFailure ? `Latest blocker: ${lastFailure}.` : 'What I can verify: no successful client_get_state/client_action evidence was recorded for this turn.',
        'Next step: inspect client_get_state, then run the matching client_action and trust only its verification result.',
      ].filter(Boolean).join('\n');
    }
    if (desktopActionTask) {
      return [
        `I have not verified the desktop action yet: ${reason}`,
        lastFailure ? `Latest blocker: ${lastFailure}.` : 'What I can verify: no successful desktop action evidence was recorded for this turn.',
        'Next step: continue the real open/focus/check workflow, then report only after the window or process is verified.',
      ].filter(Boolean).join('\n');
    }
    if (confirmationBlocked) {
      return [
        `I did start the workflow, but it is blocked at a confirmation step: ${reason}`,
        lastFailure ? `Latest blocker: ${lastFailure}.` : '',
        'Next step: confirm the requested local action in the client, or ask me to retry after giving explicit approval.',
      ].filter(Boolean).join('\n');
    }
    return [
      `I have not actually started that action yet: ${reason}`,
      lastFailure ? `Latest blocker: ${lastFailure}.` : 'What I can verify: this turn produced only a text reply, with no successful tool evidence.',
      'Next step: provide or select the file/location, then I should run the real read/open/review tool and show progress before giving the result.',
    ].filter(Boolean).join('\n');
  }

  if (clientSurfaceTask) {
    return [
      '我还没有真正操作客户端：这一轮没有记录到成功的 client_get_state / client_action 证据。',
      lastFailure ? `最近的阻塞点：${lastFailure}。` : '现在能确认的是：这次没有完成可验证的客户端状态读取或界面动作。',
      '下一步应该先读取客户端状态；如果是打开中枢世界，就调用 client_action(open_nexus)，并等验证结果后再说完成。',
    ].filter(Boolean).join('\n');
  }

  if (desktopActionTask) {
    return [
      `\u6211\u8fd8\u6ca1\u6709\u62ff\u5230\u53ef\u786e\u8ba4\u7684\u684c\u9762\u52a8\u4f5c\u7ed3\u679c\uff1a${reason}\u3002`,
      lastFailure ? `\u6700\u8fd1\u7684\u963b\u585e\u70b9\uff1a${lastFailure}\u3002` : '\u73b0\u5728\u80fd\u786e\u8ba4\u7684\u662f\uff1a\u8fd9\u4e00\u8f6e\u8fd8\u6ca1\u6709\u6210\u529f\u7684\u684c\u9762\u6253\u5f00\u3001\u805a\u7126\u6216\u8fdb\u7a0b\u9a8c\u8bc1\u8bb0\u5f55\u3002',
      '\u4e0b\u4e00\u6b65\u5e94\u8be5\u7ee7\u7eed\u6267\u884c\u6253\u5f00\u3001\u5b9a\u4f4d\u6216\u786e\u8ba4\u52a8\u4f5c\uff0c\u770b\u5230\u771f\u5b9e\u7a97\u53e3\u6216\u5de5\u5177\u8fd4\u56de\u6210\u529f\u540e\u518d\u6c47\u62a5\u5b8c\u6210\u3002',
    ].filter(Boolean).join('\n');
  }

  if (confirmationBlocked) {
    return [
      '我已经开始处理了，但卡在一个需要确认的本地动作上。',
      lastFailure ? `最近的阻塞点：${lastFailure}。` : '',
      '下一步需要在客户端确认这一步，或者你明确授权后让我重试；我不能把这一步说成已经完成。',
    ].filter(Boolean).join('\n');
  }

  return [
    '我还没有真正开始读取或审查：这一轮没有记录到成功的工具执行。',
    lastFailure ? `最近的阻塞点：${lastFailure}。` : '现在能确认的是：这次只是生成了文字回复，没有实际读到文件内容。',
    '下一步需要先拿到可读取的文件或位置；真正读取时，聊天窗会显示“正在读取文件”等进度，工具小组件也会出现执行记录。',
  ].filter(Boolean).join('\n');
}

interface CompletionGuardInput {
  task: string;
  response: string;
  toolCalls?: ToolExecutionRecord[];
  source?: string;
}

const EXTERNAL_WORK_TASK_RE =
  /\b(cad|dxf|dwg|pptx?|powerpoint|freecad|autocad|file|folder|desktop|browser|search|open|launch|save|export|install|run|execute|play|music|ocr)\b|(?:文件|路径|桌面|图纸|户型|平面图|装修|图片|照片|识别|提取|打开|加载|保存|导出|输出|安装|运行|执行|播放|音乐|生成|创建|方案|PPT|CAD|DXF)/i;

const COMPLETION_CLAIM_RE =
  // i18n-allow: Chinese execution-claim recognition pattern; not user-visible copy.
  /(?:任务|工作|全部|都)?(?:已经|已)?[^。！？\n]{0,18}(?:完成|搞定|做好|做完)|(?:已经|已)[^。！？\n]{0,18}(?:生成|新建|创建|保存|输出|写入|写好|写完|打开|加载|导出)|(?:生成好了|新建好了|创建好了|保存好了|输出好了|写好了|写完了|打开了|加载好了|搞定了)|\b(?:task complete|completed successfully|created|saved|opened|exported|generated)\b/i;

const SELF_COMPLETION_CLAIM_RE =
  // i18n-allow: Chinese self-completion recognition pattern; not user-visible copy.
  /(?:^|[\n。！？!?；;])\s*(?:(?:好|好的|可以|行)[，,\s]*)?(?:(?:(?:我|我们|这边)\s*(?:(?:已经|已)[^。！？!?\n]{0,28}(?:完成|做完|做好|搞定|生成|新建|创建|保存|输出|写入|写好|写完|打开|加载|导出|发送|处理完|执行完)|[^。！？!?\n]{0,28}(?:完成了|做完了|做好了|搞定了|生成好了|新建好了|创建好了|保存好了|输出好了|写好了|写完了|打开了|加载好了|导出了|发送了|处理完了|执行完了)))|(?:(?:任务|工作|操作|处理|这件事)(?:已经|已)?|已经|已)[^。！？!?\n]{0,28}(?:完成|做完|做好|搞定|生成|新建|创建|保存|输出|写入|写好|写完|打开|加载|导出|发送|处理完|执行完)|(?:生成|新建|创建|保存|输出|写|打开|加载|发送|处理|执行|搞定|完成)(?:好|完)?了)[^。！？!?\n]{0,16}(?=$|[，,。！？!?；;：:\n])/iu;

const SELF_COMPLETION_CLAIM_EN_RE =
  /(?:^|[\n.!?;])\s*(?:(?:I|we)(?:'ve| have)?(?:\s+already)?[^.!?\n]{0,36}(?:completed|finished|created|saved|opened|generated|sent|written)\b[^.!?\n]{0,48}|(?:done|completed|finished|created|saved|opened|generated|sent)(?:\s+successfully)?)(?=$|[,.:;!?\n])/iu;

const SELF_EXECUTION_STATUS_RE =
  // i18n-allow: Chinese immediate-execution recognition pattern; not user-visible copy.
  /(?:(?:我|我们|这边)\s*(?:(?:现在(?:就|马上)?|马上|立即)\s*(?:就\s*)?(?:做|动手|开始|执行|处理|操作|写|新建|创建|保存|生成|发送|打开|继续)|正在\s*(?:做|执行|处理|操作|写|新建|创建|保存|生成|发送|打开|继续))|(?:^|[\n。！？!?；;])\s*(?:(?:好|好的|可以|行)[，,\s]*)?(?:现在就做(?:这件事|这个任务)?|马上(?:就)?动手(?:处理)?|正在(?:执行|处理|操作)(?:中|这个任务|该任务)?)(?=$|[，,。！？!?；;：:\n])|\b(?:I(?:'m| am)\s+(?:doing|executing|working on)\s+(?:it|this)(?:\s+now)?|I(?:'ll| will)\s+(?:do|start|execute|handle)\s+(?:it|this)\s+now)\b)/iu;

const REFLECTIVE_SELF_IMPROVEMENT_ACTION_RE =
  // i18n-allow: Chinese reflective-action recognition pattern; not user-visible copy.
  /(?:改进|改善|提升|优化|反思|复盘|审视|检查|评估|梳理|发现|找出|纠正)/u;

const REFLECTIVE_SELF_IMPROVEMENT_TARGET_RE =
  // i18n-allow: Chinese self-improvement target recognition pattern; not user-visible copy.
  /(?:能力|理解|判断|表现|回答|回复|沟通|自然度|效率|不足|短板|改进空间|成长|学习|认知|自我建设)/u;

const REFLECTIVE_SELF_DEVELOPMENT_COMPLETION_RE =
  // i18n-allow: Chinese reflective self-development recognition pattern; not user-visible copy.
  /(?:我|自己|自身|自我|个人)[^。！？!?；;，,\n]{0,36}(?:已经|已|完成|形成|具备|掌握|提升|建立|建设)|(?:能力|理解|判断|表现|成长|学习|认知|自我建设)[^。！？!?；;，,\n]{0,24}(?:已经|已|完成|形成|具备|掌握|提升|建立|建设)/u;

const SELF_CLAIM_EXPLANATION_RE =
  // i18n-allow: Chinese explanatory-use filter; not user-visible copy.
  /^(?:已完成|写好了|写完了|已新建|正在执行|现在就做|马上动手)\s*(?:是|表示|意味着|属于|这个词|这句话|这种说法)/u;

const OPEN_CLAIM_RE =
  /(?:(?:已经|成功|均已|都已|已)[^。！？\n]{0,12}(?:打开|加载))|(?:(?:打开|加载)(?:成功|完成|好了|完毕|了))|\b(?:opened|launched|loaded)(?:\s+successfully)?\b/i;

const FILE_CREATION_CLAIM_RE =
  // i18n-allow: Chinese file-production claim recognition pattern; not user-visible copy.
  /(?:已经|已|都)?[^。！？\n]{0,18}(?:生成|新建|创建|保存|输出|写入|写好|写完|导出)|(?:生成好了|新建好了|创建好了|保存好了|输出好了|写好了|写完了)|\b(?:created|saved|exported|generated)\b/i;

const COMMUNICATION_CLAIM_RE =
  // i18n-allow: user-visible completion-claim recognition; not response copy.
  /(?:已经|已|都)?[^。！？\n]{0,18}(?:发送|提交|发布|送达|回复)|(?:发送成功|提交成功|发布成功|已经回复)|\b(?:sent|submitted|published|delivered|replied)\b/i;

const INSPECTION_ONLY_TOOL_RE =
  /^(read_|list_|search_|grep_|desktop_path_info|desktop_list_files|client_get_state|adapter_health_check|usage_get_summary|calendar_|lumi_constitution|agent_list|get_|path_info)/i;

const FILE_PRODUCER_TOOL_RE =
  /^(write_file|create_ppt|create_docx|create_pdf|cad_generate_dxf|cad_prepare_autocad_operations|mcp_cad-drafting_autocad_playback_file|transcribe_audio_to_text_file|legal_generate_(?!citation_verification_report)|legal_analyze_folder_and_draft_argument|legal_review_contract|legal_draft_contract|legal_finalize_delivery_package|legal_prepare_filing_handoff|legal_external_research_plan|legal_prepare_external_browser_workspace|generate_.*(?:dxf|ppt|file)|export_|save_|document_)/i;

const OPEN_TOOL_RE =
  /^(desktop_open|client_action|computer_use|external_app_.*open|open_)/i;

const ACTION_PROMISE_EVIDENCE_TOOL_RE =
  /^(read_|extract_document_text|read_docx|read_pdf|pdf_to_text|ocr_image_file|transcribe_audio_to_text_file|desktop_open|desktop_capture_screen|desktop_ui_snapshot|capture_screen|computer_use|client_get_state|client_action|work_product_verify|create_|write_|generate_|export_|save_)/i;

const READ_REVIEW_PROMISE_RE =
  /\b(?:read|open|check|review|analy[sz]e|inspect|process)\b|(?:\u8bfb\u53d6|\u8bfb\u4e00\u4e0b|\u8bfb\u4e0b|\u6253\u5f00|\u67e5\u770b|\u770b\u770b|\u5ba1\u67e5|\u5ba1\u9605|\u5206\u6790|\u68c0\u67e5|\u5904\u7406)/iu;

const READ_REVIEW_EVIDENCE_TOOL_RE =
  /^(read_|extract_document_text|read_docx|read_pdf|pdf_to_text|ocr_image_file|transcribe_audio_to_text_file|desktop_open|desktop_capture_screen|desktop_ui_snapshot|capture_screen|computer_use|client_get_state|client_action)/i;

const DESKTOP_ACTION_TASK_RE =
  /\b(?:desktop|screen|app|application|program|software|wechat|weixin|browser|open|launch|start|run)\b|(?:\u684c\u9762|\u5c4f\u5e55|\u5fae\u4fe1|\u5feb\u6377\u65b9\u5f0f|\u5e94\u7528|\u7a0b\u5e8f|\u8f6f\u4ef6|\u6253\u5f00|\u6253\u4e0d\u5f00|\u542f\u52a8|\u8fd0\u884c|\u5f00\u542f)/iu;

const CONTENT_WORK_TASK_RE =
  /\b(?:file|document|docx|pdf|contract|agreement|attachment|read|review|inspect|analy[sz]e|transcribe|audio|note)\b|(?:\u6587\u4ef6|\u6587\u6863|\u8d44\u6599|\u9644\u4ef6|\u5408\u540c|\u534f\u8bae|\u5ba1\u67e5|\u5ba1\u9605|\u5206\u6790|\u8f6c\u5199|\u8bed\u97f3|\u97f3\u9891|\u7b14\u5f55)/iu;

const DESKTOP_ACTION_EVIDENCE_TOOL_RE =
  /^(desktop_|computer_use|external_app_|browser_open_task|mcp_wechat|mcp_.*wechat|client_action)/i;

const VERIFY_PASS_RE = /"status"\s*:\s*"pass"|status:\s*pass/i;

const ACTION_EVIDENCE_TASK_RE =
  /\b(?:file|document|docx|pdf|attachment|desktop|screen|open|read|review|inspect|analy[sz]e|contract|agreement)\b|(?:文件|文档|资料|附件|合同|协议|打开|读取|查看|看看|审查|分析|检查|桌面|屏幕|生成|保存|导出)/iu;

const ACTION_PROMISE_RE =
  // i18n-allow: Chinese action-promise recognition pattern; not user-visible copy.
  /(?:\b(?:i(?:'ll| will| am going to|'m going to)|let me|i need to|i'll first|let me first)\b[^.\n]{0,120}\b(?:read|open|check|review|analy[sz]e|inspect|process|search|generate|create|export)\b)|(?:(?:我|让我|我先|让我先|先|现在|马上|接下来)[^。\n]{0,80}(?:做|动手|开始|执行|读取|读|打开|查看|看看|审查|分析|检查|处理|调用|搜索|查找|生成|新建|创建|写|导出|保存))/iu;

const CLIENT_SURFACE_TASK_RE =
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  /客户端|自己的客户端|中枢世界|中枢|世界视图|云端画布|技能大厅|知识库|运行日志|主屏幕|主页|桌面小组件|小组件|client_get_state|client_action|\b(?:client|nexus|nexus\s+view|cloud\s+canvas|world\s+view|desktop\s+widget|widget\s+mode)\b/iu;

function isClientSurfaceTask(task: string): boolean {
  return CLIENT_SURFACE_TASK_RE.test(task || '');
}

function isDesktopActionTask(task: string): boolean {
  const text = task || '';
  if (requiresCurrentAppUiMutation(text)) return true;
  return DESKTOP_ACTION_TASK_RE.test(text) && !CONTENT_WORK_TASK_RE.test(text);
}

function stripNegatedClaimClauses(value: string): string {
  return String(value || '')
    .replace(
      /[\u201c\u201d\u2018\u2019"'`](?:\u5df2\u5b8c\u6210|\u6b63\u5728\u6267\u884c|\u73b0\u5728\u5c31\u505a|\u9a6c\u4e0a\u52a8\u624b|\u5199\u597d\u4e86|\u5df2\u65b0\u5efa)[\u201c\u201d\u2018\u2019"'`]/gu,
      ' ',
    )
    .replace(
      /(?:\u6ca1\u6709|\u6ca1|\u5e76\u672a|\u5c1a\u672a|\u672a\u66fe|\u4e0d\u4f1a|\u4e0d\u80fd|\u4e0d\u5e94|\u4e0d\u8981|\u7981\u6b62|\u672a)(?=[^\u3002\uFF1B\uFF01\uFF1F\n\r]{0,48}(?:\u5b8c\u6210|\u505a\u5b8c|\u505a\u597d|\u641e\u5b9a|\u6253\u5f00|\u542f\u52a8|\u53d1\u9001|\u751f\u6210|\u65b0\u5efa|\u521b\u5efa|\u4fdd\u5b58|\u5bfc\u51fa|\u5199\u5165|\u5199\u597d|\u5199\u5b8c|\u8bfb\u53d6|\u67e5\u770b|\u8c03\u7528|\u4f7f\u7528|\u6267\u884c|\u5904\u7406))[^\u3002\uFF1B\uFF01\uFF1F\n\r]*/gu,
      ' ',
    )
    .replace(
      /\b(?:did\s+not|didn't|does\s+not|doesn't|have\s+not|haven't|has\s+not|hasn't|will\s+not|won't|cannot|can't|must\s+not|do\s+not|don't|never)\b(?=[^.;!?\n\r]{0,64}\b(?:complete|open|launch|send|create|generate|save|export|read|view|call|use|execute|run)\b)[^.;!?\n\r]*/giu,
      ' ',
    );
}

function hasSelfCompletionClaim(value: string): boolean {
  const text = String(value || '').trim();
  if (!text || SELF_CLAIM_EXPLANATION_RE.test(text)) return false;
  return SELF_COMPLETION_CLAIM_RE.test(text) || SELF_COMPLETION_CLAIM_EN_RE.test(text);
}

/**
 * Immediate-execution wording is also natural in a reflective answer, such as
 * "I am continuing to improve my task understanding".  Only remove a status
 * clause when the user did not ask for external work and that same clause is
 * explicitly about introspection/self-improvement.  Splitting by clause keeps
 * a separate "now I will open the file" claim enforceable in a mixed answer.
 */
function stripReflectiveSelfImprovementStatusClauses(task: string, value: string): string {
  if (needsCompletionEvidence(task) || ACTION_EVIDENCE_TASK_RE.test(task)) return value;

  return String(value || '').replace(
    /(^|[\n。！？!?；;，,])([^\n。！？!?；;，,]+)/gu,
    (segment, boundary: string, clause: string) => {
      const isReflectiveStatus =
        SELF_EXECUTION_STATUS_RE.test(clause)
        && REFLECTIVE_SELF_IMPROVEMENT_ACTION_RE.test(clause)
        && REFLECTIVE_SELF_IMPROVEMENT_TARGET_RE.test(clause);
      return isReflectiveStatus ? boundary : segment;
    },
  );
}

/**
 * A reflective answer can truthfully describe Lumi's own development with
 * completion grammar (for example, "I have completed the basic capability
 * foundation") without claiming that a user-requested external action ran.
 * Remove only self-development clauses that contain no external-work signal;
 * a neighbouring or mixed "I opened the desktop file" clause remains guarded.
 */
function stripReflectiveSelfDevelopmentCompletionClauses(task: string, value: string): string {
  if (needsCompletionEvidence(task) || ACTION_EVIDENCE_TASK_RE.test(task)) return value;

  return String(value || '').replace(
    /(^|[\n。！？!?；;，,])([^\n。！？!?；;，,]+)/gu,
    (segment, boundary: string, clause: string) => {
      const reflectiveCompletion =
        REFLECTIVE_SELF_DEVELOPMENT_COMPLETION_RE.test(clause)
        && REFLECTIVE_SELF_IMPROVEMENT_TARGET_RE.test(clause)
        && !ACTION_EVIDENCE_TASK_RE.test(clause)
        && !EXTERNAL_WORK_TASK_RE.test(clause);
      return reflectiveCompletion ? boundary : segment;
    },
  );
}

interface ParsedJsonToolResult {
  parsed: boolean;
  payload: Record<string, unknown> | null;
}

function parseStructuredToolResult(value: string): ParsedJsonToolResult {
  let parsed: unknown = String(value || '').trim();
  let parsedAtLeastOnce = false;
  for (let attempt = 0; attempt < 3 && typeof parsed === 'string'; attempt += 1) {
    try {
      parsed = JSON.parse(parsed);
      parsedAtLeastOnce = true;
    } catch {
      break;
    }
  }
  return {
    parsed: parsedAtLeastOnce,
    payload: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null,
  };
}

const INCOMPLETE_TOOL_STATUSES = new Set([
  'blocked',
  'cancelled',
  'canceled',
  'confirmation_required',
  'error',
  'failed',
  'in_progress',
  'needs_confirmation',
  'not_ready',
  'partial',
  'pending',
  'queued',
  'requires_confirmation',
  'requires_setup',
  'submitted_unverified',
  'timeout',
  'timed_out',
  'unverified',
]);

function normalizedFailureText(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string'
    ? value.trim()
    : (() => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })().trim();
  if (!text || /^(?:undefined|null)$/i.test(text)) return '';
  return text.length > 320 ? `${text.slice(0, 317)}...` : text;
}

function structuredToolFailureDetail(payload: Record<string, unknown>): string {
  const status = typeof payload.status === 'string'
    ? payload.status.trim().toLowerCase()
    : '';
  const verification = payload.verification && typeof payload.verification === 'object' && !Array.isArray(payload.verification)
    ? payload.verification as Record<string, unknown>
    : null;
  const verificationStatus = typeof verification?.status === 'string'
    ? verification.status.trim().toLowerCase()
    : '';
  const explicitFailure =
    payload.ok === false
    || payload.success === false
    || payload.failed === true
    || payload.completionMarkerExists === false
    || payload.requiresConfirmation === true
    || payload.confirmationRequired === true
    || INCOMPLETE_TOOL_STATUSES.has(status)
    || INCOMPLETE_TOOL_STATUSES.has(verificationStatus)
    || Boolean(normalizedFailureText(payload.error))
    || Boolean(normalizedFailureText(verification?.error));
  if (!explicitFailure) return '';

  const detail = [
    payload.error,
    payload.reason,
    payload.blocker,
    verification?.error,
    verification?.reason,
    verification?.message,
    payload.message,
  ].map(normalizedFailureText).find(Boolean);
  if (detail) return detail;
  if (status && INCOMPLETE_TOOL_STATUSES.has(status)) return `status=${status}`;
  if (verificationStatus && INCOMPLETE_TOOL_STATUSES.has(verificationStatus)) {
    return `verification.status=${verificationStatus}`;
  }
  if (payload.completionMarkerExists === false) return 'completion marker was not found';
  if (payload.requiresConfirmation === true || payload.confirmationRequired === true) {
    return 'user confirmation is required';
  }
  if (payload.success === false) return 'tool reported success=false';
  if (payload.ok === false) return 'tool reported ok=false';
  if (payload.failed === true) return 'tool reported failed=true';
  return 'tool returned an incomplete result without an explicit error';
}

function toolFailureDetail(call: ToolExecutionRecord): string {
  const directError = normalizedFailureText(call.error);
  if (directError) return directError;

  const result = String(call.result || '').trim();
  if (!result) return '';
  const parsed = parseStructuredToolResult(result);
  if (parsed.payload) return structuredToolFailureDetail(parsed.payload);
  if (parsed.parsed) return '';
  if (/requires user confirmation|requires confirmation|user confirmation|\u7528\u6237\u786e\u8ba4|\u9700\u8981\u786e\u8ba4/i.test(result)) {
    return normalizedFailureText(result);
  }
  return '';
}

function summarizeFailedToolCalls(failed: ToolExecutionRecord[], chinese = false): string {
  return failed.slice(-2).map(call => {
    const name = String(call.name || 'tool').trim() || 'tool';
    const detail = toolFailureDetail(call);
    const safeDetail = chinese && detail && isInternalExecutionDetail(detail)
      ? formatCnToolFailureDetail(detail)
      : detail;
    return safeDetail ? `${name}: ${safeDetail}` : name;
  }).join('; ');
}

function isSuccessfulToolCall(call: ToolExecutionRecord): boolean {
  if (call.terminalVerification?.status === 'failed') return false;
  if (call.error || !String(call.result || '').trim()) return false;
  const parsed = parseStructuredToolResult(call.result || '');
  if (parsed.payload) return !structuredToolFailureDetail(parsed.payload);
  if (parsed.parsed) return true;
  return !/requires user confirmation|requires confirmation|user confirmation|\u7528\u6237\u786e\u8ba4|\u9700\u8981\u786e\u8ba4/i.test(String(call.result || ''));
}

function hasMaterialSideEffect(call: ToolExecutionRecord): boolean {
  return Boolean(call.capability?.sideEffects.some(effect => effect.type !== 'none'));
}

function unverifiedCompletionReceipts(
  claimText: string,
  successful: ToolExecutionRecord[],
): ToolExecutionRecord[] {
  const sideEffectCalls = successful.filter(hasMaterialSideEffect);
  if (sideEffectCalls.length === 0) return [];

  const expectedStrategies = new Set<NonNullable<ToolExecutionRecord['terminalVerification']>['strategy']>();
  if (FILE_CREATION_CLAIM_RE.test(claimText)) expectedStrategies.add('artifact');
  if (OPEN_CLAIM_RE.test(claimText)) {
    expectedStrategies.add('state_diff');
    expectedStrategies.add('visual');
  }
  if (COMMUNICATION_CLAIM_RE.test(claimText)) expectedStrategies.add('provider_ack');

  const relevant = expectedStrategies.size > 0
    ? sideEffectCalls.filter(call => (
        call.terminalVerification
        && expectedStrategies.has(call.terminalVerification.strategy)
      ))
    : sideEffectCalls;
  return relevant.filter(call => call.terminalVerification?.status === 'unverified');
}

function buildExecutionStatusGuardedResponse(
  task: string,
  reason: string,
  failed: ToolExecutionRecord[],
): string {
  const isZh = /[\u3400-\u9fff]/.test(task);
  const lastFailure = summarizeFailedToolCalls(failed, isZh);
  if (!isZh) {
    return [
      `I cannot honestly say I am executing this yet: ${reason}`,
      lastFailure ? `Latest blocker: ${lastFailure}.` : 'No successful current-turn tool execution was recorded.',
      'I need to run the real tool first, then report the verified progress.',
    ].filter(Boolean).join('\n');
  }
  return [
    `\u6211\u8fd8\u4e0d\u80fd\u8bf4\u6b63\u5728\u6267\u884c\uff1a${reason}\u3002`, // i18n-allow: reviewed Chinese execution-guard response.
    lastFailure ? `\u6700\u8fd1\u7684\u963b\u585e\u70b9\uff1a${lastFailure}\u3002` : '\u8fd9\u4e00\u8f6e\u6ca1\u6709\u8bb0\u5f55\u5230\u6210\u529f\u7684\u771f\u5b9e\u5de5\u5177\u6267\u884c\u3002', // i18n-allow: reviewed Chinese execution-guard response.
    '\u6211\u9700\u8981\u5148\u771f\u6b63\u8c03\u7528\u5bf9\u5e94\u5de5\u5177\uff0c\u518d\u6309\u5f53\u524d\u8f6e\u56de\u6267\u6c47\u62a5\u8fdb\u5ea6\u3002', // i18n-allow: reviewed Chinese execution-guard response.
  ].filter(Boolean).join('\n');
}

export function needsCompletionEvidence(task: string): boolean {
  return EXTERNAL_WORK_TASK_RE.test(task || '');
}

export function guardCompletionClaims(input: CompletionGuardInput): CompletionGuardResult {
  const task = input.task || '';
  const response = input.response || '';
  if (!response.trim()) return { text: response, blocked: false };
  const claimText = stripNegatedClaimClauses(response);

  const toolCalls = input.toolCalls || [];
  const toolOutcomes = toolCalls.map(call => ({ call, successful: isSuccessfulToolCall(call) }));
  const successful = toolOutcomes.filter(outcome => outcome.successful).map(outcome => outcome.call);
  const failed = toolOutcomes
    .filter(outcome => !outcome.successful && Boolean(outcome.call.error || String(outcome.call.result || '').trim()))
    .map(outcome => outcome.call);
  const completionClaimText = stripReflectiveSelfDevelopmentCompletionClauses(task, claimText);
  const claimsSelfCompletion = hasSelfCompletionClaim(completionClaimText);
  const executionStatusClaimText = stripReflectiveSelfImprovementStatusClauses(task, claimText);
  const claimsExecutionStatus = SELF_EXECUTION_STATUS_RE.test(executionStatusClaimText);
  const needsEvidence =
    needsCompletionEvidence(task) ||
    EXTERNAL_WORK_TASK_RE.test(response) ||
    claimsSelfCompletion ||
    claimsExecutionStatus;
  const desktopActionTask = isDesktopActionTask(task);
  const hasSuccessfulDesktopActionEvidence = successful.some(call =>
    DESKTOP_ACTION_EVIDENCE_TOOL_RE.test(call.name)
  );
  const hasDesktopActionAttempt = toolCalls.some(call =>
    DESKTOP_ACTION_EVIDENCE_TOOL_RE.test(call.name)
    && (Boolean(call.error) || Boolean(String(call.result || '').trim()))
  );
  const promisesReadReviewAction = READ_REVIEW_PROMISE_RE.test(claimText) && !desktopActionTask;
  const hasPromiseEvidence = successful.some(call =>
    ACTION_PROMISE_EVIDENCE_TOOL_RE.test(call.name) ||
    (!INSPECTION_ONLY_TOOL_RE.test(call.name) && Boolean(call.result || call.name))
  );
  const hasReadReviewEvidence = successful.some(call => READ_REVIEW_EVIDENCE_TOOL_RE.test(call.name));
  const missingPromisedEvidence = claimsExecutionStatus && desktopActionTask
    ? !hasSuccessfulDesktopActionEvidence
    : desktopActionTask
    ? !hasDesktopActionAttempt
    : (successful.length === 0 || (promisesReadReviewAction ? !hasReadReviewEvidence : !hasPromiseEvidence));
  const promisesActionWithoutEvidence =
    (
      claimsExecutionStatus ||
      (
        ACTION_PROMISE_RE.test(claimText) &&
        // A future-looking phrase in Lumi's answer (for example, "I will
        // keep reviewing and improving my abilities") is not evidence that
        // the user asked for external work.  Promise enforcement must be
        // anchored to the current user task/continuation contract; otherwise
        // ordinary reflection is replaced by an unrelated file-read guard.
        ACTION_EVIDENCE_TASK_RE.test(task)
      )
    ) &&
    missingPromisedEvidence;

  if (promisesActionWithoutEvidence) {
    const reason = claimsExecutionStatus
      ? 'No successful current-turn tool execution was recorded for that execution-status claim.'
      : promisesReadReviewAction
      ? 'No successful content-read/open/review tool execution was recorded for the promised action.'
      : 'No successful tool execution was recorded for the promised action.';
    return {
      text: claimsExecutionStatus
        ? buildExecutionStatusGuardedResponse(task, reason, failed)
        : buildActionPromiseGuardedResponse(task, reason, failed),
      blocked: true,
      reason,
    };
  }

  const claimsCompletion = COMPLETION_CLAIM_RE.test(completionClaimText) || claimsSelfCompletion;
  if (!needsEvidence || !claimsCompletion) return { text: response, blocked: false };

  const currentAppMutationTask = requiresCurrentAppUiMutation(task);
  if (currentAppMutationTask && !hasCurrentAppUiMutationEvidence(toolCalls, task)) {
    const reason = 'Missing verified in-app UI mutation evidence.';
    return {
      text: buildGuardedResponse(task, reason, successful, failed),
      blocked: true,
      reason,
    };
  }

  if (
    currentAppMutationTask
    && claimsCurrentAppSaveCompletion(claimText)
    && !hasCurrentAppSaveEvidence(toolCalls, task)
  ) {
    const reason = 'Missing verified in-app save evidence.';
    return {
      text: buildGuardedResponse(task, reason, successful, failed),
      blocked: true,
      reason,
    };
  }

  const actionContract = buildActionContract(task);
  const hasDomainCompletionEvidence = actionContract.applies
    && hasCoreActionEvidence(actionContract, toolCalls, task);
  // Persistent-task creation has its own receipt contract. Once that exact
  // contract is satisfied, do not run the response through generic
  // file/desktop heuristics: wording such as "created and persisted" is about
  // the internal task ledger, not a file artifact or desktop mutation.
  if (actionContract.kind === 'work_task' && hasDomainCompletionEvidence) {
    return { text: response, blocked: false };
  }
  const unverifiedReceipts = hasDomainCompletionEvidence
    ? []
    : unverifiedCompletionReceipts(claimText, successful);
  if (unverifiedReceipts.length > 0) {
    const reason = unverifiedReceipts
      .map(call => call.terminalVerification?.reason)
      .filter(Boolean)
      .join('; ') || 'The tool returned, but the capability verification contract was not satisfied.';
    return {
      text: buildGuardedResponse(task, reason, successful, failed),
      blocked: true,
      reason,
    };
  }

  const hasAnySuccess = successful.length > 0;
  const hasActionTool = successful.some(call => !INSPECTION_ONLY_TOOL_RE.test(call.name));
  const hasFileProducer = successful.some(call =>
    FILE_PRODUCER_TOOL_RE.test(call.name) ||
    (
      !INSPECTION_ONLY_TOOL_RE.test(call.name) &&
      /File written:|Text file:|Output file:|Saved to:|written:|created:|saved:|exported:|\.dxf|\.pptx|\.docx|\.pdf|\.md|\.txt/i.test(call.result || '')
    )
  );
  const hasOpenTool = successful.some(call => OPEN_TOOL_RE.test(call.name));
  const hasPassingVerification = successful.some(call => /work_product_verify/i.test(call.name) && VERIFY_PASS_RE.test(call.result || ''));
  const pathsExist = extractLocalPaths(response)
    .some(filePath => {
      try {
        const stat = fs.statSync(filePath);
        return stat.isFile() && stat.size > 0;
      } catch {
        return false;
      }
    });

  let reason = '';
  let reasonCode: CompletionGuardResult['reasonCode'];
  if (!hasAnySuccess) {
    reason = '这一轮没有成功执行任何工具';
  } else if (OPEN_CLAIM_RE.test(claimText) && !hasOpenTool) {
    reason = '回复声称已经打开或加载，但没有成功的打开/客户端动作记录';
  } else if (
    FILE_CREATION_CLAIM_RE.test(claimText)
    && !currentAppMutationTask
    && !hasFileProducer
    && !hasPassingVerification
  ) {
    reason = '回复声称已经生成或保存产物，但没有成功的写入/生成/验收记录';
  } else if (!hasActionTool && !hasPassingVerification && !pathsExist) {
    reason = '\u6210\u529f\u6267\u884c\u4e86\u67e5\u8be2\u6216\u68c0\u67e5\u5de5\u5177\uff0c\u4f46\u8fd9\u4e9b\u7ed3\u679c\u4e0d\u662f\u5b8c\u6210\u5f53\u524d\u8bf7\u6c42\u6240\u9700\u7684\u6267\u884c\u8bc1\u636e'; // i18n-allow: reviewed Chinese evidence-accuracy reason.
    reasonCode = 'successful_irrelevant_evidence';
  }

  if (!reason) return { text: response, blocked: false };

  const guardedText = buildGuardedResponse(task, reason, successful, failed);
  return {
    text: guardedText,
    blocked: true,
    reason,
    reasonCode,
  };
}

function extractLocalPaths(text: string): string[] {
  const matches = text.match(/[A-Za-z]:\\[^\n\r"'<>|]+?\.(?:dxf|dwg|scr|lsp|ps1|svg|pdf|docx|xlsx|pptx|md|txt|json|csv|png|jpe?g|webp|html)/gi) || [];
  return matches
    .map(item => path.normalize(item.trim().replace(/[),.;，。；]+$/g, '')))
    .slice(0, 12);
}

function buildGuardedResponse(
  task: string,
  reason: string,
  successful: ToolExecutionRecord[],
  failed: ToolExecutionRecord[],
): string {
  const isZh = /[\u3400-\u9fff]/.test(task);
  const clientSurfaceTask = isClientSurfaceTask(task);
  const desktopActionTask = isDesktopActionTask(task);
  const lastSuccess = successful.slice(-3).map(call => call.name).join(', ');
  const lastFailure = summarizeFailedToolCalls(failed, isZh);
  const confirmationBlocked = failed.some(call =>
    /requires user confirmation|requires confirmation|user confirmation|\u7528\u6237\u786e\u8ba4|\u9700\u8981\u786e\u8ba4/i.test(toolFailureDetail(call))
  );

  if (isZh && desktopActionTask && !clientSurfaceTask) {
    return [
      `\u6211\u5df2\u7ecf\u5c1d\u8bd5\u4e86\u684c\u9762\u52a8\u4f5c\uff0c\u4f46\u8fd8\u4e0d\u80fd\u786e\u8ba4\u5b8c\u6210\uff1a${reason}\u3002`,
      lastSuccess ? `\u5df2\u6210\u529f\u6267\u884c\uff1a${lastSuccess}\uff1b\u4f46\u8fd9\u4e9b\u56de\u6267\u4e0d\u662f\u5b8c\u6210\u5f53\u524d\u8bf7\u6c42\u6240\u9700\u7684\u684c\u9762\u8bc1\u636e\u3002` : '\u76ee\u524d\u6ca1\u6709\u8bb0\u5f55\u5230\u6210\u529f\u7684\u684c\u9762\u6253\u5f00\u3001\u805a\u7126\u6216\u8fdb\u7a0b\u9a8c\u8bc1\u3002', // i18n-allow: reviewed Chinese evidence-accuracy response.
      lastFailure ? `\u6700\u8fd1\u7684\u963b\u585e\u70b9\uff1a${lastFailure}\u3002` : '',
      '\u4e0b\u4e00\u6b65\u5e94\u8be5\u7ee7\u7eed\u5b9a\u4f4d\u3001\u6253\u5f00\u6216\u805a\u7126\u76ee\u6807\uff0c\u5e76\u5728\u771f\u5b9e\u7a97\u53e3\u6216\u8fdb\u7a0b\u786e\u8ba4\u540e\u518d\u6c47\u62a5\u5b8c\u6210\u3002',
    ].filter(Boolean).join('\n');
  }

  if (!isZh) {
    if (clientSurfaceTask) {
      return [
        `I cannot honestly say the Lumi client action is complete yet: ${reason}.`,
        lastSuccess ? `Successfully executed: ${lastSuccess}; those receipts do not prove the requested client action completed.` : 'Verified so far: no successful client state/action evidence was recorded.',
        lastFailure ? `Latest blocker: ${lastFailure}.` : '',
        'Next step: run or retry the real client_get_state/client_action path, then report the verified state.',
      ].filter(Boolean).join('\n');
    }
    if (desktopActionTask) {
      return [
        `I tried the desktop action, but cannot mark it complete yet: ${reason}.`,
        lastSuccess ? `Successfully executed: ${lastSuccess}; those receipts are not the desktop evidence required to complete this request.` : 'Verified so far: no successful desktop action was recorded.',
        lastFailure ? `Latest blocker: ${lastFailure}.` : '',
        'Next step: keep locating/opening/focusing the target and verify the real window or process before reporting completion.',
      ].filter(Boolean).join('\n');
    }
    if (confirmationBlocked) {
      return [
        `I started the workflow, but cannot mark it complete yet: ${reason}.`,
        lastSuccess ? `Verified so far: successful tools: ${lastSuccess}.` : '',
        lastFailure ? `Latest blocker: ${lastFailure}.` : '',
        'Next step: confirm the gated action in the client or explicitly ask me to retry with approval.',
      ].filter(Boolean).join('\n');
    }
    return [
      `I cannot honestly mark this complete yet: ${reason}.`,
      lastSuccess ? `Successfully executed: ${lastSuccess}; those results are not the evidence required to complete the current request.` : 'Verified so far: no successful tool execution was recorded.',
      lastFailure ? `Latest blocker: ${lastFailure}.` : '',
      'Next step: continue the actual tool workflow, then verify the produced file/action before reporting completion.',
    ].filter(Boolean).join('\n');
  }

  if (clientSurfaceTask) {
    return [
      `我还不能说客户端动作已经完成：${reason}。`,
      lastSuccess ? `\u5df2\u6210\u529f\u6267\u884c\uff1a${lastSuccess}\uff1b\u4f46\u8fd9\u4e9b\u56de\u6267\u4e0d\u80fd\u8bc1\u660e\u8bf7\u6c42\u7684\u5ba2\u6237\u7aef\u52a8\u4f5c\u5df2\u7ecf\u5b8c\u6210\u3002` : '目前没有记录到成功的客户端状态读取或界面动作。', // i18n-allow: reviewed Chinese evidence-accuracy response.
      lastFailure ? `最近的阻塞点：${lastFailure}。` : '',
      '下一步应该继续真实执行 client_get_state / client_action，并在状态验证后再汇报完成。',
    ].filter(Boolean).join('\n');
  }

  if (confirmationBlocked) {
    return [
      `我已经开始处理，但还不能说完成：${reason}。`,
      lastSuccess ? `目前能确认的成功步骤：${lastSuccess}。` : '',
      lastFailure ? `最近的阻塞点：${lastFailure}。` : '',
      '下一步需要在客户端确认这个受控动作，或你明确授权后让我重试。',
    ].filter(Boolean).join('\n');
  }

  return [
    `我还不能说这件事已经完成：${reason}。`,
    lastSuccess ? `\u5df2\u6210\u529f\u6267\u884c\uff1a${lastSuccess}\uff1b\u4f46\u8fd9\u4e9b\u7ed3\u679c\u4e0d\u662f\u5b8c\u6210\u5f53\u524d\u8bf7\u6c42\u6240\u9700\u7684\u6267\u884c\u8bc1\u636e\u3002` : '目前没有记录到成功的工具执行。', // i18n-allow: reviewed Chinese evidence-accuracy response.
    lastFailure ? `最近的阻塞点：${lastFailure}。` : '',
    '下一步应该继续真实执行工具，并在文件路径、桌面动作或验收结果确认后再汇报完成。',
  ].filter(Boolean).join('\n');
}
