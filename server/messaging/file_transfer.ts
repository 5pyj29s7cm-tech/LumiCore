import fs from 'fs';
import path from 'path';
import { FeishuAdapter } from './feishu';
import { getMessagingConfig } from './config';
import { listBindingsForUser, type MessagingBinding } from './bindings';
import { getActiveWeChatAdapter } from './wechat_runtime';
import { getMember, getOrgById, logAudit } from '../org/db';

const FEISHU_FILE_LIMIT_BYTES = 30 * 1024 * 1024;
const WECHAT_FILE_LIMIT_BYTES = 25 * 1024 * 1024;

export interface FeishuFileTarget {
  bindingId: string;
  orgId: string;
  orgName: string;
  chatId: string;
  chatType: 'private' | 'group';
  platformUserId: string;
}

export interface FeishuFileTransferResult {
  messageId: string;
  fileName: string;
  fileSize: number;
  target: FeishuFileTarget;
  sourceDomain: 'personal' | 'work';
}

export interface PersonalWeChatFileTarget {
  bindingId: string;
  platformUserId: string;
  chatId: string;
}

export interface PersonalWeChatFileTransferResult {
  messageId: string;
  fileName: string;
  fileSize: number;
  target: PersonalWeChatFileTarget;
  sourceDomain: 'personal' | 'work';
  method: 'wechat_ilink_file_api';
}

export class WeChatFileApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeChatFileApiUnavailableError';
  }
}

function bindingToTarget(binding: MessagingBinding): FeishuFileTarget | null {
  const chatId = String(binding.chatId || '').trim();
  if (!chatId) return null;
  const org = getOrgById(binding.orgId);
  return {
    bindingId: binding.id,
    orgId: binding.orgId,
    orgName: org?.name || binding.orgId,
    chatId,
    chatType: binding.chatType === 'group' ? 'group' : 'private',
    platformUserId: binding.platformUserId,
  };
}

export function listFeishuFileTargets(userId: string, orgId = ''): FeishuFileTarget[] {
  return listBindingsForUser(userId)
    .filter(binding => binding.platform === 'feishu' && binding.domain === 'work')
    .filter(binding => !orgId || binding.orgId === orgId)
    .filter(binding => {
      const membership = getMember(binding.orgId, userId);
      return membership?.status === 'active' && membership.role !== 'viewer';
    })
    .map(bindingToTarget)
    .filter((target): target is FeishuFileTarget => Boolean(target));
}

export function listPersonalWeChatFileTargets(userId: string): PersonalWeChatFileTarget[] {
  return listBindingsForUser(userId)
    .filter(binding => binding.platform === 'wechat' && binding.domain === 'personal')
    .map(binding => ({
      bindingId: binding.id,
      platformUserId: binding.platformUserId,
      chatId: String(binding.chatId || binding.platformUserId),
    }));
}

function resolvePersonalWeChatTarget(userId: string, bindingId = ''): PersonalWeChatFileTarget {
  let targets = listPersonalWeChatFileTargets(userId);
  if (bindingId) targets = targets.filter(target => target.bindingId === bindingId);
  if (targets.length === 0) {
    throw new WeChatFileApiUnavailableError('No personal WeChat binding is available for this Lumi user.');
  }
  if (targets.length > 1) {
    throw new Error(`Multiple personal WeChat bindings matched. Specify bindingId: ${targets.map(target => target.bindingId).join(', ')}`);
  }
  return targets[0];
}

function resolveTarget(params: {
  userId: string;
  orgId?: string;
  bindingId?: string;
  chatId?: string;
}): FeishuFileTarget {
  let targets = listFeishuFileTargets(params.userId, String(params.orgId || '').trim());
  if (params.bindingId) targets = targets.filter(target => target.bindingId === params.bindingId);
  if (params.chatId) targets = targets.filter(target => target.chatId === params.chatId);
  if (targets.length === 0) {
    throw new Error('No authorized Feishu file target matched this user and organization. Bind the target chat first.');
  }
  if (targets.length > 1) {
    throw new Error(`Multiple Feishu targets matched. Specify bindingId or chatId: ${targets.map(target => `${target.bindingId}=${target.orgName}/${target.chatType}`).join(', ')}`);
  }
  return targets[0];
}

