import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { readDB } from "../../db_layer";
import {
  getUserConversations,
  getMessages,
  closeConversation,
  getActiveConversation,
  startNewConversation,
  startIsolatedConversation,
  activateConversation,
  deleteConversationData,
} from "../conversation/manager";
import {
  buildTransportNeutralConfirmationScope,
  revokePendingConfirmationChannelDurably,
} from "../tools/pending_confirmation";
import { ensurePendingConfirmationPersistenceInitialized } from "../tools/pending_confirmation_repository";
import { sanitizePublicExecutionText } from '../../shared/public_execution_language';

type ConversationScope = { domain: 'personal' | 'work'; orgId: string };

function getConversationScope(req: any): ConversationScope {
  const requestedDomain = String(req.query?.domain || req.body?.domain || '').trim();
  if (requestedDomain === 'personal') return { domain: 'personal', orgId: '' };
  if (requestedDomain === 'work') {
    return { domain: 'work', orgId: req.user?.orgId ? String(req.user.orgId) : '' };
  }
  return req.user?.orgId
    ? { domain: 'work', orgId: String(req.user.orgId) }
    : { domain: 'personal', orgId: '' };
}

function conversationMatchesScope(conv: any, scope: ConversationScope): boolean {
  if (scope.domain === 'work') return !!scope.orgId && conv.orgId === scope.orgId;
  return !conv.orgId || conv.orgId === '';
}

function customerAssistantText(value: unknown): string {
  const text = String(value || '').trim();
  return sanitizePublicExecutionText(
    text,
    /[\u3400-\u9fff]/u.test(text) ? 'zh' : 'en',
  );
}

export function projectConversationMessageForCustomer(message: any): any {
  const role = String(message?.role || '').toLowerCase();
  if (role === 'assistant' || role === 'agent') {
    return {
      ...message,
      ...(message.message !== undefined ? { message: customerAssistantText(message.message) } : {}),
      ...(message.content !== undefined ? { content: customerAssistantText(message.content) } : {}),
      ...(message.response !== undefined ? { response: customerAssistantText(message.response) } : {}),
    };
  }
  // Older combined rows store the assistant answer in `response` beside the
  // user message. Project that half without altering the user's own words.
  if (message?.response !== undefined) {
    return { ...message, response: customerAssistantText(message.response) };
  }
  return message;
}

