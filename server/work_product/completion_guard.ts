import fs from 'fs';
import path from 'path';
import { ToolExecutionRecord } from '../tools/types';

export interface CompletionGuardResult {
  text: string;
  blocked: boolean;
  reason?: string;
}

function buildActionPromiseGuardedResponse(
  task: string,
  reason: string,
  failed: ToolExecutionRecord[],
): string {
  const isZh = /[\u3400-\u9fff]/.test(task);
  const lastFailure = failed.slice(-2).map(call => `${call.name}: ${call.error}`).join('; ');

  if (!isZh) {
    return [
      `I have not actually started that action yet: ${reason}`,
      lastFailure ? `Latest blocker: ${lastFailure}.` : 'What I can verify: this turn produced only a text reply, with no successful tool evidence.',
      'Next step: provide or select the file/location, then I should run the real read/open/review tool and show progress before giving the result.',
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
  /(?:任务|工作|全部|都)?(?:已经|已)?[^。！？\n]{0,18}(?:完成|搞定|做好|做完)|(?:已经|已)[^。！？\n]{0,18}(?:生成|创建|保存|输出|写入|打开|加载|导出)|(?:生成好了|创建好了|保存好了|输出好了|打开了|加载好了|搞定了)|\b(?:task complete|completed successfully|created|saved|opened|exported|generated)\b/i;

const OPEN_CLAIM_RE =
  /(?:已经|已|都)?[^。！？\n]{0,12}(?:打开|加载)|(?:打开了|加载好了)|\b(?:opened|launched)\b/i;

const FILE_CREATION_CLAIM_RE =
  /(?:已经|已|都)?[^。！？\n]{0,18}(?:生成|创建|保存|输出|写入|导出)|(?:生成好了|创建好了|保存好了|输出好了)|\b(?:created|saved|exported|generated)\b/i;

const INSPECTION_ONLY_TOOL_RE =
  /^(read_|list_|search_|grep_|desktop_path_info|desktop_list_files|client_get_state|adapter_health_check|usage_get_summary|calendar_|lumi_constitution|agent_list|get_|path_info)/i;

const FILE_PRODUCER_TOOL_RE =
  /^(write_file|create_ppt|create_docx|create_pdf|cad_generate_dxf|generate_.*(?:dxf|ppt|file)|export_|save_|document_)/i;

const OPEN_TOOL_RE =
  /^(desktop_open|client_action|computer_use|external_app_.*open|open_)/i;

const ACTION_PROMISE_EVIDENCE_TOOL_RE =
  /^(read_|extract_document_text|read_docx|read_pdf|pdf_to_text|ocr_image_file|transcribe_audio_to_text_file|desktop_open|desktop_capture_screen|desktop_ui_snapshot|capture_screen|computer_use|client_action|work_product_verify|create_|write_|generate_|export_|save_)/i;

const READ_REVIEW_PROMISE_RE =
  /\b(?:read|open|check|review|analy[sz]e|inspect|process)\b|(?:\u8bfb\u53d6|\u8bfb\u4e00\u4e0b|\u8bfb\u4e0b|\u6253\u5f00|\u67e5\u770b|\u770b\u770b|\u5ba1\u67e5|\u5ba1\u9605|\u5206\u6790|\u68c0\u67e5|\u5904\u7406)/iu;

const READ_REVIEW_EVIDENCE_TOOL_RE =
  /^(read_|extract_document_text|read_docx|read_pdf|pdf_to_text|ocr_image_file|transcribe_audio_to_text_file|desktop_open|desktop_capture_screen|desktop_ui_snapshot|capture_screen|computer_use|client_action)/i;

const VERIFY_PASS_RE = /"status"\s*:\s*"pass"|status:\s*pass/i;

const ACTION_EVIDENCE_TASK_RE =
  /\b(?:file|document|docx|pdf|attachment|desktop|screen|open|read|review|inspect|analy[sz]e|contract|agreement)\b|(?:文件|文档|资料|附件|合同|协议|打开|读取|查看|看看|审查|分析|检查|桌面|屏幕|生成|保存|导出)/iu;

const ACTION_PROMISE_RE =
  /(?:\b(?:i(?:'ll| will| am going to|'m going to)|let me|i need to|i'll first|let me first)\b[^.\n]{0,120}\b(?:read|open|check|review|analy[sz]e|inspect|process|search|generate|create|export)\b)|(?:(?:我|让我|我先|让我先|先|现在|马上|接下来)[^。\n]{0,80}(?:读取|读|打开|查看|看看|审查|分析|检查|处理|调用|搜索|查找|生成|导出|保存))/iu;

export function needsCompletionEvidence(task: string): boolean {
  return EXTERNAL_WORK_TASK_RE.test(task || '');
}

export function guardCompletionClaims(input: CompletionGuardInput): CompletionGuardResult {
  const task = input.task || '';
  const response = input.response || '';
  if (!response.trim()) return { text: response, blocked: false };

  const needsEvidence = needsCompletionEvidence(task) || EXTERNAL_WORK_TASK_RE.test(response);
  const toolCalls = input.toolCalls || [];
  const successful = toolCalls.filter(call => !call.error);
  const failed = toolCalls.filter(call => call.error);
  const promisesReadReviewAction = READ_REVIEW_PROMISE_RE.test(response);
  const hasPromiseEvidence = successful.some(call =>
    ACTION_PROMISE_EVIDENCE_TOOL_RE.test(call.name) ||
    (!INSPECTION_ONLY_TOOL_RE.test(call.name) && Boolean(call.result || call.name))
  );
  const hasReadReviewEvidence = successful.some(call => READ_REVIEW_EVIDENCE_TOOL_RE.test(call.name));
  const promisesActionWithoutEvidence =
    ACTION_PROMISE_RE.test(response) &&
    (ACTION_EVIDENCE_TASK_RE.test(task) || ACTION_EVIDENCE_TASK_RE.test(response)) &&
    (successful.length === 0 || (promisesReadReviewAction ? !hasReadReviewEvidence : !hasPromiseEvidence));

  if (promisesActionWithoutEvidence) {
    const reason = promisesReadReviewAction
      ? 'No successful content-read/open/review tool execution was recorded for the promised action.'
      : 'No successful tool execution was recorded for the promised action.';
    return {
      text: buildActionPromiseGuardedResponse(task, reason, failed),
      blocked: true,
      reason,
    };
  }

  const claimsCompletion = COMPLETION_CLAIM_RE.test(response);
  if (!needsEvidence || !claimsCompletion) return { text: response, blocked: false };

  const hasAnySuccess = successful.length > 0;
  const hasActionTool = successful.some(call => !INSPECTION_ONLY_TOOL_RE.test(call.name));
  const hasFileProducer = successful.some(call =>
    FILE_PRODUCER_TOOL_RE.test(call.name) ||
    /File written:|written:|created:|saved:|exported:|\.dxf|\.pptx|\.docx|\.pdf|\.md/i.test(call.result || '')
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
  if (!hasAnySuccess) {
    reason = '这一轮没有成功执行任何工具';
  } else if (OPEN_CLAIM_RE.test(response) && !hasOpenTool) {
    reason = '回复声称已经打开或加载，但没有成功的打开/客户端动作记录';
  } else if (FILE_CREATION_CLAIM_RE.test(response) && !hasFileProducer && !hasPassingVerification) {
    reason = '回复声称已经生成或保存产物，但没有成功的写入/生成/验收记录';
  } else if (!hasActionTool && !hasPassingVerification && !pathsExist) {
    reason = '只有查询或检查记录，没有实际执行、生成、打开或验收证据';
  }

  if (!reason) return { text: response, blocked: false };

  const guardedText = buildGuardedResponse(task, reason, successful, failed);
  return { text: guardedText, blocked: true, reason };
}

function extractLocalPaths(text: string): string[] {
  const matches = text.match(/[A-Za-z]:\\[^\n\r"'<>|]+?\.(?:dxf|dwg|svg|pdf|docx|xlsx|pptx|md|txt|json|csv|png|jpe?g|webp|html)/gi) || [];
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
  const lastSuccess = successful.slice(-3).map(call => call.name).join(', ');
  const lastFailure = failed.slice(-2).map(call => `${call.name}: ${call.error}`).join('; ');

  if (!isZh) {
    return [
      `I cannot honestly mark this complete yet: ${reason}.`,
      lastSuccess ? `Verified so far: successful tools: ${lastSuccess}.` : 'Verified so far: no successful tool execution was recorded.',
      lastFailure ? `Latest blocker: ${lastFailure}.` : '',
      'Next step: continue the actual tool workflow, then verify the produced file/action before reporting completion.',
    ].filter(Boolean).join('\n');
  }

  return [
    `我还不能说这件事已经完成：${reason}。`,
    lastSuccess ? `目前能确认的成功步骤：${lastSuccess}。` : '目前没有记录到成功的工具执行。',
    lastFailure ? `最近的阻塞点：${lastFailure}。` : '',
    '下一步应该继续真实执行工具，并在文件路径、桌面动作或验收结果确认后再汇报完成。',
  ].filter(Boolean).join('\n');
}
