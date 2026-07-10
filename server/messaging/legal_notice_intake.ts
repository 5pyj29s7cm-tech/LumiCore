import { toolRegistry } from '../tools/registry';
import * as LegalCases from '../org/legal_cases';
import type { IncomingMessage } from './types';

function text(value: unknown): string {
  return String(value || '').trim();
}

function extractFirstUrl(input: string): string {
  return input.match(/https?:\/\/[^\s"'<>，。；;）)】]+/i)?.[0] || '';
}

function extractSpecificCourt(input: string): string {
  const candidates = Array.from(input.matchAll(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院)/g))
    .map(match => match[0])
    .filter(candidate => !['人民法院', '法院'].includes(candidate))
    .sort((a, b) => b.length - a.length);
  return candidates[0] || '';
}

function extractCaseTarget(input: string): string {
  const patterns = [
    /(?:归档|保存|放入|放到|加入).{0,10}(?:案件|案号|卷宗)?[：:\s「《"]*([^，。；;\n」》"]{2,80})/,
    /(?:案件|案号|卷宗)[：:\s「《"]+([^，。；;\n」》"]{2,80})/,
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

export function isLegalNoticeIntakeCandidate(input: string): boolean {
  const body = text(input);
  const hasLegalSignal = /(人民法院|法院|12368|开庭|传票|送达|应诉|举证|立案|审判|诉讼|案号|民初|民终|执|裁定|判决|通知|短信|起诉|答辩|证据|律师|法律|合同纠纷|侵权|仲裁)/.test(body);
  if (extractFirstUrl(body) && hasLegalSignal) return true;
  return hasLegalSignal && /(入案|归档|保存|导入|收录|放入|放到|加入|新建|创建|发给\s*Lumi|给\s*Lumi|Lumi\s*bot)/i.test(body);
}

function findOrCreateCaseFromNotice(params: {
  orgId: string;
  userId: string;
  message: string;
}): { caseFile: LegalCases.OrgLegalCaseFile; hints: ReturnType<typeof LegalCases.extractLegalCaseHints>; rawMaterialId: string } {
  const hints = LegalCases.extractLegalCaseHints(params.message);
  const specificCourt = extractSpecificCourt(params.message);
  if (specificCourt) hints.court = specificCourt;
  const explicitTarget = extractCaseTarget(params.message);

  let caseFile: LegalCases.OrgLegalCaseFile | null = null;
  if (explicitTarget) caseFile = LegalCases.listCases(params.orgId, explicitTarget, 1)[0] || null;
  if (!caseFile && hints.caseNumber) caseFile = LegalCases.listCases(params.orgId, hints.caseNumber, 1)[0] || null;

  if (!caseFile) {
    caseFile = LegalCases.createCase(params.orgId, params.userId, {
      title: explicitTarget || hints.caseNumber || `远程法院短信通知 ${new Date().toISOString().slice(0, 10)}`,
      caseNumber: hints.caseNumber || '',
      court: hints.court || '',
      cause: hints.cause || '',
      hearingDate: hints.hearingDate || '',
      stage: hints.hearingDate ? 'trial' : 'consultation',
      notes: params.message.slice(0, 3000),
    });
  } else {
    const patch: Partial<LegalCases.OrgLegalCaseFile> = {};
    if (hints.caseNumber && !caseFile.caseNumber) patch.caseNumber = hints.caseNumber;
    if (hints.court && !caseFile.court) patch.court = hints.court;
    if (hints.cause && !caseFile.cause) patch.cause = hints.cause;
    if (hints.hearingDate && !caseFile.hearingDate) {
      patch.hearingDate = hints.hearingDate;
      if (caseFile.stage === 'consultation') patch.stage = 'trial';
    }
    if (Object.keys(patch).length > 0) {
      caseFile = LegalCases.updateCase(params.orgId, params.userId, caseFile.id, patch) || caseFile;
    }
  }

  const rawMaterial = LegalCases.addMaterial(params.orgId, params.userId, caseFile.id, {
    type: 'note',
    title: '微信/飞书转发法院短信原文',
    content: [
      '# 微信/飞书转发法院短信原文',
      '',
      `- 收取时间：${new Date().toISOString()}`,
      `- 案号：${hints.caseNumber || '未识别'}`,
      `- 法院：${hints.court || '未识别'}`,
      `- 开庭/通知日期：${hints.hearingDate || '未识别'}`,
      '',
      '## 原文',
      '',
      params.message,
    ].join('\n'),
    source: 'tool',
  });

  return { caseFile, hints, rawMaterialId: rawMaterial?.id || '' };
}

function platformLabel(platform: IncomingMessage['platform']): string {
  if (platform === 'feishu') return '飞书';
  if (platform === 'wechat') return '微信';
  if (platform === 'wecom') return '企微';
  return '远程消息';
}

function bindingPrompt(platform: IncomingMessage['platform']): string {
  const label = platformLabel(platform);
  return [
    `我识别到这是一条法院短信/通知链接或法律材料入案请求，但当前${label}账号还没有绑定 Lumi 组织工作域，所以不会自动写入案件。`,
    '',
    `请先在 Lumi 桌面端生成${label}绑定码，然后在${label}里发送：绑定 Lumi <绑定码>。`,
    '绑定后，再把短信、链接或案件材料转发给我，我会自动入案、留痕并处理链接。',
  ].join('\n');
}

export async function handleRemoteLegalNoticeIntake(msg: IncomingMessage): Promise<string | null> {
  const messageText = text(msg.text);
  if (!isLegalNoticeIntakeCandidate(messageText)) return null;

  if (!msg.boundOrgId || !msg.boundUserId) {
    return bindingPrompt(msg.platform);
  }

  if (toolRegistry.get('legal_message_intake_to_case')) {
    return await toolRegistry.execute('legal_message_intake_to_case', {
      orgId: msg.boundOrgId,
      userId: msg.boundUserId,
      platform: msg.platform,
      sender: msg.userName || msg.userId,
      message: messageText,
      attachments: msg.attachments || [],
      receivedAt: msg.timestamp,
      processLinks: true,
      persistCase: true,
    }, {
      userId: msg.boundUserId,
      orgId: msg.boundOrgId,
      domain: 'work',
      source: `${msg.platform}-legal-notice-intake`,
    });
  }

  const url = extractFirstUrl(messageText);
  if (!url) return null;
  const { caseFile, hints, rawMaterialId } = findOrCreateCaseFromNotice({
    orgId: msg.boundOrgId,
    userId: msg.boundUserId,
    message: messageText,
  });

  let report = '';
  let processError = '';
  try {
    if (!toolRegistry.get('legal_process_notice_link')) {
      throw new Error('legal_process_notice_link is not registered');
    }
    report = await toolRegistry.execute('legal_process_notice_link', {
      orgId: msg.boundOrgId,
      userId: msg.boundUserId,
      caseId: caseFile.id,
      caseName: caseFile.title,
      url,
      message: messageText,
      noticeText: messageText,
      title: '微信/飞书转发法院通知链接材料',
      persistCase: true,
      confirmedForKb: false,
      includeExtractedText: true,
      extractedTextLimit: 6000,
    }, {
      userId: msg.boundUserId,
      orgId: msg.boundOrgId,
      domain: 'work',
      source: `${msg.platform}-legal-notice-intake`,
    });
  } catch (err: any) {
    processError = err?.message || String(err);
  }

  const refreshed = LegalCases.getCase(msg.boundOrgId, caseFile.id) || caseFile;
  const browserHandoff = /授权网页登录协作|登录|验证码|人脸|短信验证/.test(report);
  const processedLine = processError
    ? `链接处理：未完成，${processError}`
    : browserHandoff
      ? '链接处理：已归档短信原文；链接需要在授权浏览器中继续登录/验证/下载。'
      : '链接处理：已读取或下载并保存留痕。';

  return [
    `已收到${platformLabel(msg.platform)}转发的法院短信链接，并写入案件。`,
    '',
    `案件：${refreshed.title}`,
    `案号：${refreshed.caseNumber || hints.caseNumber || '未识别'}`,
    `法院：${refreshed.court || hints.court || '未识别'}`,
    `开庭/通知日期：${refreshed.hearingDate || hints.hearingDate || '未识别'}`,
    `短信原文材料：${rawMaterialId || '已尝试归档'}`,
    processedLine,
    '',
    '注意：签收、确认送达、缴费、提交材料等动作仍需要律师或当事人在授权页面确认。',
  ].join('\n');
}
