import * as LegalCases from "../../../../org/legal_cases";
import { legalWrite } from "../../../../legal/execution";
import path from "path";
import fs from "fs";
import { textArg, legalWorkspaceId, resolveWritableOutputDir, ensureLegalDeliveryRoot } from "./context";
import { normalizeLegalCaseStage } from "./case_workflow";
import { buildLegalWorkProductPreflightSection } from "./citations";

function meetingSignalBullets(text: string, keywords: RegExp, fallback: string): string[] {
  const lines = String(text || '')
    .split(/\r?\n|[。！？；;]+/)
    .map(line => line.trim())
    .filter(line => line.length >= 6);
  const picked = lines.filter(line => keywords.test(line)).slice(0, 10);
  const source = picked.length ? picked : lines.slice(0, 8);
  return source.length ? source.map(line => `- ${line.slice(0, 180)}`) : [`- ${fallback}`];
}

function buildLegalMeetingMinutesMarkdown(args: Record<string, any>): string {
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const transcript = textArg(args, 'transcript') || textArg(args, 'meetingText') || textArg(args, 'notes');
  const participants = textArg(args, 'participants') || '待补充';
  const meetingTime = textArg(args, 'meetingTime') || new Date().toISOString();
  const objective = textArg(args, 'objective') || textArg(args, 'claims') || '待律师确认';
  const factSignals = meetingSignalBullets(transcript, /合同|付款|交付|质量|借款|工资|解除|侵权|损失|时间|经过|事实|争议|claim|fact/i, '待从会议记录中补充事实线索');
  const evidenceSignals = meetingSignalBullets(transcript, /证据|合同|发票|流水|转账|聊天|微信|短信|邮件|录音|照片|签收|送货|检测|鉴定|原件|evidence|document/i, '待从会议记录中补充证据线索');
  const issueSignals = meetingSignalBullets(transcript, /争议|焦点|对方|抗辩|质证|管辖|时效|责任|违约|赔偿|风险|issue|risk/i, '待从会议记录中提炼争议焦点');
  const deadlineSignals = meetingSignalBullets(transcript, /开庭|举证|答辩|上诉|立案|提交|缴费|送达|截止|期限|日期|deadline|hearing|file/i, '暂未识别明确期限，需人工确认');

  return `# ${caseName} 法律会议纪要

- 会议时间：${meetingTime}
- 参会/沟通人员：${participants}
- 办理目标：${objective}
- 生成时间：${new Date().toISOString()}
- 状态：律师复核稿；不得直接作为最终法律意见、承诺或对外提交文本。

## 一、沟通要点
${meetingSignalBullets(transcript, /./, '待补充会议沟通内容').join('\n')}

## 二、案件事实线索
${factSignals.join('\n')}

## 三、证据线索与三性提示
${evidenceSignals.join('\n')}

| 核验项 | 会议后处理 |
| --- | --- |
| 真实性 | 核对原件、形成时间、签章、电子数据原始载体、聊天/邮件导出方式 |
| 合法性 | 核对取得方式、授权来源、隐私边界、平台规则和证据提交限制 |
| 关联性 | 对应争议焦点、待证事实、证明目的和证明力大小 |

## 四、争议焦点/风险线索
${issueSignals.join('\n')}

## 五、期限和待办
${deadlineSignals.join('\n')}

## 六、建议下一步
1. 使用 legal_case_workspace 更新案件空间。
2. 使用 legal_extract_dispute_focus 提炼争议焦点。
3. 使用 legal_generate_litigation_packet 生成原告/被告诉讼文书包草稿。
4. 使用 legal_external_research_plan 生成法条、类案、主体信息检索行动单。
5. 正式交付前使用 legal_finalize_delivery_package，并接受现行有效法律硬门槛。

## 七、原始转写/沟通记录
${transcript || '待补充'}
`;
}

function legalMeetingBulletsFromTranscript(text: string, keywords: RegExp, fallback: string): string[] {
  const lines = String(text || '')
    .split(/\r?\n|[。！？；;]+/)
    .map(line => line.trim())
    .filter(Boolean);
  const picked = lines.filter(line => keywords.test(line)).slice(0, 12);
  const source = picked.length ? picked : lines.slice(0, 8);
  return source.length ? source.map(line => `- ${line.slice(0, 220).replace(/\|/g, ' ')}`) : [`- ${fallback}`];
}

