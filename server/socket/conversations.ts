import { Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { readDB } from "../../db_layer";
import { getJwtSecret } from "../config/local_identity";

const JWT_SECRET = getJwtSecret();

function getOrgIdFromSocket(socket: Socket): string | undefined {
  try {
    const authToken = socket.handshake?.auth?.token;
    if (authToken) {
      const decoded: any = jwt.verify(authToken, JWT_SECRET);
      return decoded.orgId;
    }
  } catch {}
  return undefined;
}

export function registerConversationHandlers(socket: Socket, getUserId: (s: Socket) => string) {
  socket.on("chat:conversations", async () => {
    try {
      const uid = getUserId(socket);
      const orgId = getOrgIdFromSocket(socket);
      const db = readDB();

      const convs = (db.conversations || [])
        .filter((c: any) => {
          if (c.userId !== uid) return false;
          if (orgId) return c.orgId === orgId;
          return (!c.orgId || c.orgId === '');
        })
        .sort((a: any, b: any) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
        .slice(0, 30);

      const interactionsByConv = new Map<string, any[]>();
      for (const i of (db.interactions || [])) {
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
      const orgId = getOrgIdFromSocket(socket);
      const db = readDB();

      // Ownership + domain verification
      const conv = (db.conversations || []).find((c: any) => c.id === data.conversationId);
      if (!conv) {
        socket.emit("chat:messages", { conversationId: data.conversationId, messages: [] });
        return;
      }
      if (conv.userId !== uid) {
        socket.emit("chat:messages", { conversationId: data.conversationId, messages: [] });
        return;
      }
      if (orgId) {
        if (conv.orgId !== orgId) {
          socket.emit("chat:messages", { conversationId: data.conversationId, messages: [] });
          return;
        }
      } else {
        if (conv.orgId && conv.orgId !== '') {
          socket.emit("chat:messages", { conversationId: data.conversationId, messages: [] });
          return;
        }
      }

      const interactions = (db.interactions || [])
        .filter((i: any) => i.conversationId === data.conversationId)
        .sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .slice(-100);

      const messages: any[] = [];
      for (const i of interactions) {
        if (i.content || i.message) {
          messages.push({ id: i.id + '_u', type: 'user-text', content: i.content || i.message, timestamp: i.timestamp });
        }
        const tcs = Array.isArray(i.toolCalls) ? i.toolCalls : [];
        for (const tc of tcs) {
          messages.push({ id: i.id + '_t_' + tc.name, type: 'tool', name: tc.name, args: tc.args || tc.arguments || {}, status: 'done', timestamp: i.timestamp });
        }
        if (i.response) {
          messages.push({ id: i.id + '_r', type: 'lumi', content: i.response, timestamp: i.timestamp });
        }
      }
      socket.emit("chat:messages", { conversationId: data.conversationId, messages });
    } catch (err) {
      console.error("[chat:messages] Error:", err);
      socket.emit("chat:messages", { conversationId: data.conversationId, messages: [] });
    }
  });
}
