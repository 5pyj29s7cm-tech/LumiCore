import { textArg } from "./context";
import { legalWorkspaceId } from "./context";
import * as LegalCases from "../../../../org/legal_cases";
import { legalWrite } from "../../../../legal/execution";
import { normalizeLegalCaseStage } from "./case_workflow";
import { resolveWritableOutputDir } from "./context";
import { ensureLegalDeliveryRoot } from "./context";
import path from "path";
import { buildLegalWorkProductPreflightSection } from "./citations";
import fs from "fs";
import { encodeToolResult } from "../../../../tools/result_envelope";

export function buildLegalMeetingMinutesMarkdown(args: Record<string, any>): string {
  const caseName = textArg(args, 'caseName') || '未命名案件';
  return [
    '# ' + caseName + ' 法律会议纪要',
    '',
    '- 会议时间：' + (textArg(args, 'meetingTime') || '未提供'),
    '- 参会/沟通人员：' + (textArg(args, 'participants') || '未提供'),
    '- 办理目标：' + (textArg(args, 'objective') || textArg(args, 'claims') || '待律师确认'),
    '- 状态：律师复核稿；不得直接作为最终法律意见、承诺或对外提交文本。',
    '',
    '## 已有会议总结',
    textArg(args, 'report') || '尚未生成总结；以下仅保留原始转写，不推断事实、行动项或期限。',
  ].join('\n');
}

export function buildLegalMeetingActionItemsMarkdown(args: Record<string, any>): string {
  return [
    '# ' + (textArg(args, 'caseName') || '未命名案件') + ' Meeting Action Items',
    '',
    textArg(args, 'report') || '尚未生成总结；行动项、责任人和期限尚待核对原始转写。',
  ].join('\n');
}

export function buildLegalMeetingCaseUpdateMarkdown(args: Record<string, any>): string {
  return textArg(args, 'materials') || textArg(args, 'transcript') || textArg(args, 'meetingText') || textArg(args, 'notes');
}

export function buildLegalMeetingLiveBriefMarkdown(args: Record<string, any>, files: {
  minutesPath: string;
  actionItemsPath: string;
  caseUpdatePath: string;
}): string {
  return [
    '# ' + (textArg(args, 'caseName') || '未命名案件') + ' Live Meeting Brief',
    '',
    textArg(args, 'report') || '尚未生成总结；原始转写已保留，需律师复核。',
    '',
    '## Generated Files',
    '- Meeting minutes: ' + files.minutesPath,
    '- Existing report and actions: ' + files.actionItemsPath,
    '- Original transcript: ' + files.caseUpdatePath,
  ].join('\n');
}