function buildLegalMeetingActionItemsMarkdown(args: Record<string, any>): string {
  const transcript = textArg(args, 'transcript') || textArg(args, 'meetingText') || textArg(args, 'notes');
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const deadlineLines = legalMeetingBulletsFromTranscript(
    transcript,
    /开庭|举证|答辩|立案|提交|缴费|送达|截止|期限|日期|deadline|hearing|file|submit/i,
    '暂未识别明确期限，需会后人工确认。',
  );
  const evidenceLines = legalMeetingBulletsFromTranscript(
    transcript,
    /证据|原件|合同|发票|流水|转账|聊天|微信|短信|邮件|照片|录音|送货|签收|鉴定|evidence|document/i,
    '待补充证据名称、来源、页码和原件状态。',
  );
  const nextLines = legalMeetingBulletsFromTranscript(
    transcript,
    /需要|确认|补充|整理|生成|起草|检索|联系|提交|下载|归档|核验|review|confirm|draft|search/i,
    '会后先生成案件工作台状态，再提炼争议焦点和证据目录。',
  );

  return [
    `# ${caseName} Meeting Action Items`,
    '',
    '## Deadlines / Time Points',
    ...deadlineLines,
    '',
    '## Evidence To Collect',
    ...evidenceLines,
    '',
    '## Ownerless Next Actions',
    ...nextLines,
    '',
    '## Next Legal Workflow',
    '| Step | Tool | Purpose |',
    '| --- | --- | --- |',
    '| 1 | legal_case_workspace | Update case state, missing fields, and next action. |',
    '| 2 | legal_extract_dispute_focus | Extract issues, facts to prove, and cross-examination points. |',
    '| 3 | legal_case_reasoning_matrix | Build the internal major/minor/conclusion reasoning base. |',
    '| 4 | legal_generate_litigation_packet / legal_generate_argument_or_opinion | Draft lawyer-reviewed work products. |',
    '| 5 | legal_generate_citation_verification_report / legal_finalize_delivery_package | Run current-law and delivery gates before formal use. |',
  ].join('\n');
}

function buildLegalMeetingCaseUpdateMarkdown(args: Record<string, any>): string {
  const transcript = textArg(args, 'transcript') || textArg(args, 'meetingText') || textArg(args, 'notes');
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const participants = textArg(args, 'participants') || '待补充';
  const objective = textArg(args, 'objective') || textArg(args, 'claims') || '待律师确认';
  const facts = legalMeetingBulletsFromTranscript(
    transcript,
    /事实|经过|合同|履行|付款|交付|质量|解除|侵权|损失|争议|claim|fact/i,
    '待从会议记录补充案件事实。',
  );
  const issues = legalMeetingBulletsFromTranscript(
    transcript,
    /争议|焦点|对方|抗辩|质证|管辖|时效|责任|违约|赔偿|风险|issue|risk/i,
    '待从会议记录提炼争议焦点。',
  );
  const evidence = legalMeetingBulletsFromTranscript(
    transcript,
    /证据|合同|发票|流水|转账|聊天|微信|短信|邮件|录音|照片|签收|送货|document|evidence/i,
    '待从会议记录整理证据线索。',
  );

  return [
    `# ${caseName} Case Intake Update`,
    '',
    `- Participants: ${participants}`,
    `- Objective: ${objective}`,
    `- Generated at: ${new Date().toISOString()}`,
    '',
    '## Fact Timeline Seeds',
    ...facts,
    '',
    '## Dispute Focus Seeds',
    ...issues,
    '',
    '## Evidence Seeds',
    ...evidence,
    '',
    '## Case Workspace Fields To Recheck',
    '- Party identity / authorization / service address',
    '- Court / jurisdiction / cause of action',
    '- Claims, amount calculation, limitation period, and deadlines',
    '- Evidence authenticity, legality, relevance, original carrier, and page numbers',
    '- Current effective law and similar-case source registration before formal drafting',
  ].join('\n');
}

