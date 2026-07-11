import type { ToolExecutionRecord } from '../tools/types';

export interface DesktopObservationToolCall {
  name: 'desktop_active_window' | 'desktop_running_processes' | 'desktop_idle_time' | 'desktop_system_info';
  arguments: Record<string, any>;
}

function stripNegativeConstraints(value: string): string {
  return String(value || '')
    .replace(/(?:\u7981\u6b62|\u4e0d\u8981|\u4e0d\u51c6|\u4e0d\u5f97|\u4e0d\u7528|\u65e0\u9700|\u907f\u514d|\u52ff|\u522b)[^\u3002\uFF1B;.!?\n\r]*/giu, ' ')
    .replace(/\b(?:do\s+not|don't|never|must\s+not|without)\b[^.;!?\n\r]*/giu, ' ');
}

export function buildDesktopObservationPlan(input: string): DesktopObservationToolCall[] {
  const text = String(input || '').trim();
  if (!text) return [];

  const wantsActiveWindow = /\b(?:active|foreground|current)\s+window\b|\bwindow\s+title\b|(?:\u5f53\u524d|\u6d3b\u52a8|\u524d\u53f0)\u7a97\u53e3|\u7a97\u53e3\u6807\u9898/iu.test(text);
  const wantsProcesses = /\b(?:running\s+process(?:es)?|process\s+(?:list|state|status)|runtime\s+state|desktop\s+(?:state|status))\b|(?:\u8fd0\u884c|\u6d3b\u8dc3|\u5f53\u524d)\u8fdb\u7a0b|\u8fdb\u7a0b(?:\u5217\u8868|\u72b6\u6001|\u4fe1\u606f)|\u684c\u9762\u8fd0\u884c\u72b6\u6001/iu.test(text);
  const wantsIdle = /\b(?:idle\s+time|away\s+time)\b|\u7a7a\u95f2\u65f6\u95f4|\u591a\u4e45\u6ca1\u64cd\u4f5c/iu.test(text);
  const wantsSystem = /\b(?:system\s+info|os\s+info|cpu|memory|disk)\b|\u7cfb\u7edf\u4fe1\u606f|CPU|\u5185\u5b58|\u78c1\u76d8/iu.test(text);
  const wantsDesktopState = /\bdesktop\s+(?:state|status|runtime)\b|\u684c\u9762\u8fd0\u884c\u72b6\u6001|\u684c\u9762\u72b6\u6001/iu.test(text);
  if (!wantsActiveWindow && !wantsProcesses && !wantsIdle && !wantsSystem && !wantsDesktopState) return [];

  const positiveText = stripNegativeConstraints(text);
  const hasPositiveMutation = /\b(?:open|launch|start|click|type|switch|close|send|post|write|change|modify|run)\b|(?:\u6253\u5f00|\u542f\u52a8|\u70b9\u51fb|\u8f93\u5165|\u5207\u6362|\u5173\u95ed|\u53d1\u9001|\u53d1\u5e03|\u5199\u5165|\u4fee\u6539|\u8fd0\u884c)(?!\u72b6\u6001)/iu.test(positiveText);
  if (hasPositiveMutation) return [];

  const calls: DesktopObservationToolCall[] = [];
  if (wantsActiveWindow || wantsDesktopState) calls.push({ name: 'desktop_active_window', arguments: {} });
  if (wantsProcesses || wantsDesktopState) calls.push({ name: 'desktop_running_processes', arguments: { top: 20 } });
  if (wantsIdle || wantsDesktopState) calls.push({ name: 'desktop_idle_time', arguments: {} });
  if (wantsSystem) calls.push({ name: 'desktop_system_info', arguments: {} });
  return calls;
}

function parseResult(record: ToolExecutionRecord | undefined): any {
  if (!record) return null;
  try {
    return JSON.parse(String(record.result || ''));
  } catch {
    return null;
  }
}

export function formatDesktopObservationResult(
  records: ToolExecutionRecord[],
  taskText: string,
): string | null {
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
  if (successful.length === 0) return null;

  const active = parseResult([...successful].reverse().find(record => /^(desktop_active_window|get_active_window_info)$/i.test(record.name)));
  const processes = parseResult([...successful].reverse().find(record => /^(desktop_running_processes|get_running_processes)$/i.test(record.name)));
  const idle = parseResult([...successful].reverse().find(record => /^desktop_idle_time$/i.test(record.name)));
  const system = parseResult([...successful].reverse().find(record => /^(desktop_system_info|get_system_info)$/i.test(record.name)));
  const failures = records.filter(record => record.error);
  const hasMutation = successful.some(record =>
    /^(desktop_open|desktop_show_lumi_window|desktop_run_command|desktop_clipboard_write|desktop_mouse_|desktop_keyboard_|client_action|computer_use)/i.test(record.name)
  );
  const zh = /[\u3400-\u9fff]/u.test(taskText || '');

  if (!zh) {
    const lines = ['The desktop-state check completed with fresh evidence from the connected desktop client.'];
    if (active && typeof active === 'object') {
      const processLabel = active.process_name ? ` (${active.process_name}${active.pid ? `, PID ${active.pid}` : ''})` : '';
      const sizeLabel = Number(active.width) > 0 && Number(active.height) > 0 ? `, ${active.width}x${active.height}` : '';
      lines.push(`Active window: ${active.title || 'unknown'}${processLabel}${sizeLabel}.`);
    }
    if (Array.isArray(processes)) {
      const names = processes.slice(0, 5).map(item => String(item?.name || '')).filter(Boolean);
      lines.push(`Runtime state: ${processes.length} process entries were read${names.length ? `; leading entries: ${names.join(', ')}` : ''}.`);
    }
    if (idle && Number.isFinite(Number(idle.idle_seconds))) lines.push(`Desktop idle time: about ${Math.round(Number(idle.idle_seconds))} seconds.`);
    if (system && typeof system === 'object') lines.push('System information was refreshed successfully.');
    if (failures.length) lines.push(`Unavailable checks: ${failures.map(record => `${record.name}: ${record.error}`).join('; ')}.`);
    if (!hasMutation) lines.push('No click, typing, window switch, app launch, or content modification tool ran in this turn.');
    return lines.join('\n');
  }

  const lines = ['\u672c\u8f6e\u684c\u9762\u72b6\u6001\u8bfb\u53d6\u5df2\u5b8c\u6210\uff0c\u7ed3\u679c\u6765\u81ea\u5f53\u524d\u684c\u9762\u5ba2\u6237\u7aef\u7684\u5b9e\u65f6\u56de\u4f20\u3002'];
  if (active && typeof active === 'object') {
    const processLabel = active.process_name ? `\uff08${active.process_name}${active.pid ? `\uff0cPID ${active.pid}` : ''}\uff09` : '';
    const sizeLabel = Number(active.width) > 0 && Number(active.height) > 0 ? `\uff0c\u7a97\u53e3 ${active.width}x${active.height}` : '';
    lines.push(`\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff1a${active.title || '\u672a\u77e5'}${processLabel}${sizeLabel}\u3002`);
  }
  if (Array.isArray(processes)) {
    const names = processes.slice(0, 5).map(item => String(item?.name || '')).filter(Boolean);
    lines.push(`\u8fd0\u884c\u72b6\u6001\uff1a\u5df2\u8bfb\u53d6 ${processes.length} \u6761\u6d3b\u8dc3\u8fdb\u7a0b\u8bb0\u5f55${names.length ? `\uff0c\u524d\u51e0\u9879\u4e3a ${names.join('\u3001')}` : ''}\u3002`);
  }
  if (idle && Number.isFinite(Number(idle.idle_seconds))) lines.push(`\u684c\u9762\u7a7a\u95f2\u65f6\u95f4\uff1a\u7ea6 ${Math.round(Number(idle.idle_seconds))} \u79d2\u3002`);
  if (system && typeof system === 'object') lines.push('\u7cfb\u7edf\u4fe1\u606f\u5df2\u5b8c\u6210\u5237\u65b0\u3002');
  if (failures.length) lines.push(`\u672a\u5b8c\u6210\u7684\u8bfb\u53d6\uff1a${failures.map(record => `${record.name}: ${record.error}`).join('\uff1b')}\u3002`);
  if (!hasMutation) lines.push('\u672c\u8f6e\u6ca1\u6709\u6267\u884c\u70b9\u51fb\u3001\u8f93\u5165\u3001\u5207\u6362\u7a97\u53e3\u3001\u6253\u5f00\u5e94\u7528\u6216\u4fee\u6539\u5185\u5bb9\u3002');
  return lines.join('\n');
}
