import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('command center live agent office', () => {
  it('renders people, desks, and Lumi dispatch animation from real task state', () => {
    const panel = source('src/components/CommandCenterPanel.tsx');
    const scene = source('src/components/AgentOfficeScene.tsx');
    const world = source('src/components/AgentOfficeWorld.tsx');

    expect(panel).toContain('<AgentOfficeScene');
    expect(panel).toContain('const state = deskState(agent, backgroundTasks)');
    expect(panel).toContain('taskTitle: task?.title');
    expect(scene).toContain('<AgentOfficeWorld');
    expect(world).toContain('function Avatar');
    expect(world).toContain('function Desk');
    expect(world).toContain('function LumiCommander');
    expect(world).toContain("const working = worker.state === 'working'");
    expect(world).toContain('worker.taskTitle');
    expect(world).toContain('function DispatchBeam');
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