function buildLegalMeetingLiveBriefMarkdown(args: Record<string, any>, files: {
  minutesPath: string;
  actionItemsPath: string;
  caseUpdatePath: string;
}): string {
  const transcript = textArg(args, 'transcript') || textArg(args, 'meetingText') || textArg(args, 'notes');
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const summary = legalMeetingBulletsFromTranscript(transcript, /./, '会议内容待补充。').slice(0, 6);

  return [
    `# ${caseName} Live Meeting Brief`,
    '',
    '## Live Meeting Workstream',
    '- Lumi records the meeting transcript into the case space.',
    '- Lumi keeps a rolling summary, action items, case-intake update, and formal minutes as separate files.',
    '- Meeting output is a lawyer-review draft. It is not a final legal opinion, filing submission, settlement commitment, or service confirmation.',
    '',
    '## Rolling Summary',
    ...summary,
    '',
    '## Generated Files',
    `- Formal minutes: ${files.minutesPath}`,
    `- Action items: ${files.actionItemsPath}`,
    `- Case intake update: ${files.caseUpdatePath}`,
    '',
    '## Automatic Follow-Up',
    '- Open the case action board and resolve blockers before drafting.',
    '- Generate dispute focus and reasoning matrix before litigation documents.',
    '- Run current-law and delivery gates before any formal document is marked usable.',
  ].join('\n');
}

export async function meetingMinutesToCaseHandler(args: Record<string, any>, context?: any): Promise<string> {
  const transcript = textArg(args, 'transcript') || textArg(args, 'meetingText') || textArg(args, 'notes');
  if (!transcript) return '请提供 transcript / meetingText / notes，用于生成法律会议纪要。';

  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const persist = args.persistCase !== false;
  let caseFile: LegalCases.OrgLegalCaseFile | null = null;
  if (persist) {
    const explicitCaseId = textArg(args, 'caseId');
    caseFile = explicitCaseId ? LegalCases.getCase(orgId, explicitCaseId, userId, 'write') : null;
    if (!caseFile) caseFile = LegalCases.listCases(orgId, caseName, 1, userId)[0] || null;
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
  const markdown = `${baseMarkdown}\n\n${liveBriefMarkdown}\n\n${preflightSection}`;
  legalWrite(() => fs.writeFileSync(minutesPath, markdown, 'utf-8'));
  legalWrite(() => fs.writeFileSync(actionItemsPath, actionItemsMarkdown, 'utf-8'));
  legalWrite(() => fs.writeFileSync(caseUpdatePath, caseUpdateMarkdown, 'utf-8'));
  legalWrite(() => fs.writeFileSync(liveBriefPath, liveBriefMarkdown, 'utf-8'));

  let archiveLine = '- 案件空间：未归档（persistCase=false）';
  if (persist && caseFile) {
    const material = legalWrite(() => LegalCases.addMaterial(orgId, userId, caseFile.id, {
      type: 'consultation',
      title: `${caseName}法律会议纪要`,
      content: markdown,
      localPath: minutesPath,
      source: 'meeting',
    }));
    legalWrite(() => LegalCases.addMaterial(orgId, userId, caseFile.id, {
      type: 'note',
      title: `${caseName}会议行动项与期限`,
      content: actionItemsMarkdown,
      localPath: actionItemsPath,
      source: 'meeting',
    }));
    legalWrite(() => LegalCases.addMaterial(orgId, userId, caseFile.id, {
      type: 'note',
      title: `${caseName}会议案件更新`,
      content: caseUpdateMarkdown,
      localPath: caseUpdatePath,
      source: 'meeting',
    }));
    archiveLine = material
      ? `- 案件空间：已归档 caseId=${caseFile.id} materialId=${material.id}`
      : `- 案件空间：未归档 caseId=${caseFile.id}`;
  }

  return [
    '# 法律会议纪要已生成',
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
    '- 用 legal_case_workspace 查看案件闭环状态。',
    '- 用 legal_extract_dispute_focus 提炼争议焦点。',
    '- 用 legal_generate_litigation_packet 或 legal_generate_argument_or_opinion 生成律师复核稿。',
  ].join('\n');
}
