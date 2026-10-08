import { mediaGenerationIntent } from './normalized_action_intent';
import { requestedVideoDuration, requestedVideoAudio } from '../../shared/video_generation_options';
import { parseReceiptObject, toolRecordTerminalPayload } from '../tools/receipt_payload';
import { verifiedSkillAuthoringReceipt } from '../skills/authoring_receipt';
import { artifactPathFromRecord, isArtifactProducerRecord, resolveArtifactDelivery } from '../tools/artifact_evidence';
import { matchesRequestedArtifactOutput } from './artifact_write_scope';
import { getArtifactTaskProgress } from './action_contract';
import { formatArtifactProgress } from './artifact_progress';
import { extractExplicitArtifactTextRequirements, extractCurrentAppTarget, extractRequestedCurrentAppText, hasBlankAutoCadDocumentEvidence, hasRequestedDesktopOpenEvidence, hasVerifiedCadGeometryExtractionEvidence, requiresArtifactPostWriteReadback, requiresArtifactOpen, requiresCadGeometryExtractionOnly, requiresCurrentAppUiMutation, requiresVisibleAutoCadExecution } from './action_contract';
import { formatCnToolFailureDetail } from "../regions/messages/voice_fast_path_messages";
import { formatArtifactCreatedAndOpened, formatArtifactCreatedOpenFailed } from "../regions/messages/naturalness_messages";
import { CN_EXECUTION_EVIDENCE_MESSAGES } from "../regions/messages/execution_evidence_messages";
import { toolRecordSucceeded } from './task_execution_ledger';
import fs from 'node:fs';
import { CN_RESULT_GROUNDING_MESSAGES } from "../regions/messages/voice_fast_path_messages";
import { CN_CAD_MESSAGES } from "../regions/messages/cad_messages";
import { CN_EXTERNAL_AI_MESSAGES } from "../regions/messages/external_ai_messages";
import { buildMediaArtifactReceipt } from '../socket/media_artifact_receipt';
import { type LumiResultFinalizerInput, type LumiResultFinalizerResult } from "./result_finalizer_types";
import { recordMatchesCurrentTurnIdentity, isChineseText, resultTaskText, taskActionContract, isVerifiedCurrentTurnRecord, requiresSourceGroundedArtifactContent, findUnresolvedArtifactPlaceholder } from "./result_finalizer_support";

