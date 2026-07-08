/**
 * Proactive Triggers — rule engine matching ambient events to proactive actions.
 *
 * Listens to activity stream events (window changes, clipboard, idle state)
 * and generates proactive suggestions via socket emission to the frontend.
 */

import { Server as SocketIOServer } from 'socket.io';
import { ActivityEvent } from './activity_stream';
import { isURL, isErrorText, isCodeSnippet, isFilePath, isStackTrace, classifyClipboard } from './clipboard_monitor';

export interface ProactiveSuggestion {
  id: string;
  userId: string;
  type: 'clipboard_url' | 'clipboard_error' | 'clipboard_code' | 'clipboard_path' | 'clipboard_trace' | 'idle_greeting' | 'window_context';
  message: string;
  action?: string;
  context?: Record<string, any>;
  timestamp: string;
}

const cooldowns = new Map<string, number>();
const recentProactiveByUser = new Map<string, ProactiveSuggestion>();
const COOLDOWN_MS: Record<string, number> = {
  clipboard_url: 60_000,
  clipboard_error: 120_000,
  clipboard_code: 120_000,
  clipboard_path: 90_000,
  clipboard_trace: 180_000,
  idle_greeting: 300_000,
  window_context: 120_000,
};

function isOnCooldown(userId: string, type: string): boolean {
  const key = `${userId}_${type}`;
  const last = cooldowns.get(key) || 0;
  const cooldown = COOLDOWN_MS[type] || 60_000;
  if (Date.now() - last < cooldown) return true;
  cooldowns.set(key, Date.now());
  return false;
}

