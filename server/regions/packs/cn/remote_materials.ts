import type { IncomingAttachment, IncomingMessage } from '../../../messaging/types';
import path from 'path';
import { requestsOrganizationScope } from '../../../messaging/personal_org_scope';
import { getDataPath } from '../../../config/data_path';
import fs from 'fs';
import { parseDocument } from '../../../legal/parser';
import { FeishuAdapter } from '../../../messaging/feishu';
import { WeComAdapter } from '../../../messaging/wecom';

const MAX_MESSAGING_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function messagingConversationAgentId(message: IncomingMessage): string {
  if (message.platform === 'wechat' && message.boundUserId && !message.boundOrgId) {
    return 'lumi';
  }
  const scope = message.chatType === 'group'
    ? `group:${message.chatId}:member:${message.userId}:thread:${message.threadId || 'main'}`
    : `private:${message.chatId || message.userId}`;
  return `lumi:${message.platform}:${scope}`;
}

// ── AI reply pipeline — powered by Lumi personality ──

function sanitizeFileName(name: string): string {
  return (name || 'attachment')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'attachment';
}

function isParseableAttachment(fileName: string, attachmentType: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  if (attachmentType === 'image' || attachmentType === 'audio' || attachmentType === 'media') return false;
  return ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.txt', '.md'].includes(ext);
}

export function getRequestText(msg: IncomingMessage): string {
  const markers = [
    '\n以下是用户通过',
    '\nThe following materials were sent earlier',
  ];
  const markerIndex = markers
    .map(marker => msg.text.indexOf(marker))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0];
  const request = markerIndex === undefined ? msg.text.trim() : msg.text.slice(0, markerIndex).trim();
  const attachmentLabels = new Set((msg.attachments || []).flatMap(attachment => {
    const name = String(attachment.fileName || '').trim();
    return name ? [`[附件] ${name}`, `[Attachment] ${name}`] : [];
  }));
  const requestLines = request.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // Feishu, WeCom and WeChat synthesize these labels for an attachment-only
  // event. A filename is material metadata, not user authorization to execute
  // verbs that happen to appear inside that filename.
  if (attachmentLabels.size > 0 && requestLines.length > 0 && requestLines.every(line => attachmentLabels.has(line))) {
    return '';
  }
  return request;
}

export function buildRemoteTurnIntentText(
  msg: IncomingMessage,
  pendingConfirmationPrompt = '',
): string {
  return [getRequestText(msg), pendingConfirmationPrompt].filter(Boolean).join('\n');
}

export function getDisplayText(msg: IncomingMessage): string {
  const request = getRequestText(msg);
  const attachmentNames = Array.from(new Set((msg.attachments || [])
    .map(attachment => String(attachment.fileName || '').trim())
    .filter(name => name && !request.includes(name))));
  return [request, attachmentNames.length ? `附件：${attachmentNames.join('；')}` : ''].filter(Boolean).join('\n');
}

export function remotePlatformLabel(platform: IncomingMessage['platform']): string {
  if (platform === 'wecom') return '企业微信';
  if (platform === 'wechat') return '微信';
  return '飞书';
}

export function remoteMaterialSource(platform: IncomingMessage['platform']): 'feishu' | 'wecom' | 'wechat' {
  if (platform === 'wecom') return 'wecom';
  if (platform === 'wechat') return 'wechat';
  return 'feishu';
}

export const needsBinding = requestsOrganizationScope;

function attachmentPromptBlock(attachment: IncomingAttachment): string {
  const parts = [
    `## 附件：${attachment.fileName}`,
    `类型：${attachment.type}`,
    attachment.fileSize ? `大小：${attachment.fileSize} bytes` : '',
    attachment.localPath ? `本地缓存：${attachment.localPath}` : '',
  ].filter(Boolean);
  if (attachment.parseError) {
    parts.push(`解析状态：${attachment.parseError}`);
  } else if (attachment.extractedText) {
    parts.push('解析文本：');
    parts.push(attachment.extractedText.slice(0, 12000));
  } else {
    parts.push('解析状态：已接收附件，但当前类型暂未自动抽取文本。');
  }
  return parts.join('\n');
}

export async function enrichMessagingAttachments(
  msg: IncomingMessage,
  platformFolder: 'feishu' | 'wecom' | 'wechat',
  contextPrompt: string,
  downloader: (attachment: IncomingAttachment) => Promise<Buffer>,
): Promise<IncomingMessage> {
  if (!msg.attachments || msg.attachments.length === 0) return msg;

  const enrichedAttachments: IncomingAttachment[] = [];
  for (const attachment of msg.attachments) {
    const enriched: IncomingAttachment = { ...attachment };
    try {
      if (attachment.fileSize && attachment.fileSize > MAX_MESSAGING_ATTACHMENT_BYTES) {
        throw new Error(`file too large (${Math.round(attachment.fileSize / 1024 / 1024)} MB)`);
      }
      const buffer = await downloader(attachment);
      enriched.fileSize = enriched.fileSize || buffer.byteLength;
      if (buffer.byteLength > MAX_MESSAGING_ATTACHMENT_BYTES) {
        throw new Error(`file too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB)`);
      }

      const safeName = sanitizeFileName(enriched.fileName);
      const scopeDir = msg.boundOrgId
        ? `org-${sanitizeFileName(msg.boundOrgId)}`
        : msg.boundUserId
          ? `personal-${sanitizeFileName(msg.boundUserId)}`
          : 'unbound-quarantine';
      const messageKey = sanitizeFileName(msg.messageId).slice(0, 80);
      const savePath = getDataPath(path.join('messaging', platformFolder, 'attachments', scopeDir, `${Date.now()}_${messageKey}_${safeName}`));
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, buffer);
      enriched.localPath = savePath;

      if (isParseableAttachment(safeName, enriched.type)) {
        const parsed = await parseDocument(savePath);
        if (parsed?.text?.trim()) {
          enriched.extractedText = parsed.text.trim();
        } else {
          enriched.parseError = '文件已保存，但没有抽取到可读文本';
        }
      }
    } catch (err: any) {
      enriched.parseError = err?.message || String(err);
    }
    enrichedAttachments.push(enriched);
  }

  const attachmentBlocks = enrichedAttachments.map(attachmentPromptBlock).join('\n\n');
  const text = [
    msg.text,
    '',
    contextPrompt,
    attachmentBlocks,
  ].filter(Boolean).join('\n');

  return {
    ...msg,
    text,
    attachments: enrichedAttachments,
  };
}

export function enrichFeishuAttachments(msg: IncomingMessage, adapter: FeishuAdapter): Promise<IncomingMessage> {
  return enrichMessagingAttachments(
    msg,
    'feishu',
    '以下是用户通过飞书发送的附件内容。请优先结合附件内容回答；如果像案件材料，请按案件事实、争议焦点、证据/材料缺口、下一步建议来整理，并提醒最终由律师确认。',
    async attachment => {
      if (!attachment.resourceKey) throw new Error('missing resource key');
      return adapter.downloadMessageResource(msg.messageId, attachment.resourceKey, attachment.resourceType || 'file');
    },
  );
}

export function enrichWeComAttachments(msg: IncomingMessage, adapter: WeComAdapter): Promise<IncomingMessage> {
  return enrichMessagingAttachments(
    msg,
    'wecom',
    '以下是用户通过企业微信发送的附件内容。请结合附件回答；如属案件材料，按事实、争议焦点、证据缺口和下一步建议整理。',
    async attachment => {
      if (!attachment.resourceKey) throw new Error('missing media id');
      return adapter.downloadMedia(attachment.resourceKey);
    },
  );
}
