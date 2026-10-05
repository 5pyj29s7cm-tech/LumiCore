import type { IncomingMessage } from '../../../messaging/types';
import { assertMessagingAuthorization as assertAcceptedMessagingAuthorization, isMessagingAuthorizationCurrent as isAcceptedMessagingAuthorizationCurrent, MessagingAuthorizationRevokedError } from '../../../messaging/turn_authorization';
import { drainRemotePostTurnLearning } from './remote_memory';
import { getRequestText } from "./remote_materials";

const messageRouteQueues = new Map<string, Promise<void>>();
export const acceptedMessageSettlements = new Set<Promise<void>>();
export let acceptingMessagingIngress = true;

export function isMessagingAuthorizationCurrent(message: IncomingMessage): boolean {
  return acceptingMessagingIngress && isAcceptedMessagingAuthorizationCurrent(message);
}

export function assertMessagingAuthorization(message: IncomingMessage): void {
  if (!acceptingMessagingIngress) throw new MessagingAuthorizationRevokedError();
  assertAcceptedMessagingAuthorization(message);
}

/** Close admission synchronously, then settle every already accepted route.
 * The shutdown coordinator owns the deadline; timing out must not kill writers.
 */
export async function stopMessagingIngressAndDrain(): Promise<void> {
  acceptingMessagingIngress = false;
  for (const entry of activeMessageRouteControllers.values()) {
    entry.controller.abort(new Error('Messaging is shutting down.'));
  }
  await Promise.all([...acceptedMessageSettlements]);
  await drainRemotePostTurnLearning();
}
const messageRouteActivity = new Map<string, {
  latestSequence: number;
  latestMessageId: string;
  latestText: string;
  updatedAt: number;
}>();
const activeMessageRouteControllers = new Map<string, {
  messageId: string;
  routeSequence: number;
  controller: AbortController;
}>();
const MESSAGE_ACTIVITY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_ROUTE_ACTIVITY = 4_096;

function visibleMessageRouteKey(message: IncomingMessage): string {
  return [
    message.platform,
    message.userId,
    message.chatType,
    message.chatId,
    message.threadId || 'main',
  ].join(':');
}

export function registerMessageRouteActivity(message: IncomingMessage): IncomingMessage {
  const currentTime = Date.now();
  for (const [key, activity] of messageRouteActivity) {
    if (currentTime - activity.updatedAt > MESSAGE_ACTIVITY_TTL_MS) messageRouteActivity.delete(key);
  }
  const key = visibleMessageRouteKey(message);
  const previous = messageRouteActivity.get(key);
  const routeSequence = (previous?.latestSequence || 0) + 1;
  const tracked = {
    ...message,
    receivedAt: message.receivedAt || new Date(currentTime).toISOString(),
    routeSequence,
  };
  // Refresh insertion order for active conversations, then evict the oldest
  // inactive keys if a long-lived backend sees more unique chats than the TTL
  // window can reclaim promptly.
  if (previous) messageRouteActivity.delete(key);
  while (messageRouteActivity.size >= MAX_MESSAGE_ROUTE_ACTIVITY) {
    const oldestKey = messageRouteActivity.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    messageRouteActivity.delete(oldestKey);
  }
  messageRouteActivity.set(key, {
    latestSequence: routeSequence,
    latestMessageId: tracked.messageId,
    latestText: getRequestText(tracked),
    updatedAt: currentTime,
  });
  const active = activeMessageRouteControllers.get(key);
  if (active && active.routeSequence < routeSequence && !active.controller.signal.aborted) {
    active.controller.abort(new Error('A newer remote message superseded this turn.'));
  }
  return tracked;
}

function newerMessageActivity(message: IncomingMessage) {
  const activity = messageRouteActivity.get(visibleMessageRouteKey(message));
  if (!activity || !message.routeSequence || activity.latestSequence <= message.routeSequence) return null;
  return activity;
}

export function newerMessageSupersedesThisTurn(message: IncomingMessage): boolean {
  return Boolean(newerMessageActivity(message));
}

export function registerActiveMessageRouteController(
  message: IncomingMessage,
  controller: AbortController,
): () => void {
  const key = visibleMessageRouteKey(message);
  const routeSequence = Number(message.routeSequence || 0);
  const entry = { messageId: message.messageId, routeSequence, controller };
  activeMessageRouteControllers.set(key, entry);
  if (newerMessageSupersedesThisTurn(message) && !controller.signal.aborted) {
    controller.abort(new Error('A newer remote message superseded this turn.'));
  }
  const checkAuthorization = () => {
    if (!isMessagingAuthorizationCurrent(message) && !controller.signal.aborted) {
      controller.abort(new MessagingAuthorizationRevokedError());
    }
  };
  checkAuthorization();
  const authorizationTimer = setInterval(checkAuthorization, 100);
  authorizationTimer.unref?.();
  return () => {
    clearInterval(authorizationTimer);
    if (activeMessageRouteControllers.get(key) === entry) activeMessageRouteControllers.delete(key);
  };
}

export function correlateMessagingReply(
  message: IncomingMessage,
  reply: string,
): { text: string; superseded: boolean; delayed: boolean } {
  if (!isMessagingAuthorizationCurrent(message)) return { text: '', superseded: true, delayed: false };
  const readableReply = formatRemoteReplyForReadability(reply);
  const activity = newerMessageActivity(message);
  if (!activity) return { text: readableReply, superseded: false, delayed: false };
  // Remote transports cannot retract an already delivered message. Once a
  // newer user turn is accepted, an older completion must therefore be
  // suppressed before both persistence and delivery. Prefixing a late answer
  // still lets obsolete work talk over a correction or a topic switch.
  return { text: '', superseded: true, delayed: true };
}

export function formatRemoteReplyForReadability(value: string): string {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  const paragraphs = text.split(/\n{2,}/).flatMap(paragraph => {
    const clean = paragraph.trim();
    if (clean.length <= 120 || /```|^\s*(?:[-*+] |\d+[.)] )/m.test(clean)) return clean ? [clean] : [];
    const sentences = clean.split(/(?<=[。！？!?；;])\s*/u).filter(Boolean);
    if (sentences.length < 2) return [clean];
    const chunks: string[] = [];
    let chunk = '';
    for (const sentence of sentences) {
      if (chunk && (chunk.length + sentence.length > 150 || chunk.split(/[。！？!?；;]/u).length > 3)) {
        chunks.push(chunk.trim());
        chunk = sentence;
      } else {
        chunk += sentence;
      }
    }
    if (chunk.trim()) chunks.push(chunk.trim());
    return chunks;
  });
  return paragraphs.join('\n\n');
}

function messageRouteKey(message: IncomingMessage): string {
  return visibleMessageRouteKey(message);
}

export async function enqueueMessageRoute(message: IncomingMessage, work: () => Promise<void>): Promise<void> {
  const key = messageRouteKey(message);
  const previous = messageRouteQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  messageRouteQueues.set(key, next);
  try {
    await next;
  } finally {
    if (messageRouteQueues.get(key) === next) messageRouteQueues.delete(key);
  }
}