export function mountConversationRoutes(router: Router, _jwtSecret: string) {
  router.get("/conversations", requireAuth, (req, res) => {
    // Keep pagination bounded at the transport boundary.  The command-center
    // history rail uses `hasMore` to continue loading without guessing from a
    // short page, while older clients can continue to ignore that field.
    const requestedLimit = parseInt(req.query.limit as string, 10);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 20, 1), 100);
    const requestedOffset = parseInt(req.query.offset as string, 10);
    const offset = Math.max(Number.isFinite(requestedOffset) ? requestedOffset : 0, 0);
    const scope = getConversationScope(req);
    if (scope.domain === 'work' && !scope.orgId) return res.json({ conversations: [], limit, offset, hasMore: false });
    const agentId = String(req.query.agentId || '').trim() || undefined;
    // Fetch one sentinel row so an exact page-size response still tells the
    // client whether another page exists.
    const page = getUserConversations(req.user!.uid, limit + 1, offset, scope.domain, scope.orgId, agentId);
    const hasMore = page.length > limit;
    const conversations = page.slice(0, limit)
      .map(conversation => {
        const recent = getMessages(conversation.id, 12).filter(message => message.role !== 'tool');
        const lastUser = [...recent].reverse().find(message => message.role !== 'assistant' && String(message.message || '').trim());
        const lastVisible = [...recent].reverse().find(message => (
          String(message.role === 'assistant' ? message.message : (message.response || message.message) || '').trim()
        ));
        const rawPreview = String(
          lastVisible
            ? (lastVisible.role === 'assistant' ? lastVisible.message : (lastVisible.response || lastVisible.message))
            : conversation.summary || ''
        );
        const preview = customerAssistantText(rawPreview).replace(/\s+/g, ' ').trim().slice(0, 120);
        const displayTitle = String(conversation.title || lastUser?.message || preview || '').replace(/\s+/g, ' ').trim().slice(0, 48);
        return { ...conversation, displayTitle, preview };
      });
    res.json({ conversations, limit, offset, hasMore });
  });

  router.get("/conversations/active", requireAuth, (req, res) => {
    const scope = getConversationScope(req);
    if (scope.domain === 'work' && !scope.orgId) return res.json({ activeConversation: null });
    const agentId = (req.query.agentId as string | undefined) || undefined;
    const activeConversation = getActiveConversation(req.user!.uid, agentId, scope.domain, scope.orgId);
    res.json({ activeConversation });
  });

  router.post("/conversations/new", requireAuth, (req, res) => {
    const scope = getConversationScope(req);
    if (scope.domain === 'work' && !scope.orgId) {
      return res.status(403).json({ error: 'A connected organization is required for a work conversation' });
    }
    const agentId = String(req.body?.agentId || req.query?.agentId || 'lumi').trim() || 'lumi';
    const isolated = req.body?.activation === 'isolated';
    const conversation = isolated
      ? startIsolatedConversation(req.user!.uid, agentId, scope.domain, scope.orgId)
      : startNewConversation(req.user!.uid, agentId, scope.domain, scope.orgId);
    res.status(201).json({ conversation });
  });

  router.get("/conversations/search", requireAuth, (req, res) => {
    const query = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
    const scope = getConversationScope(req);
    if (!query || (scope.domain === 'work' && !scope.orgId)) {
      return res.json({ results: [], query, limit });
    }

    const agentId = (req.query.agentId as string | undefined) || undefined;
    const db = readDB();
    const conversationIds = new Set(
      (db.conversations || [])
        .filter((conv: any) => {
          if (conv.userId !== req.user!.uid) return false;
          if (agentId && conv.agentId !== agentId) return false;
          return conversationMatchesScope(conv, scope);
        })
        .map((conv: any) => conv.id)
    );

    const results = (db.interactions || [])
      .filter((item: any) => {
        if (item.userId !== req.user!.uid) return false;
        if (!conversationIds.has(item.conversationId)) return false;
        if (item.role === 'tool') return false;
        return true;
      })
      .map((item: any) => {
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        const rawText = String(
          item.message ||
          (item.response && item.role === 'assistant' ? item.response : '') ||
          (!item.response ? item.content || '' : '')
        ).trim();
        const text = role === 'assistant' ? customerAssistantText(rawText) : rawText;
        return {
          id: item.id,
          userId: item.userId,
          agentId: item.agentId || '',
          conversationId: item.conversationId,
          role,
          message: text,
          mode: item.mode || '',
          timestamp: item.timestamp,
        };
      })
      .filter((item: any) => item.message && item.message.toLowerCase().includes(query))
      .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);

    res.json({ results, query, limit });
  });

  router.get("/conversations/:id/messages", requireAuth, (req, res) => {
    const db = readDB();
    const conv = (db.conversations || []).find((c: any) => c.id === req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    // Ownership check
    if (conv.userId !== req.user!.uid) return res.status(403).json({ error: "Unauthorized" });
    // Domain check
    const scope = getConversationScope(req);
    if (!conversationMatchesScope(conv, scope)) return res.status(403).json({ error: "Unauthorized" });
    const limit = parseInt(req.query.limit as string) || 50;
    const messages = getMessages(req.params.id, limit).map(projectConversationMessageForCustomer);
    res.json({ messages });
  });

  router.post("/conversations/:id/activate", requireAuth, (req, res) => {
    const scope = getConversationScope(req);
    if (scope.domain === 'work' && !scope.orgId) {
      return res.status(403).json({ error: 'A connected organization is required for a work conversation' });
    }
    const agentId = String(req.body?.agentId || req.query?.agentId || 'lumi').trim() || 'lumi';
    const conversation = activateConversation(
      req.params.id,
      req.user!.uid,
      agentId,
      scope.domain,
      scope.orgId,
    );
    if (!conversation) return res.status(404).json({ error: 'Conversation not found for this agent or workspace' });
    res.json({ conversation });
  });

  router.post("/conversations/:id/close", requireAuth, (req, res) => {
    const db = readDB();
    const conv = (db.conversations || []).find((c: any) => c.id === req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (conv.userId !== req.user!.uid) return res.status(403).json({ error: "Unauthorized" });
    const scope = getConversationScope(req);
    if (!conversationMatchesScope(conv, scope)) return res.status(403).json({ error: "Unauthorized" });
    const { summary } = req.body || {};
    const closed = closeConversation(req.params.id, summary);
    if (!closed) return res.status(404).json({ error: "Conversation not found" });
    res.json({ success: true, conversation: closed });
  });

  router.delete("/conversations/:id", requireAuth, async (req, res) => {
    const scope = getConversationScope(req);
    const db = readDB();
    const conversation = (db.conversations || []).find((candidate: any) => (
      candidate.id === req.params.id
      && candidate.userId === req.user!.uid
      && conversationMatchesScope(candidate, scope)
    ));
    if (!conversation) return res.status(404).json({ error: "Not found" });
    let pendingConfirmationsCancelled = 0;
    try {
      await ensurePendingConfirmationPersistenceInitialized();
      const channelScope = buildTransportNeutralConfirmationScope({
        domain: scope.domain,
        orgId: scope.orgId,
        conversationId: conversation.id,
      });
      pendingConfirmationsCancelled = await revokePendingConfirmationChannelDurably(
        req.user!.uid,
        {
          domain: scope.domain,
          orgId: scope.orgId,
          channelId: String(channelScope.channelId || ''),
        },
      );
    } catch (error) {
      console.error('[Conversations] Failed to revoke pending confirmations before deletion:', error);
      return res.status(503).json({ error: 'Conversation confirmation cleanup is unavailable' });
    }
    const deleted = deleteConversationData(
      req.params.id,
      req.user!.uid,
      scope.domain,
      scope.orgId,
    );
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, deleted, pendingConfirmationsCancelled });
  });
}
