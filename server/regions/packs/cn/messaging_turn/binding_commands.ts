import type { IncomingMessage } from "../../../../messaging/types";
import { getBinding, parseMessagingBindingCommand, planBindingCodeConsumption, type BindingCodeConsumptionPlan, type MessagingPlatformId } from "../../../../messaging/bindings";
import { getMember } from "../../../../org/db";
import { captureMessagingBinding, captureMessagingOrganization } from "../../../../messaging/turn_authorization";
import { remotePlatformLabel } from "../remote_materials";

const bindingCodeQueues = new Map<string, Promise<unknown>>();

export function bindingOrgId(req: any): string {
  const sessionOrgId = String(req.user?.orgId || '').trim();
  const requestedOrgId = String(req.body?.orgId || '').trim();
  if (sessionOrgId && requestedOrgId && sessionOrgId !== requestedOrgId) {
    throw new Error('Requested organization does not match the active organization context');
  }
  return sessionOrgId || requestedOrgId;
}

interface PlannedMessagingBindingCommand {
  reply: string;
  consumption?: BindingCodeConsumptionPlan;
}

function isBindingPlatform(platform: IncomingMessage['platform']): platform is MessagingPlatformId {
  return platform === 'feishu' || platform === 'wecom' || platform === 'wechat';
}

export function planMessagingBindingCommand(msg: IncomingMessage): PlannedMessagingBindingCommand | null {
  if (!isBindingPlatform(msg.platform)) return null;
  const command = parseMessagingBindingCommand(msg.text);
  if (!command) return null;
  if (msg.chatType === 'group' && command.kind === 'bind') {
    return {
      reply: 'For security, Lumi identity binding codes can only be used in a private chat with the bot. This group must be authorized separately by an organization owner or administrator.',
    };
  }
  if (command.kind === 'status') {
    const current = getBinding(msg.platform, msg.userId, msg.chatId, msg.chatType);
    if (!current) {
      return { reply: `当前${remotePlatformLabel(msg.platform)}身份尚未绑定 Lumi。请在 Lumi 桌面端生成一次性绑定码后发送“绑定 Lumi 绑定码”。` };
    }
    if (current.domain === 'work') {
      const membership = getMember(current.orgId, current.lumiUserId);
      if (!membership || membership.status !== 'active') {
        return { reply: '已找到绑定记录，但对应组织成员权限已经失效。请在 Lumi 中恢复成员权限或重新绑定。' };
      }
    }
    return {
      reply: current.domain === 'personal'
        ? `绑定状态已核验：当前${remotePlatformLabel(msg.platform)}身份已连接到你的个人 Lumi。`
        : `绑定状态已核验：当前${msg.chatType === 'group' ? '群成员身份' : '会话身份'}已连接到 Lumi 组织工作域。`,
    };
  }
  if (command.kind === 'invalid') {
    return { reply: `绑定命令格式不完整。请原样发送“绑定 Lumi 绑定码”，或在 Lumi 桌面端重新生成${remotePlatformLabel(msg.platform)}绑定码。` };
  }
  const consumption = planBindingCodeConsumption(
    msg.platform,
    command.code,
    msg.userId,
    msg.chatId,
    msg.chatType,
  );
  if (!consumption) {
    return { reply: `绑定码无效或已过期。请在 Lumi 桌面端重新生成${remotePlatformLabel(msg.platform)}绑定码。` };
  }
  if (consumption.code.domain === 'work') {
    const membership = getMember(consumption.code.orgId, consumption.code.lumiUserId);
    if (!membership || membership.status !== 'active') {
      return { reply: '绑定码对应的组织成员权限已经失效。请在 Lumi 中恢复成员权限后重新生成绑定码。' };
    }
  }
  return {
    consumption,
    reply: consumption.code.domain === 'personal'
      ? '绑定成功。这里的消息会由你的个人 Lumi 处理，并同步到 Lumi 客户端聊天。'
      : '绑定成功。这个会话现在会按所选组织和你的 Lumi 身份路由；可以查询组织知识库、查询案件，或发送案件文件归档。',
  };
}

export function applyMessagingBinding(msg: IncomingMessage): IncomingMessage {
  if (msg.bindingAuthorization !== undefined) return msg;
  if (!isBindingPlatform(msg.platform)) return msg;
  const binding = getBinding(msg.platform, msg.userId, msg.chatId, msg.chatType);
  if (!binding) return msg.boundUserId ? msg : { ...msg, bindingAuthorization: null };
  if (binding.domain === 'work') {
    const membership = getMember(binding.orgId, binding.lumiUserId);
    if (!membership || membership.status !== 'active') return msg;
  }
  return captureMessagingOrganization({
    ...msg,
    boundUserId: binding.lumiUserId,
    boundOrgId: binding.domain === 'work' ? binding.orgId : undefined,
    bindingAuthorization: captureMessagingBinding(binding),
  });
}

export function applyPlannedMessagingBinding(
  msg: IncomingMessage,
  plan: BindingCodeConsumptionPlan,
): IncomingMessage {
  return captureMessagingOrganization({
    ...msg,
    boundUserId: plan.code.lumiUserId,
    boundOrgId: plan.code.domain === 'work' ? plan.code.orgId : undefined,
    bindingAuthorization: undefined,
  });
}

export async function enqueueBindingCodeTransaction<T>(
  plan: BindingCodeConsumptionPlan,
  work: () => Promise<T>,
): Promise<T> {
  const key = `${plan.platform}:${plan.code.code}`;
  const previous = bindingCodeQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  bindingCodeQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (bindingCodeQueues.get(key) === next) bindingCodeQueues.delete(key);
  }
}
