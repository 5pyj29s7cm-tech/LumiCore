/**
 * Continuous Activity Stream — tracks ambient user activity events.
 *
 * Events are pushed from the Tauri frontend via poll_activity and from
 * the clipboard monitor. The stream feeds proactive triggers.
 */

export type ActivityEventType =
  | 'window_changed'
  | 'clipboard_changed'
  | 'user_idle_start'
  | 'user_idle_end';

export interface ActivityEvent {
  type: ActivityEventType;
  timestamp: string;
  data?: Record<string, any>;
}

const MAX_EVENTS = 100;
const activityBuffers = new Map<string, ActivityEvent[]>();

export function clearActivityStream(userId: string): void {
  activityBuffers.delete(userId);
  idleState.delete(userId);
}

export function pushActivityEvent(userId: string, event: ActivityEvent): void {
  if (!activityBuffers.has(userId)) {
    activityBuffers.set(userId, []);
  }
  const buffer = activityBuffers.get(userId)!;
  buffer.push(event);
  if (buffer.length > MAX_EVENTS) {
    buffer.shift();
  }
}

export function getRecentActivity(userId: string, limit = 20): ActivityEvent[] {
  const buffer = activityBuffers.get(userId) || [];
  return buffer.slice(-limit);
}

export function getLastEvent(userId: string, type?: ActivityEventType): ActivityEvent | null {
  const buffer = activityBuffers.get(userId) || [];
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (!type || buffer[i].type === type) return buffer[i];
  }
  return null;
}

/** Track per-user state machine for idle transitions */
const idleState = new Map<string, { isIdle: boolean; idleSince?: string }>();

export function getIdleState(userId: string): { isIdle: boolean; idleSince?: string } {
  return idleState.get(userId) || { isIdle: false };
}

export function setIdleState(userId: string, isIdle: boolean): void {
  const prev = idleState.get(userId);
  if (prev?.isIdle !== isIdle) {
    idleState.set(userId, {
      isIdle,
      idleSince: isIdle ? new Date().toISOString() : undefined,
    });
    pushActivityEvent(userId, {
      type: isIdle ? 'user_idle_start' : 'user_idle_end',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Parse an IDE window title to extract file name and project name.
 * Handles VS Code, Cursor, JetBrains, Notepad++, and more.
 */
function parseIDEWindow(title: string, processName: string): { fileName?: string; projectName?: string } | null {
  const idePatterns: Array<{ proc: RegExp; titleRegex: RegExp }> = [
    // VS Code / Cursor: "file.ts - ProjectName - Visual Studio Code"
    { proc: /^(code|cursor)$/i, titleRegex: /^(.+?)\s*[-—]\s*(.+?)\s*[-—]\s*(Visual Studio Code|Cursor|VSCodium|Code - Insiders)$/ },
    // JetBrains: "file.ts - ProjectName - IntelliJ IDEA"
    { proc: /^(idea64|idea|webstorm64|webstorm|pycharm64|pycharm|goland64|goland|rustrover64|rustrover|clion64|clion)$/i, titleRegex: /^(.+?)\s*[-—]\s*(.+?)\s*[-—]\s*(.+)$/ },
    // Notepad++: "file.ts - Notepad++"
    { proc: /^notepad\+\+$/i, titleRegex: /^(.+?)\s*[-—]\s*Notepad\+\+$/ },
    // Sublime: "file.ts - Sublime Text"
    { proc: /^sublime_text$/i, titleRegex: /^(.+?)\s*[-—]\s*(Sublime Text|Sublime Merge)$/ },
    // Windows Terminal / CMD / PowerShell: extract working dir from title
    { proc: /^(windowsTerminal|cmd|powershell)$/i, titleRegex: /^(Administrator\s*:\s*)?(.+?)$/ },
  ];

  for (const { proc, titleRegex } of idePatterns) {
    if (proc.test(processName)) {
      const match = title.match(titleRegex);
      if (match) {
        if (proc.source.includes('code|cursor') || proc.source.includes('idea|webstorm')) {
          return { fileName: match[1]?.trim(), projectName: match[2]?.trim() };
        }
        if (proc.source.includes('notepad|sublime')) {
          return { fileName: match[1]?.trim() };
        }
        if (proc.source.includes('windowsTerminal|cmd')) {
          return { projectName: match[2]?.trim() };
        }
      }
    }
  }

  // Generic: check if title looks like a file path
  const fileMatch = title.match(/^(.+\.(ts|tsx|js|jsx|py|rs|go|java|cpp|c|h|css|html|json|yaml|yml|toml|sql|md|txt))\s/i);
  if (fileMatch) {
    return { fileName: fileMatch[1] };
  }

  return null;
}

/** Build a desktop context block for the LLM system prompt — what app the user is in right now */
export function getDesktopContext(userId: string): string | null {
  const lastWindow = getLastEvent(userId, 'window_changed');
  if (!lastWindow || !lastWindow.data) return null;

  const { title, process_name } = lastWindow.data;
  const age = (Date.now() - new Date(lastWindow.timestamp).getTime()) / 1000;

  // Stale window info (> 30 seconds) — don't inject, might be misleading
  if (age > 30) return null;

  const appName = process_name?.replace(/\.exe$/i, '') || 'Unknown';
  const ide = parseIDEWindow(title || '', process_name || '');

  const lines: string[] = [];
  lines.push('\n## Desktop Context');
  lines.push(`The user is currently in **${appName}** — active window: "${title || 'Unknown'}".`);

  if (ide?.fileName) {
    lines.push(`- Current file: **${ide.fileName}**`);
  }
  if (ide?.projectName) {
    lines.push(`- Project: **${ide.projectName}**`);
  }

  // IDE-specific guidance
  const isTerminal = /^(cmd|powershell|windowsTerminal|terminal|alacritty|wezterm)$/i.test(process_name || '');
  const isIDE = /^(code|cursor|idea64|idea|webstorm|pycharm|goland|rustrover|clion|notepad\+\+|sublime_text)$/i.test(process_name || '');
  const isBrowser = /^(chrome|msedge|firefox|brave|opera|msedgewebview2)$/i.test(process_name || '');

  if (isIDE) {
    lines.push('- The user is writing code. When they say "this" or "here", they mean the current file. Use `read_file` or `grep_files` to understand context.');
  }
  if (isTerminal) {
    lines.push('- The user is in a terminal. They may want to run commands. Prefer `run_command` for CLI operations.');
  }
  if (isBrowser) {
    lines.push('- The user is browsing the web. They may want to search, open URLs, or analyze page content. Use `web_search` or `url_fetch`.');
  }

  lines.push('- Use this context only when the user refers to "this", "here", the current app, their screen, or when it is necessary to complete the requested work.');
  lines.push('- Keep ambient desktop context silent otherwise. Do not mention the foreground app, project, file, or inferred activity as conversational small talk unless the user asks or it materially resolves an ambiguity.');

  return lines.join('\n');
}
