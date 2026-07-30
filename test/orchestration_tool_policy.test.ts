import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildOrchestrationWorkerTaskText,
  buildOrchestrationWorkerToolPolicy,
  isTerminalOrchestrationToolEvent,
} from '../server/agents/orchestrator';
import { filterChainerToolNamesByPolicy } from '../server/agents/nl_chainer';
import { isForbiddenLocalCadImageFallback } from '../server/llm/adapter';

function declaration(name: string) {
  return {
    type: 'function' as const,
    function: {
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
    },
  };
}

const declarations = [
  'work_product_plan',
  'work_product_verify',
  'desktop_list_files',
  'desktop_path_info',
  'desktop_system_info',
  'desktop_capture_screen',
  'floorplan_extract_geometry',
  'ocr_image_file',
  'ocr_screen',
  'cad_generate_dxf',
  'cad_prepare_autocad_operations',
  'mcp_cad-drafting_autocad_playback_file',
  'mcp_cad-drafting_cad_renovation_folder_workflow',
  'mcp_filesystem_read_media_file',
  'mcp_filesystem_read_file',
  'read_file',
  'desktop_open',
  'desktop_active_window',
  'get_active_window_info',
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_click',
  'desktop_ui_invoke',
  'desktop_ui_type',
  'write_file',
  'list_directory',
  'search_files',
  'grep_files',
  'create_docx',
  'create_pdf',
  'create_ppt',
  'run_command',
  'desktop_run_command',
  'code_execution',
  'python_exec',
  'powershell',
  'shell_exec',
  'terminal_exec',
  'wechat_send_message',
].map(declaration);

