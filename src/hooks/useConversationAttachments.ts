import { useCallback, useEffect, useRef, useState } from 'react';
import {
  mergeChatAttachmentReferences, parseChatAttachmentContext, serializeChatAttachmentContext,
  type ChatAttachmentReference as ChatAttachment,
} from '../lib/chatAttachmentReferences';

export function useConversationAttachments(attachmentContextStoragePrefix: string, onConversationChange: () => void) {
  const [conversationAttachments, setConversationAttachments] = useState<ChatAttachment[]>([]);
  const conversationAttachmentsRef = useRef<ChatAttachment[]>([]);
  const attachmentConversationIdRef = useRef('');
  const [attachmentContextStorageKey, setAttachmentContextStorageKey] = useState('');
  const bindAttachmentContextToConversation = useCallback((
    conversationId: string,
    options: { carryCurrent?: boolean } = {},
  ) => {
    const nextConversationId = String(conversationId || '').trim();
    if (attachmentConversationIdRef.current !== nextConversationId) onConversationChange();
    if (!nextConversationId) {
      attachmentConversationIdRef.current = '';
      setAttachmentContextStorageKey('');
      conversationAttachmentsRef.current = [];
      setConversationAttachments([]);
      return;
    }
    if (attachmentConversationIdRef.current === nextConversationId) return;
    const nextStorageKey = `${attachmentContextStoragePrefix}:${nextConversationId}`;
    let nextAttachments = options.carryCurrent ? conversationAttachmentsRef.current : [];
    if (!options.carryCurrent) {
      try {
        nextAttachments = parseChatAttachmentContext(localStorage.getItem(nextStorageKey));
        if (nextAttachments.length === 0) localStorage.removeItem(nextStorageKey);
      } catch {
        nextAttachments = [];
      }
    }
    attachmentConversationIdRef.current = nextConversationId;
    setAttachmentContextStorageKey(nextStorageKey);
    conversationAttachmentsRef.current = nextAttachments;
    setConversationAttachments(nextAttachments);
    if (options.carryCurrent && nextAttachments.length > 0) {
      try {
        localStorage.setItem(nextStorageKey, serializeChatAttachmentContext(nextAttachments));
      } catch {}
    }
  }, [attachmentContextStoragePrefix, onConversationChange]);
  useEffect(() => {
    const onConversationClosed = (event: Event) => {
      const closedConversationId = String((event as CustomEvent<{ conversationId?: string }>).detail?.conversationId || '');
      if (!closedConversationId || closedConversationId !== attachmentConversationIdRef.current) return;
      try {
        localStorage.removeItem(`${attachmentContextStoragePrefix}:${closedConversationId}`);
      } catch {}
      bindAttachmentContextToConversation('');
    };
    window.addEventListener('lumi:conversation-closed', onConversationClosed);
    return () => window.removeEventListener('lumi:conversation-closed', onConversationClosed);
  }, [attachmentContextStoragePrefix, bindAttachmentContextToConversation]);
  const rememberConversationAttachments = useCallback((attachments: ChatAttachment[]) => {
    const merged = mergeChatAttachmentReferences(conversationAttachmentsRef.current, attachments).attachments;
    conversationAttachmentsRef.current = merged;
    setConversationAttachments(merged);
    if (attachmentContextStorageKey) {
      try {
        localStorage.setItem(attachmentContextStorageKey, serializeChatAttachmentContext(merged));
      } catch {}
    }
  }, [attachmentContextStorageKey]);

  const clearConversationAttachments = useCallback(() => {
    conversationAttachmentsRef.current = [];
    setConversationAttachments([]);
    if (attachmentContextStorageKey) {
      try { localStorage.removeItem(attachmentContextStorageKey); } catch {}
    }
  }, [attachmentContextStorageKey]);

  return { conversationAttachments, conversationAttachmentsRef, attachmentConversationIdRef,
    bindAttachmentContextToConversation, rememberConversationAttachments, clearConversationAttachments };
}
