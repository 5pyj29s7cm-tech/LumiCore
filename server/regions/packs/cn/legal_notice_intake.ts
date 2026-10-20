import { getActiveConversation } from '../../../conversation/manager';
import { buildTransportNeutralConfirmationScope, getPendingConfirmation, isExplicitConfirmationReply } from '../../../tools/pending_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../../../tools/pending_confirmation_repository';
import { planPersonalOrganizationScope, requestsOrganizationScope, type PersonalOrganizationScopePlan } from '../../../messaging/personal_org_scope';
import { messagingConversationAgentId } from './remote_materials';
import type { ToolContext, ToolExecutionRecord } from '../../../tools/types';
import { toolRegistry } from '../../../tools/registry';
import { executeToolCallOrThrow, getCanonicalToolExecutionInputDigests, isCanonicalToolExecutionRecord, toolExecutionInputDigests } from '../../../tools/execution_engine';
import { createHash } from 'crypto';
import { encodeToolResult } from '../../../tools/result_envelope';
import { frozenCapabilitySnapshot } from '../../../tools/definitions/workflow/capability_snapshot';
export const REMOTE_LEGAL_INTAKE_TOOL = 'legal_message_intake_to_case';
import * as LegalCases from '../../../org/legal_cases';
import { getMember, listUserOrgs } from '../../../org/db';
import { upsertPendingReminder } from '../../../memory';
import { pushNotification } from '../../../routes/notifications';
import type { IncomingMessage } from '../../../messaging/types';
import { assertMessagingAuthorization, captureMessagingOrganization, isMessagingAuthorizationCurrent, MessagingAuthorizationRevokedError } from '../../../messaging/turn_authorization';
import {
  consumePendingLegalNotice,
  getPendingLegalNotice,
  savePendingLegalNotice,
  type PendingLegalNotice,
  type PendingLegalNoticeCandidate,
} from '../../../messaging/legal_notice_pending';

interface LegalNoticeExecutionControl extends Partial<ToolContext> {
  isCancelled?: () => boolean;
  executionSignal?: AbortSignal;
}

export interface RemoteLegalNoticeStageReceipt {
  kind: 'legal_notice_intake_stage';
  version: 1;
  scope: 'case_material_archive';
  disposition: 'archived' | 'awaiting_target' | 'no_target' | 'blocked';
  taskId?: string;
  requestId?: string;
  orgId?: string;
  pendingId?: string;
  archive?: {
    toolName: string;
    capabilityId: string;
    idempotencyKey: string;
    inputDigest: string;
    changedCaseIds: string[];
    materialSources: { caseId: string; materialId: string; sourceDigest: string }[];
  };
}

interface RemoteLegalToolResult {
  content: string;
  record?: ToolExecutionRecord;
}

function archiveStageProof(
  msg: IncomingMessage,
  control: LegalNoticeExecutionControl,
  result: RemoteLegalToolResult,
  target: PendingLegalNoticeCandidate,
): RemoteLegalNoticeStageReceipt['archive'] | undefined {
  const record = result.record;
  const receipt = record?.receipt as { ok?: unknown; persisted?: unknown; changedCaseIds?: unknown; materialSources?: unknown } | undefined;
  const digests = record && getCanonicalToolExecutionInputDigests(record);
  if (!record || !isCanonicalToolExecutionRecord(record) || !digests?.argumentsDigest
    || record.error || record.terminalVerification?.status !== 'verified' || record.envelope?.status !== 'verified_success'
    || !control.taskId || !control.requestId || record.taskId !== control.taskId || record.requestId !== control.requestId
    || record.envelope.taskId !== control.taskId || record.envelope.requestId !== control.requestId
    || record.externalMessageId !== msg.messageId || record.arguments.orgId !== target.orgId || target.orgId !== msg.boundOrgId
    || record.arguments.userId !== msg.boundUserId || record.arguments.persistCase !== true
    || record.capability?.operation !== 'create' || !record.capability.sideEffects.some(effect => effect.type === 'local_state_change')
    || !record.envelope.idempotencyKey || receipt?.ok !== true || receipt.persisted !== true
    || !Array.isArray(receipt.changedCaseIds) || !receipt.changedCaseIds.length || !Array.isArray(receipt.materialSources)) return undefined;
  const changedCaseIds = receipt.changedCaseIds.filter((id): id is string => typeof id === 'string' && Boolean(id));
  if (changedCaseIds.length !== 1 || changedCaseIds.length !== receipt.changedCaseIds.length
    || (target.caseId && (changedCaseIds[0] !== target.caseId || record.arguments.caseId !== target.caseId))) return undefined;
  const archivedCase = LegalCases.getCase(target.orgId, changedCaseIds[0], msg.boundUserId);
  if (!archivedCase || (!target.caseId && (target.caseTitle && archivedCase.title !== target.caseTitle
    || target.caseNumber && archivedCase.caseNumber !== target.caseNumber))) return undefined;
  const materialSources: NonNullable<RemoteLegalNoticeStageReceipt['archive']>['materialSources'] = [];
  for (const source of receipt.materialSources) {
    if (!source || typeof source !== 'object') return undefined;
    const material = source as { caseId?: unknown; materialId?: unknown; sourceDigest?: unknown };
    if (typeof material.caseId !== 'string' || !changedCaseIds.includes(material.caseId)
      || typeof material.materialId !== 'string' || typeof material.sourceDigest !== 'string') return undefined;
    const current = LegalCases.getCase(target.orgId, material.caseId, msg.boundUserId)?.materials.find(item => item.id === material.materialId);
    if (!current || createHash('sha256').update(JSON.stringify([
      current.source, current.title, current.content, current.fileName || '', current.localPath || '',
    ])).digest('hex') !== material.sourceDigest) return undefined;
    materialSources.push({ caseId: material.caseId, materialId: material.materialId, sourceDigest: material.sourceDigest });
  }
  if (!materialSources.length) return undefined;
  return { toolName: record.name, capabilityId: record.capability.capabilityId,
    idempotencyKey: record.envelope.idempotencyKey, inputDigest: digests.argumentsDigest, changedCaseIds, materialSources };
}

