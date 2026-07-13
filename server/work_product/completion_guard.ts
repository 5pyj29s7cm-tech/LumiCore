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
  const clientSurfaceTask = isClientSurfaceTask(task);
  const desktopActionTask = isDesktopActionTask(task);
  const lastFailure = failed.slice(-2).map(call => `${call.name}: ${call.error}`).join('; ');
  const confirmationBlocked = failed.some(call =>
    /requires user confirmation|requires confirmation|user confirmation|用户确认|需要确认/i.test(String(call.error || ''))
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
  /(?:任务|工作|全部|都)?(?:已经|已)?[^。！？\n]{0,18}(?:完成|搞定|做好|做完)|(?:已经|已)[^。！？\n]{0,18}(?:生成|创建|保存|输出|写入|打开|加载|导出)|(?:生成好了|创建好了|保存好了|输出好了|打开了|加载好了|搞定了)|\b(?:task complete|completed successfully|created|saved|opened|exported|generated)\b/i;

const OPEN_CLAIM_RE =
  /(?:已经|已|都)?[^。！？\n]{0,12}(?:打开|加载)|(?:打开了|加载好了)|\b(?:opened|launched)\b/i;

const FILE_CREATION_CLAIM_RE =
  /(?:已经|已|都)?[^。！？\n]{0,18}(?:生成|创建|保存|输出|写入|导出)|(?:生成好了|创建好了|保存好了|输出好了)|\b(?:created|saved|exported|generated)\b/i;

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
  /(?:\b(?:i(?:'ll| will| am going to|'m going to)|let me|i need to|i'll first|let me first)\b[^.\n]{0,120}\b(?:read|open|check|review|analy[sz]e|inspect|process|search|generate|create|export)\b)|(?:(?:我|让我|我先|让我先|先|现在|马上|接下来)[^。\n]{0,80}(?:读取|读|打开|查看|看看|审查|分析|检查|处理|调用|搜索|查找|生成|导出|保存))/iu;

const CLIENT_SURFACE_TASK_RE =
  /客户端|自己的客户端|中枢世界|中枢|世界视图|云端画布|技能大厅|知识库|运行日志|主屏幕|主页|订阅|激活|账单|桌面小组件|小组件|客户接管面板|客户结果面板|设计交付面板|电商增长面板|client_get_state|client_action|\b(?:client|nexus|nexus\s+view|cloud\s+canvas|world\s+view|subscription|activation|billing|desktop\s+widget|widget\s+mode|customer\s+takeover\s+panel|design\s+delivery\s+panel|ecommerce\s+growth\s+panel)\b/iu;

function isClientSurfaceTask(task: string): boolean {
  return CLIENT_SURFACE_TASK_RE.test(task || '');
}

function isDesktopActionTask(task: string): boolean {
  const text = task || '';
  return DESKTOP_ACTION_TASK_RE.test(text) && !CONTENT_WORK_TASK_RE.test(text);
}

function stripNegatedClaimClauses(value: string): string {
  return String(value || '')
    .replace(
      /(?:\u6ca1\u6709|\u5e76\u672a|\u672a\u66fe|\u4e0d\u4f1a|\u4e0d\u80fd|\u4e0d\u5e94|\u4e0d\u8981|\u7981\u6b62|\u672a)(?=[^\u3002\uFF1B\uFF01\uFF1F\n\r]{0,48}(?:\u5b8c\u6210|\u6253\u5f00|\u542f\u52a8|\u53d1\u9001|\u751f\u6210|\u521b\u5efa|\u4fdd\u5b58|\u5bfc\u51fa|\u8bfb\u53d6|\u67e5\u770b))[^\u3002\uFF1B\uFF01\uFF1F\n\r]*/gu,
      ' ',
    )
    .replace(
      /\b(?:did\s+not|didn't|does\s+not|doesn't|have\s+not|haven't|has\s+not|hasn't|will\s+not|won't|cannot|can't|must\s+not|do\s+not|don't|never)\b(?=[^.;!?\n\r]{0,64}\b(?:complete|open|launch|send|create|generate|save|export|read|view)\b)[^.;!?\n\r]*/giu,
      ' ',
    );
}

export function needsCompletionEvidence(task: string): boolean {
  return EXTERNAL_WORK_TASK_RE.test(task || '');
}

export function guardCompletionClaims(input: CompletionGuardInput): CompletionGuardResult {
  const task = input.task || '';
  const response = input.response || '';
  if (!response.trim()) return { text: response, blocked: false };
  const claimText = stripNegatedClaimClauses(response);

  const needsEvidence = needsCompletionEvidence(task) || EXTERNAL_WORK_TASK_RE.test(response);
  const toolCalls = input.toolCalls || [];
  const successful = toolCalls.filter(call => !call.error && String(call.result || '').trim());
  const failed = toolCalls.filter(call => call.error);
  const desktopActionTask = isDesktopActionTask(task);
  const hasDesktopActionEvidence = toolCalls.some(call =>
    DESKTOP_ACTION_EVIDENCE_TOOL_RE.test(call.name) &&
    (Boolean(call.error) || Boolean(String(call.result || '').trim()))
  );
  const promisesReadReviewAction = READ_REVIEW_PROMISE_RE.test(claimText) && !desktopActionTask;
  const hasPromiseEvidence = successful.some(call =>
    ACTION_PROMISE_EVIDENCE_TOOL_RE.test(call.name) ||
    (!INSPECTION_ONLY_TOOL_RE.test(call.name) && Boolean(call.result || call.name))
  );
  const hasReadReviewEvidence = successful.some(call => READ_REVIEW_EVIDENCE_TOOL_RE.test(call.name));
  const missingPromisedEvidence = desktopActionTask
    ? !hasDesktopActionEvidence
    : (successful.length === 0 || (promisesReadReviewAction ? !hasReadReviewEvidence : !hasPromiseEvidence));
  const promisesActionWithoutEvidence =
    ACTION_PROMISE_RE.test(claimText) &&
    (ACTION_EVIDENCE_TASK_RE.test(task) || ACTION_EVIDENCE_TASK_RE.test(claimText)) &&
    missingPromisedEvidence;

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

  const claimsCompletion = COMPLETION_CLAIM_RE.test(claimText);
  if (!needsEvidence || !claimsCompletion) return { text: response, blocked: false };

  const hasAnySuccess = successful.length > 0;
  const hasActionTool = successful.some(call => !INSPECTION_ONLY_TOOL_RE.test(call.name));
  const hasFileProducer = successful.some(call =>
    FILE_PRODUCER_TOOL_RE.test(call.name) ||
    /File written:|Text file:|Output file:|Saved to:|written:|created:|saved:|exported:|\.dxf|\.pptx|\.docx|\.pdf|\.md|\.txt/i.test(call.result || '')
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
  } else if (OPEN_CLAIM_RE.test(claimText) && !hasOpenTool) {
    reason = '回复声称已经打开或加载，但没有成功的打开/客户端动作记录';
  } else if (FILE_CREATION_CLAIM_RE.test(claimText) && !hasFileProducer && !hasPassingVerification) {
    reason = '回复声称已经生成或保存产物，但没有成功的写入/生成/验收记录';
  } else if (!hasActionTool && !hasPassingVerification && !pathsExist) {
    reason = '只有查询或检查记录，没有实际执行、生成、打开或验收证据';
  }

  if (!reason) return { text: response, blocked: false };

  const guardedText = buildGuardedResponse(task, reason, successful, failed);
  return { text: guardedText, blocked: true, reason };
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
  const lastFailure = failed.slice(-2).map(call => `${call.name}: ${call.error}`).join('; ');
  const confirmationBlocked = failed.some(call =>
    /requires user confirmation|requires confirmation|user confirmation|用户确认|需要确认/i.test(String(call.error || ''))
  );

  if (isZh && desktopActionTask && !clientSurfaceTask) {
    return [
      `\u6211\u5df2\u7ecf\u5c1d\u8bd5\u4e86\u684c\u9762\u52a8\u4f5c\uff0c\u4f46\u8fd8\u4e0d\u80fd\u786e\u8ba4\u5b8c\u6210\uff1a${reason}\u3002`,
      lastSuccess ? `\u76ee\u524d\u80fd\u786e\u8ba4\u7684\u6210\u529f\u6b65\u9aa4\uff1a${lastSuccess}\u3002` : '\u76ee\u524d\u6ca1\u6709\u8bb0\u5f55\u5230\u6210\u529f\u7684\u684c\u9762\u6253\u5f00\u3001\u805a\u7126\u6216\u8fdb\u7a0b\u9a8c\u8bc1\u3002',
      lastFailure ? `\u6700\u8fd1\u7684\u963b\u585e\u70b9\uff1a${lastFailure}\u3002` : '',
      '\u4e0b\u4e00\u6b65\u5e94\u8be5\u7ee7\u7eed\u5b9a\u4f4d\u3001\u6253\u5f00\u6216\u805a\u7126\u76ee\u6807\uff0c\u5e76\u5728\u771f\u5b9e\u7a97\u53e3\u6216\u8fdb\u7a0b\u786e\u8ba4\u540e\u518d\u6c47\u62a5\u5b8c\u6210\u3002',
    ].filter(Boolean).join('\n');
  }

  if (!isZh) {
    if (clientSurfaceTask) {
      return [
        `I cannot honestly say the Lumi client action is complete yet: ${reason}.`,
        lastSuccess ? `Verified so far: successful tools: ${lastSuccess}.` : 'Verified so far: no successful client state/action evidence was recorded.',
        lastFailure ? `Latest blocker: ${lastFailure}.` : '',
        'Next step: run or retry the real client_get_state/client_action path, then report the verified state.',
      ].filter(Boolean).join('\n');
    }
    if (desktopActionTask) {
      return [
        `I tried the desktop action, but cannot mark it complete yet: ${reason}.`,
        lastSuccess ? `Verified so far: successful tools: ${lastSuccess}.` : 'Verified so far: no successful desktop action was recorded.',
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
      lastSuccess ? `Verified so far: successful tools: ${lastSuccess}.` : 'Verified so far: no successful tool execution was recorded.',
      lastFailure ? `Latest blocker: ${lastFailure}.` : '',
      'Next step: continue the actual tool workflow, then verify the produced file/action before reporting completion.',
    ].filter(Boolean).join('\n');
  }

  if (clientSurfaceTask) {
    return [
      `我还不能说客户端动作已经完成：${reason}。`,
      lastSuccess ? `目前能确认的成功步骤：${lastSuccess}。` : '目前没有记录到成功的客户端状态读取或界面动作。',
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
    lastSuccess ? `目前能确认的成功步骤：${lastSuccess}。` : '目前没有记录到成功的工具执行。',
    lastFailure ? `最近的阻塞点：${lastFailure}。` : '',
    '下一步应该继续真实执行工具，并在文件路径、桌面动作或验收结果确认后再汇报完成。',
  ].filter(Boolean).join('\n');
}