export async function meetingMinutesToCaseHandler(args: Record<string, any>, context?: any): Promise<string> {
  const transcript = buildLegalMeetingCaseUpdateMarkdown(args);
  if (!transcript) return '请提供 transcript / meetingText / notes，用于保存法律会议原始转写。';
  const hasReport = Boolean(textArg(args, 'report'));

  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const persist = args.persistCase !== false;
  let caseFile: LegalCases.OrgLegalCaseFile | null = null;
  if (persist) {
    const explicitCaseId = textArg(args, 'caseId');
    caseFile = explicitCaseId ? LegalCases.getCase(orgId, explicitCaseId, userId, 'write') : null;
    if (explicitCaseId && !caseFile) throw new Error('The requested legal case is unavailable for writing.');
    if (!explicitCaseId) caseFile = LegalCases.listCases(orgId, caseName, 1, userId)[0] || null;
    if (!caseFile) {
      caseFile = legalWrite(() => LegalCases.createCase(orgId, userId, {
        title: caseName,
        party: textArg(args, 'participants'),
        cause: textArg(args, 'caseType') || textArg(args, 'cause'),
        stage: normalizeLegalCaseStage(textArg(args, 'stage')),
        notes: transcript.slice(0, 3000),
      }));
    }
  }

  const outputDir = resolveWritableOutputDir(
    textArg(args, 'outputDir'),
    ensureLegalDeliveryRoot(orgId),
    caseName,
    'meeting_minutes',
  );
  const minutesPath = path.join(outputDir, 'legal-meeting-minutes.md');
  const actionItemsPath = path.join(outputDir, 'legal-meeting-action-items.md');
  const caseUpdatePath = path.join(outputDir, 'legal-meeting-case-update.md');
  const liveBriefPath = path.join(outputDir, 'legal-meeting-live-brief.md');
  const baseMarkdown = buildLegalMeetingMinutesMarkdown(args);
  const actionItemsMarkdown = buildLegalMeetingActionItemsMarkdown(args);
  const caseUpdateMarkdown = buildLegalMeetingCaseUpdateMarkdown(args);
  const liveBriefMarkdown = buildLegalMeetingLiveBriefMarkdown(args, {
    minutesPath,
    actionItemsPath,
    caseUpdatePath,
  });
  const preflightSection = buildLegalWorkProductPreflightSection([
    baseMarkdown,
    actionItemsMarkdown,
    caseUpdateMarkdown,
  ].join('\n\n'), args, orgId);
  const markdown = `${baseMarkdown}\n\n${preflightSection}`;
  legalWrite(() => fs.writeFileSync(minutesPath, markdown, 'utf-8'));
  legalWrite(() => fs.writeFileSync(actionItemsPath, actionItemsMarkdown, 'utf-8'));
  legalWrite(() => fs.writeFileSync(caseUpdatePath, caseUpdateMarkdown, 'utf-8'));
  legalWrite(() => fs.writeFileSync(liveBriefPath, liveBriefMarkdown, 'utf-8'));

  let archiveLine = '- 案件空间：未归档';
  let sourceMaterial: LegalCases.OrgLegalCaseMaterial | undefined | null;
  let reportMaterial: LegalCases.OrgLegalCaseMaterial | undefined | null;
  const meetingLabel = [textArg(args, 'meetingTime') || '时间未提供', textArg(args, 'meetingId')].filter(Boolean).join(' · ');
  const sourceTitle = caseName + '原始会议转写 · ' + meetingLabel;
  const reportTitle = caseName + '法律会议纪要 · ' + meetingLabel;
  if (persist && caseFile) {
    sourceMaterial = caseFile.materials.find(material => material.type === 'consultation' && material.source === 'import' && material.title === sourceTitle && material.content === transcript)
      || legalWrite(() => LegalCases.addMaterial(orgId, userId, caseFile.id, {
      type: 'consultation', title: sourceTitle, content: transcript,
      localPath: caseUpdatePath, source: 'import',
    }));
    reportMaterial = caseFile.materials.find(material => material.type === 'note' && material.source === 'tool' && material.title === reportTitle && material.content === markdown)
      || legalWrite(() => LegalCases.addMaterial(orgId, userId, caseFile.id, {
      type: 'note', title: reportTitle, content: markdown,
      localPath: minutesPath, source: 'tool',
    }));
    if (!sourceMaterial || !reportMaterial) throw new Error('The original transcript and meeting report were not both archived.');
    archiveLine = '- 案件空间：已归档至「' + caseFile.title + '」';
  }

  return encodeToolResult([
    hasReport ? '# 法律会议纪要已生成' : '# 法律会议原文已保存，尚未生成总结',
    '',
    `- 案件：${caseName}`,
    `- 输出目录：${outputDir}`,
    `- 纪要文件：${minutesPath}`,
    `- 实时摘要文件：${liveBriefPath}`,
    `- 行动项文件：${actionItemsPath}`,
    `- 案件更新文件：${caseUpdatePath}`,
    archiveLine,
    '',
    preflightSection,
    '',
    '## 下一步',
    '- 用 案件工作台 查看案件闭环状态。',
    '- 用 争议焦点分析 提炼争议焦点。',
    '- 用 诉讼文书生成 或 法律意见生成 生成律师复核稿。',
  ].join('\n'), { ok: hasReport, status: hasReport ? 'generated' : 'partial',
    archivedCaseId: persist && sourceMaterial && reportMaterial ? caseFile?.id : '',
    materialIds: sourceMaterial && reportMaterial ? { transcript: sourceMaterial.id, minutes: reportMaterial.id } : undefined,
  });
}