export function formatGroundedWorkflowProgress(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  const record = [...(input.toolRecords || [])].reverse().find(item =>
      ['run_workflow', 'get_workflow_run', 'resume_workflow_run', 'decide_workflow_confirmation'].includes(item.name)
      && !item.error && recordMatchesCurrentTurnIdentity(input, item)
      && item.terminalVerification?.status === 'verified');
  if (!record) return null;
  const result = parseReceiptObject(toolRecordTerminalPayload(record));
    if (result?.ok !== true || !result.runId || !result.workflowId) return null;
    const zh = isChineseText(resultTaskText(input));
    if (result.status === 'completed' && result.totalSteps > 0 && result.completedSteps === result.totalSteps) {
      const output = [...(Array.isArray(result.outputs) ? result.outputs : [])].reverse().find(item => item.status === 'verified');
      const payload = parseReceiptObject(output?.result);
      const cell = (value: unknown) => String(value ?? '').replace(/[\r\n|]/g, ' ').replace(/([\\`*_<>])/g, '\\$1').slice(0, 180);
      const render = (value: unknown, depth = 0): string => {
        if (depth > 3) return '…';
        if (Array.isArray(value)) {
          const rows = value.slice(0, 12);
          if (rows.length && rows.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
            const keys = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, 8);
            if (keys.length && rows.every(row => keys.every(key => row[key] == null || typeof row[key] !== 'object'))) {
              return [`| ${keys.map(cell).join(' | ')} |`, `| ${keys.map(() => '---').join(' | ')} |`,
                ...rows.map(row => `| ${keys.map(key => cell(row[key])).join(' | ')} |`), ...(value.length > 12 ? ['…'] : [])].join('\n');
            }
          }
          return rows.map(row => render(row, depth + 1)).join('\n');
        }
        if (value && typeof value === 'object') return Object.entries(value).slice(0, 12)
          .map(([key, item]) => `${cell(key)}: ${item && typeof item === 'object' ? '\n\n' : ''}${render(item, depth + 1)}`).join('\n\n');
        return cell(value);
      };
      const detail = render(payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : output?.result);
      // i18n-allow: bilingual completed workflow summary grounded in durable output.
      return { text: `${zh ? '工作流已完成' : 'Workflow completed'} (${result.completedSteps}/${result.totalSteps})。${detail ? '\n\n' + detail : ''}`,
        blocked: false, reason: 'workflow_completed' };
    }
    if (['blocked', 'cancelled', 'failed'].includes(result.status)) {
      // i18n-allow: bilingual ledger-grounded failure, not an observation success claim.
      return { text: zh
        ? `工作流尚未完成：已完成 ${result.completedSteps}/${result.totalSteps} 步。${result.reconciliationRequired ? '上一步返回了数据，但还没有通过结果核验，不能算完成；请先核对，避免重复执行。' : '流程已停止，需要处理当前阻碍后再继续。'}\n运行编号：${result.runId}`
        : `The workflow is not complete: ${result.completedSteps}/${result.totalSteps} steps completed. ${result.reconciliationRequired ? 'The last result needs reconciliation before any retry.' : 'Resolve the current blocker before continuing.'}\nRun: ${result.runId}`,
        blocked: true, reason: 'workflow_incomplete' };
    }
  if (result.status === 'waiting_confirmation' && result.confirmation?.confirmationId) {
    const pending = result.confirmation;
    // i18n-allow: bilingual exact workflow progress, not business completion.
    const text = zh
      ? `工作流已开始，正在等待确认第 ${result.completedSteps + 1} 步，尚未全部完成。\n操作：${pending.capabilityId}\n参数：${JSON.stringify(pending.argumentPreview || {})}\n运行：${result.runId}\n版本：${result.revision}\n确认标识：${pending.confirmationId}`
      : `The workflow has started and is waiting for step ${result.completedSteps + 1} confirmation; it is not complete.\nAction: ${pending.capabilityId}\nArguments: ${JSON.stringify(pending.argumentPreview || {})}\nRun: ${result.runId}\nRevision: ${result.revision}\nConfirmation: ${pending.confirmationId}`;
    return { text, blocked: false, reason: 'waiting_confirmation' };
  }
  if (['started', 'running', 'queued'].includes(result.status)) {
    // i18n-allow: bilingual nonterminal workflow status.
    return { text: zh ? `工作流正在运行，尚未全部完成。运行编号：${result.runId}` : `The workflow is running and is not complete. Run: ${result.runId}`, blocked: false, reason: 'workflow_running' };
  }
  return null;
}

export function formatGroundedSkillDraft(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  const actionText = resultTaskText(input);
  const authoring = verifiedSkillAuthoringReceipt(actionText, input.toolRecords || [], { requestId: input.requestId, taskId: input.taskId });
  if (authoring?.intent === 'publish') {
    const published = authoring.result;
    // i18n-allow: Verified local workflow publication, distinct from execution.
    return { text: isChineseText(actionText)
      ? `工作流已审核发布：${published.name}，版本 ${published.version}。\n本轮尚未运行。`
      : `Workflow published: ${published.name}, version ${published.version}.\nIt has not been run in this turn.`,
    blocked: false, reason: 'workflow_published' };
  }
  if (authoring?.intent === 'save') {
    const draft = authoring.result;
    // i18n-allow: Verified draft state; never imply publication or execution.
    return { text: isChineseText(actionText)
      ? `工作流草稿已保存：${draft.name || '未命名工作流'}，共 ${draft.stepCount || 0} 步。\n尚未审核发布，暂不能运行。`
      : `Workflow draft saved: ${draft.name || 'Untitled workflow'}, ${draft.stepCount || 0} steps.\nIt has not been reviewed or published and cannot run yet.`,
      blocked: false, reason: 'workflow_draft_saved' };
  }
  if (authoring?.intent === 'generate') {
    const draft = authoring.result;
    return {
      // i18n-allow: bilingual receipt-grounded skill draft completion; does not claim execution.
      text: isChineseText(actionText)
        ? `技能草稿已生成：${draft.displayName || draft.skillName}。\n静态、类型和依赖检查已通过，尚未安装或执行。\n草稿目录：${draft.draftDirectory}\n审核标识：${draft.review.contentHash}\n安装后还需要用实际任务验证效果。`
        : `Skill draft generated: ${draft.displayName || draft.skillName}.\nStatic, type and dependency checks passed; it has not been installed or executed.\nDraft: ${draft.draftDirectory}\nReview hash: ${draft.review.contentHash}\nBusiness behavior still requires testing after installation.`,
      blocked: false, reason: 'Verified skill draft phase; installation and business execution remain separate.',
    };
  }
  return null;
}

export function formatGroundedArtifactResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  if (taskActionContract(input).kind !== 'artifact_work') return null;
  const records = input.toolRecords || [];
  const delivery = resolveArtifactDelivery(records, record => isVerifiedCurrentTurnRecord(input, record));
  if (!delivery) return null;
  const { producer: created, outputPath: path, readback } = delivery;
  const actionText = resultTaskText(input);
  if (!matchesRequestedArtifactOutput(actionText, path)) return null;
  const progress = getArtifactTaskProgress(actionText, records, input);
  if (progress && !progress.complete) return {
    text: formatArtifactProgress(progress, actionText), blocked: true,
    reason: `artifact_step_pending:${progress.next}`,
  };
  // A requested numeric answer is part of delivery, not just an optional
  // acknowledgement of the saved file. Deliver same-output readback evidence.
  // i18n-allow: Requested numerical deliverable recognition.
  const requestsComputedAnswer = /(?:告诉|汇报|列出|给出|检查|核对|确认)[\s\S]{0,32}(?:金额|合计|总数|计算结果)|\b(?:tell|report|show|check|verify)\b[\s\S]{0,40}\b(?:total|sum|calculated result)\b/iu.test(actionText);
  const calculatedCells = parseReceiptObject(toolRecordTerminalPayload(created))?.calculatedCells;
  const calculationEvidence = Array.isArray(calculatedCells) ? calculatedCells.slice(0, 80).filter(cell => (
    cell && typeof cell.sheet === 'string' && /^[A-Z]+\d+$/u.test(cell.cell) && typeof cell.value === 'number' && Number.isFinite(cell.value)
  )).map(cell => `${typeof cell.label === 'string' && cell.label ? cell.label : `${cell.sheet}!${cell.cell}`}: ${cell.value}`).join('\n') : '';
  const readbackRequired = requiresArtifactPostWriteReadback(actionText) || (requestsComputedAnswer && !calculationEvidence);
  const asksToOpen = requiresArtifactOpen(actionText);
  const openRecord = [...records].reverse().find(record => /^(?:desktop_open|browser_open_task)$/i.test(String(record.name || '')));
  const verified = records.some(record => (
    !record.error
    && /^(?:desktop_path_info|work_product_verify)$/i.test(String(record.name || ''))
    && String(record.result || '').trim()
  ));
  const zh = isChineseText(actionText);
  if (asksToOpen && openRecord?.error) {
    const failure = formatCnToolFailureDetail(String(openRecord.error || ''));
    const text = formatArtifactCreatedOpenFailed(
      actionText,
      path,
      verified,
      zh ? failure : String(openRecord.error || ''),
    );
    return {
      text,
      blocked: true,
      reason: 'Artifact creation succeeded, but the requested open step failed.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Artifact creation succeeded, but the requested open step failed.',
      },
    };
  }
  if (asksToOpen && !hasRequestedDesktopOpenEvidence(records, actionText, path)) {
    return {
      text: zh ? CN_EXECUTION_EVIDENCE_MESSAGES.artifactOpenMissing(path) : `Saved the file: ${path}. Opening it in the requested application has not yet been verified.`,
      blocked: true,
      reason: 'Artifact creation succeeded, but the requested open step has no verified exact-target evidence.',
    };
  }
  if (asksToOpen && openRecord && !openRecord.error && String(openRecord.result || '').trim()) {
    if (readbackRequired && !readback) return null;
    return {
      text: [formatArtifactCreatedAndOpened(actionText, path, verified),
        ...(requestsComputedAnswer && calculationEvidence ? [calculationEvidence] : readbackRequired && readback ? [String(readback.result || '').slice(0, 12_000)] : [])].join('\n'),
      blocked: false,
      reason: 'Grounded artifact creation and open result from current-turn receipts.',
    };
  }
  const artifactVerified = (
    toolRecordSucceeded(created)
    && created.terminalVerification?.status === 'verified'
  );
  if (artifactVerified) {
    try {
      const stats = fs.statSync(path);
      if (stats.isFile() && stats.size > 0) {
        const exactText = extractExplicitArtifactTextRequirements(actionText);
        let artifactText = '';
        if ((exactText.length || requiresSourceGroundedArtifactContent(actionText)) && /\.(?:txt|md|csv|json|xml|html?|css|svg|dxf|ya?ml|toml|tsx?|jsx?|py|rs)$/iu.test(path)) {
          artifactText = fs.readFileSync(path, 'utf8');
          if (requiresSourceGroundedArtifactContent(actionText)) {
            const unresolvedPlaceholder = findUnresolvedArtifactPlaceholder(artifactText);
            if (unresolvedPlaceholder) {
              return {
                text: zh
                  ? `\u6587\u4ef6\u5df2\u5199\u5165\uff0c\u4f46\u4ecd\u5305\u542b\u672a\u7528\u6e90\u6587\u4ef6\u771f\u5b9e\u5185\u5bb9\u66ff\u6362\u7684\u5360\u4f4d\u7b26\u201c${unresolvedPlaceholder}\u201d\uff0c\u4e0d\u80fd\u62a5\u544a\u5b8c\u6210\u3002\u4ea7\u7269\u8def\u5f84\uff1a${path}`
                  : `The file was written, but it still contains an unresolved source placeholder "${unresolvedPlaceholder}". It cannot be reported as complete. Artifact path: ${path}`,
                blocked: true,
                reason: 'Source-grounded artifact still contains unresolved placeholders.',
              };
            }
          }
          const missing = exactText.filter(value => !artifactText.includes(value));
          if (missing.length) {
            return {
              text: zh
                ? `文件已写入，但尚未满足当前要求：缺少精确文本“${missing[0]}”。我不会把它汇报为已完成。产物路径：${path}`
                : `The file was written, but it is missing the exact required text "${missing[0]}". I will not mark it complete. Artifact path: ${path}`,
              blocked: true,
              reason: `Verified artifact is missing exact required text: ${missing[0]}`,
              notification: {
                type: 'work_product_guard',
                level: 'warning',
                message: `Verified artifact is missing exact required text: ${missing[0]}`,
              },
            };
          }
          if (/(?:只写入|仅写入|only\s+write)/iu.test(actionText)) {
            const expected = exactText.join('\n').replace(/\r\n/g, '\n');
            if (artifactText.replace(/\r\n/g, '\n') !== expected) {
              return {
                text: zh
                  ? `文件已写入，但全文并非用户指定的逐行内容，不能报告完成。产物路径：${path}`
                  : `The file was written, but its full text does not exactly match the requested lines. Artifact path: ${path}`,
                blocked: true,
                reason: 'Verified artifact contains extra, missing, or reordered text.',
              };
            }
          }
        }
        if (readbackRequired && (!readback || readback.error || !String(readback.result || '').trim())) {
          return {
            text: zh
              ? `文件已经写入，但没有取得同一路径的成功回读回执，不能报告完成。产物路径：${path}`
              : `The file was written, but no successful same-path readback receipt was recorded. Artifact path: ${path}`,
            blocked: true,
            reason: 'Requested post-write readback is missing or failed.',
          };
        }
        if (readbackRequired && readback && /\.(?:txt|md|csv|json|xml|html?|css|svg|dxf|ya?ml|toml|tsx?|jsx?|py|rs)$/iu.test(path)) {
          if (!artifactText) artifactText = fs.readFileSync(path, 'utf8');
          const receiptText = String(readback.result || '').replace(/\r\n/g, '\n');
          const actualText = artifactText.replace(/\r\n/g, '\n');
          if (receiptText !== actualText) {
            return {
              text: zh
                ? `文件已经写入，但回读回执与磁盘全文不一致，不能报告完成。产物路径：${path}`
                : `The file was written, but the readback receipt differs from the current file. Artifact path: ${path}`,
              blocked: true,
              reason: 'Post-write readback differs from the current artifact.',
            };
          }
          if (/(?:\u7f16\u7801|\u603b\u884c\u6570|\u884c\u6570|\u5168\u6587|encoding|line\s*count|full\s*text)/iu.test(actionText)) {
            const normalizedText = actualText.replace(/\n$/, '');
            const lineCount = normalizedText ? normalizedText.split('\n').length : 0;
            return {
              text: zh
                ? [
                    '\u5df2\u5b8c\u6210\u672c\u5730\u6587\u4ef6\u521b\u5efa\u4e0e\u56de\u8bfb\u6838\u9a8c\u3002',
                    `\u8def\u5f84\uff1a${path}`,
                    '\u7f16\u7801\uff1aUTF-8',
                    `\u603b\u884c\u6570\uff1a${lineCount}`,
                    '\u5168\u6587\uff1a',
                    normalizedText,
                  ].join('\n')
                : [
                    'Completed the local file and verified it by reading it back.',
                    `Path: ${path}`,
                    'Encoding: UTF-8',
                    `Line count: ${lineCount}`,
                    'Full text:',
                    normalizedText,
                  ].join('\n'),
              blocked: false,
              reason: 'Grounded artifact completion with exact same-path post-write readback.',
            };
          }
          if (/(?:编码|总行数|行数|全文|encoding|line\s*count|full\s*text)/iu.test(actionText)) {
            const normalizedText = actualText.replace(/\n$/, '');
            const lineCount = normalizedText ? normalizedText.split('\n').length : 0;
            return {
              text: zh
                ? [
                    '已完成本地文件创建与回读核验。',
                    `路径：${path}`,
                    '编码：UTF-8',
                    `总行数：${lineCount}`,
                    '全文：',
                    normalizedText,
                  ].join('\n')
                : [
                    'Completed the local file and verified it by reading it back.',
                    `Path: ${path}`,
                    'Encoding: UTF-8',
                    `Line count: ${lineCount}`,
                    'Full text:',
                    normalizedText,
                  ].join('\n'),
              blocked: false,
              reason: 'Grounded artifact completion with exact same-path post-write readback.',
            };
          }
        }
        if (requestsComputedAnswer && calculationEvidence) {
          return {
            text: [zh ? CN_EXECUTION_EVIDENCE_MESSAGES.artifactSavedVerified(path) : `Saved and verified the file: ${path}`,
              zh ? CN_EXECUTION_EVIDENCE_MESSAGES.formulaResultsHeading : 'Calculated formula results:', calculationEvidence].join('\n'),
            blocked: false,
            reason: 'Grounded artifact completion with delivered same-path readback content.',
          };
        }
        if (readbackRequired && readback) {
          const readbackText = String(readback.result || '').trim();
          const limit = 12_000;
          const excerpt = readbackText.slice(0, limit);
          return {
            text: [
              zh ? CN_RESULT_GROUNDING_MESSAGES.artifactSavedReadback(path) : `Saved and read back the file: ${path}`,
              zh ? CN_RESULT_GROUNDING_MESSAGES.artifactReadbackHeading : 'Readback result:',
              excerpt,
              readbackText.length > limit
                ? (zh ? CN_RESULT_GROUNDING_MESSAGES.artifactReadbackExcerpt(limit) : 'Only the first 12000 characters of the readback are shown.')
                : '',
            ].filter(Boolean).join('\n'),
            blocked: false,
            reason: 'Grounded artifact completion with delivered same-path readback content.',
          };
        }
        return {
          text: zh
            ? `已完成并验证本地文件：${path}（${stats.size} 字节）。`
            : `Completed and verified the local file: ${path} (${stats.size} bytes).`,
          blocked: false,
          reason: 'Grounded artifact completion from a verified producer receipt and the current local file.',
        };
      }
    } catch {}
  }
  // A declaration without a verified non-empty file remains subject to the
  // generic completion guard below.
  return null;
}

const CAD_GEOMETRY_ZH = {
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  failed: '\u51e0\u4f55\u63d0\u53d6\u672a\u6210\u529f\uff0c\u672a\u6267\u884c\u7ed8\u5236\u3002',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  succeeded: '\u51e0\u4f55\u63d0\u53d6\u6210\u529f\uff0c\u672a\u6267\u884c\u7ed8\u5236\u3002',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  reason: '\u539f\u56e0\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  source: '\u6765\u6e90\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  verificationState: '\u9a8c\u8bc1\u72b6\u6001\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  receipt: '\u51e0\u4f55\u56de\u6267\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  dimensions: '\u51e0\u4f55\u5c3a\u5bf8\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  counts: '\u51e0\u4f55\u8ba1\u6570\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  failedStage: '\u5931\u8d25\u9636\u6bb5\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  receiptState: '\u56de\u6267\u72b6\u6001\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  next: '\u4e0b\u4e00\u6b65\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry public failure copy.
  retry: '\u8bf7\u68c0\u67e5\u6e90\u6587\u4ef6\u540e\u91cd\u8bd5\uff0c\u6216\u6362\u4e00\u4efd\u53ef\u8bfb\u7684\u56fe\u7eb8\u3002',
} as const;

export function formatGroundedCadGeometryExtractionResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const actionText = resultTaskText(input);
  if (!requiresCadGeometryExtractionOnly(actionText)) return null;
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    /^floorplan_extract_geometry$/i.test(String(item.name || ''))
  ));
  if (!record) return null;

  const zh = isChineseText(actionText);
  if (record.error) {
    const publicMessage = zh
      ? `${CAD_GEOMETRY_ZH.failed}\n${CAD_GEOMETRY_ZH.retry}`
      : 'Geometry extraction did not succeed; no drawing was executed. Check the source file and retry, or use another readable drawing.';
    return {
      text: publicMessage,
      blocked: true,
      reason: 'floorplan_geometry_extraction_failed',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: publicMessage,
      },
    };
  }

  let parsed: Record<string, any>;
  try {
    const value = JSON.parse(String(record.result || ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('non-object receipt');
    parsed = value as Record<string, any>;
  } catch {
    const blocker = 'floorplan_extract_geometry returned malformed structured JSON.';
    return {
      text: zh
        ? [
            CAD_GEOMETRY_ZH.failed,
            `${CAD_GEOMETRY_ZH.reason}${blocker}`,
          ].join('\n')
        : [
            'Geometry extraction did not succeed; no drawing was executed.',
            `Reason: ${blocker}`,
          ].join('\n'),
      blocked: true,
      reason: blocker,
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: blocker,
      },
    };
  }

  const sourcePath = String(parsed.path || record.arguments?.imagePath || '').trim();
  const receiptPath = String(parsed.geometryReceiptPath || '').trim();
  const flag = (value: unknown) => value === true ? 'true' : value === false ? 'false' : 'unknown';
  const state = `parsed=${flag(parsed.parsed)}, geometryReady=${flag(parsed.geometryReady)}, geometryVerified=${flag(parsed.geometryVerified)}`;
  const verified = hasVerifiedCadGeometryExtractionEvidence([record]);
  if (verified) {
    const width = Number(parsed?.geometryReview?.width || 0);
    const height = Number(parsed?.geometryReview?.height || 0);
    const countEntries = Object.entries(parsed?.geometryReview?.counts || {})
      .filter(([, value]) => Number(value) > 0)
      .map(([key, value]) => `${key}=${Number(value)}`);
    const lines = zh
      ? [
          CAD_GEOMETRY_ZH.succeeded,
          sourcePath ? `${CAD_GEOMETRY_ZH.source}${sourcePath}` : '',
          `${CAD_GEOMETRY_ZH.verificationState}${state}\u3002`,
          receiptPath ? `${CAD_GEOMETRY_ZH.receipt}${receiptPath}` : '',
          width > 0 && height > 0 ? `${CAD_GEOMETRY_ZH.dimensions}${width} x ${height}\u3002` : '',
          countEntries.length > 0 ? `${CAD_GEOMETRY_ZH.counts}${countEntries.join(', ')}\u3002` : '',
        ]
      : [
          'Geometry extraction succeeded; no drawing was executed.',
          sourcePath ? `Source: ${sourcePath}` : '',
          `Verification state: ${state}.`,
          receiptPath ? `Geometry receipt: ${receiptPath}` : '',
          width > 0 && height > 0 ? `Geometry dimensions: ${width} x ${height}.` : '',
          countEntries.length > 0 ? `Geometry counts: ${countEntries.join(', ')}.` : '',
        ];
    return {
      text: lines.filter(Boolean).join('\n'),
      blocked: false,
      reason: 'Grounded geometry-extraction success from a verified floorplan_extract_geometry receipt.',
    };
  }

  const failedStage = String(parsed.failedStage || 'verification').trim();
  const parseError = String(
    parsed.parseError
    || parsed?.geometryReview?.validation?.errors?.[0]
    || parsed?.geometryReview?.visualVerification?.criticalMismatches?.[0]
    || 'The geometry receipt did not pass readiness and verification.',
  ).trim();
  const next = String(parsed.next || '').trim();
  const lines = zh
    ? [
        CAD_GEOMETRY_ZH.failed,
        `${CAD_GEOMETRY_ZH.failedStage}${failedStage}\u3002`,
        `${CAD_GEOMETRY_ZH.receiptState}${state}\u3002`,
        `${CAD_GEOMETRY_ZH.reason}${parseError}`,
        next ? `${CAD_GEOMETRY_ZH.next}${next}` : '',
      ]
    : [
        'Geometry extraction did not succeed; no drawing was executed.',
        `Failed stage: ${failedStage}.`,
        `Receipt state: ${state}.`,
        `Reason: ${parseError}`,
        next ? `Next: ${next}` : '',
      ];
  const blocker = `Geometry extraction receipt reported ${failedStage}: ${parseError}`;
  return {
    text: lines.filter(Boolean).join('\n'),
    blocked: true,
    reason: blocker,
    notification: {
      type: 'work_product_guard',
      level: 'warning',
      message: blocker,
    },
  };
}

export function formatGroundedWpsMutationResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const actionText = resultTaskText(input);
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    item.name === 'wps_create_document_with_text'
    && !item.error
    && String(item.result || '').trim()
  ));
  if (!record) return null;

  const primaryText = String(actionText || '').split(/\n## Recent action continuation context\b/i, 1)[0].trim();
  const target = extractCurrentAppTarget(actionText);
  const targetsWps = /(?:^|\b)wps(?:\s+office|\s+writer)?(?:\b|$)|\u91d1\u5c71/iu.test(target);
  // A direct "create a Word/document" request may not carry recovered
  // appTarget context even though the current-turn native WPS receipt proves
  // exactly which application performed the mutation. Accept that receipt as
  // the surface identity instead of discarding a verified in-app result.
  const directDocumentMutation = (
    /(?:\u65b0\u5efa|\u521b\u5efa|\u5199\u5165|\u8f93\u5165|\u7f16\u8f91|\u4fee\u6539)|\b(?:new|create|write|type|edit|modify)\b/iu.test(primaryText)
    && /(?:\bWPS\b|\bWord\b|\u6587\u6863)|\bdocument\b/iu.test(primaryText)
  );
  if (!targetsWps && !directDocumentMutation) return null;
  if (!requiresCurrentAppUiMutation(actionText) && !directDocumentMutation) return null;

  let receipt: Record<string, any>;
  try {
    const parsed = JSON.parse(String(record.result || ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    receipt = parsed as Record<string, any>;
  } catch {
    return null;
  }

  const requestedText = extractRequestedCurrentAppText(primaryText);
  const suppliedText = String(record.arguments?.text || '');
  const readBack = String(receipt.bodyTextWithoutTerminalParagraph || '');
  const attachmentMode = String(receipt.attachmentMode || '');
  const attachmentFlagsMatch = attachmentMode === 'attachedExisting'
    ? receipt.attachedExisting === true && receipt.newVisibleInstance === false
    : attachmentMode === 'newVisibleInstance'
      ? receipt.attachedExisting === false && receipt.newVisibleInstance === true
      : false;
  const verified = (
    receipt.ok === true
    && receipt.status === 'verified'
    && receipt.automation === 'KWPS.Application'
    && receipt.visible === true
    && receipt.documentCreated === true
    && receipt.exactTextMatch === true
    && receipt.processName === 'wps.exe'
    && Number(receipt.processId) > 0
    && attachmentFlagsMatch
    && Boolean(String(receipt.documentName || '').trim())
    && Boolean(String(receipt.windowTitle || '').trim())
    && receipt.saved === false
    && !String(receipt.savePath || '').trim()
    && suppliedText === requestedText
    && readBack === requestedText
  );
  if (!verified) return null;

  const zh = isChineseText(actionText);
  const userRequestedSave = /(?:\u4fdd\u5b58)|\b(?:save)\b/iu.test(primaryText);
  const documentName = String(receipt.documentName).trim();
  const windowTitle = String(receipt.windowTitle).trim();
  const processId = Number(receipt.processId);
  const lines = zh
    ? [
        requestedText
          ? CN_RESULT_GROUNDING_MESSAGES.wpsExactTextWritten(documentName, requestedText)
          : CN_RESULT_GROUNDING_MESSAGES.wpsBlankDocumentCreated(documentName),
        CN_RESULT_GROUNDING_MESSAGES.wpsWindow(windowTitle),
        CN_RESULT_GROUNDING_MESSAGES.wpsProcess(processId),
        CN_RESULT_GROUNDING_MESSAGES.wpsUnsaved,
      ]
    : [
        requestedText
          ? `Created visible WPS document "${documentName}" and wrote the exact requested text: ${requestedText}`
          : `Created visible blank WPS document "${documentName}".`,
        `Window: ${windowTitle}`,
        `Process: wps.exe (PID ${processId})`,
        'The document is currently unsaved.',
      ];
  return {
    text: lines.join('\n'),
    blocked: userRequestedSave,
    reason: userRequestedSave
      ? 'WPS document creation and exact text entry were verified, but the requested save action was not completed.'
      : requestedText
        ? 'Grounded WPS document creation and exact text entry from a verified KWPS.Application receipt.'
        : 'Grounded blank WPS document creation from a verified KWPS.Application receipt.',
    notification: userRequestedSave
      ? {
          type: 'work_product_guard',
          level: 'warning',
          message: 'The WPS document was created and populated, but it is not saved.',
        }
      : undefined,
  };
}

export function formatGroundedCadRunResult(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  if (taskActionContract(input).kind !== 'cad_drafting') return null;
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    !item.error
    && /^(?:mcp_cad-drafting_autocad_playback_file|cad_draw_floorplan_in_autocad)$/i.test(String(item.name || ''))
    && String(item.result || '').trim()
  ));
  if (!record) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(String(record.result || ''));
  } catch {
    return null;
  }

  const actionText = resultTaskText(input);
  const zh = isChineseText(actionText);
  const markerPath = String(parsed?.completionMarkerPath || '').trim();
  const operationsPath = String(parsed?.operationsPath || parsed?.manifest?.operationsPath || '').trim();
  const executable = String(parsed?.autocadExecutable || parsed?.manifest?.autocadExecutable || '').trim();
  const executableSource = String(parsed?.autocadExecutableSource || parsed?.manifest?.autocadExecutableSource || '').trim();
  const operationCount = Number(parsed?.operationCount || parsed?.manifest?.operationCount || 0);
  const strokeDelayMs = Number(parsed?.strokeDelayMs || parsed?.manifest?.strokeDelayMs || 0);
  const expectedEntityCount = Number(parsed?.expectedEntityCount || 0);
  const entitiesAdded = Number(parsed?.entitiesAdded || 0);
  const completed = parsed?.status === 'completed'
    && parsed?.completionMarkerExists === true
    && parsed?.transport === 'mcp_autocad_com'
    && parsed?.visiblePlayback === true
    && parsed?.geometryVerified === true
    && parsed?.entityCountMatches === true
    && operationCount > 0
    && operationCount === expectedEntityCount
    && entitiesAdded === expectedEntityCount
    && Boolean(String(parsed?.operationSetId || '').trim());

  if (completed) {
    const lines = zh
      ? [
          CN_CAD_MESSAGES.playbackCompleted,
          markerPath ? `完成标记：${markerPath}` : '',
          operationsPath ? `${CN_CAD_MESSAGES.drawingOperations}${operationsPath}` : '',
          executable ? `AutoCAD：${executable}${executableSource ? `（来源：${executableSource}）` : ''}` : '',
          operationCount > 0 ? `已执行 ${operationCount} 个绘图操作。` : '',
          parsed?.geometryVerified === true && parsed?.geometryVerificationRequired === true && Boolean(String(parsed?.geometryReceiptPath || '').trim())
            ? CN_CAD_MESSAGES.sourceGeometryVerified
            : '',
          parsed?.entityCountMatches === true ? `${CN_CAD_MESSAGES.entityDeltaVerification}${entitiesAdded}/${expectedEntityCount}\u3002` : '',
        ]
      : [
          'The visible stroke-by-stroke playback completed in the real AutoCAD application through Lumi CAD MCP/COM and passed marker verification.',
          markerPath ? `Completion marker: ${markerPath}` : '',
          operationsPath ? `Drawing operations: ${operationsPath}` : '',
          executable ? `AutoCAD: ${executable}${executableSource ? ` (source: ${executableSource})` : ''}` : '',
          operationCount > 0 ? `${operationCount} drawing operations completed.` : '',
          strokeDelayMs > 0 ? `Visible stroke interval: ${strokeDelayMs} ms.` : '',
          parsed?.geometryVerified === true && parsed?.geometryVerificationRequired === true && Boolean(String(parsed?.geometryReceiptPath || '').trim())
            ? 'Source geometry verification: passed.'
            : '',
          parsed?.entityCountMatches === true ? `Entity delta verification: ${entitiesAdded}/${expectedEntityCount}.` : '',
        ];
    return {
      text: lines.filter(Boolean).join('\n'),
      blocked: false,
      reason: 'Grounded AutoCAD MCP/COM visible-playback summary from the CAD completion marker.',
    };
  }

  if (!requiresVisibleAutoCadExecution(actionText)) return null;
  const blocker = String(parsed?.blocker || parsed?.note || (
    parsed?.geometryVerified !== true
      ? 'AutoCAD geometry did not pass source verification.'
      : parsed?.entityCountMatches !== true
        ? 'AutoCAD entity-count verification did not pass.'
        : 'AutoCAD completion marker was not observed.'
  )).trim();
  const text = zh
    ? [
        '这次 AutoCAD 实际绘图还没有完成。',
        `阻塞点：${blocker}`,
        markerPath ? `待验收标记：${markerPath}` : '',
      ].filter(Boolean).join('\n')
    : [
        'The real AutoCAD drawing run is not complete yet.',
        `Blocker: ${blocker}`,
        markerPath ? `Expected completion marker: ${markerPath}` : '',
      ].filter(Boolean).join('\n');
  return {
    text,
    blocked: true,
    reason: blocker,
    notification: {
      type: 'work_product_guard',
      level: 'warning',
      message: blocker,
    },
  };
}

export function formatGroundedBlankAutoCadDocumentResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  if (taskActionContract(input).kind !== 'cad_document') return null;
  if (!hasBlankAutoCadDocumentEvidence(input.toolRecords || [])) return null;
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    !item.error
    && /^mcp_cad-drafting_autocad_new_document$/i.test(String(item.name || ''))
    && String(item.result || '').trim()
  ));
  if (!record) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(String(record.result || ''));
  } catch {
    return null;
  }
  const document = String(parsed?.document || '').trim();
  const entityCount = Number(parsed?.entityCount);
  const zh = isChineseText(resultTaskText(input));
  return {
    text: zh
      ? CN_CAD_MESSAGES.blankDocumentCreated(document, entityCount)
      : `Created and focused the blank drawing ${document} in the real AutoCAD application; it currently contains ${entityCount} entities.`,
    blocked: false,
    reason: 'Grounded blank AutoCAD document result from a verified MCP/COM receipt.',
  };
}

export function formatExternalAiHistoryResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    !item.error
    && /^external_ai_history_(?:source_register|source_list|source_revoke|sync|status|query)$/i.test(String(item.name || ''))
    && String(item.result || '').trim()
  ));
  if (!record) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(String(record.result || ''));
  } catch {
    return null;
  }
  const zh = isChineseText(resultTaskText(input));
  const sourceId = String(parsed?.sourceId || parsed?.source?.id || '').trim();
  const targetId = String(parsed?.targetId || parsed?.source?.targetId || 'unknown').trim();
  const status = String(parsed?.status || 'unknown').trim();

  if (record.name === 'external_ai_history_sync') {
    const jobId = String(parsed?.jobId || '').trim();
    if (!sourceId || !jobId || parsed?.verified !== true) return null;
    const counts = parsed?.counts || {};
    const completeness = String(parsed?.completeness || 'unknown');
    const nextCursor = String(parsed?.nextCursor || '');
    const limitations = Array.isArray(parsed?.limitations)
      ? parsed.limitations.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : [];
    const detail = String(parsed?.error || parsed?.blocker || '').trim();
    const lines = zh
      ? [
          CN_EXTERNAL_AI_MESSAGES.historySyncStatus(targetId, status, String(parsed?.sourceKind || 'unknown'), jobId),
          CN_EXTERNAL_AI_MESSAGES.historyCounts(
            Number(counts.inserted || 0), Number(counts.updated || 0), Number(counts.skipped || 0),
            Number(counts.conflicted || 0), Number(counts.attachments || 0), Number(parsed?.pageCount || 0),
          ),
          CN_EXTERNAL_AI_MESSAGES.historyCompleteness(completeness, nextCursor),
          detail ? CN_EXTERNAL_AI_MESSAGES.historyBlocker(detail) : '',
          limitations.length ? CN_EXTERNAL_AI_MESSAGES.historyLimitations(limitations.join('；')) : '',
        ]
      : [
          `External AI history sync: ${status}; target ${targetId}; source ${String(parsed?.sourceKind || 'unknown')}; job ${jobId}.`,
          `Receipt: ${Number(counts.inserted || 0)} inserted, ${Number(counts.updated || 0)} updated, ${Number(counts.skipped || 0)} deduplicated, ${Number(counts.conflicted || 0)} conflicts, ${Number(counts.attachments || 0)} attachments, ${Number(parsed?.pageCount || 0)} pages.`,
          `Completeness: ${completeness}${nextCursor ? `; resume cursor ${nextCursor}` : ''}.`,
          detail ? `Not completed: ${detail}` : '',
          limitations.length ? `Limitations: ${limitations.join('; ')}` : '',
        ];
    return {
      text: lines.filter(Boolean).join('\n'),
      blocked: ['blocked', 'failed'].includes(status),
      reason: `Grounded external AI history sync receipt: status=${status}; source=${sourceId}; job=${jobId}.`,
    };
  }

  if (record.name === 'external_ai_history_query') {
    if (parsed?.ok !== true || status !== 'queried' || !sourceId || !Array.isArray(parsed?.messages)) return null;
    const messages = parsed.messages.slice(-50);
    const completeness = String(parsed?.completeness || 'source_bounded');
    const lines = [
      zh
        ? CN_EXTERNAL_AI_MESSAGES.historyQueryHeader(targetId, messages.length, completeness)
        : `Read ${messages.length} locally synchronized message(s) from ${targetId}; completeness: ${completeness}.`,
      ...messages.map((message: any) => {
        const role = String(message?.role || 'unknown');
        const messageId = String(message?.sourceExternalMessageId || message?.externalMessageId || 'derived');
        const content = String(message?.content || '').trim().slice(0, 1_600);
        return zh
          ? CN_EXTERNAL_AI_MESSAGES.historyMessage(role, content, messageId)
          : `- ${role} (${messageId}): ${content}`;
      }),
    ];
    const limitations = Array.isArray(parsed?.limitations)
      ? parsed.limitations.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : [];
    if (limitations.length) lines.push(zh
      ? CN_EXTERNAL_AI_MESSAGES.historyLimitations(limitations.join('；'))
      : `Limitations: ${limitations.join('; ')}`);
    return {
      text: lines.join('\n'),
      blocked: false,
      reason: `Grounded external AI history query receipt: source=${sourceId}; messages=${messages.length}.`,
    };
  }

  if (record.name === 'external_ai_history_source_list') {
    if (parsed?.ok !== true || !Array.isArray(parsed?.sources)) return null;
    const lines = parsed.sources.map((source: any) => {
      const itemStatus = String(source?.status || 'unknown');
      const itemId = String(source?.id || 'unknown');
      const itemTarget = String(source?.targetId || 'unknown');
      return zh
        ? CN_EXTERNAL_AI_MESSAGES.historySourceState(itemStatus, itemId, itemTarget)
        : `External AI history source: ${itemStatus}; target ${itemTarget}; source id ${itemId}.`;
    });
    return {
      text: lines.length ? lines.join('\n') : (zh ? CN_EXTERNAL_AI_MESSAGES.historyNoSources : 'No external AI history source is authorized in this scope.'),
      blocked: false,
      reason: 'Grounded external AI history source list receipt.',
    };
  }

  if (record.name === 'external_ai_history_status') {
    if (parsed?.ok !== true || !parsed?.source) return null;
    const counts = parsed?.counts || {};
    const base = zh
      ? CN_EXTERNAL_AI_MESSAGES.historySourceState(status, sourceId, targetId)
      : `External AI history source: ${status}; target ${targetId}; source id ${sourceId}.`;
    const countLine = zh
      ? CN_EXTERNAL_AI_MESSAGES.historyLedgerCounts(
          Number(counts.conversations || 0), Number(counts.messages || 0),
          Number(counts.attachments || 0), Number(counts.jobs || 0),
        )
      : `Local ledger: ${Number(counts.conversations || 0)} conversations, ${Number(counts.messages || 0)} messages, ${Number(counts.attachments || 0)} attachments, ${Number(counts.jobs || 0)} sync jobs.`;
    return { text: `${base}\n${countLine}`, blocked: false, reason: `Grounded external AI history status receipt: source=${sourceId}.` };
  }

  if (record.name === 'external_ai_history_source_register' || record.name === 'external_ai_history_source_revoke') {
    if (parsed?.ok !== true || !sourceId) return null;
    const state = record.name.endsWith('revoke') ? 'revoked' : status;
    return {
      text: zh
        ? CN_EXTERNAL_AI_MESSAGES.historySourceState(state, sourceId, targetId)
        : `External AI history source: ${state}; target ${targetId}; source id ${sourceId}.`,
      blocked: false,
      reason: `Grounded external AI history authorization receipt: status=${state}; source=${sourceId}.`,
    };
  }
  return null;
}

export function groundedMediaGeneration(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  const mediaRequest = input.flow?.structuredMediaRequest;
  const task = resultTaskText(input);
  const languageText = mediaRequest ? input.taskText : task;
  // A generator receipt proves generation only, not a requested publication,
  // document, delivery or subsequent application action.
  // i18n-allow: Media creation versus compound external-work input recognition.
  if ((!mediaRequest && !/(?:生成|创建|制作|绘制|画).{0,90}(?:图片|图像|插画|海报|视频)|\b(?:generate|create|draw|make).{0,80}(?:image|picture|video)\b/iu.test(task))
    || /(?:发送|发给|上传|发布|打开|导出|写入|保存到|CAD|图纸|文档|PPT)|\b(?:send|upload|publish|open|export|document|save to|cad)\b/iu.test(task)) return null; // i18n-allow: Compound task boundaries.
  // i18n-allow: Requested media kind, excluding covers and document-only briefs.
  const videoRequested = mediaRequest ? ['text_to_video', 'image_to_video'].includes(mediaRequest.operation) : mediaGenerationIntent(task)?.target === 'generate_video';
  const record = [...(input.toolRecords || [])].reverse().find(item => /^(?:generate_image|get_image_generation_status|ai_edit_image|generate_video)$/u.test(item.name));
  const receipt = record && isVerifiedCurrentTurnRecord(input, record) ? buildMediaArtifactReceipt(record.name, record.arguments, toolRecordTerminalPayload(record), record.error) : null;
  if (videoRequested && !receipt?.artifacts.some(artifact => artifact.kind === 'video')) {
    const outputs = (input.toolRecords || []).filter(item => isArtifactProducerRecord(item) && isVerifiedCurrentTurnRecord(input, item))
      .map(artifactPathFromRecord).filter(file => /\.(?:docx?|pdf|txt|md|pptx?|xlsx?|png|jpe?g|webp)$/iu.test(file));
    const files = [...new Set(outputs.map(file => file.split(/[\\/]/u).at(-1)!))].slice(0, 5);
    if (files.length || receipt?.artifacts.some(artifact => artifact.kind !== 'video')) return {
      text: isChineseText(languageText) ? CN_EXECUTION_EVIDENCE_MESSAGES.videoDeliverableMismatch(files)
        : `The saved output ${files.length ? '(' + files.join(', ') + ')' : ''} is supporting material, not the requested video. Video creation is incomplete; existing files are preserved and generation will not be retried automatically.`,
      blocked: true, reason: 'media_output_type_mismatch',
    };
  }
  if (!receipt) return null;
  if (receipt.artifacts.some(artifact => artifact.kind === 'video') && requestedVideoAudio(mediaRequest?.prompt || task) && receipt.settings.hasAudio !== true) return {
    text: isChineseText(languageText) ? CN_EXECUTION_EVIDENCE_MESSAGES.videoAudioIncomplete(receipt.settings.hasAudio)
      : 'The video file was saved, but the requested audio is missing or unverified. The task is incomplete; the existing video is preserved and generation will not be retried automatically.',
    blocked: true, reason: 'media_audio_requirement_unmet',
  };
  const requestedDuration = mediaRequest?.duration ?? requestedVideoDuration(task);
  const durationMismatch = receipt.artifacts.some(artifact => artifact.kind === 'video') && requestedDuration !== undefined
    && (!Number.isFinite(receipt.settings.duration) || Math.abs(Number(receipt.settings.duration) - requestedDuration) > 0.35);
  if (receipt.settingsMatch === false || durationMismatch) return {
    text: isChineseText(languageText) ? CN_EXECUTION_EVIDENCE_MESSAGES.videoSettingsReview(receipt.settings.size, receipt.settings.duration)
      : `The video was saved, but its measured settings (${receipt.settings.size || 'unknown size'}, ${receipt.settings.duration ?? 'unknown'} seconds) do not match the request or could not be verified. Review the existing file before generating again.`,
    blocked: true, reason: 'media_settings_mismatch',
  };
  const requestedKind = videoRequested ? 'video' : 'image';
  if (receipt.artifacts.some(artifact => artifact.kind !== requestedKind)) return null;
  // i18n-allow: Multiple distinct media deliverables cannot share one receipt.
  if (/(?:图片|图像).{0,12}(?:和|以及|再|并).{0,12}视频|\b(?:image|picture).{0,12}(?:and|then).{0,12}video\b/iu.test(task)) return null;
  // i18n-allow: Explicit image counts are completion requirements.
  const countText = task.match(/(?:生成|创建|制作|画|绘制)\s*([一二两三四五六七八九十\d]+)\s*张/u)?.[1];
  const chineseCounts: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }; // i18n-allow: Number recognition.
  const requestedCount = countText ? chineseCounts[countText] || Number(countText) : 1;
  if (!Number.isSafeInteger(requestedCount) || receipt.artifacts.length < requestedCount) return null;
  const zh = isChineseText(languageText);
  const text = receipt.artifacts[0].kind === 'video'
    ? zh ? CN_EXECUTION_EVIDENCE_MESSAGES.videoGenerated(receipt.settings.hasAudio)
      : receipt.settings.hasAudio === true ? 'The video was generated; an audio track was detected.'
        : receipt.settings.hasAudio === false ? 'The video picture was generated, but the file has no audio track.' : 'The video was saved; its audio track has not been verified.'
    : zh ? CN_EXECUTION_EVIDENCE_MESSAGES.imageGenerated : 'The requested media was generated.';
  return { text, blocked: false, reason: 'Grounded verified generated-media artifact.' };
}
