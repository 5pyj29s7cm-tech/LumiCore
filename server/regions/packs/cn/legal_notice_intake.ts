import { toolRegistry } from '../../../tools/registry';
import { executeToolCallOrThrow } from '../../../tools/execution_engine';
import * as LegalCases from '../../../org/legal_cases';
import { getMember, listUserOrgs } from '../../../org/db';
import { upsertPendingReminder } from '../../../memory';
import { pushNotification } from '../../../routes/notifications';
import type { IncomingMessage } from '../../../messaging/types';
import {
  consumePendingLegalNotice,
  getPendingLegalNotice,
  savePendingLegalNotice,
  type PendingLegalNotice,
  type PendingLegalNoticeCandidate,
} from '../../../messaging/legal_notice_pending';

function executeRegisteredTool(
  name: string,
  args: Record<string, any>,
  context: Record<string, any>,
): Promise<string> {
  return executeToolCallOrThrow({
    registry: toolRegistry,
    name,
    arguments: args,
    context,
  });
}

function text(value: unknown): string {
  return String(value || '').trim();
}

function originalMessageText(value: string): string {
  const marker = '\n\n以下是用户通过';
  return value.includes(marker) ? value.slice(0, value.indexOf(marker)).trim() : value.trim();
}

function legalSignalText(message: IncomingMessage): string {
  const attachmentSignals = (message.attachments || []).flatMap(attachment => [
    attachment.fileName,
    attachment.extractedText,
  ]);
  return [originalMessageText(message.text), ...attachmentSignals].filter(Boolean).join('\n');
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
  if (explicitTarget) caseFile = LegalCases.listCases(params.orgId, explicitTarget, 1, params.userId)[0] || null;
  if (!caseFile && hints.caseNumber) caseFile = LegalCases.listCases(params.orgId, hints.caseNumber, 1, params.userId)[0] || null;

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
    `我识别到这是一条法院短信/通知链接或法律材料入案请求，但当前${label}账号还没有绑定到 Lumi，所以不会读取私人或组织案件。`,
    '',
    `请先在 Lumi 桌面端生成${label}绑定码，然后在${label}里发送：绑定 Lumi <绑定码>。`,
    '绑定后，个人微信也可以由同一个 Lumi 进入你有权限的组织：唯一匹配时直接入案，存在多个目标时只询问一次。',
  ].join('\n');
}

function normalizeCaseIdentity(value: string): string {
  return String(value || '').replace(/[（）()\s]/g, '').toLowerCase();
}

function writableOrganizations(userId: string) {
  return listUserOrgs(userId).filter(org => {
    const member = getMember(org.id, userId);
    return member?.status === 'active' && member.role !== 'viewer';
  });
}

function organizationCandidates(userId: string): PendingLegalNoticeCandidate[] {
  return writableOrganizations(userId).map(org => ({ orgId: org.id, orgName: org.name }));
}