describe('orchestration and replan tool policy', () => {
  it('keeps pure desktop observation workers on the exact parent read-only allowlist', () => {
    const task = '\u7ec4\u5efa\u56e2\u961f\uff0c\u5206\u4e24\u6b65\u6267\u884c\uff1a\u5148\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff0c\u518d\u5217\u51fa\u684c\u9762\u6587\u4ef6\uff0c\u6700\u540e\u6309\u771f\u5b9e\u7ed3\u679c\u6c47\u62a5\u3002';
    const inherited = {
      allowedTools: declarations.map(item => item.function.name),
      requireConfirmation: ['write_file'],
      forbiddenTools: [],
      maxIterations: 20,
    };
    const policy = buildOrchestrationWorkerToolPolicy(task, inherited, declarations);

    expect(policy.allowedTools).toEqual([
      'desktop_active_window',
      'desktop_list_files',
    ]);
    expect(policy.forbiddenTools).toEqual(expect.arrayContaining([
      'get_active_window_info',
      'desktop_path_info',
      'list_directory',
      'search_files',
      'grep_files',
      'read_file',
      'write_file',
      'run_command',
    ]));
    expect(policy.requireConfirmation).toEqual([]);
    expect(policy.maxIterations).toBe(3);
  });

  it('carries the routed voice policy through orchestrator and worker execution', () => {
    const root = process.cwd();
    const voice = fs.readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const chat = fs.readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8');
    const orchestrator = fs.readFileSync(path.join(root, 'server/agents/orchestrator.ts'), 'utf8');
    const adapter = fs.readFileSync(path.join(root, 'server/llm/adapter.ts'), 'utf8');

    expect(voice).toMatch(/runOrchestratedTask\([\s\S]{0,700}toolPolicy:\s*routedToolPolicy/);
    expect(voice).toContain('if (isTerminalOrchestrationToolEvent(record))');
    expect((chat.match(/if \(isTerminalOrchestrationToolEvent\(record\)\)/g) || [])).toHaveLength(2);
    expect(voice).toMatch(
      /if \(isTerminalOrchestrationToolEvent\(record\)\)[\s\S]{0,800}if \(isDirectDesktopTool\(record\.name\)\) return;/,
    );
    expect((
      chat.match(
        /if \(isTerminalOrchestrationToolEvent\(record\)\)[\s\S]{0,1800}?if \(isDirectDesktopTool\(record\.name\)\) return;/g,
      ) || []
    )).toHaveLength(2);
    expect(orchestrator).toContain('context.toolPolicy');
    expect(orchestrator).toContain('toolPolicy: workerToolPolicy');
    expect(adapter).toContain('getToolDeclarationsForPolicy(');
    expect(adapter).toContain("failClosedWithoutPolicy: context?.source === 'orchestrator'");
  });

  it('distinguishes UI start events from terminal receipts', () => {
    expect(isTerminalOrchestrationToolEvent({
      id: 'start',
      name: 'desktop_active_window',
      arguments: {},
    })).toBe(false);
    expect(isTerminalOrchestrationToolEvent({
      id: 'done',
      name: 'desktop_active_window',
      arguments: {},
      result: '{}',
    })).toBe(true);
    expect(isTerminalOrchestrationToolEvent({
      id: 'failed',
      name: 'desktop_list_files',
      arguments: {},
      error: 'offline',
    })).toBe(true);
  });

  it('inherits an exact routed policy without expanding it on worker retry', () => {
    const inherited = {
      allowedTools: [
        'desktop_list_files',
        'desktop_path_info',
        'floorplan_extract_geometry',
        'ocr_image_file',
        'cad_prepare_autocad_operations',
        'mcp_cad-drafting_autocad_playback_file',
        'mcp_filesystem_read_media_file',
        'run_command',
      ],
      requireConfirmation: ['run_command'],
      forbiddenTools: ['wechat_send_message'],
      maxIterations: 25,
    };
    const policy = buildOrchestrationWorkerToolPolicy(
      '把桌面的设计草稿.jpg画到 AutoCAD 里',
      inherited,
      declarations,
    );

    expect(policy.allowedTools).toEqual(expect.arrayContaining([
      'desktop_list_files',
      'floorplan_extract_geometry',
      'ocr_image_file',
      'cad_prepare_autocad_operations',
      'mcp_cad-drafting_autocad_playback_file',
    ]));
    expect(policy.allowedTools).not.toContain('mcp_filesystem_read_media_file');
    expect(policy.allowedTools).not.toContain('run_command');
    expect(policy.allowedTools).not.toContain('write_file');
    expect(policy.allowedTools).not.toContain('wechat_send_message');
    expect(policy.forbiddenTools).toEqual(expect.arrayContaining([
      'mcp_filesystem_read_media_file',
      'run_command',
      'wechat_send_message',
    ]));
    expect(policy.maxIterations).toBe(12);
  });

  it('fails closed to routed read/inspect tools when no parent policy exists', () => {
    const policy = buildOrchestrationWorkerToolPolicy(
      '读取桌面的设计草稿.jpg并分析 CAD 几何',
      undefined,
      declarations,
    );

    expect(policy.allowedTools).toEqual(expect.arrayContaining([
      'desktop_list_files',
      'desktop_path_info',
      'floorplan_extract_geometry',
      'ocr_image_file',
    ]));
    expect(policy.allowedTools).not.toContain('desktop_open');
    expect(policy.allowedTools).not.toContain('desktop_ui_type');
    expect(policy.allowedTools).not.toContain('write_file');
    expect(policy.allowedTools).not.toContain('run_command');
    expect(policy.allowedTools).not.toContain('wechat_send_message');
  });

  it('narrows an inherited extraction-only CAD policy to read and geometry tools', () => {
    const inherited = {
      allowedTools: declarations.map(item => item.function.name),
      requireConfirmation: ['write_file', 'run_command'],
      forbiddenTools: [],
      maxIterations: 30,
    };
    const policy = buildOrchestrationWorkerToolPolicy(
      '读取桌面上的设计草稿.jpg，提取几何信息，先不要绘制，只告诉我提取是否成功。',
      inherited,
      declarations,
    );
    const expectedAllowed = [
      'desktop_list_files',
      'desktop_path_info',
      'desktop_system_info',
      'desktop_capture_screen',
      'floorplan_extract_geometry',
      'ocr_image_file',
      'ocr_screen',
    ];
    const forbidden = [
      'cad_generate_dxf',
      'cad_prepare_autocad_operations',
      'mcp_cad-drafting_autocad_playback_file',
      'mcp_cad-drafting_cad_renovation_folder_workflow',
      'write_file',
      'create_docx',
      'create_pdf',
      'create_ppt',
      'mcp_filesystem_read_media_file',
      'mcp_filesystem_read_file',
      'run_command',
      'desktop_run_command',
      'code_execution',
      'python_exec',
      'powershell',
      'shell_exec',
      'terminal_exec',
    ];

    expect(new Set(policy.allowedTools)).toEqual(new Set(expectedAllowed));
    expect(policy.forbiddenTools).toEqual(expect.arrayContaining(forbidden));
    expect(policy.requireConfirmation).toEqual([]);
    expect(policy.maxIterations).toBe(6);
    for (const name of forbidden) {
      expect(policy.allowedTools).not.toContain(name);
    }
  });

  it('preserves a normal inherited WPS UI policy when the worker wording routes more narrowly', () => {
    const inheritedAllowed = [
      'desktop_open',
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_ui_focus',
      'desktop_ui_click',
      'desktop_ui_invoke',
      'desktop_ui_type',
    ];
    const policy = buildOrchestrationWorkerToolPolicy(
      'Use the currently open WPS document and type the requested text.',
      {
        allowedTools: inheritedAllowed,
        requireConfirmation: [],
        forbiddenTools: ['computer_use'],
        maxIterations: 10,
      },
      declarations,
    );

    expect(new Set(policy.allowedTools)).toEqual(new Set(inheritedAllowed));
    expect(policy.forbiddenTools).toContain('computer_use');
    expect(policy.allowedTools).not.toContain('write_file');
    expect(policy.allowedTools).not.toContain('create_docx');
    expect(policy.allowedTools).not.toContain('run_command');
    expect(policy.maxIterations).toBe(10);
  });

  it('retains the original local CAD source boundary when decomposition paraphrases it away', () => {
    const workerTask = buildOrchestrationWorkerTaskText(
      '提取几何并继续绘制，不要重复询问。',
      '把桌面的设计草稿.jpg画到 AutoCAD 里',
    );
    const policy = buildOrchestrationWorkerToolPolicy(
      workerTask,
      {
        allowedTools: [
          'desktop_list_files',
          'desktop_path_info',
          'floorplan_extract_geometry',
          'ocr_image_file',
          'cad_prepare_autocad_operations',
          'mcp_cad-drafting_autocad_playback_file',
          'mcp_filesystem_read_media_file',
          'run_command',
          'desktop_run_command',
          'python_exec',
        ],
        requireConfirmation: ['run_command'],
        forbiddenTools: [],
        maxIterations: 20,
      },
      declarations,
    );

    expect(workerTask).toContain('Original orchestrated task');
    expect(workerTask).toContain('桌面的设计草稿.jpg');
    expect(policy.allowedTools).toEqual(expect.arrayContaining([
      'floorplan_extract_geometry',
      'ocr_image_file',
      'mcp_cad-drafting_autocad_playback_file',
    ]));
    expect(policy.allowedTools).not.toEqual(expect.arrayContaining([
      'mcp_filesystem_read_media_file',
      'run_command',
      'desktop_run_command',
      'python_exec',
    ]));
  });

  it('keeps NL chainer planning and replan inside the inherited allowed set', () => {
    const policy = {
      allowedTools: ['desktop_active_window', 'desktop_ui_type'],
      requireConfirmation: [],
      forbiddenTools: ['run_command'],
      maxIterations: 6,
    };
    expect(filterChainerToolNamesByPolicy(
      ['desktop_active_window', 'desktop_ui_type', 'run_command', 'write_file'],
      policy,
    )).toEqual(['desktop_active_window', 'desktop_ui_type']);
    expect(filterChainerToolNamesByPolicy(
      ['desktop_active_window'],
      undefined,
    )).toEqual([]);
  });

  it('blocks project-scoped filesystem and certutil/base64 fallback for desktop CAD images', () => {
    const task = '把 C:\\Users\\me\\Desktop\\设计草稿.jpg 画到 AutoCAD 里';
    expect(isForbiddenLocalCadImageFallback(
      task,
      'mcp_filesystem_read_media_file',
      { path: 'C:\\Users\\me\\Desktop\\设计草稿.jpg' },
    )).toBe(true);
    expect(isForbiddenLocalCadImageFallback(
      task,
      'run_command',
      { command: 'certutil -encode C:\\Users\\me\\Desktop\\设计草稿.jpg out.txt' },
    )).toBe(true);
    expect(isForbiddenLocalCadImageFallback(
      task,
      'desktop_run_command',
      { command: '[Convert]::ToBase64String([IO.File]::ReadAllBytes($p))' },
    )).toBe(true);
    expect(isForbiddenLocalCadImageFallback(
      task,
      'ocr_image_file',
      { path: 'C:\\Users\\me\\Desktop\\设计草稿.jpg' },
    )).toBe(false);
  });
});
