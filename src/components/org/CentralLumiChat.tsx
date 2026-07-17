import React, { useCallback, useState, useRef, useEffect } from 'react';
import { motion } from 'motion/react';
import { BrainCircuit, Building2, Send, Loader2, User, Bot, Settings, Paperclip, FileText, Mic, Image as ImageIcon, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '../../contexts/AppContext';
import { useSocket } from '../../hooks/useSocket';
import { useT } from '../../lib/useT';
import { uiMessage } from '../../i18n/uiMessages';
import {
  isTerminalAgentStatus,
  shouldDisplayAgentResponse,
  type AgentResponseDelivery,
} from '../../lib/agentResponseDelivery';

type ChatAttachment = {
  id: string;
  fileName: string;
  path?: string;
  content?: string | null;
  preview?: string | null;
  mimeType?: string;
  size?: number;
  kind: 'image' | 'audio' | 'file';
  fileId?: string;
  downloadUrl?: string;
  transcript?: string | null;
  transcriptionStatus?: string;
  transcriptionError?: string | null;
  transcriptionProvider?: string;
  transcriptionModel?: string;
};

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
  timestamp: number;
  source?: 'socket' | 'history' | 'error' | 'system';
}

interface LumiModelPreference {
  provider?: string;
  model?: string;
}

function makeMessageId(prefix = 'org-msg') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const CHAT_ATTACHMENT_ACCEPT = [
  '.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff',
  '.mp3,.mpeg,.wav,.m4a,.ogg,.oga,.flac,.aac,.wma,.webm',
  '.txt,.md,.json,.csv,.pdf,.docx,.xlsx,.xls,.pptx,.ppt,.rtf,.ts,.tsx,.js,.jsx,.py,.html,.css,.yaml,.yml,.xml,.log',
].join(',');

function isImageFileName(name: string, mimeType?: string): boolean {
  return Boolean(mimeType?.startsWith('image/')) || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(name || '');
}

function isAudioFileName(name: string, mimeType?: string): boolean {
  return Boolean(mimeType?.startsWith('audio/')) || /\.(mp3|mpeg|wav|m4a|ogg|oga|flac|aac|wma|webm)$/i.test(name || '');
}

function extractAudioTranscript(value?: string | null): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const marker = 'transcript:';
  const index = raw.toLowerCase().indexOf(marker);
  const transcript = index >= 0 ? raw.slice(index + marker.length).trim() : raw;
  return transcript || null;
}

function serializeChatAttachment(item: ChatAttachment): ChatAttachment {
  return {
    id: item.id,
    fileName: item.fileName,
    path: item.path,
    content: item.content || null,
    preview: item.preview || null,
    mimeType: item.mimeType || '',
    size: item.size || 0,
    kind: item.kind,
    fileId: item.fileId || '',
    downloadUrl: item.downloadUrl,
    transcript: item.transcript || null,
    transcriptionStatus: item.transcriptionStatus || '',
    transcriptionError: item.transcriptionError || null,
    transcriptionProvider: item.transcriptionProvider || '',
    transcriptionModel: item.transcriptionModel || '',
  };
}

function normalizeHistoryMessage(item: any): Message | null {
  if (item?.role === 'tool') return null;
  const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : null;
  if (!role) return null;
  const content = String(item.message || item.response || item.content || '').trim();
  if (!content) return null;
  return {
    id: item.id || makeMessageId('org-history'),
    role,
    content,
    timestamp: item.timestamp ? new Date(item.timestamp).getTime() : Date.now(),
    source: 'history',
  };
}

