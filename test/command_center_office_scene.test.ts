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

  it('keeps the office full-screen with floating chat and receipt ledger controls', () => {
    const chatPage = source('src/components/AgentChatPage.tsx');
    const panel = source('src/components/CommandCenterPanel.tsx');
    const surfaces = source('shared/client_surfaces.ts');

    expect(chatPage).toContain('className="absolute inset-0 z-0"');
    expect(chatPage).toContain("'pointer-events-auto absolute bottom-4 left-4 top-3 z-40");
    expect(panel).toContain('className="custom-scrollbar absolute bottom-4 right-4 top-16 z-30');
    expect(panel).toContain('className="absolute bottom-4 left-1/2 z-30');
    expect(panel).not.toContain("grid-cols-[minmax(0,1fr)_260px]");
    expect(panel).not.toContain('<TeamHub');
    expect(panel).toContain("onOpenNexus ? onOpenNexus() : onViewChange('core')");
    expect(surfaces).toContain("open_team: 'office'");
  });
});
