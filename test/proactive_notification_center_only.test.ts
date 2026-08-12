import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('notification center-only delivery', () => {
  it('records proactive and away notifications without mounting an automatic popup', () => {
    const proactive = source('src/components/ProactiveNotifications.tsx');

    expect(proactive).toContain("socket.on('agent:proactive', handleProactive)");
    expect(proactive).toContain("socket.on('autonomous:away_summary', handleAwaySummary)");
    expect(proactive).toContain('addNotification({');
    expect(proactive).toContain('action: data.action');
    expect(proactive).toContain('proactiveContext: data.context');
    expect(proactive).not.toContain("from 'sonner'");
    expect(proactive).not.toContain('showProactiveToast');
    expect(proactive).not.toContain("socket.on('agent:tool_call'");
  });

  it('keeps agent notifications in state while suppressing their paired transient toast', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const preferenceHandler = between(desktop, 'const onPreferencesChanged', 'const onAgentPromoted');
    const promotedHandler = between(desktop, 'const onAgentPromoted', 'const onAgentNotification');
    const notificationHandler = between(desktop, 'const onAgentNotification', 'const onWakeDetected');

    expect(preferenceHandler).toContain('addNotification({');
    expect(preferenceHandler).not.toContain('toast');
    expect(promotedHandler).toContain('addNotification({');
    expect(promotedHandler).not.toContain('toast');
    expect(notificationHandler).toContain('addNotification({');
    expect(notificationHandler).not.toContain('toast');
  });

  it('keeps passive personality evolution in the notification center', () => {
    const evolution = source('src/components/PersonalityEvolution.tsx');
    const eventEffect = between(evolution, '// Listen for real-time evolution events via WebSocket', 'const triggerEvolution');

    expect(eventEffect).toContain("socket.on('personality:evolved', handler)");
    expect(eventEffect).toContain('addNotification({');
    expect(eventEffect).not.toContain('toast.');
  });

  it('does not duplicate global proactive popups from the sanctuary chat', () => {
    const sanctuary = source('src/components/Sanctuary.tsx');
    const socketEffect = between(sanctuary, '// Socket listeners', '// Auto-scroll');

    expect(sanctuary).not.toContain("from 'sonner'");
    expect(socketEffect).not.toContain("socket.on('agent:proactive'");
    expect(socketEffect).toContain("type: 'error'");
  });

  it('does not auto-open MCP or desktop-takeover panels for background events', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const mcpListener = between(desktop, '// MCP Live Activity socket listener', '// Workflow status listener');

    expect(mcpListener).toContain("socket.on('mcp:activity', handler)");
    expect(mcpListener).toContain('addNotification({');
    expect(desktop).not.toContain('setShowMcpPanel(true)');
    expect(desktop).not.toContain('showWallpaperWorkPrompt');
    expect(desktop).not.toContain('setWallpaperWorkPromptVisible(true)');
  });

  it('keeps socket and load failures inline instead of duplicating them as toasts', () => {
    const chat = source('src/components/AgentChatPage.tsx');
    const chatError = between(chat, 'const onError = (data:', '// conversation_updated:');
    const knowledge = source('src/components/KnowledgeBase.tsx');
    const knowledgeLoadError = between(knowledge, 'const reportLoadError', 'const scopedMemoryUrl');

    expect(chatError).toContain('setMessages(prev =>');
    expect(chatError).not.toContain('toast.');
    expect(knowledgeLoadError).toContain('setLoadError(message)');
    expect(knowledgeLoadError).not.toContain('toast.');
  });

  it('moves autonomous completion and failure alerts into the notification center', () => {
    const feed = source('src/components/AutonomousFeed.tsx');
    const failedHandler = between(feed, 'const recordFailedTask', 'const onCompleted');
    const completedHandler = between(feed, 'const onCompleted', 'const onFailed');

    expect(failedHandler).toContain('addNotification({');
    expect(failedHandler).not.toContain('toast.error');
    expect(completedHandler).toContain('addNotification({');
    expect(completedHandler).not.toContain('toast.success');
  });

  it('preserves unread count, notification list access, and click-through viewing', () => {
    const appContext = source('src/contexts/AppContext.tsx');
    const desktop = source('src/components/DesktopUI.tsx');
    const center = source('src/components/NotificationCenter.tsx');

    expect(appContext).toContain('const unreadCount = notifications.filter(n => !n.read).length');
    expect(appContext).toContain('read: false');
    expect(appContext).toContain('setNotifications(prev => [notification, ...prev].slice(0, 50))');
    expect(desktop).toContain("onClick={() => setIsNotificationPanelOpen(prev => !prev)}");
    expect(desktop).toContain('{unreadCount > 0 && (');
    expect(center).toContain('onClick={() => handleClick(n)}');
    expect(center).toContain('onChatMessage?.(item)');
  });
});