export function CentralLumiChat() {
  const t = useT();
  const socket = useSocket();
  const { orgConnection } = useApp();
  const isZh = t.langCode !== 'en';
  const ui = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);
  const greeting = useCallback((): Message => ({
    id: 'org-lumi-greeting',
    role: 'assistant',
    content: uiMessage('central-lumi-chat.hello-i-m-your-company.add6a8645c'),
    timestamp: Date.now(),
    source: 'system',
  }), [ui]);
  const [messages, setMessages] = useState<Message[]>(() => [greeting()]);
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [requestNotice, setRequestNotice] = useState('');
  const [modelPreference, setModelPreference] = useState<LumiModelPreference | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const streamingMessageIdRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearActiveRequest = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    activeRequestIdRef.current = null;
    streamingMessageIdRef.current = null;
    setLoading(false);
    setRequestNotice('');
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    const loadModelPreference = async () => {
      try {
        const res = await fetch('/api/preferences/llm', { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) setModelPreference(data);
      } catch {
        if (!cancelled) setModelPreference(null);
      }
    };
    void loadModelPreference();
    const handleModelChange = () => { void loadModelPreference(); };
    window.addEventListener('lumi:model-configuration-changed', handleModelChange);
    return () => {
      cancelled = true;
      window.removeEventListener('lumi:model-configuration-changed', handleModelChange);
    };
  }, []);

  const modelPreferenceLabel = uiMessage('central-lumi-chat.lumi-model.4d32a91f0c');
  const modelPreferenceValue = modelPreference
    ? `${modelPreference.provider || '-'} / ${modelPreference.model || '-'}`
    : uiMessage('central-lumi-chat.loading.7bfbe693d1');
  const openModelSettings = () => {
    window.dispatchEvent(new CustomEvent('lumi:client-action', {
      detail: { action: 'open_settings', section: 'reasoning-model' },
    }));
  };
  const scopedFileUrl = useCallback((path: string) => {
    const separator = path.includes('?') ? '&' : '?';
    const orgScope = orgConnection?.orgId ? `&orgId=${encodeURIComponent(orgConnection.orgId)}` : '';
    return `${path}${separator}domain=work${orgScope}`;
  }, [orgConnection?.orgId]);
  const notifyKnowledgeUpdated = useCallback((files?: Array<{ id?: string; name?: string; displayName?: string }>) => {
    window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', {
      detail: {
        domain: 'work',
        orgId: orgConnection?.orgId || undefined,
        files,
      },
    }));
    window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
  }, [orgConnection?.orgId]);

  const uploadChatAttachments = useCallback(async (files: FileList | null) => {
    const selectedFiles = Array.from(files || []);
    if (selectedFiles.length === 0) return;
    if (!orgConnection?.orgId) {
      toast.error('Please connect an organization workspace first.');
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      selectedFiles.forEach(file => formData.append('files', file));
      formData.append('domain', 'work');
      formData.append('orgId', orgConnection.orgId);

      const res = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Upload failed (${res.status})`);
      }

      const uploadedAttachments: ChatAttachment[] = (Array.isArray(data.files) ? data.files : []).map((file: any) => {
        const fileName = file.name || file.displayName || file.id || 'attachment';
        const mimeType = file.mimeType || '';
        const kind: ChatAttachment['kind'] =
          file.kind === 'image' || isImageFileName(fileName, mimeType) ? 'image' :
          file.kind === 'audio' || isAudioFileName(fileName, mimeType) ? 'audio' :
          'file';
        const transcript = kind === 'audio'
          ? extractAudioTranscript(file.transcript || file.content || file.preview || null)
          : null;

        return {
          id: `org-att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          fileName,
          path: file.path,
          content: file.content || null,
          preview: file.preview || null,
          mimeType,
          size: file.rawSize || file.size || 0,
          kind,
          fileId: file.id || fileName,
          downloadUrl: file.id ? scopedFileUrl(`/api/files/download/${encodeURIComponent(file.id)}?inline=1`) : undefined,
          transcript,
          transcriptionStatus: file.extractionStatus || (transcript ? 'indexed' : ''),
          transcriptionError: file.extractionError || file.syncError || null,
          transcriptionProvider: file.extractionProvider || undefined,
          transcriptionModel: file.extractionModel || undefined,
        };
      });

      if (uploadedAttachments.length === 0) {
        throw new Error('No files were returned by upload.');
      }

      setPendingAttachments(prev => [...prev, ...uploadedAttachments]);
      notifyKnowledgeUpdated(uploadedAttachments.map(item => ({
        id: item.fileId || item.path || item.fileName,
        name: item.fileName,
        displayName: item.fileName,
      })));

      const failedAudio = uploadedAttachments.find(item => item.kind === 'audio' && item.transcriptionError);
      if (failedAudio?.transcriptionError) {
        toast.error(failedAudio.transcriptionError);
      } else {
        toast.success('Attached to Lumi in the organization workspace.');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [notifyKnowledgeUpdated, orgConnection?.orgId, scopedFileUrl]);

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments(prev => prev.filter(item => item.id !== id));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadConversation = async () => {
      try {
        const activeRes = await fetch('/api/conversations/active?domain=work&agentId=lumi', {
          credentials: 'include',
        });
        const activeData = await activeRes.json().catch(() => ({}));
        const conversationId = activeData.activeConversation?.id;
        if (!activeRes.ok || !conversationId) {
          if (!cancelled) setMessages(prev => (prev.length ? prev : [greeting()]));
          return;
        }
        const messagesRes = await fetch(`/api/conversations/${conversationId}/messages?domain=work&limit=80`, {
          credentials: 'include',
        });
        const messagesData = await messagesRes.json().catch(() => ({}));
        if (!messagesRes.ok) return;
        const history = Array.isArray(messagesData.messages)
          ? messagesData.messages.map(normalizeHistoryMessage).filter(Boolean) as Message[]
          : [];
        if (!cancelled) setMessages(history.length > 0 ? history : [greeting()]);
      } catch {
        if (!cancelled) setMessages(prev => (prev.length ? prev : [greeting()]));
      }
    };
    loadConversation();
    return () => { cancelled = true; };
  }, [greeting]);

  useEffect(() => {
    if (!socket) return;

    const isCurrent = (data?: { requestId?: string }) => {
      return Boolean(activeRequestIdRef.current && data?.requestId === activeRequestIdRef.current);
    };

    const onChunk = (data: { text?: string; agentName?: string; requestId?: string }) => {
      if (!isCurrent(data) || !data.text) return;
      setLoading(false);
      setRequestNotice('');
      setMessages(prev => {
        const streamingId = streamingMessageIdRef.current;
        if (streamingId) {
          return prev.map(message => (
            message.id === streamingId
              ? { ...message, content: message.content + data.text }
              : message
          ));
        }
        const nextId = makeMessageId('org-stream');
        streamingMessageIdRef.current = nextId;
        return [...prev, {
          id: nextId,
          role: 'assistant',
          content: data.text || '',
          timestamp: Date.now(),
          source: 'socket',
        }];
      });
    };

    const onResponse = (data: AgentResponseDelivery & { requestId?: string }) => {
      if (!isCurrent(data)) return;
      setRequestNotice('');
      const finalText = (data.text || '').trim();
      if (!shouldDisplayAgentResponse(data)) {
        const streamingId = streamingMessageIdRef.current;
        if (streamingId) {
          setMessages(prev => prev.filter(message => message.id !== streamingId));
        }
        clearActiveRequest();
        return;
      }
      setMessages(prev => {
        const streamingId = streamingMessageIdRef.current;
        if (streamingId) {
          return prev.map(message => (
            message.id === streamingId
              ? { ...message, content: finalText || message.content }
              : message
          ));
        }
        if (!finalText) return prev;
        return [...prev, {
          id: makeMessageId('org-response'),
          role: 'assistant',
          content: finalText,
          timestamp: Date.now(),
          source: 'socket',
        }];
      });
      clearActiveRequest();
    };

    const onStatus = (data: { status?: string; requestId?: string }) => {
      if (!isCurrent(data)) return;
      if (data.status === 'thinking' || data.status === 'responding') {
        setLoading(true);
        setRequestNotice('');
      }
      if (data.status && isTerminalAgentStatus(data.status)) {
        const streamingId = streamingMessageIdRef.current;
        if (streamingId) {
          setMessages(prev => prev.filter(message => message.id !== streamingId));
        }
        clearActiveRequest();
      }
    };

    const onError = (data: { message?: string; requestId?: string }) => {
      if (!isCurrent(data)) return;
      setRequestNotice('');
      setMessages(prev => [...prev, {
        id: makeMessageId('org-error'),
        role: 'assistant',
        content: data.message || uiMessage('central-lumi-chat.lumi-can-t-answer-in.4cc9225c23'),
        timestamp: Date.now(),
        source: 'error',
      }]);
      clearActiveRequest();
    };

    socket.on('agent:chunk', onChunk);
    socket.on('agent:response', onResponse);
    socket.on('agent:status', onStatus);
    socket.on('agent:error', onError);

    return () => {
      socket.off('agent:chunk', onChunk);
      socket.off('agent:response', onResponse);
      socket.off('agent:status', onStatus);
      socket.off('agent:error', onError);
      clearActiveRequest();
    };
  }, [clearActiveRequest, socket, ui]);

  const handleSend = () => {
    const text = input.trim();
    const outgoingAttachments = pendingAttachments.map(serializeChatAttachment);
    if ((!text && outgoingAttachments.length === 0) || loading || uploading) return;
    setRequestNotice('');
    if (!socket) {
      setMessages(prev => [...prev, {
        id: makeMessageId('org-error'),
        role: 'assistant',
        content: uiMessage('central-lumi-chat.the-organization-chat-channel-is.340dac9249'),
        timestamp: Date.now(),
        source: 'error',
      }]);
      return;
    }
    if (!orgConnection?.orgId) {
      setMessages(prev => [...prev, {
        id: makeMessageId('org-error'),
        role: 'assistant',
        content: uiMessage('central-lumi-chat.please-connect-or-switch-to.6356c27681'),
        timestamp: Date.now(),
        source: 'error',
      }]);
      return;
    }

    const requestId = `org_chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const history = messages
      .filter(message => message.source !== 'error' && message.source !== 'system')
      .map(message => ({ role: message.role, content: message.content }));
    const outgoingText = text || 'Please review these attachments.';
    const userMsg: Message = {
      id: makeMessageId('org-user'),
      role: 'user',
      content: outgoingText,
      attachments: outgoingAttachments,
      timestamp: Date.now(),
      source: 'socket',
    };

    activeRequestIdRef.current = requestId;
    streamingMessageIdRef.current = null;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (activeRequestIdRef.current !== requestId) return;
      timeoutRef.current = null;
      setLoading(false);
      setRequestNotice(uiMessage('central-lumi-chat.lumi-is-taking-longer-than.0277a413ba'));
    }, 60000);

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setPendingAttachments([]);
    setLoading(true);
    socket.emit('agent:chat', {
      text: outgoingText,
      history,
      attachments: outgoingAttachments,
      personalityId: 'lumi',
      category: 'organization',
      agentId: 'lumi',
      domain: 'work',
      orgId: orgConnection.orgId,
      source: 'org-chat',
      requestId,
    });
  };

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-6 pb-4 border-b border-white/5">
        <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
          <Building2 size={20} className="text-blue-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-white">{t.orgChat}</h2>
          <p className="text-white/55 text-xs">{uiMessage('central-lumi-chat.same-lumi-organization-permissions-and.681e347d91')}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/60" title={modelPreferenceValue}>
            <BrainCircuit size={14} className="text-blue-300" />
            <span className="whitespace-nowrap">{modelPreferenceLabel}</span>
            <span className="hidden max-w-[180px] truncate text-white/35 md:inline">{modelPreferenceValue}</span>
          </div>
          <button
            type="button"
            onClick={openModelSettings}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/50 transition hover:bg-white/10 hover:text-white"
            title={uiMessage('central-lumi-chat.model-settings.f125a74d22')}
            aria-label={uiMessage('central-lumi-chat.open-model-settings.88d35c9bc1')}
          >
            <Settings size={15} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.map((msg) => (
          <motion.div
            key={msg.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
          >
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
              msg.role === 'user' ? 'bg-purple-500/10' : 'bg-blue-500/10'
            }`}>
              {msg.role === 'user' ? (
                <User size={14} className="text-purple-400" />
              ) : (
                <Bot size={14} className="text-blue-400" />
              )}
            </div>
            <div className={`max-w-[70%] rounded-2xl px-4 py-3 ${
              msg.role === 'user'
                ? 'bg-purple-500/10 border border-purple-500/20 text-white/90'
                : 'bg-white/5 border border-white/10 text-white/80'
            }`}>
              {Array.isArray(msg.attachments) && msg.attachments.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {msg.attachments.map(item => {
                    const card = (
                      <div className="flex min-w-0 items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/70">
                        {item.kind === 'image' && item.downloadUrl ? (
                          <img src={item.downloadUrl} alt={item.fileName} className="h-8 w-8 rounded-lg object-cover" loading="lazy" />
                        ) : item.kind === 'image' ? (
                          <ImageIcon size={16} className="text-blue-300" />
                        ) : item.kind === 'audio' ? (
                          <Mic size={16} className="text-blue-300" />
                        ) : (
                          <FileText size={16} className="text-white/50" />
                        )}
                        <span className="max-w-[180px] truncate">{item.fileName}</span>
                      </div>
                    );
                    return item.downloadUrl ? (
                      <a key={item.id} href={item.downloadUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 transition-opacity hover:opacity-80">
                        {card}
                      </a>
                    ) : (
                      <div key={item.id} className="min-w-0">{card}</div>
                    );
                  })}
                </div>
              )}
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
              <span className="text-xs text-white/45 mt-1 block">
                {new Date(msg.timestamp).toLocaleTimeString(isZh ? 'zh-CN' : undefined, { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </motion.div>
        ))}
        {loading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <Bot size={14} className="text-blue-400" />
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl px-4 py-3">
              <Loader2 size={16} className="animate-spin text-blue-400" />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-white/5">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={CHAT_ATTACHMENT_ACCEPT}
          onChange={(event) => { void uploadChatAttachments(event.target.files); }}
          className="hidden"
        />
        {requestNotice && (
          <div className="mb-3 rounded-xl border border-blue-400/20 bg-blue-500/10 px-3 py-2 text-xs leading-relaxed text-blue-100/75">
            {requestNotice}
          </div>
        )}
        {pendingAttachments.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {pendingAttachments.map(item => (
              <div
                key={item.id}
                className="group flex max-w-full items-center gap-2 rounded-xl border border-blue-400/20 bg-blue-500/10 px-3 py-2 text-xs text-white/75"
              >
                {item.kind === 'image' && item.downloadUrl ? (
                  <img src={item.downloadUrl} alt={item.fileName} className="h-7 w-7 rounded-lg object-cover" loading="lazy" />
                ) : item.kind === 'image' ? (
                  <ImageIcon size={15} className="text-blue-300" />
                ) : item.kind === 'audio' ? (
                  <Mic size={15} className="text-blue-300" />
                ) : (
                  <FileText size={15} className="text-white/50" />
                )}
                <span className="max-w-[220px] truncate">{item.fileName}</span>
                {item.transcriptionStatus && item.kind === 'audio' && (
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/45">
                    {item.transcriptionStatus}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removePendingAttachment(item.id)}
                  className="rounded-lg p-1 text-white/35 transition hover:bg-white/10 hover:text-white"
                  aria-label="Remove attachment"
                  title="Remove attachment"
                >
                  <XCircle size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading || uploading || !orgConnection?.orgId}
            className="p-3 rounded-xl border border-white/10 bg-white/5 text-white/65 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            title="Attach files"
            aria-label="Attach files"
          >
            {uploading ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
          </button>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder={uiMessage('central-lumi-chat.ask-about-company-policies-knowledge.95b8a73f10')}
            className="flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white text-sm placeholder:text-white/45 focus:outline-none focus:border-blue-500/40"
          />
          <button
            onClick={handleSend}
            disabled={(!input.trim() && pendingAttachments.length === 0) || loading || uploading}
            className="p-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white transition-colors"
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}
