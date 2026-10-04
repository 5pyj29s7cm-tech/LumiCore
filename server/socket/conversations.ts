import { Socket } from "socket.io";
import { conversationAccessStatus, listConversationHeaders, listUserInteractions } from '../conversation/history_repository';
import { resolveAuthorizedSocketScope } from './scope';
import { collectChatArtifacts } from '../conversation/chat_artifacts';

export function registerConversationHandlers(socket: Socket, getUserId: (s: Socket) => string) {
  socket.on("chat:conversations", async () => {
    try {
      const uid = getUserId(socket);
      const scope = resolveAuthorizedSocketScope(socket, uid);
      if (!scope) { socket.emit('chat:conversations', { conversations: [], error: 'Workspace access is unavailable.' }); return; }
      const owner = { userId: uid, ...scope };
      const convs = listConversationHeaders(owner, 30);

      const interactionsByConv = new Map<string, any[]>();
      for (const i of listUserInteractions(uid, { conversationIds: convs.map(c => c.id) })) {
        const cid = i.conversationId;
        if (!cid) continue;
        if (!interactionsByConv.has(cid)) interactionsByConv.set(cid, []);
        interactionsByConv.get(cid)!.push(i);
      }

      const list = convs.map((c: any) => {
        const convInteractions = interactionsByConv.get(c.id) || [];
        const lastInteraction = convInteractions[convInteractions.length - 1];
        const firstMsg = convInteractions[0];
        return {
          id: c.id,
          title: c.title || (firstMsg?.content || firstMsg?.message || 'New Conversation').slice(0, 50),
          messageCount: c.messageCount || 0,
          lastActiveAt: c.lastActiveAt,
          createdAt: c.createdAt,
          preview: (lastInteraction?.response || '').slice(0, 80) || (lastInteraction?.content || '').slice(0, 80),
        };
      });

      socket.emit("chat:conversations", { conversations: list });
    } catch (err) {
      console.error("[chat:conversations] Error:", err);
      socket.emit("chat:conversations", { conversations: [] });
    }
  });

  socket.on("chat:messages", async (data: { conversationId: string }) => {
    try {
      if (!data.conversationId) {
        socket.emit("chat:messages", { conversationId: '', messages: [] });
        return;
      }
      const uid = getUserId(socket);
      const scope = resolveAuthorizedSocketScope(socket, uid);
      if (!scope) { socket.emit('chat:messages', { conversationId: data.conversationId, messages: [], error: 'Workspace access is unavailable.' }); return; }
      if (conversationAccessStatus(data.conversationId, { userId: uid, ...scope }) !== 'allowed') {
        socket.emit('chat:messages', { conversationId: data.conversationId, messages: [] });
        return;
      }
      const interactions = listUserInteractions(uid, { conversationId: data.conversationId, order: 'oldest' }).slice(-100);

      const messages: any[] = [];
      for (const i of interactions) {
        const body = i.content || i.message;
        if (body && (!i.role || i.role === 'user')) {
          messages.push({ id: i.id + '_u', type: 'user-text', content: i.content || i.message, timestamp: i.timestamp });
        }
        const tcs = Array.isArray(i.toolCalls) ? i.toolCalls : [];
        for (const tc of tcs) {
          messages.push({ id: i.id + '_t_' + tc.name, type: 'tool', name: tc.name, args: tc.args || tc.arguments || {}, status: 'done', timestamp: i.timestamp });
        }
        const response = i.role === 'assistant' ? (body || i.response) : i.response;
        if (response && (!i.role || i.role === 'user' || i.role === 'assistant')) {
          messages.push({ id: i.id + '_r', type: 'lumi', content: response, timestamp: i.timestamp,
            conversationId: data.conversationId, fileArtifacts: collectChatArtifacts(i.toolCalls, data.conversationId) });
        }
      }
      socket.emit("chat:messages", { conversationId: data.conversationId, messages });
    } catch (err) {
      console.error("[chat:messages] Error:", err);
      socket.emit("chat:messages", { conversationId: data.conversationId, messages: [] });
    }
  });
}
