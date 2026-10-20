import { type ChatResponseFinalization } from "@/lib/chatProgress";
import { type CallState } from "@/hooks/useVoiceCall";
import { type ChatAttachmentReference } from "@/lib/chatAttachmentReferences";
import { type ChatArtifact } from "../../../shared/chat_artifacts";
import { type StructuredMediaRequest } from "../../../shared/media_generation";

export type WorkflowStatus = 'idle' | 'thinking' | 'background' | 'executing' | 'waiting_confirmation' | 'cancelling' | 'cancelled' | 'done' | 'error';


export type ChatTurnUiMeta = {
  hadTool: boolean;
  finalization: ChatResponseFinalization | null;
};


export interface AgentChatVoiceSession {
  callState: CallState;
  audioLevel: number;
  error: string | null;
  onStart: (conversationId?: string) => void;
  onEnd: () => void;
}


export type ConversationHistoryItem = {
  id: string;
  displayTitle?: string;
  title?: string;
  preview?: string;
  status: 'active' | 'paused' | 'closed';
  messageCount: number;
  lastActiveAt: string;
  createdAt: string;
};


export type ConversationHistoryContextMenu = {
  conversationId: string;
  x: number;
  y: number;
};


export type ChatAttachment = ChatAttachmentReference;


export type GeneratedFileLink = ChatArtifact;


export type ChatSendOptions = {
  onRequestCreated?: (requestId: string) => void;
  mediaRequest?: StructuredMediaRequest;
  includeConversationAttachments?: boolean;
};


export type ChatFilePanelItem = {
  id: string;
  fileName: string;
  subtitle: string;
  kind: GeneratedFileLink['kind'] | ChatAttachment['kind'];
  source: 'pending' | 'generated' | 'knowledge';
  fileId?: string;
  path?: string;
  openUrl?: string;
  saveUrl?: string;
  status?: string;
  mimeType?: string;
  size?: number;
};


export type KnowledgeUpdateDetail = {
  domain?: 'personal' | 'work';
  orgId?: string;
  files?: Array<{ id?: string; name?: string; displayName?: string }>;
};