export async function sendLocalFileToFeishu(params: {
  userId: string;
  filePath: string;
  orgId?: string;
  bindingId?: string;
  chatId?: string;
  displayName?: string;
  note?: string;
  sourceDomain?: 'personal' | 'work';
}): Promise<FeishuFileTransferResult> {
  const userId = String(params.userId || '').trim();
  const filePath = path.resolve(String(params.filePath || '').trim());
  if (!userId) throw new Error('A bound Lumi user is required for file transfer');
  if (!params.filePath) throw new Error('filePath is required');

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (stat.size === 0) throw new Error('Cannot send an empty file');
  if (stat.size > FEISHU_FILE_LIMIT_BYTES) throw new Error('Feishu file upload limit is 30 MB');

  const target = resolveTarget({
    userId,
    orgId: params.orgId,
    bindingId: params.bindingId,
    chatId: params.chatId,
  });
  const config = getMessagingConfig().feishu;
  if (!config.enabled || !config.appId || !config.appSecret) {
    throw new Error('Feishu messaging is not configured');
  }

  const adapter = new FeishuAdapter(config);
  const note = String(params.note || '').trim();
  if (note) await adapter.sendMessage(target.chatId, { platform: 'feishu', text: note });
  const buffer = fs.readFileSync(filePath);
  const fileName = path.basename(String(params.displayName || path.basename(filePath)).trim()) || path.basename(filePath);
  const messageId = await adapter.sendFile(target.chatId, buffer, fileName);
  const sourceDomain = params.sourceDomain === 'work' ? 'work' : 'personal';

  logAudit({
    orgId: target.orgId,
    userId,
    action: 'messaging.file.transfer_to_feishu',
    resourceType: 'messaging_file_transfer',
    resourceId: messageId || `${target.chatId}:${Date.now()}`,
    details: {
      sourceDomain,
      targetPlatform: 'feishu',
      targetChatId: target.chatId,
      targetChatType: target.chatType,
      bindingId: target.bindingId,
      fileName,
      fileSize: stat.size,
      localPath: filePath,
    },
  });

  return { messageId, fileName, fileSize: stat.size, target, sourceDomain };
}

export async function sendLocalFileToPersonalWeChat(params: {
  userId: string;
  filePath: string;
  bindingId?: string;
  displayName?: string;
  note?: string;
  sourceOrgId?: string;
}): Promise<PersonalWeChatFileTransferResult> {
  const userId = String(params.userId || '').trim();
  const filePath = path.resolve(String(params.filePath || '').trim());
  if (!userId) throw new Error('A bound Lumi user is required for file transfer');
  if (!params.filePath) throw new Error('filePath is required');

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (stat.size === 0) throw new Error('Cannot send an empty file');
  if (stat.size > WECHAT_FILE_LIMIT_BYTES) throw new Error('WeChat file upload limit is 25 MB');

  const sourceOrgId = String(params.sourceOrgId || '').trim();
  if (sourceOrgId) {
    const membership = getMember(sourceOrgId, userId);
    if (membership?.status !== 'active' || membership.role === 'viewer') {
      throw new Error('This Lumi user cannot transfer organization files from the requested organization.');
    }
  }

  const target = resolvePersonalWeChatTarget(userId, String(params.bindingId || '').trim());
  const adapter = getActiveWeChatAdapter();
  if (!adapter) {
    throw new WeChatFileApiUnavailableError('The WeChat bot connection is not active.');
  }
  if (!adapter.hasConversationContext(target.platformUserId)) {
    throw new WeChatFileApiUnavailableError('The bound WeChat conversation has no recent context. Send Lumi a WeChat message first.');
  }

  const buffer = fs.readFileSync(filePath);
  const fileName = path.basename(String(params.displayName || path.basename(filePath)).trim()) || path.basename(filePath);
  const note = String(params.note || '').trim();
  if (note) await adapter.sendMessage(target.platformUserId, { platform: 'wechat', text: note });
  const messageId = await adapter.sendFile(target.platformUserId, buffer, fileName);
  const sourceDomain = sourceOrgId ? 'work' : 'personal';

  if (sourceOrgId) {
    logAudit({
      orgId: sourceOrgId,
      userId,
      action: 'messaging.file.transfer_to_personal_wechat',
      resourceType: 'messaging_file_transfer',
      resourceId: messageId || `${target.platformUserId}:${Date.now()}`,
      details: {
        sourceDomain,
        targetPlatform: 'wechat',
        targetBindingId: target.bindingId,
        targetPlatformUserId: target.platformUserId,
        fileName,
        fileSize: stat.size,
        localPath: filePath,
        verificationMethod: 'wechat_ilink_provider_ack',
      },
    });
  }

  return {
    messageId,
    fileName,
    fileSize: stat.size,
    target,
    sourceDomain,
    method: 'wechat_ilink_file_api',
  };
}
