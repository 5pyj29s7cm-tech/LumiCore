import type { Server, Socket } from 'socket.io';
import { getConversationFocusThreads, updateConversationActionFocus } from '../conversation/manager';
import { resolveSocketScope } from './scope';

function focusRoom(userId: string, domain: 'personal' | 'work', orgId: string): string {
  return domain === 'work' && orgId ? `user:${userId}:org:${orgId}` : `user:${userId}:personal`;
}

export function registerFocusHandlers(
  socket: Socket,
  userIdFn: (socket: Socket) => string,
  io: Server,
): void {
  socket.on('focus:list', (
    data: { domain?: 'personal' | 'work'; orgId?: string; includeTerminal?: boolean } = {},
    ack?: (payload: any) => void,
  ) => {
    const userId = userIdFn(socket);
    const scope = resolveSocketScope(socket, userId, data);
    const threads = getConversationFocusThreads({
      userId,
      domain: scope.domain,
      orgId: scope.orgId,
      includeTerminal: data.includeTerminal === true,
    });
    ack?.({ ok: true, domain: scope.domain, orgId: scope.orgId, threads });
  });

  socket.on('focus:update', (
    data: {
      taskId?: string;
      domain?: 'personal' | 'work';
      orgId?: string;
      commitment?: string;
      nextAction?: string;
      waitingFor?: string;
      interruption?: string;
      resumePoint?: string;
      dueAt?: string;
    } = {},
    ack?: (payload: any) => void,
  ) => {
    const userId = userIdFn(socket);
    const scope = resolveSocketScope(socket, userId, data);
    const taskId = String(data.taskId || '').trim();
    if (!taskId) {
      ack?.({ ok: false, error: 'taskId is required' });
      return;
    }
    const thread = updateConversationActionFocus({
      taskId,
      userId,
      domain: scope.domain,
      orgId: scope.orgId,
      commitment: data.commitment,
      nextAction: data.nextAction,
      waitingFor: data.waitingFor,
      interruption: data.interruption,
      resumePoint: data.resumePoint,
      dueAt: data.dueAt,
    });
    if (!thread) {
      ack?.({ ok: false, error: 'Focus task not found in the current scope' });
      return;
    }
    const payload = { domain: scope.domain, orgId: scope.orgId, thread };
    io.to(focusRoom(userId, scope.domain, scope.orgId)).emit('focus:updated', payload);
    ack?.({ ok: true, ...payload });
  });
}
