import * as LegalCases from "../../../../org/legal_cases";
import { legalWrite } from "../../../../legal/execution";
import { legalTemporalOptions, legalWorkspaceId, textArg, listArg } from "./context";
import { normalizeLegalCaseStage } from "./case_workflow";
import { processNoticeLinkHandler } from "./notice_intake";
import { evaluateCurrentLawGate, formatCitationList } from "./citations";

type LegalRemoteMessagePlatform = 'feishu' | 'wechat' | 'wecom' | 'sms' | 'other';

function normalizeLegalRemoteMessagePlatform(value: string): LegalRemoteMessagePlatform {
  if (/飞书|feishu|lark/i.test(value)) return 'feishu';
  if (/企微|企业微信|wecom|wxwork/i.test(value)) return 'wecom';
  if (/微信|wechat|weixin/i.test(value)) return 'wechat';
  if (/短信|sms/i.test(value)) return 'sms';
  return 'other';
}

function legalRemoteMessagePlatformLabel(platform: LegalRemoteMessagePlatform): string {
  if (platform === 'feishu') return '飞书';
  if (platform === 'wechat') return '微信';
  if (platform === 'wecom') return '企微';
  if (platform === 'sms') return '短信';
  return '远程消息';
}

function legalRemoteMessageMaterialSource(platform: LegalRemoteMessagePlatform): LegalCases.OrgLegalCaseMaterial['source'] {
  if (platform === 'feishu' || platform === 'wecom' || platform === 'wechat') return platform;
  return 'import';
}

function extractAllUrls(input: string): string[] {
  const urls = Array.from(String(input || '').matchAll(/https?:\/\/[^\s<>"'，。；、）)\]]+/gi))
    .map(match => match[0].replace(/[。。，，；;、]+$/u, '').trim())
    .filter(Boolean);
  return Array.from(new Set(urls));
}

function listAttachmentNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, any>;
      return String(record.fileName || record.name || record.title || record.localPath || '').trim();
    }).filter(Boolean);
  }
  return String(value || '').split(/\n|,|;|；/).map(item => item.trim()).filter(Boolean);
}

function attachmentContentBlocks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (!item || typeof item !== 'object') return '';
    const record = item as Record<string, any>;
    const name = String(record.fileName || record.name || record.title || '未命名附件').trim();
    const text = String(record.extractedText || record.text || record.content || '').trim();
    const localPath = String(record.localPath || '').trim();
    const meta = [
      `## 附件：${name}`,
      localPath ? `- 本地缓存：${localPath}` : '',
      text ? '' : '- 正文：未抽取到可读文本',
      text,
    ].filter(Boolean);
    return meta.join('\n');
  }).filter(Boolean);
}

function extractSpecificCourtFromLegalMessage(message: string): string {
  const courts = Array.from(String(message || '').matchAll(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院)/g))
    .map(match => match[0])
    .filter(candidate => !['人民法院', '法院'].includes(candidate))
    .sort((a, b) => b.length - a.length);
  return courts[0] || '';
}

export async function legalMessageIntakeToCaseHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const platform = normalizeLegalRemoteMessagePlatform(
    textArg(args, 'platform') || textArg(args, 'source') || context?.source || 'other',
  );
  const sender = textArg(args, 'sender') || textArg(args, 'from') || textArg(args, 'userName') || '未标注';
  const receivedAt = textArg(args, 'receivedAt') || textArg(args, 'timestamp') || new Date().toISOString();
  const messageText = [
    textArg(args, 'message') || textArg(args, 'text') || textArg(args, 'content') || textArg(args, 'noticeText'),
    ...attachmentContentBlocks(args.attachments),
  ].filter(Boolean).join('\n\n').trim();
  const attachmentNames = Array.from(new Set([
    ...listAttachmentNames(args.attachments),
    ...listArg(args, 'fileNames'),
    ...listArg(args, 'attachmentNames'),
  ]));
  const urls = Array.from(new Set([
    ...listArg(args, 'urls'),
    textArg(args, 'url'),
    textArg(args, 'link'),
    textArg(args, 'noticeUrl'),
    ...extractAllUrls(messageText),
  ].map(item => String(item || '').trim()).filter(Boolean)));

  if (!messageText && attachmentNames.length === 0 && urls.length === 0) {
    return '请提供要入案的消息正文、附件名称或链接。';
  }

  const hints = LegalCases.extractLegalCaseHints(messageText);
  const specificCourt = extractSpecificCourtFromLegalMessage(messageText);
  if (specificCourt) hints.court = specificCourt;
  let caseFile = textArg(args, 'caseId') ? LegalCases.getCase(orgId, textArg(args, 'caseId'), userId, 'write') : null;
  const explicitCaseName = textArg(args, 'caseName') || textArg(args, 'title');
  if (!caseFile && explicitCaseName) {
    caseFile = LegalCases.listCases(orgId, explicitCaseName, 1, userId)[0] || null;
  }
  if (!caseFile && hints.caseNumber) {
    caseFile = LegalCases.listCases(orgId, hints.caseNumber, 1, userId)[0] || null;
  }

  const persistCase = args.persistCase !== false;
  const caseName = explicitCaseName || hints.caseNumber || `远程法律消息 ${new Date().toISOString().slice(0, 10)}`;
  if (!caseFile && persistCase) {
    caseFile = legalWrite(() => LegalCases.createCase(orgId, userId, {
      title: caseName,
      caseNumber: hints.caseNumber || '',
      court: hints.court || textArg(args, 'court'),
      cause: hints.cause || textArg(args, 'caseType') || textArg(args, 'cause'),
      party: textArg(args, 'parties') || textArg(args, 'party'),
      hearingDate: hints.hearingDate || '',
      stage: normalizeLegalCaseStage(textArg(args, 'stage') || (hints.hearingDate ? 'trial' : 'consultation')),
      notes: messageText.slice(0, 3000),
    }));
  } else if (caseFile) {
    const patch: Partial<LegalCases.OrgLegalCaseFile> = {};
    if (hints.caseNumber && !caseFile.caseNumber) patch.caseNumber = hints.caseNumber;
    if (hints.court && !caseFile.court) patch.court = hints.court;
    if (hints.cause && !caseFile.cause) patch.cause = hints.cause;
    if (hints.hearingDate && !caseFile.hearingDate) patch.hearingDate = hints.hearingDate;
    if (Object.keys(patch).length > 0) {
      caseFile = legalWrite(() => LegalCases.updateCase(orgId, userId, caseFile.id, patch)) || caseFile;
    }
  }

  const rawMaterialContent = [
    '# 远程法律消息原文',
    '',
    `- 平台：${legalRemoteMessagePlatformLabel(platform)}`,
    `- 发送人：${sender}`,
    `- 收取时间：${receivedAt}`,
    `- 案号：${hints.caseNumber || '未识别'}`,
    `- 法院：${hints.court || textArg(args, 'court') || '未识别'}`,
    `- 开庭/通知日期：${hints.hearingDate || '未识别'}`,
    attachmentNames.length ? `- 附件：${attachmentNames.join('；')}` : '- 附件：无',
    urls.length ? `- 识别链接：${urls.join('；')}` : '- 识别链接：无',
    '',
    '## 原始消息',
    '',
    messageText || '（无正文，仅有附件或链接线索）',
    '',
    '## 入案边界',
    '',
    '- 本材料先作为案件线索和原始沟通记录归档，事实、证据三性、来源权限和法律适用仍需律师复核。',
    '- 涉及签收、提交、缴费、撤回、和解承诺或正式对外发送的动作，不在本入案工具内自动完成。',
  ].join('\n');

  const attachmentMaterialIds: string[] = [];
  if (caseFile) {
    legalWrite(() => LegalCases.addMaterial(orgId, userId, caseFile.id, {
      type: 'consultation',
      title: `${legalRemoteMessagePlatformLabel(platform)}法律消息原文`,
      content: rawMaterialContent,
      fileName: attachmentNames.length === 1 ? attachmentNames[0] : undefined,
      source: legalRemoteMessageMaterialSource(platform),
    }));
    if (Array.isArray(args.attachments)) {
      for (const item of args.attachments) {
        if (!item || typeof item !== 'object') continue;
        const attachment = item as Record<string, any>;
        const fileName = String(attachment.fileName || attachment.name || attachment.title || '').trim();
        const localPath = String(attachment.localPath || '').trim();
        const extractedText = String(attachment.extractedText || attachment.text || attachment.content || '').trim();
        if (!fileName && !localPath && !extractedText) continue;
        const attachmentMaterial = legalWrite(() => LegalCases.addMaterial(orgId, userId, caseFile.id, {
          type: 'note',
          title: `远程附件：${fileName || '未命名附件'}`,
          content: extractedText || '附件已保存到案件空间，当前类型未抽取到可读文本。',
          fileName: fileName || undefined,
          localPath: localPath || undefined,
          source: legalRemoteMessageMaterialSource(platform),
        }));
        if (attachmentMaterial?.id) attachmentMaterialIds.push(attachmentMaterial.id);
      }
    }
    caseFile = LegalCases.getCase(orgId, caseFile.id, userId) || caseFile;
  }

  let linkLine = urls.length ? `已识别 ${urls.length} 个链接，暂未处理。` : '未识别链接。';
  const processLinks = args.processLinks !== false && urls.length > 0;
  if (urls.length > 0 && args.processLinks === false) {
    linkLine = `已识别 ${urls.length} 个链接，已按 processLinks=false 只归档不抓取。`;
  } else if (processLinks) {
    try {
      const report = await processNoticeLinkHandler({
        ...args,
        orgId,
        userId,
        caseId: caseFile?.id || textArg(args, 'caseId'),
        caseName: caseFile?.title || caseName,
        url: urls[0],
        message: messageText,
        noticeText: messageText,
        title: '远程消息链接材料',
        persistCase: !!caseFile,
        confirmedForKb: false,
        includeExtractedText: true,
        extractedTextLimit: Number(args.extractedTextLimit) || 6000,
      }, {
        ...context,
        orgId,
        userId,
        domain: 'work',
        source: `${platform}-legal-message-intake`,
      });
      if (caseFile) {
        const linkedHints = LegalCases.extractLegalCaseHints(report);
        const linkedPatch: Partial<LegalCases.OrgLegalCaseFile> = {};
        if (linkedHints.caseNumber && !caseFile.caseNumber) linkedPatch.caseNumber = linkedHints.caseNumber;
        if (linkedHints.court && !caseFile.court) linkedPatch.court = linkedHints.court;
        if (linkedHints.cause && !caseFile.cause) linkedPatch.cause = linkedHints.cause;
        if (linkedHints.hearingDate && !caseFile.hearingDate) {
          linkedPatch.hearingDate = linkedHints.hearingDate;
          if (caseFile.stage === 'consultation') linkedPatch.stage = 'trial';
        }
        if (Object.keys(linkedPatch).length > 0) {
          caseFile = legalWrite(() => LegalCases.updateCase(orgId, userId, caseFile.id, linkedPatch)) || caseFile;
        }
      }
      if (/授权网页登录协作|登录|验证码|人脸|短信验证|访问受限|平台限制/.test(report)) {
        linkLine = '链接已登记；目标页面需要授权浏览器登录、验证码、人脸或短信验证，已转为人工协作下一步。';
      } else if (/已下载材料|已直接读取|保存留痕|留痕报告/.test(report)) {
        linkLine = '链接已读取/下载并保存留痕，处理报告已归档到案件空间。';
      } else {
        linkLine = '链接已调用处理工具，结果已记录；请查看案件材料中的链接处理报告。';
      }
      if (caseFile) caseFile = LegalCases.getCase(orgId, caseFile.id, userId) || caseFile;
    } catch (err: any) {
      linkLine = `链接处理未完成：${err?.message || String(err)}`;
    }
  }

  const gate = evaluateCurrentLawGate(rawMaterialContent, orgId, [], textArg(args, 'factDate'), { ...legalTemporalOptions(args), actorUserId: context?.userId });
  const workflow = caseFile
    ? LegalCases.evaluateCaseWorkflow(caseFile, {
        currentLawGate: gate.statuteChecks.length === 0 ? 'none' : gate.passed ? 'passed' : 'blocked',
        currentLawBlockingSummary: gate.blockingStatutes.length
          ? formatCitationList(gate.blockingStatutes).join('；')
          : '',
      })
    : null;
  const next = workflow?.nextStep
    ? `${workflow.nextStep.label}：${workflow.nextStep.nextStep}`
    : caseFile
      ? '案件基础材料已归档，后续进入持续复核。'
      : '未归档到案件空间；选择目标案件后再继续。';

  return [
    '# 远程法律消息已入案',
    '',
    `- 平台：${legalRemoteMessagePlatformLabel(platform)}`,
    `- 发送人：${sender}`,
    `- 案件：${caseFile?.title || caseName}`,
    `- 案号：${caseFile?.caseNumber || hints.caseNumber || '未识别'}`,
    `- 法院：${caseFile?.court || hints.court || textArg(args, 'court') || '未识别'}`,
    `- 开庭/通知日期：${caseFile?.hearingDate || hints.hearingDate || '未识别'}`,
    `- 案件现有材料：${caseFile ? `共 ${caseFile.materials.length} 份` : '尚未入案'}`,
    `- 附件材料：${attachmentMaterialIds.length > 0 ? `已独立归档 ${attachmentMaterialIds.length} 份` : (attachmentNames.length > 0 ? '未形成独立附件材料' : '无')}`,
    `- 附件/文件：${attachmentNames.length ? attachmentNames.join('；') : '无'}`,
    `- 链接处理：${linkLine}`,
    workflow ? `- 案件闭环状态：${workflow.doneCount}/${workflow.steps.length}（${workflow.completionRatio}%），阻断 ${workflow.blockedCount}，待补 ${workflow.missingCount}` : '- 案件闭环状态：未评估',
    `- 下一动作：${next}`,
    '',
    '## 边界',
    '- 这一步完成的是远程消息入案、来源留痕和下一步判断，不等同于正式法律意见或对外提交。',
    '- 如消息中包含法院平台、法蝉、Alpha、企查查等需登录来源，Lumi 只使用授权账号和可见浏览器协作，不绕过验证码、权限、付费墙或平台风控。',
  ].join('\n');
}