function nativeStageReply(
  msg: IncomingMessage,
  control: LegalNoticeExecutionControl,
  content: string,
  disposition: RemoteLegalNoticeStageReceipt['disposition'],
  archive?: RemoteLegalNoticeStageReceipt['archive'],
): string {
  const receipt: RemoteLegalNoticeStageReceipt = {
    kind: 'legal_notice_intake_stage', version: 1, scope: 'case_material_archive',
    disposition: disposition === 'archived' && !archive ? 'blocked' : disposition,
    taskId: control.taskId, requestId: control.requestId, orgId: msg.boundOrgId,
    pendingId: msg.legalNoticeSelection?.pendingId, ...(archive ? { archive } : {}),
  };
  return encodeToolResult(disposition === 'archived' && !archive
    ? `${content}\n\n入案工具已执行；当前案件材料核验未通过，因此未将这轮请求标为完成，且不会自动重复归档。`
    : content, receipt);
}

function assertNoticeAuthorized(msg: IncomingMessage, control: LegalNoticeExecutionControl): void {
  assertMessagingAuthorization(msg);
  if (msg.legalNoticeSelection && !currentPendingNoticeSelection(msg)) throw new MessagingAuthorizationRevokedError();
  if (control.isCancelled?.() || control.executionSignal?.aborted) throw new MessagingAuthorizationRevokedError();
}

async function executeRegisteredTool(
  msg: IncomingMessage,
  control: LegalNoticeExecutionControl,
  name: string,
  args: Record<string, any>,
  context: Record<string, any>,
): Promise<RemoteLegalToolResult> {
  assertNoticeAuthorized(msg, control);
  const binding = msg.legalNoticeSelection?.execution;
  if (binding) {
    const scope = { ...control, ...context };
    const definition = toolRegistry.get(name), manifest = toolRegistry.getCapabilityManifestEntry(name, control.toolPolicy, scope);
    const prepared = toolRegistry.prepareExecution(name, args, scope);
    if (!definition || !manifest || binding.toolName !== name || binding.capabilityId !== manifest.capabilityId
      || binding.capabilityContractHash !== frozenCapabilitySnapshot(manifest, definition.parameters).contractHash
      || binding.argumentsDigest !== toolExecutionInputDigests(prepared.arguments).argumentsDigest
      || binding.targetIdentity !== noticeTargetIdentity(msg.legalNoticeSelection!.target)) throw new MessagingAuthorizationRevokedError();
  }
  let record: ToolExecutionRecord | undefined;
  let expectedInputDigest = '';
  const result = await executeToolCallOrThrow({
    registry: toolRegistry,
    name,
    arguments: args,
    context: {
      ...control,
      ...context,
      onAdapterStart: control.onAdapterStart ? async event => {
        assertNoticeAuthorized(msg, control);
        await control.onAdapterStart!(event);
        assertNoticeAuthorized(msg, control);
      } : undefined,
      onToolStart: current => {
        if (!expectedInputDigest && current.name === name) expectedInputDigest = toolExecutionInputDigests(current.arguments).argumentsDigest;
        control.onToolStart?.(current);
      },
      onToolRecord: current => {
        if (current.name === name && getCanonicalToolExecutionInputDigests(current)?.argumentsDigest === expectedInputDigest) record = current;
        control.onToolRecord?.(current);
      },
      onAdapterSettlement: control.onAdapterSettlement,
      executionSignal: control.executionSignal,
      isCancelled: () => Boolean(control.isCancelled?.() || control.executionSignal?.aborted || !isMessagingAuthorizationCurrent(msg)),
    },
  });
  assertNoticeAuthorized(msg, control);
  return { content: result, record };
}

