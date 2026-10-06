import { analyzeWechatIntake } from './wechat_intake';
import { createWorkTakeoverTaskFromWechatIntake, getScopedWorkTakeoverTask } from './tasks';

export function createWorkTakeoverTaskFromMessage(scope: { userId: string; domain: string; orgId: string }, args: Record<string, any>, message: string, source: string) {
  const intake = analyzeWechatIntake({ message, source,
    contact: args.contact ? String(args.contact) : undefined,
    takeoverMode: args.takeoverMode ? String(args.takeoverMode) as any : 'auto',
    userRules: args.userRules ? String(args.userRules) : undefined,
  });
  const task = createWorkTakeoverTaskFromWechatIntake(scope.userId, intake, {
    domain: scope.domain, orgId: scope.orgId, sourceMessage: message,
    title: args.title ? String(args.title) : undefined,
  });
  return { intake, task };
}

export async function resolveWorkTakeoverIntakeTask(scope: { userId: string; domain: string; orgId: string }, args: Record<string, any>, desktopRelay?: (name: string, args: Record<string, any>) => Promise<string>, clipboardOwner = 'Clipboard autorun') {
  if (scope.domain === 'work' && !scope.orgId) throw new Error('Work takeover requires the current organization scope.');
  let task = args.id ? getScopedWorkTakeoverTask(scope, String(args.id)) : null;
  if (args.id && !task) throw new Error('Work takeover task not found in the current scope: ' + args.id);
  let message = String(args.message || '').replace(/\s+/g, ' ').trim();
  if (!task && args.fromClipboard === true) {
    if (!desktopRelay) throw new Error(clipboardOwner + ' requires the Lumi desktop client relay.');
    message = String(await desktopRelay('desktop_clipboard_read', {}) || '').replace(/\s+/g, ' ').trim();
    if (!message) throw new Error('Clipboard is empty. Copy the customer/WeChat message first.');
  }
  if (!task && message) return { ...createWorkTakeoverTaskFromMessage(scope, args, message, args.source ? String(args.source) : args.fromClipboard ? 'clipboard' : 'manual'), createdTask: true };
  task ||= getScopedWorkTakeoverTask(scope);
  if (!task) throw new Error('No work takeover task found. Provide id, message, fromClipboard, or create a task first.');
  return { task, intake: undefined, createdTask: false };
}
