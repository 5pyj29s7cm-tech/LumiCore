// @vitest-environment jsdom
import React, { useMemo, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatAttachmentsAndPresentation } from '../src/components/agent_chat/state/use_chat_attachments_and_presentation';
import { ChatFilePreview, type ChatPreviewFile } from '../src/components/ChatFilePreview';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), fetch: vi.fn(), toast: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.toast } }));
vi.mock('../src/hooks/useGeneratedLibrary', () => ({ useGeneratedLibrary: () => ({ files: [], loading: false, failed: false, refresh: vi.fn() }) }));
vi.mock('../src/hooks/useConversationAttachments', () => ({ useConversationAttachments: () => ({
  conversationAttachments: [], conversationAttachmentsRef: { current: [] }, attachmentConversationIdRef: { current: 'native-open-chat' },
  bindAttachmentContextToConversation: vi.fn(), rememberConversationAttachments: vi.fn(), clearConversationAttachments: vi.fn(),
}) }));
vi.mock('../src/components/MediaGenerationStudio', () => ({ EMPTY_MEDIA_GENERATION_SOURCES: {} }));
const OriginalURL = URL;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue({ success: true, output: 'opened' });
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ kind: 'text', text: 'PREVIEW_BODY' }), blob: async () => new Blob(['fixture']) });
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL = vi.fn(() => 'blob:offline-preview'); static revokeObjectURL = vi.fn(); });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ref = <T,>(current: T) => ({ current });
function bindings(setPreviewFile: React.Dispatch<React.SetStateAction<ChatPreviewFile | null>>, platform: string) {
  const noop = vi.fn();
  return {
    isCreationWorkspace: false, chatExecutionSource: 'command-center-chat', isOpen: true, isOfficeCommandCenter: true, platform,
    agentId: 'lumi', agent: null, t: {}, user: { uid: 'ui-user', id: 'ui-user' }, activeDomain: 'personal', activeOrgId: '',
    pendingAttachments: [], pendingAttachmentsRef: ref([]), inputDictationActiveRef: ref(false), localCallState: 'idle',
    mediaStudioOpenRef: ref(false), activeMediaGenerationRef: ref(null), mediaGenerationArtifactsRef: ref([]), mediaGenerationArtifactValidationRef: ref(null),
    mediaSourceUploadTargetRef: ref(null), mediaSourceArtifacts: [], mediaGenerationArtifacts: [], messages: [],
    chatProgressClearTimerRef: ref(null), lastChatProgressTextRef: ref(''), chatTurnTimerGuardRef: ref({ dispose: noop, schedule: noop }),
    seenWorkflowToolEvents: ref(new Set()), draftTextRef: ref(''), messageInputRef: ref(null),
    chatViewWorkRef: ref({ invalidate: noop }), chatUploadsRef: ref({ reset: noop }),
    showVoicePicker: false, showWeChatSettings: false, showAttachmentMenu: false, conversationHistoryOpen: false, conversationContextMenu: null,
    setMediaStudioMode: noop, setMediaGenerationArtifacts: noop, setMediaGeneration: noop, setMediaGenerationRetryRequest: noop, setMediaSourceArtifacts: noop,
    setMediaSources: noop, setMediaSourceUploading: noop, endLocalVoiceSession: noop, setIsListening: noop, setChatProgressLines: noop,
    setWorkflowStatus: noop, setHasDraftText: noop, setShowVoicePicker: noop, setShowWeChatSettings: noop, setShowAttachmentMenu: noop,
    setConversationHistoryOpen: noop, setConversationContextMenu: noop, setAttachmentUploadFailures: noop, setIsOptimizing: noop, setOptimizationProgress: noop,
    setPreviewFile,
  } as any;
}
function Attachment({ extension, platform = 'tauri', explicit = false }: { extension: string; platform?: string; explicit?: boolean }) {
  const [preview, setPreview] = useState<ChatPreviewFile | null>(null);
  const previous = useMemo(() => bindings(setPreview, platform), [platform]);
  const { openChatFile } = useChatAttachmentsAndPresentation(previous);
  const file = { fileName: 'original.' + extension, path: 'C:/Documents/original.' + extension,
    openUrl: '/api/files/generated?path=' + encodeURIComponent('C:/Documents/original.' + extension) + '&conversationId=native-open-chat' };
  return <><button onClick={() => void openChatFile(file, explicit ? 'preview' : undefined)}>文件入口</button>
    {preview && <ChatFilePreview file={preview} isZh onClose={() => setPreview(null)} />}</>;
}
it.each(['docx', 'pdf'])('opens the actual local %s once with the existing native command and does not request a preview', async extension => {
  render(<Attachment extension={extension} />); fireEvent.click(screen.getByRole('button', { name: '文件入口' }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('open_item', { target: 'C:/Documents/original.' + extension }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.fetch).not.toHaveBeenCalled();
});
it('keeps explicit preview separate from native original opening', async () => {
  render(<Attachment extension="docx" explicit />); fireEvent.click(screen.getByRole('button', { name: '文件入口' }));
  await screen.findByText('PREVIEW_BODY');
  expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(new URL(mocks.fetch.mock.calls[0][0]).searchParams.get('preview')).toBe('1');
});
it.each(['rejected', 'unsuccessful'])('falls back to the existing preview if native opening is %s', async outcome => {
  if (outcome === 'rejected') mocks.invoke.mockRejectedValue(new Error('No default application'));
  else mocks.invoke.mockResolvedValue({ success: false, output: 'No default application' });
  render(<Attachment extension="pdf" />); fireEvent.click(screen.getByRole('button', { name: '文件入口' }));
  await screen.findByText('PREVIEW_BODY');
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('open_item', { target: 'C:/Documents/original.pdf' });
  expect(mocks.fetch).toHaveBeenCalledOnce(); expect(mocks.toast).toHaveBeenCalled();
});
it('keeps web documents in the existing preview without invoking a native command', async () => {
  render(<Attachment extension="pdf" platform="web" />); fireEvent.click(screen.getByRole('button', { name: '文件入口' }));
  await screen.findByText('PREVIEW_BODY'); expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.fetch).toHaveBeenCalledOnce();
});
it('keeps media in its existing preview without invoking a native document handler', async () => {
  render(<Attachment extension="png" />); fireEvent.click(screen.getByRole('button', { name: '文件入口' }));
  await screen.findByRole('img'); expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.fetch).toHaveBeenCalledOnce();
});