function buildClipboardContext(kind: string, text: string): Record<string, any> {
  const trimmed = text.trim();
  return {
    trigger: 'clipboard_changed',
    kind,
    preview: trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}...` : trimmed,
  };
}

function rememberProactiveSuggestion(suggestion: ProactiveSuggestion): void {
  recentProactiveByUser.set(suggestion.userId, suggestion);
}

function emitProactiveSuggestion(userId: string, io: SocketIOServer, suggestion: ProactiveSuggestion): void {
  rememberProactiveSuggestion(suggestion);
  io.to(`user:${userId}`).emit('agent:proactive', suggestion);
}

export function getRecentProactiveSuggestion(userId: string, maxAgeMs = 5 * 60_000): ProactiveSuggestion | null {
  const suggestion = recentProactiveByUser.get(userId);
  if (!suggestion) return null;
  const ageMs = Date.now() - new Date(suggestion.timestamp).getTime();
  if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
    recentProactiveByUser.delete(userId);
    return null;
  }
  return suggestion;
}

export function formatProactiveSuggestionForPrompt(suggestion: ProactiveSuggestion): string {
  const context = suggestion.context || {};
  const lines = [
    '## Recent Proactive Context',
    `Lumi recently initiated a prompt: "${suggestion.message}"`,
    `Type: ${suggestion.type}`,
  ];
  if (suggestion.action) lines.push(`Suggested action: ${suggestion.action}`);
  if (context.trigger === 'window_changed') {
    lines.push('Trigger: the user switched foreground windows.');
    if (context.appLabel || context.processName) lines.push(`Foreground app: ${context.appLabel || context.processName}`);
    if (context.windowTitle) lines.push(`Foreground title: ${context.windowTitle}`);
  } else if (context.trigger === 'clipboard_changed') {
    lines.push('Trigger: the user copied new clipboard content.');
    if (context.kind) lines.push(`Clipboard kind: ${context.kind}`);
    if (context.preview) lines.push(`Clipboard preview: ${String(context.preview).slice(0, 1200)}`);
  }
  lines.push('If the current voice input is a short affirmative or continuation such as "嗯", "好的", "帮我看", "继续", or "yes", treat it as referring to this proactive context. Do real work through tools when the suggested action requires inspection or operation; do not ask from scratch unless the context is insufficient.');
  return lines.join('\n');
}

export function processActivityEvent(
  event: ActivityEvent,
  userId: string,
  io: SocketIOServer,
): ProactiveSuggestion | null {
  // ── Clipboard URL copied ──
  if (event.type === 'clipboard_changed' && event.data?.text) {
    const text = event.data.text as string;
    if (isURL(text) && !isOnCooldown(userId, 'clipboard_url')) {
      const suggestion: ProactiveSuggestion = {
        id: `proactive_${Date.now()}`,
        userId,
        type: 'clipboard_url',
        message: '我注意到你复制了一个链接，需要我帮你打开或总结内容吗？',
        action: 'summarize_url',
        context: buildClipboardContext('url', text),
        timestamp: new Date().toISOString(),
      };
      // Emit to user's socket room
      emitProactiveSuggestion(userId, io, suggestion);
      return suggestion;
    }
    if (isErrorText(text) && !isOnCooldown(userId, 'clipboard_error')) {
      const suggestion: ProactiveSuggestion = {
        id: `proactive_${Date.now()}`,
        userId,
        type: 'clipboard_error',
        message: '看起来你遇到了一个错误，需要我帮你分析一下吗？',
        action: 'debug_error',
        context: buildClipboardContext('error', text),
        timestamp: new Date().toISOString(),
      };
      emitProactiveSuggestion(userId, io, suggestion);
      return suggestion;
    }
    if (isCodeSnippet(text) && !isOnCooldown(userId, 'clipboard_code')) {
      const suggestion: ProactiveSuggestion = {
        id: `proactive_${Date.now()}`,
        userId,
        type: 'clipboard_code',
        message: '我注意到你复制了一段代码，需要我帮你分析、优化或解释吗？',
        action: 'analyze_code',
        context: buildClipboardContext('code', text),
        timestamp: new Date().toISOString(),
      };
      emitProactiveSuggestion(userId, io, suggestion);
      return suggestion;
    }
    if (isFilePath(text) && !isOnCooldown(userId, 'clipboard_path')) {
      const suggestion: ProactiveSuggestion = {
        id: `proactive_${Date.now()}`,
        userId,
        type: 'clipboard_path',
        message: '你复制了一个文件路径，需要我打开或查看这个文件吗？',
        action: 'open_path',
        context: buildClipboardContext('path', text),
        timestamp: new Date().toISOString(),
      };
      emitProactiveSuggestion(userId, io, suggestion);
      return suggestion;
    }
    if (isStackTrace(text) && !isOnCooldown(userId, 'clipboard_trace')) {
      const suggestion: ProactiveSuggestion = {
        id: `proactive_${Date.now()}`,
        userId,
        type: 'clipboard_trace',
        message: '你复制了一个堆栈追踪，需要我帮你定位问题吗？',
        action: 'debug_trace',
        context: buildClipboardContext('stack_trace', text),
        timestamp: new Date().toISOString(),
      };
      emitProactiveSuggestion(userId, io, suggestion);
      return suggestion;
    }
  }

  // ── Window changed — check for known productivity apps ──
  if (event.type === 'window_changed' && event.data?.process_name) {
    const proc = (event.data.process_name as string).toLowerCase();
    const appSuggestions: Record<string, { message: string; action: string; appLabel: string }> = {
      'powerpnt.exe': { message: '需要我帮你制作演示文稿吗？', action: 'create_presentation', appLabel: 'PowerPoint' },
      'winword.exe': { message: '需要我帮你写文档或生成内容吗？', action: 'write_document', appLabel: 'Word' },
      'excel.exe': { message: '需要我帮你分析数据或创建表格吗？', action: 'analyze_spreadsheet', appLabel: 'Excel' },
      'devenv.exe': { message: '需要我帮你审查代码或调试问题吗？', action: 'analyze_code', appLabel: 'Visual Studio' },
      'code.exe': { message: '有什么代码问题我可以帮你？', action: 'analyze_code', appLabel: 'VS Code' },
    };
    const suggestionConfig = appSuggestions[proc];
    if (suggestionConfig?.message && !isOnCooldown(userId, 'window_context')) {
      const suggestion: ProactiveSuggestion = {
        id: `proactive_${Date.now()}`,
        userId,
        type: 'window_context',
        message: suggestionConfig.message,
        action: suggestionConfig.action,
        context: {
          trigger: 'window_changed',
          processName: event.data.process_name,
          windowTitle: event.data.title || '',
          appLabel: suggestionConfig.appLabel,
        },
        timestamp: new Date().toISOString(),
      };
      emitProactiveSuggestion(userId, io, suggestion);
      return suggestion;
    }
  }

  return null;
}