function text(value: unknown): string {
  return String(value || '').trim();
}

function originalMessageText(value: string): string {
  const markers = [
    '\n以下是用户通过',
    '\nThe following materials were sent earlier',
  ];
  const markerIndex = markers
    .map(marker => value.indexOf(marker))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0];
  return markerIndex === undefined ? value.trim() : value.slice(0, markerIndex).trim();
}

function currentUserRequestText(message: IncomingMessage): string {
  const request = originalMessageText(text(message.text));
  const attachmentLabels = new Set((message.attachments || []).flatMap(attachment => {
    const name = text(attachment.fileName);
    return name ? [`[附件] ${name}`, `[Attachment] ${name}`] : [];
  }));
  const requestLines = request.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return attachmentLabels.size > 0
    && requestLines.length > 0
    && requestLines.every(line => attachmentLabels.has(line))
    ? ''
    : request;
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

export type RemoteLegalNoticeIntakeIntent = 'none' | 'archive_existing' | 'create_case';

export function classifyRemoteLegalNoticeIntakeIntent(input: string): RemoteLegalNoticeIntakeIntent {
  const request = text(input);
  if (!request) return 'none';
  const affirmative = request
    .replace(/(?:不要|别|无需|不用|不需要|请勿|禁止)[^，。；;！？!?\n]{0,12}?(?:建案|入案|归档|保存|导入|收录|放入|放到|加入|新建|创建)/gu, ' ')
    .replace(/\b(?:do\s+not|don't|never|without)\b[^\n.!?;]{0,20}?\b(?:file|archive|save|import|add|create|start)\b/giu, ' ');
  const explicitlyCreatesCase = /(?:建案|入案|(?:新建|创建|建立|建)(?:一个|一份|该|这个)?(?:案件|案卷|卷宗)|(?:案件|案卷|卷宗).{0,8}(?:新建|创建|建立)|\b(?:create|start)\s+(?:a\s+)?new\s+case\b)/iu.test(affirmative);
  if (explicitlyCreatesCase) return 'create_case';
  const explicitlyArchives = /(?:归档)|(?:(?:保存|导入|收录|放入|放到|加入).{0,18}(?:案件|案号|案卷|卷宗|案件库))|(?:(?:案件|案号|案卷|卷宗|案件库).{0,18}(?:保存|导入|收录|放入|放到|加入))|\b(?:file|archive|save|import|add)\b.{0,30}\b(?:to|into|in)\b.{0,12}\b(?:existing|current|specified)?\s*case\b/iu.test(affirmative);
  return explicitlyArchives ? 'archive_existing' : 'none';
}

export function isExplicitLegalNoticeIntakeRequest(input: string): boolean {
  return classifyRemoteLegalNoticeIntakeIntent(input) !== 'none';
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
  const indexMatch = reply.match(/^\s*(?:归档到|选择|第)?\s*(\d+)\s*(?:个|项|号)?\s*$/);
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
      [candidateLabel(candidate), candidate.caseTitle, candidate.caseNumber, candidate.orgName]
        .some(value => value?.toLowerCase() === query.toLowerCase()),
    );
    if (labelMatches.length === 1) return labelMatches[0];

    const caseMatches: PendingLegalNoticeCandidate[] = [];
    for (const candidate of pending.candidates) {
      for (const caseFile of LegalCases.listCases(candidate.orgId, query, 10, pending.userId)) {
        if (![caseFile.title, caseFile.caseNumber].some(value => value?.toLowerCase() === query.toLowerCase())) continue;
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
  }

  if (pending.candidates.length === 1 && /^(?:确认|可以|好|就这个|归档)$/.test(reply.trim())) {
    return pending.candidates[0];
  }
  return null;
}

function noticeTargetIdentity(target: PendingLegalNoticeCandidate): string {
  return JSON.stringify([target.orgId, target.caseId || '', target.caseTitle || '', target.caseNumber || '']);
}

function currentPendingNoticeSelection(msg: IncomingMessage): PendingLegalNotice | null {
  const selected = msg.legalNoticeSelection;
  if (!selected || !msg.boundUserId || selected.selectionText !== currentUserRequestText(msg)
    || selected.target.orgId !== msg.boundOrgId) return null;
  const pending = getPendingLegalNotice(msg, msg.boundUserId);
  if (!pending || pending.id !== selected.pendingId || pending.messageText !== selected.requestText) return null;
  const target = selectPendingCandidate(pending, selected.selectionText);
  if (!target || noticeTargetIdentity(target) !== noticeTargetIdentity(selected.target)) return null;
  const member = getMember(target.orgId, msg.boundUserId);
  if (member?.status !== 'active' || member.role === 'viewer') return null;
  if (target.caseId) {
    const caseFile = LegalCases.getCase(target.orgId, target.caseId, msg.boundUserId);
    if (!caseFile || caseFile.title !== target.caseTitle || (caseFile.caseNumber || '') !== (target.caseNumber || '')) return null;
  }
  return pending;
}

/** Reuse the existing pending choice and scope plan before transcript/task admission. */
export async function planRemoteOrganizationScope(input: IncomingMessage): Promise<PersonalOrganizationScopePlan> {
  const { legalNoticeSelection: _untrustedSelection, ...message } = input;
  const request = currentUserRequestText(message);
  const ordinary = () => planPersonalOrganizationScope(message, requestsOrganizationScope(request), undefined, isRequestedLegalNoticeIntake(message));
  if (!message.boundUserId || message.boundOrgId) return ordinary();
  assertMessagingAuthorization(message);
  const pending = getPendingLegalNotice(message, message.boundUserId);
  if (!pending || !looksLikePendingSelection(request) || isRequestedLegalNoticeIntake(message)) return ordinary();
  if (isExplicitConfirmationReply(request)) {
    await ensurePendingConfirmationPersistenceInitialized();
    const conversation = getActiveConversation(message.boundUserId, messagingConversationAgentId(message), 'personal', '');
    if (conversation) {
      const scope = buildTransportNeutralConfirmationScope({ domain: 'personal', orgId: '', conversationId: conversation.id });
      const taskId = conversation.actionContinuationState?.taskId;
      if (getPendingConfirmation(message.boundUserId, { ...scope, ...(taskId ? { taskId } : {}) })
        || getPendingConfirmation(message.boundUserId, scope)) return ordinary();
    }
  }
  const target = selectPendingCandidate(pending, request);
  if (!target) return { resolution: { kind: 'reply', message, reply: pendingPrompt(pending.candidates, pending.inspectionReport) }, commit: () => undefined };
  const scope = { userId: message.boundUserId, domain: 'work' as const, orgId: target.orgId };
  const definition = toolRegistry.get(REMOTE_LEGAL_INTAKE_TOOL);
  const manifest = toolRegistry.getCapabilityManifestEntry(REMOTE_LEGAL_INTAKE_TOOL, undefined, scope);
  const execution = definition && manifest ? Object.freeze({
    toolName: REMOTE_LEGAL_INTAKE_TOOL, capabilityId: manifest.capabilityId,
    capabilityContractHash: frozenCapabilitySnapshot(manifest, definition.parameters).contractHash,
    argumentsDigest: toolExecutionInputDigests(toolRegistry.prepareExecution(REMOTE_LEGAL_INTAKE_TOOL,
      legalIntakeArguments({ ...message, attachments: pending.attachments }, target, pending.messageText), scope).arguments).argumentsDigest,
    sourceId: pending.id, selectionText: request, targetIdentity: noticeTargetIdentity(target), scope,
  }) : undefined;
  const selected: IncomingMessage = { ...message, legalNoticeSelection: Object.freeze({
    pendingId: pending.id, selectionText: request, requestText: pending.messageText, target: Object.freeze({ ...target }), execution,
    attachments: Object.freeze(pending.attachments.map(attachment => Object.freeze({
      id: String(attachment.id || ''), type: attachment.type, fileName: String(attachment.fileName || ''),
      ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
      extractedText: String(attachment.extractedText || Reflect.get(attachment, 'text') || Reflect.get(attachment, 'content') || ''),
    }))),
  }) };
  if (!currentPendingNoticeSelection({ ...selected, boundOrgId: target.orgId })) return {
    resolution: { kind: 'reply', message, reply: '所选组织权限已变化，本轮没有归档。请重新选择可访问的组织案件。' }, // i18n-allow: reuse existing pending-scope refusal.
    commit: () => undefined,
  };
  return planPersonalOrganizationScope(selected, false, target.orgId);
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

async function inspectPersonalNotice(msg: IncomingMessage, messageText: string, control: LegalNoticeExecutionControl): Promise<string> {
  const url = extractFirstUrl(messageText);
  if (!url || !msg.boundUserId || !toolRegistry.get('legal_process_notice_link')) return '';
  try {
    return (await executeRegisteredTool(msg, control, 'legal_process_notice_link', {
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
    })).content;
  } catch (err: any) {
    assertNoticeAuthorized(msg, control);
    return `链接检查未完成：${err?.message || String(err)}`;
  }
}

function legalIntakeArguments(msg: IncomingMessage, target: PendingLegalNoticeCandidate, messageText: string) {
  return {
    orgId: target.orgId, userId: msg.boundUserId!, platform: msg.platform,
    sender: msg.userName || msg.userId, message: messageText, attachments: msg.attachments || [],
    receivedAt: msg.timestamp, caseId: target.caseId || undefined,
    caseName: target.caseId ? undefined : target.caseTitle, processLinks: true, persistCase: true,
  };
}

async function runOrganizationLegalIntake(
  msg: IncomingMessage,
  target: PendingLegalNoticeCandidate,
  messageText: string,
  control: LegalNoticeExecutionControl,
): Promise<string> {
  assertNoticeAuthorized(msg, control);
  const userId = msg.boundUserId!;
  const member = getMember(target.orgId, userId);
  if (!member || member.status !== 'active' || member.role === 'viewer') {
    return nativeStageReply(msg, control, '当前 Lumi 身份没有向该组织案件写入材料的权限。', 'blocked');
  }
  if (msg.boundOrgId !== target.orgId) throw new MessagingAuthorizationRevokedError();
  if (!toolRegistry.get(REMOTE_LEGAL_INTAKE_TOOL)) {
    return nativeStageReply(msg, control, '当前法律消息入案工具未注册，本轮没有归档，也没有创建案件。请恢复该工具后再选择入案。', 'blocked');
  }

  assertNoticeAuthorized(msg, control);
  let resolvedTarget = target;
  const intakeIntent = classifyRemoteLegalNoticeIntakeIntent(messageText);
  if (!resolvedTarget.caseId && intakeIntent !== 'create_case') {
    const matches = caseCandidates(userId, legalSignalText({ ...msg, text: messageText }))
      .filter(candidate => candidate.orgId === target.orgId && candidate.caseId);
    if (matches.length === 1) {
      resolvedTarget = matches[0];
    } else if (matches.length > 1) {
      return nativeStageReply(msg, control, [
        '找到多个可能的已有案件，本轮没有归档，也没有创建新案件。请明确回复案件名称或案号：',
        ...matches.slice(0, 8).map((candidate, index) => `${index + 1}. ${candidateLabel(candidate)}`),
      ].join('\n'), 'awaiting_target');
    } else {
      return nativeStageReply(msg, control, '没有找到可唯一匹配的已有案件，本轮没有归档，也没有创建新案件。请提供已有案件名称/案号，或明确说“新建案件并归档”。', 'no_target');
    }
  }

  {
    const execution = await executeRegisteredTool(msg, control, REMOTE_LEGAL_INTAKE_TOOL, legalIntakeArguments(msg, resolvedTarget, messageText), {
      userId,
      orgId: resolvedTarget.orgId,
      domain: 'work',
      source: `${msg.platform}-legal-notice-intake`,
    });
    const report = execution.content;
    const archive = archiveStageProof(msg, control, execution, resolvedTarget);
    const caseId = archive?.changedCaseIds[0];
    const caseFile = caseId ? LegalCases.getCase(resolvedTarget.orgId, caseId, userId, 'write') : null;
    const reminderCount = caseFile
      ? createCaseAlerts({ userId, orgId: resolvedTarget.orgId, caseFile, content: `${messageText}\n${report}` })
      : 0;
    // The verified adapter has committed; consume its target selection once even
    // if current readback is insufficient, so evidence repair never replays intake.
    if (msg.legalNoticeSelection) consumePendingLegalNotice(msg.legalNoticeSelection.pendingId);
    return nativeStageReply(msg, control, `${report}\n\n- 案件提醒：${reminderCount ? `已生成/更新 ${reminderCount} 条` : '未识别到未来期限，请人工核对通知日期'}`,
      'archived', archive);
  }

}

async function handlePersonalLegalNotice(
  msg: IncomingMessage,
  messageText: string,
  matchText: string,
  control: LegalNoticeExecutionControl,
): Promise<string> {
  const userId = msg.boundUserId!;
  let candidates = caseCandidates(userId, matchText);
  let inspected = '';
  if (candidates.length !== 1) {
    inspected = await inspectPersonalNotice(msg, matchText, control);
    assertNoticeAuthorized(msg, control);
    candidates = caseCandidates(userId, `${matchText}\n${inspected}`);
  }

  if (candidates.length === 0) {
    const organizations = organizationCandidates(userId);
    const hints = LegalCases.extractLegalCaseHints(`${matchText}\n${inspected}`);
    const explicitTarget = extractCaseTarget(messageText);
    if (organizations.length === 1 && (hints.caseNumber || explicitTarget)) {
      candidates = [{ ...organizations[0], caseTitle: explicitTarget || hints.caseNumber, caseNumber: hints.caseNumber }];
    } else candidates = organizations;
  }

  if (candidates.length === 0) {
    pushNotification(userId, {
      type: 'legal_notice',
      title: '法院通知待归档',
      message: '个人微信已收到法院通知，但当前身份没有可写入的组织案件空间。',
    });
    return nativeStageReply(msg, control, '链接已经按个人待归档材料检查，但当前 Lumi 身份没有可写入的组织。请先创建或加入组织后再归档。', 'blocked');
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
  return nativeStageReply(msg, control, pendingPrompt(candidates, inspected), 'awaiting_target');
}

function isRequestedLegalNoticeIntake(msg: IncomingMessage): boolean {
  const messageText = currentUserRequestText(msg);
  const signalText = legalSignalText(msg);
  const hasCourtNoticeAttachment = Boolean(msg.attachments?.length)
    && /(人民法院|12368|开庭通知|传票|送达通知|应诉通知|举证通知|[（(]\d{4}[）)].{2,50}号)/.test(signalText);
  const explicitIntakeRequest = isExplicitLegalNoticeIntakeRequest(messageText);
  const hasLegalMaterialSignal = isLegalNoticeIntakeCandidate(signalText)
    || hasCourtNoticeAttachment
    || /(人民法院|法院|12368|开庭|传票|送达|应诉|举证|立案|诉讼|案号|民初|民终|裁定|判决|律师|法律|合同纠纷|侵权|仲裁)/.test(signalText);
  // Attachment content establishes what the material is, never what the user
  // authorized. Analysis/read requests remain read-only even when the filename
  // or extracted body looks like a court notice. Case creation/archiving opens
  // only from the current user's explicit wording (or a durable pending target
  // selection handled below).
  return explicitIntakeRequest && hasLegalMaterialSignal;
}

export async function handleRemoteLegalNoticeIntake(msg: IncomingMessage, control: LegalNoticeExecutionControl = {}): Promise<string | null> {
  msg.organizationAuthorization = captureMessagingOrganization(msg).organizationAuthorization;
  assertNoticeAuthorized(msg, control);
  const messageText = currentUserRequestText(msg);
  const legalCandidate = isRequestedLegalNoticeIntake(msg);

  if (msg.legalNoticeSelection) {
    const pending = currentPendingNoticeSelection(msg);
    if (!pending) throw new MessagingAuthorizationRevokedError();
    return runOrganizationLegalIntake({ ...msg, attachments: pending.attachments }, msg.legalNoticeSelection.target, pending.messageText, control);
  }

  if (!legalCandidate) return null;

  if (!msg.boundUserId) {
    return nativeStageReply(msg, control, bindingPrompt(msg.platform), 'blocked');
  }
  if (!msg.boundOrgId) return handlePersonalLegalNotice(msg, messageText, legalSignalText(msg), control);

  return runOrganizationLegalIntake(msg, {
    orgId: msg.boundOrgId,
    orgName: writableOrganizations(msg.boundUserId).find(org => org.id === msg.boundOrgId)?.name || msg.boundOrgId,
  }, messageText, control);
}
