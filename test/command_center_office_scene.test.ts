import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('command center live agent office', () => {
  it('renders a native 2D Lumi workspace and dispatch animation from real task state', () => {
    const panel = source('src/components/CommandCenterPanel.tsx');
    const scene = source('src/components/AgentOfficeScene.tsx');
    const world = source('src/components/AgentOfficeWorld.tsx');

    expect(panel).toContain('<AgentOfficeScene');
    expect(panel).toContain('const state = deskState(agent, backgroundTasks)');
    expect(panel).toContain('taskTitle: task?.title');
    expect(scene).toContain('<AgentOfficeWorld');
    expect(world).toContain('function Employee');
    expect(world).toContain('function Workstation');
    expect(world).toContain('function OfficeChair');
    expect(world).toContain('function LumiCommander');
    expect(world).toContain('lumi-private-office__glass');
    expect(world).toContain('lumi-private-office__command-wall');
    expect(world).toContain('lumi-private-office__guest-seat');
    expect(world).toContain("worker.state === 'working'");
    expect(world).toContain('worker.taskTitle');
    expect(world).toContain('function TaskDispatchLayer');
    expect(world).toContain('const workstationPositions');
    expect(world).toContain('const officeSlots = workstationPositions.map');
    expect(world).toContain('is-vacant');
    expect(world).toContain('lumi-2d-workstation__vacancy');
    expect(scene).toContain('<AgentOfficeWorld workers={visibleWorkers}');
    expect(scene).toContain('lumi-office-floor-switch');
    expect(scene).toContain("workers.length === 0 && <div className=\"lumi-office-empty-note\"");
    expect(world).toContain('const activityRoutes');
    expect(world).toContain('function LumiWisp');
    expect(world).toContain('lumi-wisp__shell');
    expect(world).toContain('lumi-wisp__tendril--left');
    expect(world).toContain('lumi-wisp__step--right');
    expect(world).toContain('lumi-wisp__tail-shape');
    expect(world).toContain('function OfficeLife');
    expect(world).toContain('<animateMotion');
    expect(world).toContain('lumi-2d-node--roaming');
    expect(world).toContain('lumi-2d-node--seated');
    expect(world).toContain("worker.state === 'working'");
    expect(world).not.toContain('@react-three/fiber');
    expect(world).not.toContain('@react-three/drei');
    expect(world).not.toContain('useTexture');
    expect(world).not.toContain('planeGeometry');
    expect(world).not.toContain('lumi-actor');
    expect(source('src/index.css')).toContain('@keyframes lumi-wisp-form-walk');
    expect(source('src/index.css')).toContain('@keyframes lumi-wisp-work-tendril-left');
    expect(source('src/index.css')).toContain('@keyframes lumi-wisp-tendril-wave');
    expect(source('src/index.css')).toContain('@keyframes lumi-wisp-form-rest');
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
    const scene = source('src/components/AgentOfficeScene.tsx');
    const world = source('src/components/AgentOfficeWorld.tsx');

    expect(panel).not.toContain('Math.random');
    expect(scene).not.toContain('Math.random');
    expect(scene).not.toContain('setInterval');
    expect(scene).not.toContain('setTimeout');
    expect(world).not.toContain('Math.random');
    expect(world).not.toContain('setInterval');
    expect(world).not.toContain('setTimeout');
  });

  it('keeps the office mounted while task state refreshes silently', () => {
    const panel = source('src/components/CommandCenterPanel.tsx');

    expect(panel).toContain('const hasLoadedOfficeRef = useRef(false)');
    expect(panel).toContain('const refreshInFlightRef = useRef<Promise<void> | null>(null)');
    expect(panel).toContain('if (firstLoad) setLoading(true)');
    expect(panel).toContain('if (firstLoad) setLoading(false)');
    expect(panel).toContain('if (refreshInFlightRef.current) return refreshInFlightRef.current');
    expect(panel).toContain('setTimeout(() => void refresh(), 600)');
    expect(panel).toContain('setInterval(() => void refresh(), 60_000)');
  });

  it('keeps the office and chat in an integrated split workspace with transient task status', () => {
    const chatPage = source('src/components/AgentChatPage.tsx');
    const panel = source('src/components/CommandCenterPanel.tsx');
    const taskWidget = source('src/components/ActiveTaskWidget.tsx');
    const surfaces = source('shared/client_surfaces.ts');
    const styles = source('src/index.css');

    expect(chatPage).toContain('lumi-command-center-workspace overflow-hidden');
    expect(chatPage).toContain('lumi-command-center-office relative min-h-0 min-w-0 flex-1');
    expect(chatPage).toContain('lumi-command-center-chat-rail w-[clamp(420px,30vw,560px)]');
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
    expect(taskWidget).toContain("const ACTIVE_TASK_STATUSES = new Set(['planning', 'executing', 'waiting_confirmation'])");
    expect(taskWidget).toContain('AnimatePresence');
    expect(taskWidget).toContain('view.visible &&');
    expect(taskWidget).toContain('primaryTask?.evidence.verified');
    expect(panel).not.toContain('className="custom-scrollbar absolute bottom-4 right-4 top-16 z-30');
    expect(panel).toContain('className="absolute bottom-4 left-1/2 z-30');
    expect(panel).not.toContain("grid-cols-[minmax(0,1fr)_260px]");
    expect(panel).not.toContain('<TeamHub');
    expect(panel).toContain("onOpenNexus ? onOpenNexus() : onViewChange('core')");
    expect(surfaces).toContain("open_team: 'office'");
  });
});
