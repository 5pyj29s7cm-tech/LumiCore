import { describe, expect, it } from 'vitest';
import { createToolRouteSelection } from '../server/cognition/tool_route_selection';
import { mergeToolPolicyWithRoute, routeToolsForTurn } from '../server/cognition/tool_router';

const names = ['knowledge_file_stats', 'knowledge_coverage_report', 'desktop_running_processes', 'desktop_active_window',
  'desktop_list_files', 'desktop_path_info', 'read_file', 'search_files', 'extract_document_text', 'read_docx', 'read_pdf',
  'runtime_work_cancel', 'runtime_work_status', 'ocr_image_file', 'floorplan_extract_geometry', 'extension_registry_list',
  'generate_video', 'generate_image', 'write_file', 'desktop_open', 'client_action',
  'cad_draw_floorplan_in_autocad', 'cad_prepare_autocad_operations', 'mcp_cad-drafting_autocad_playback_file'];
const declarations = names.map(name => ({ type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object', properties: {} } } }));
const policy = { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 80 };

describe('one exact tool route owner', () => {
  it.each([
    ['查看当前知识库有多少文件，然后取消后台任务', ['runtime_work_cancel'], 'task_control'],
    ['检查当前打开的 WPS 文档，然后取消后台任务', ['runtime_work_cancel'], 'task_control'],
    ['只读取桌面设计草稿.jpg 的几何信息，先不要绘制，然后取消后台任务', ['runtime_work_cancel'], 'task_control'],
    ['查看后台任务进度，在 WPS 打开文件检查内容', ['runtime_work_status'], 'task_control'],
    ['列出签名扩展，在 WPS 打开文件检查内容', ['extension_registry_list'], 'extension_registry'],
    ['创建记忆中的小王虚拟人物，然后取消后台任务', ['runtime_work_cancel'], 'task_control'],
  ])('keeps the winning control scope executable: %s', (text, expected, category) => {
    const route = routeToolsForTurn(text as string, declarations, { enableMcpHealthGate: false });
    expect(route.toolNames).toEqual(expected);
    expect(route.categories).toEqual([category]);
    expect(route.hardAllowlist).toBe(true);
    expect(route.toolNames.every(name => !route.forbiddenToolNames?.includes(name))).toBe(true);
    expect(mergeToolPolicyWithRoute(policy, route).allowedTools).toEqual(expected);
  });

  it('does not retain a superseded knowledge scope as a document-read denial', () => {
    const route = routeToolsForTurn('查看当前知识库有多少文件，在 WPS 打开文件检查内容', declarations, { enableMcpHealthGate: false });
    expect(route.categories).toEqual(['current_document_inspection']);
    expect(route.toolNames).toEqual(expect.arrayContaining(['desktop_running_processes', 'desktop_active_window', 'read_file']));
    expect(mergeToolPolicyWithRoute(policy, route).allowedTools).toEqual(route.toolNames);
    expect(route.forbiddenToolNames).toEqual(expect.arrayContaining(['write_file', 'generate_video', 'runtime_work_cancel']));
  });

  it('does not infer a composite-only CAD scope merely from discovering that tool', () => {
    const route = routeToolsForTurn('分析 CAD 图纸并整理源几何', declarations, { enableMcpHealthGate: false });
    expect(route.toolNames).toContain('cad_draw_floorplan_in_autocad');
    expect(route.toolNames.length).toBeGreaterThan(1);
    expect(route.hardAllowlist).toBeUndefined();
    expect(route.maxIterations).toBeUndefined();
  });

  it('rejects late incidental tools outside an exact observation scope', () => {
    const selection = createToolRouteSelection(['desktop_active_window', 'write_file', 'generate_video']);
    selection.selected.add('write_file'); selection.selected.add('generate_video');
    const route = selection.resolve({ toolNames: ['desktop_active_window'], category: 'desktop_observation', reason: 'observe' });
    expect(route.toolNames).toEqual(['desktop_active_window']);
    expect(route.forbiddenToolNames).toEqual(['write_file', 'generate_video']);
  });

  it('keeps an explicit denial even when an exact scope requests that capability', () => {
    const selection = createToolRouteSelection(['read_file', 'write_file']);
    selection.forbiddenToolNames.add('write_file');
    const route = selection.resolve({ toolNames: ['read_file', 'write_file', 'unknown'], reason: 'scope', iterations: size => size });
    expect(route.toolNames).toEqual(['read_file']);
    expect(route.forbiddenToolNames).toEqual(['write_file']);
    expect(route.maxIterations).toBe(1);
  });

  it.each([['read_file'], ['*']])('preserves a parent policy denial when merging: %s', denial => {
    const route = { toolNames: ['read_file'], categories: [], reasons: [], totalAvailable: 1, maxTools: 8, truncated: false };
    const merged = mergeToolPolicyWithRoute({ ...policy, forbiddenTools: [denial] }, route);
    expect(merged.allowedTools).toEqual([]); expect(merged.forbiddenTools).toEqual([denial]);
  });

  it('does not expose unavailable tools or turn ordinary selection into a hard scope', () => {
    const selection = createToolRouteSelection(['read_file', 'write_file']);
    selection.selected.add('read_file'); selection.selected.add('unknown'); selection.selected.add('write_file');
    selection.forbiddenToolNames.add('write_file');
    expect(selection.resolve()).toEqual({ toolNames: ['read_file'], forbiddenToolNames: ['write_file'],
      hardAllowlist: undefined, maxIterations: undefined });
  });
});