function caseCandidates(userId: string, content: string): PendingLegalNoticeCandidate[] {
  const hints = LegalCases.extractLegalCaseHints(content);
  const explicitTarget = extractCaseTarget(content);
  const queries = Array.from(new Set([hints.caseNumber, explicitTarget].filter(Boolean) as string[]));
  if (queries.length === 0) return [];

  const candidates: PendingLegalNoticeCandidate[] = [];
  const seen = new Set<string>();
  for (const org of writableOrganizations(userId)) {
    for (const query of queries) {
      let matches = LegalCases.listCases(org.id, query, 20, userId);
      if (hints.caseNumber) {
        const normalizedCaseNumber = normalizeCaseIdentity(hints.caseNumber);
        const exact = matches.filter(item => normalizeCaseIdentity(item.caseNumber) === normalizedCaseNumber);
        if (exact.length > 0) matches = exact;
      }
      for (const caseFile of matches) {
        const key = `${org.id}:${caseFile.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          orgId: org.id,
          orgName: org.name,
          caseId: caseFile.id,
          caseTitle: caseFile.title,
          caseNumber: caseFile.caseNumber,
        });
      }
    }
  }
  return candidates;
}

function candidateLabel(candidate: PendingLegalNoticeCandidate): string {
  const caseLabel = candidate.caseTitle
    ? `${candidate.caseTitle}${candidate.caseNumber ? `（${candidate.caseNumber}）` : ''}`
    : '在该组织中新建/匹配案件';
  return `${candidate.orgName} / ${caseLabel}`;
}

function pendingPrompt(candidates: PendingLegalNoticeCandidate[], inspectionReport = ''): string {
  const inspected = /已下载材料|已直接读取|保存网页\/文本留痕|保存文件/.test(inspectionReport)
    ? '链接材料已经下载或读取并保存在个人待归档区。'
    : inspectionReport
      ? '链接已经检查；需要登录、验证码或授权的步骤已保留为人工协作。'
      : '短信原文已经保留在个人待归档区。';
  return [
    inspected,
    '目前不能唯一确定组织案件，请回复“归档到 1”或直接说案件名称/案号：',
    ...candidates.map((candidate, index) => `${index + 1}. ${candidateLabel(candidate)}`),
  ].join('\n');
}

function looksLikePendingSelection(input: string): boolean {
  return /^(?:归档|放入|放到|转入|保存到|选择|就|确认|第|案件|案号|\d)/.test(input.trim());
}

function selectPendingCandidate(pending: PendingLegalNotice, reply: string): PendingLegalNoticeCandidate | null {
  const indexMatch = reply.match(/(?:归档到|选择|第)?\s*(\d+)\s*(?:个|项|号)?/);
  if (indexMatch) {
    const selected = pending.candidates[Number(indexMatch[1]) - 1];
    if (selected) return selected;
  }

  const query = reply
    .replace(/^(?:请|就|确认|可以|好|归档|放入|放到|转入|保存到|选择)\s*/g, '')
    .replace(/^(?:案件|案号)\s*[：:]?\s*/g, '')
    .trim();
  if (query) {
    const labelMatches = pending.candidates.filter(candidate =>
      candidateLabel(candidate).toLowerCase().includes(query.toLowerCase()),
    );
    if (labelMatches.length === 1) return labelMatches[0];

    const caseMatches: PendingLegalNoticeCandidate[] = [];
    for (const candidate of pending.candidates) {
      for (const caseFile of LegalCases.listCases(candidate.orgId, query, 10, pending.userId)) {
        caseMatches.push({
          orgId: candidate.orgId,
          orgName: candidate.orgName,
          caseId: caseFile.id,
          caseTitle: caseFile.title,
          caseNumber: caseFile.caseNumber,
        });
      }
    }
    const unique = Array.from(new Map(caseMatches.map(candidate => [`${candidate.orgId}:${candidate.caseId}`, candidate])).values());
    if (unique.length === 1) return unique[0];
    if (pending.candidates.length === 1 && !pending.candidates[0].caseId) {
      return { ...pending.candidates[0], caseTitle: query };
    }
  }

  if (pending.candidates.length === 1 && /^(?:确认|可以|好|就这个|归档)$/.test(reply.trim())) {
    return pending.candidates[0];
  }
  return null;
}

function parseCaseId(report: string): string {
  const value = report.match(/案件ID：([^\n]+)/)?.[1]?.trim() || '';
  return value && !/未归档|未持久化/.test(value) ? value : '';
}

interface DeadlineSignal {
  label: string;
  value: string;
}

function extractDeadlineSignals(content: string, hearingDate = ''): DeadlineSignal[] {
  const datePattern = /(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:\s*(\d{1,2})[:：时](\d{1,2})?分?)?/g;
  const signals: DeadlineSignal[] = [];
  for (const match of content.matchAll(datePattern)) {
    const start = Math.max(0, (match.index || 0) - 45);
    const end = Math.min(content.length, (match.index || 0) + match[0].length + 45);
    const context = content.slice(start, end);
    const label = /开庭|庭审|审理/.test(context) ? '开庭'
      : /举证/.test(context) ? '举证期限'
        : /答辩/.test(context) ? '答辩期限'
          : /上诉/.test(context) ? '上诉期限'
            : /缴费|交费/.test(context) ? '缴费期限'
              : /送达|签收/.test(context) ? '送达事项'
                : '';
    if (!label) continue;
    const value = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
      + (match[4] ? ` ${match[4].padStart(2, '0')}:${(match[5] || '00').padStart(2, '0')}` : '');
    signals.push({ label, value });
  }
  if (hearingDate) signals.push({ label: '开庭', value: hearingDate });
  return Array.from(new Map(signals.map(signal => [`${signal.label}:${signal.value}`, signal])).values());
}

function reminderTime(value: string): string | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!match) return null;
  const eventTime = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] || '9'),
    Number(match[5] || '0'),
  );
  if (!Number.isFinite(eventTime.getTime()) || eventTime.getTime() <= Date.now()) return null;
  const preferred = eventTime.getTime() - 24 * 60 * 60 * 1000;
  return new Date(Math.max(preferred, Date.now() + 60_000)).toISOString();
}

function createCaseAlerts(params: {
  userId: string;
  orgId: string;
  caseFile: LegalCases.OrgLegalCaseFile;
  content: string;
}): number {
  const signals = extractDeadlineSignals(params.content, params.caseFile.hearingDate);
  let reminders = 0;
  for (const signal of signals) {
    const dueAt = reminderTime(signal.value);
    if (!dueAt) continue;
    upsertPendingReminder({
      userId: params.userId,
      content: `${params.caseFile.title}：${signal.label} ${signal.value}，请核对材料、地点和程序要求。`,
      dueAt,
      sourceInteractionId: `legal-notice:${params.orgId}:${params.caseFile.id}:${signal.label}:${signal.value}`,
      domain: 'work',
      orgId: params.orgId,
    });
    reminders++;
  }
  pushNotification(params.userId, {
    type: 'legal_notice',
    title: '法院通知已归档',
    message: `${params.caseFile.title}${params.caseFile.hearingDate ? `，开庭/通知日期 ${params.caseFile.hearingDate}` : ''}${reminders ? `，已生成 ${reminders} 条案件提醒` : ''}。`,
  });
  return reminders;
}

async function inspectPersonalNotice(msg: IncomingMessage, messageText: string): Promise<string> {
  const url = extractFirstUrl(messageText);
  if (!url || !msg.boundUserId || !toolRegistry.get('legal_process_notice_link')) return '';
  try {
    return await executeRegisteredTool('legal_process_notice_link', {
      userId: msg.boundUserId,
      url,
      message: messageText,
      noticeText: messageText,
      title: '个人微信法院通知待归档材料',
      persistCase: false,
      confirmedForKb: false,
      includeExtractedText: true,
      extractedTextLimit: 12000,
    }, {
      userId: msg.boundUserId,
      domain: 'personal',
      orgId: '',
      source: `${msg.platform}-personal-legal-notice-inspection`,
    });
  } catch (err: any) {
    return `链接检查未完成：${err?.message || String(err)}`;
  }
}

async function runOrganizationLegalIntake(
  msg: IncomingMessage,
  target: PendingLegalNoticeCandidate,
  messageText: string,
): Promise<string> {
  const userId = msg.boundUserId!;
  const member = getMember(target.orgId, userId);
  if (!member || member.status !== 'active' || member.role === 'viewer') {
    return '当前 Lumi 身份没有向该组织案件写入材料的权限。';
  }
  msg.boundOrgId = target.orgId;

  if (toolRegistry.get('legal_message_intake_to_case')) {
    const report = await executeRegisteredTool('legal_message_intake_to_case', {
      orgId: target.orgId,
      userId,
      platform: msg.platform,
      sender: msg.userName || msg.userId,
      message: messageText,
      attachments: msg.attachments || [],
      receivedAt: msg.timestamp,
      caseId: target.caseId || undefined,
      caseName: target.caseId ? undefined : target.caseTitle,
      processLinks: true,
      persistCase: true,
    }, {
      userId,
      orgId: target.orgId,
      domain: 'work',
      source: `${msg.platform}-legal-notice-intake`,
    });
    const caseId = parseCaseId(report) || target.caseId || '';
    const caseFile = caseId ? LegalCases.getCase(target.orgId, caseId, userId) : null;
    const reminderCount = caseFile
      ? createCaseAlerts({ userId, orgId: target.orgId, caseFile, content: `${messageText}\n${report}` })
      : 0;
    return `${report}\n\n- 案件提醒：${reminderCount ? `已生成/更新 ${reminderCount} 条` : '未识别到未来期限，请人工核对通知日期'}`;
  }

  const url = extractFirstUrl(messageText);
  if (!url) return '已识别法律入案请求，但当前法律消息入案工具未注册。';
  const { caseFile, hints, rawMaterialId } = findOrCreateCaseFromNotice({
    orgId: target.orgId,
    userId,
    message: messageText,
  });
  const report = await executeRegisteredTool('legal_process_notice_link', {
    orgId: target.orgId,
    userId,
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
    userId,
    orgId: target.orgId,
    domain: 'work',
    source: `${msg.platform}-legal-notice-intake`,
  });
  const refreshed = LegalCases.getCase(target.orgId, caseFile.id, userId) || caseFile;
  const reminderCount = createCaseAlerts({ userId, orgId: target.orgId, caseFile: refreshed, content: `${messageText}\n${report}` });
  return [
    `已收到${platformLabel(msg.platform)}转发的法院短信链接，并写入案件。`,
    `案件：${refreshed.title}`,
    `案号：${refreshed.caseNumber || hints.caseNumber || '未识别'}`,
    `法院：${refreshed.court || hints.court || '未识别'}`,
    `开庭/通知日期：${refreshed.hearingDate || hints.hearingDate || '未识别'}`,
    `短信原文材料：${rawMaterialId || '已尝试归档'}`,
    `案件提醒：${reminderCount ? `已生成/更新 ${reminderCount} 条` : '未识别到未来期限'}`,
  ].join('\n');
}

async function handlePersonalLegalNotice(
  msg: IncomingMessage,
  messageText: string,
  matchText: string,
): Promise<string> {
  const userId = msg.boundUserId!;
  let candidates = caseCandidates(userId, matchText);
  let inspected = '';
  if (candidates.length !== 1) {
    inspected = await inspectPersonalNotice(msg, matchText);
    candidates = caseCandidates(userId, `${matchText}\n${inspected}`);
  }

  if (candidates.length === 1) {
    return runOrganizationLegalIntake(msg, candidates[0], messageText);
  }

  if (candidates.length === 0) {
    const organizations = organizationCandidates(userId);
    const hints = LegalCases.extractLegalCaseHints(`${matchText}\n${inspected}`);
    const explicitTarget = extractCaseTarget(messageText);
    if (organizations.length === 1 && (hints.caseNumber || explicitTarget)) {
      return runOrganizationLegalIntake(msg, {
        ...organizations[0],
        caseTitle: explicitTarget || hints.caseNumber,
        caseNumber: hints.caseNumber,
      }, messageText);
    }
    candidates = organizations;
  }

  if (candidates.length === 0) {
    pushNotification(userId, {
      type: 'legal_notice',
      title: '法院通知待归档',
      message: '个人微信已收到法院通知，但当前身份没有可写入的组织案件空间。',
    });
    return '链接已经按个人待归档材料检查，但当前 Lumi 身份没有可写入的组织。请先创建或加入组织后再归档。';
  }

  savePendingLegalNotice({
    userId,
    message: msg,
    messageText,
    inspectionReport: inspected,
    candidates,
  });
  pushNotification(userId, {
    type: 'legal_notice',
    title: '法院通知等待选择案件',
    message: `已收到个人微信法院通知，等待从 ${candidates.length} 个可用目标中选择案件。`,
  });
  return pendingPrompt(candidates, inspected);
}

export async function handleRemoteLegalNoticeIntake(msg: IncomingMessage): Promise<string | null> {
  const messageText = originalMessageText(text(msg.text));
  const signalText = legalSignalText(msg);
  const hasCourtNoticeAttachment = Boolean(msg.attachments?.length)
    && /(人民法院|12368|开庭通知|传票|送达通知|应诉通知|举证通知|[（(]\d{4}[）)].{2,50}号)/.test(signalText);
  const legalCandidate = isLegalNoticeIntakeCandidate(signalText) || hasCourtNoticeAttachment;

  if (msg.boundUserId && !msg.boundOrgId && !legalCandidate) {
    const pending = getPendingLegalNotice(msg, msg.boundUserId);
    if (pending && looksLikePendingSelection(messageText)) {
      const selected = selectPendingCandidate(pending, messageText);
      if (!selected) return pendingPrompt(pending.candidates, pending.inspectionReport);
      consumePendingLegalNotice(pending.id);
      msg.text = pending.messageText;
      msg.attachments = pending.attachments;
      return runOrganizationLegalIntake(msg, selected, pending.messageText);
    }
  }

  if (!legalCandidate) return null;

  if (!msg.boundUserId) {
    return bindingPrompt(msg.platform);
  }
  if (!msg.boundOrgId) return handlePersonalLegalNotice(msg, messageText, signalText);

  return runOrganizationLegalIntake(msg, {
    orgId: msg.boundOrgId,
    orgName: writableOrganizations(msg.boundUserId).find(org => org.id === msg.boundOrgId)?.name || msg.boundOrgId,
  }, messageText);
}
