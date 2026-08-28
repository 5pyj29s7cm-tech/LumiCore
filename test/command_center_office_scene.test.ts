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

  it('keeps the app topmost when either Command Center or Wallpaper is active', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const systemService = source('src/services/systemService.ts');

    expect(desktop).toContain('chatOpen || isWallpaperMode || isDesktopWidgetMode');
    expect(desktop).toContain('systemService.setAlwaysOnTop(shouldStayOnTop)');
    expect(desktop).toContain('systemService.setAlwaysOnTop(chatOpen || isWallpaperModeRef.current)');
    expect(systemService).toContain('getCurrentWindow().setAlwaysOnTop(enabled)');
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

  it('keeps the office and chat in an integrated split workspace with transient task status', () => {
    const chatPage = source('src/components/AgentChatPage.tsx');
    const panel = source('src/components/CommandCenterPanel.tsx');
    const taskWidget = source('src/components/ActiveTaskWidget.tsx');
    const surfaces = source('shared/client_surfaces.ts');
    const styles = source('src/index.css');

    expect(chatPage).toContain('lumi-command-center-workspace overflow-hidden');
    expect(chatPage).toContain('lumi-command-center-office relative min-h-0 min-w-0 flex-1');
    expect(chatPage).toContain('data-command-center-cosmos-stage');
    expect(chatPage).toContain("{ opacity: 0, x: '100%' }");
    expect(chatPage).toContain('lumi-command-center-chat-rail--entering w-[clamp(420px,30vw,560px)]');
    expect(chatPage).toContain('useReducedMotion()');
    expect(chatPage).not.toContain('absolute bottom-4 right-4 top-3');
    expect(styles).toContain('.lumi-command-center-workspace');
    expect(styles).toContain('flex-direction: row');
    expect(styles).toContain('@media (max-width: 900px)');
    expect(styles).toContain('flex-direction: column');
    expect(chatPage).toContain('<ActiveTaskWidget');
    expect(chatPage).toContain('<VoiceCallButton');
    expect(chatPage).toContain('setShowWeChatSettings(true)');
    expect(chatPage).toContain('toggleConversationHistory');
    expect(chatPage).not.toContain('conversationPanelView');
    expect(chatPage).not.toContain('<ConversationTaskLedger');
    expect(chatPage).toContain('!isOfficeCommandCenter && (');
    expect(chatPage).toContain('<div className="lumi-chat-voice-picker relative"');
    expect(chatPage).toContain('onClick={requestMeetingMode}');
    expect(chatPage).toContain("isOfficeCommandCenter ? 'hidden' : ''");
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
});
