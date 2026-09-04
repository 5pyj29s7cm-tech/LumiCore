import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('single-core command center', () => {
  it('renders one LumiCore sphere with task state in orbit', () => {
    const panel = source('src/components/CommandCenterPanel.tsx');
    const sphere = source('src/components/LumiCoreSphere.tsx');

    expect(panel).toContain('<LumiCoreSphere');
    expect(panel).toContain('buildLumiCoreOrbitTasks(tasks)');
    expect(panel).toContain('tasks={orbitTasks}');
    expect(panel).toContain('state={coreState}');
    expect(sphere).toContain('const activeTasks = tasks.filter(task => task.active).slice(0, 8)');
    expect(sphere).toContain('{activeTasks.map((task, index) =>');
  });

  it('uses a deterministic orbital field and respects reduced-motion preferences', () => {
    const sphere = source('src/components/LumiCoreSphere.tsx');
    const styles = source('src/index.css');

    expect(sphere).toContain('data-lumi-core-command-field');
    expect(sphere).toContain('const COSMOS_STARS = [');
    expect(sphere).toContain('useReducedMotion()');
    expect(sphere).toContain('data-lumi-core-field-state={state}');
    expect(sphere).not.toContain('Math.random');
    expect(styles).toContain('.lumi-core-command-field__routes');
    expect(styles).toContain('@keyframes lumi-core-route-flow');
    expect(styles).toContain('.lumi-command-center-office--orbital::before');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('keeps the app topmost for Command Center and controlled desktop overlays only', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const systemService = source('src/services/systemService.ts');

    expect(desktop).toContain("(isWallpaperMode && wallpaperPresentation === 'desktop-control')");
    expect(desktop).toContain('systemService.setAlwaysOnTop(shouldStayOnTop)');
    expect(desktop).toContain('(!isWallpaperMode && chatOpen)');
    expect(desktop).toContain("isWallpaperModeRef.current && wallpaperPresentationRef.current === 'desktop-control'");
    expect(systemService).toContain('getCurrentWindow().setAlwaysOnTop(enabled)');
  });

  it('inherits the global light appearance at compact and full window sizes', () => {
    const chatPage = source('src/components/AgentChatPage.tsx');
    const panel = source('src/components/CommandCenterPanel.tsx');
    const styles = source('src/index.css');

    expect(chatPage).toContain('data-command-center-appearance={');
    expect(chatPage).toContain("'--lumi-chat-background': chatAccentTheme.background");
    expect(panel).toContain('lumi-command-center-panel');
    expect(styles).toContain('[data-compact-layout="true"] .lumi-chat-root {\n  background: var(--lumi-chat-background');
    expect(styles).toContain('html[data-mode="light"] .lumi-chat-root[data-lumi-command-center-view]');
    expect(styles).toContain('--cc-layer-bg: #f7faf7');
    expect(styles).toContain('background: var(--cc-office-bg');
    expect(styles).toContain('background: var(--cc-layer-field-bg');
    expect(styles).not.toContain('[data-compact-layout="true"] .lumi-chat-root {\n  background: #02050a !important;');
  });

  it('does not manufacture a fake working state or random activity', () => {
    const panel = source('src/components/CommandCenterPanel.tsx');
    const sphere = source('src/components/LumiCoreSphere.tsx');

    expect(panel).not.toContain('Math.random');
    expect(sphere).not.toContain('Math.random');
    expect(panel).toContain('commandCenterTaskIsActive(task)');
    expect(panel).toContain("const coreState = hasAttention ? 'attention' : activeTasks.length > 0 ? 'working' : 'ready'");
  });

  it('keeps the command center mounted while task state refreshes', () => {
    const panel = source('src/components/CommandCenterPanel.tsx');

    expect(panel).toContain('const refreshInFlightRef = useRef<Promise<void> | null>(null)');
    expect(panel).toContain('if (refreshInFlightRef.current) return refreshInFlightRef.current');
    expect(panel).toContain('<LumiCoreSphere');
    expect(panel).not.toContain('loading ? (');
    expect(panel).toContain("'autonomous:task_started'");
    expect(panel).toContain('timer = setTimeout(() => { void refresh(); void refreshRuntime(); }, 100)');
  });

  it('keeps the command-center core behind a left conversation and right navigation rail', () => {
    const chatPage = source('src/components/AgentChatPage.tsx');
    const panel = source('src/components/CommandCenterPanel.tsx');
    const taskWidget = source('src/components/ActiveTaskWidget.tsx');
    const surfaces = source('shared/client_surfaces.ts');
    const styles = source('src/index.css');

    expect(chatPage).toContain('lumi-command-center-workspace lumi-command-center-layered overflow-hidden');
    expect(chatPage).toContain('lumi-command-center-office lumi-command-center-cosmos-stage');
    expect(chatPage).toContain('relative min-h-0 min-w-0 flex-1');
    expect(chatPage).toContain('data-command-center-cosmos-stage');
    expect(chatPage).toContain("{ opacity: 0, x: '100%' }");
    expect(chatPage).toContain('lumi-command-center-chat-rail lumi-command-center-chat-rail--entering');
    expect(chatPage).toContain('relative z-20 min-w-0 flex-1');
    expect(chatPage).toContain('lumi-command-center-conversation-layout');
    expect(chatPage).toContain('data-command-center-history-rail');
    expect(chatPage).toContain('conversationHistoryLoadingMore');
    expect(chatPage).toContain('handleConversationHistoryScroll');
    expect(chatPage).toContain('offset=${offset}');
    expect(chatPage).toContain('data-command-center-right-rail="true"');
    expect(chatPage).toContain('data-memory-avatar-switch');
    expect(chatPage).toContain('data-lumi-core-switch');
    expect(chatPage).toContain('data-knowledge-base-switch');
    expect(chatPage).toContain('onContextMenu={(event) =>');
    expect(chatPage).toContain('deleteConversationFromHistory');
    expect(chatPage).toContain('data-command-center-conversation-context-menu');
    expect(chatPage).toContain('lumi-command-center-chat-scroll');
    expect(chatPage).toContain("msg.type === 'agent' ? 'items-start' : 'items-end'");
    expect(chatPage).toContain('lumi-command-center-history-item-preview');
    expect(chatPage).toContain('lumi-command-center-history-item-meta');
    expect(chatPage).toContain('data-command-center-history-selector');
    expect(chatPage).toContain('conversationHistorySelectorExpanded');
    expect(chatPage).toContain('lumi-command-center-history-selector-mark');
    expect(chatPage).toContain('lumi-command-center-history-item-marker');
    expect(chatPage).toContain('onMouseLeave={() => setConversationHistorySelectorExpanded(false)}');
    expect(chatPage).toContain('data-command-center-new-conversation');
    expect(chatPage).toContain('data-command-center-message-type');
    expect(chatPage).not.toContain('lumi-command-center-history-new');
    expect(chatPage).toContain('command-center.inner-realm.4d8f2a1c09');
    expect(chatPage).toContain('lumi-command-center-message-text');
    expect(chatPage).toContain('lumi-command-center-progress-text');
    expect(chatPage).toContain('data-command-center-integrated-identity');
    expect(chatPage).toContain('lumi-command-center-integrated-voice');
    expect(chatPage).toContain('!isCommandCenterUtility && !isOfficeCommandCenter');
    expect(chatPage).toContain('useReducedMotion()');
    expect(chatPage).not.toContain('absolute bottom-4 right-4 top-3');
    expect(styles).toContain('.lumi-command-center-workspace');
    expect(styles).toContain('.lumi-command-center-layered');
    expect(styles).toContain('flex-direction: column');
    expect(styles).toContain('z-index: 20');
    expect(panel).toContain('backgroundOnly');
    expect(panel).toContain('data-command-center-background');
    expect(chatPage).toContain('lumi-command-center-background-task-widget');
    expect(styles).toContain('.lumi-command-center-layered .lumi-command-center-background-task-widget');
    expect(styles).toContain('display: none');
    expect(styles).toContain('.lumi-command-center-layered .lumi-command-center-conversation-layout');
    expect(styles).toContain('.lumi-command-center-layered .lumi-command-center-switcher');
    expect(styles).toContain('scrollbar-width: none');
    expect(styles).toContain('.lumi-command-center-switcher-copy');
    expect(styles).toContain('.lumi-command-center-history-item-preview {\n  display: none;');
    expect(styles).toContain('.lumi-command-center-history-item-meta {\n  display: none;');
    expect(styles).toContain('--command-center-rail-width: clamp(220px, 20vw, 300px)');
    expect(styles).toContain('.lumi-command-center-history-rail');
    expect(styles).toContain('--history-selector-collapsed-width');
    expect(styles).toContain('.lumi-command-center-history-rail:hover .lumi-command-center-history-list');
    expect(styles).toContain('.lumi-command-center-history-item:nth-child(2)');
    expect(styles).toContain('.lumi-command-center-history-item:nth-child(n+4)');
    expect(styles).toContain('padding: clamp(.75rem, 2vw, 1.75rem) clamp(1rem, 2vw, 2.25rem)');
    expect(styles).toContain('.lumi-command-center-message-text');
    expect(styles).toContain('.lumi-command-center-message-row[data-command-center-message-type="user"] > *');
    expect(styles).toContain('flex-direction: row');
    expect(styles).toContain('@media (max-width: 900px)');
    expect(styles).toContain('flex-direction: column');
    expect(chatPage).toContain('<ActiveTaskWidget');
    expect(chatPage).toContain('<VoiceCallButton');
    expect(chatPage).toContain('setShowWeChatSettings(true)');
    expect(chatPage).toContain('toggleConversationHistory');
    expect(chatPage).not.toContain('aria-expanded={conversationHistoryOpen}');
    expect(chatPage).not.toContain('conversationPanelView');
    expect(chatPage).not.toContain('<ConversationTaskLedger');
    expect(chatPage).toContain('!isOfficeCommandCenter && (');
    expect(chatPage).toContain('<div className="lumi-chat-voice-picker relative"');
    expect(chatPage).toContain('onClick={requestMeetingMode}');
    expect(chatPage).toContain("isOfficeCommandCenter ? 'hidden' : 'inline-flex'");
    expect(taskWidget).toContain("const ACTIVE_TASK_STATUSES = new Set(['created', 'planning', 'executing', 'verifying', 'waiting_confirmation'])");
    expect(taskWidget).toContain('AnimatePresence');
    expect(taskWidget).toContain('view.visible &&');
    expect(taskWidget).toContain('primaryRuntimeTask?.evidence.verified');
    expect(panel).not.toContain('className="custom-scrollbar absolute bottom-4 right-4 top-16 z-30');
    expect(panel).toContain('className="absolute bottom-4 left-1/2 z-30');
    expect(panel).not.toContain("grid-cols-[minmax(0,1fr)_260px]");
    expect(panel).toContain("onOpenNexus ? onOpenNexus() : onViewChange('core')");
    expect(surfaces).toContain("'open_command_center'");
  });

  it('places image and video generation below Knowledge Base and renders a real media workspace', () => {
    const chatPage = source('src/components/AgentChatPage.tsx');
    const knowledgeIndex = chatPage.indexOf('data-knowledge-base-switch');
    const imageGenerationIndex = chatPage.indexOf('data-image-generation-switch');
    const videoGenerationIndex = chatPage.indexOf('data-video-generation-switch');

    expect(knowledgeIndex).toBeGreaterThan(-1);
    expect(imageGenerationIndex).toBeGreaterThan(knowledgeIndex);
    expect(videoGenerationIndex).toBeGreaterThan(imageGenerationIndex);
    expect(chatPage).toContain('data-media-generation-studio');
    expect(chatPage).toContain("kind === 'video'");
    expect(chatPage).toContain('<video');
  });
});
