import type { Server, Socket } from 'socket.io';
import { resolveAuthorizedSocketScope } from '../scope';
import { getChatExecution, markChatExecutionCancelling, type ChatExecutionScope } from '../chat_execution_registry';
import { getConversationExecution } from '../../cognition/conversation_execution';

/** Connection recovery and abort signals share the durable foreground registry. */
export function registerChatExecutionControls(socket: Socket, userIdFn: (socket: Socket) => string, io: Server) {

  socket.on("agent:execution_resume", (
    data: { requestId?: string; source?: string; domain?: string; orgId?: string | null; conversationId?: string } = {},
    ack?: (payload: { ok: boolean; snapshot?: ReturnType<typeof getChatExecution>; code?: string; error?: string }) => void,
  ) => {
    const uid = userIdFn(socket);
    const requestScope = resolveAuthorizedSocketScope(socket, uid);
    if (!requestScope) {
      try { ack?.({ ok: false, error: 'Workspace access is unavailable.' }); } catch {}
      return;
    }
    const scope: ChatExecutionScope = {
      userId: uid,
      domain: requestScope.domain,
      orgId: requestScope.orgId,
      source: data.source || 'chat',
      conversationId: data.conversationId,
    };
    const snapshot = getChatExecution(scope, data.requestId);
    try {
      ack?.(snapshot
        ? { ok: true, snapshot }
        : { ok: false, code: 'EXECUTION_NOT_FOUND', error: 'Execution not found or no longer recoverable' });
    } catch {}
    if (snapshot?.terminalEvent) {
      socket.emit(snapshot.terminalEvent.event, {
        ...snapshot.terminalEvent.payload,
        replayed: true,
      });
    }
  });

  // Abort is request-scoped and acknowledged. This handler only records that
  // the server accepted the cancellation signal; the foreground owner remains
  // the sole writer of the request's terminal transcript/task/receipt. Writing
  // a second terminal here used to race the foreground catch and could claim
  // "cancelled" while a provider that ignored AbortSignal was still running.
  socket.on("agent:abort_chat", async (
    data: { requestId?: string; source?: string; domain?: string; orgId?: string | null; conversationId?: string } = {},
    ack?: (payload: { ok: boolean; requestId?: string; status?: string; error?: string }) => void,
  ) => {
    const uid = userIdFn(socket);
    // Revoked credentials may only stop their exact original request. They
    // never become personal credentials and cannot read a recovery payload.
    if (socket.data?.authenticatedUserId !== uid || !data.requestId) {
      try { ack?.({ ok: false, error: 'An authenticated exact request is required.' }); } catch {}
      return;
    }
    const originalOrgId = String(socket.data?.authenticatedOrgId || '').trim();
    const requestScope = { domain: originalOrgId ? 'work' as const : 'personal' as const, orgId: originalOrgId };
    const scope: ChatExecutionScope = {
      userId: uid,
      domain: requestScope.domain,
      orgId: requestScope.orgId,
      source: data.source || 'chat',
      conversationId: data.conversationId,
    };
    const snapshot = getChatExecution(scope, data.requestId);
    if (!snapshot || snapshot.terminal) {
      try {
        ack?.({
          ok: Boolean(snapshot?.terminal),
          requestId: snapshot?.requestId || data.requestId,
          status: snapshot?.status,
          error: snapshot ? undefined : 'Active execution not found',
        });
      } catch {}
      return;
    }

    const targetConversationId = scope.conversationId || snapshot.conversationId || '';
    const session = getConversationExecution({ ...scope, conversationId: targetConversationId }, snapshot.requestId);
    if (!session || session.requestId !== snapshot.requestId) {
      try { ack?.({ ok: false, requestId: snapshot.requestId, error: 'Execution controller is unavailable' }); } catch {}
      return;
    }
    markChatExecutionCancelling(scope, snapshot.requestId);
    const room = chatExecutionRoom(scope);
    const cancellingPayload = {
      status: 'cancelling',
      source: scope.source,
      requestId: snapshot.requestId,
      conversationId: targetConversationId,
    };
    io.to(room).emit('agent:status', cancellingPayload);
    session.cancel();
    try { ack?.({ ok: true, requestId: snapshot.requestId, status: 'cancelling' }); } catch {}
  });
}

export function chatExecutionRoom(scope: ChatExecutionScope): string {
  return scope.domain === 'work' && scope.orgId
    ? `user:${scope.userId}:org:${scope.orgId}`
    : `user:${scope.userId}:personal`;
}
