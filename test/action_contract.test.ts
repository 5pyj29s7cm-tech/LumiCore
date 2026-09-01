import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  buildActionContract,
  buildActionEvidenceContract,
  claimsCurrentAppSaveCompletion,
  extractExplicitArtifactTextRequirements,
  extractCurrentAppTarget,
  formatActionContractPrompt,
  hasCoreActionEvidence,
  hasAuthenticatedWebResultEvidence,
  hasCurrentAppSaveEvidence,
  hasCurrentAppUiMutationEvidence,
  hasMediaPlaybackEvidence,
  hasRequestedDesktopOpenEvidence,
  hasVisualModelAvailabilityEvidence,
  hasVerifiedCadGeometryExtractionEvidence,
  hasVisibleAutoCadExecutionEvidence,
  requiresCadGeometryExtractionOnly,
  requiresCurrentAppUiMutation,
  requiresMediaPlaybackAction,
  requiresAutoCadMcpPlayback,
  requiresDesktopAiRequest,
  requiresAuthenticatedWebResult,
  requiresVisibleAutoCadExecution,
  requiresVisualModelAvailabilityCheck,
  requiresExternalAiHistory,
  requiresArtifactPostWriteReadback,
} from '../server/cognition/action_contract';
import type { TaskCapsuleV1 } from '../server/conversation/task_capsule';
import {
  recordsToTaskReceipts,
  taskCompletionFromReceipts,
} from '../server/cognition/task_execution_ledger';

describe('Lumi action contract', () => {
  it('keeps delimiter-free long Chinese context classification bounded', () => {
    const text = `old-user ${'背景资料'.repeat(500)}`;
    buildActionContract(text); // Exclude first-call module/JIT setup from the guard.
    const startedAt = performance.now();
    for (let index = 0; index < 20; index += 1) buildActionContract(text);

    // The prior filename/desktop-target regex path took roughly three seconds
    // for this exact input. Keep ample CI headroom while preventing a return
    // to repeated bounded scans over every character in long conversation.
    expect(performance.now() - startedAt).toBeLessThan(1_500);
  });

  it('requires cancellation evidence without granting a context-free cancel route', () => {
    const text = '\u6e05\u6389\u8fd9\u4e9b\u4efb\u52a1';

    expect(buildActionContract(text)).toMatchObject({ applies: false, kind: 'none' });
    expect(buildActionEvidenceContract(text)).toMatchObject({
      applies: true,
      kind: 'task_control',
      preferredTools: ['runtime_work_cancel'],
    });
  });

  it.each([
    '\u6e05\u7406\u4e00\u4e0b',
    '\u628a\u8fd9\u4e9b\u4efb\u52a1\u53d6\u6d88',
    '\u628a\u5b83\u4eec\u53d6\u6d88',
    'cancel those tasks',
  ])('uses the same truth contract for every accepted cleanup-offer reply: %s', text => {
    expect(buildActionContract(text)).toMatchObject({ applies: false, kind: 'none' });
    expect(buildActionEvidenceContract(text)).toMatchObject({
      applies: true,
      kind: 'task_control',
      preferredTools: ['runtime_work_cancel'],
    });
  });

  it.each(['idle', 'active', 'paused', 'attention'])('accepts a verified runtime status snapshot in state %s', status => {
    const text = '\u4f60\u73b0\u5728\u6709\u5728\u6267\u884c\u7684\u4efb\u52a1\u5417';
    const contract = buildActionContract(text);
    expect(hasCoreActionEvidence(contract, [{
      name: 'runtime_work_status',
      arguments: {},
      result: JSON.stringify({
        ok: true,
        status,
        activeCount: status === 'active' ? 1 : 0,
        pausedCount: status === 'paused' ? 1 : 0,
        blockedCount: status === 'attention' ? 1 : 0,
      }),
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'The unified runtime ledger returned its current state.',
      },
    }], text)).toBe(true);
  });

  it('requires the exact verified client action receipt before completing a client mode switch', () => {
    const task = '\u5207\u6362\u5ba2\u6237\u7aef\u804a\u5929\u6a21\u5f0f';
    const contract = buildActionContract(task);
    const verifiedChatModeReceipt = {
      name: 'client_action',
      arguments: { action: 'set_client_mode', mode: 'chat' },
      result: JSON.stringify({
        ok: true,
        action: 'set_client_mode',
        mode: 'chat',
        verification: { status: 'verified' },
      }),
    };

    expect(contract).toMatchObject({
      applies: true,
      kind: 'desktop_operation',
      preferredTools: ['client_get_state', 'client_action'],
    });
    expect(hasCoreActionEvidence(contract, [], task)).toBe(false);
    expect(hasCoreActionEvidence(contract, [verifiedChatModeReceipt], task)).toBe(true);
    expect(hasCoreActionEvidence(contract, [{
      ...verifiedChatModeReceipt,
      arguments: { action: 'open_command_center' },
      result: JSON.stringify({
        ok: true,
        action: 'open_command_center',
        target: 'command-center',
        verification: { status: 'verified' },
      }),
    }], task)).toBe(false);
  });

  it('does not treat cancellation-in-progress as terminal completion evidence', () => {
    const text = '\u505c\u6b62\u540e\u53f0\u4efb\u52a1';
    const contract = buildActionContract(text);
    const record = {
      name: 'runtime_work_cancel',
      arguments: {},
      result: JSON.stringify({
        ok: true,
        status: 'cancelling',
        matchedCount: 1,
        cancelledCount: 0,
        cancellingCount: 1,
        failedCount: 0,
      }),
    };
    expect(hasCoreActionEvidence(contract, [record], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [{
      ...record,
      result: JSON.stringify({
        ok: true,
        status: 'cancelled',
        matchedCount: 1,
        cancelledCount: 1,
        cancellingCount: 0,
        failedCount: 0,
      }),
    }], text)).toBe(true);
  });

  it('keeps a named persistent-task ledger status query out of runtime task control', () => {
    const text = '\u4e3b\u7a0b\u5e8f\u4efb\u52a1\u72b6\u6001\u9a8c\u6536\uff1a\u8bf7\u67e5\u8be2\u4efb\u52a1\u201c\u9752\u7a79\u5ba2\u6237\u8ddf\u8fdb\u95ed\u73af\u201d\u7684\u6301\u4e45\u72b6\u6001\uff0c\u53ea\u6839\u636e\u4efb\u52a1\u8d26\u672c\u56de\u7b54\u4efb\u52a1\u7f16\u53f7\u3001\u5f53\u524d\u72b6\u6001\u3001\u5f53\u524d\u6b65\u9aa4\u3001\u540e\u7eed\u6b65\u9aa4\u548c\u786e\u8ba4\u8fb9\u754c\uff0c\u4e0d\u8981\u6267\u884c\u4efb\u4f55\u5916\u90e8\u52a8\u4f5c\u3002';

    expect(buildActionContract(text)).toMatchObject({ applies: false, kind: 'none' });
  });

  it('recognizes an explicit arrow-ordered write then readback requirement', () => {
    expect(requiresArtifactPostWriteReadback(
      '\u5fc5\u987b\u4e25\u683c\u6309\u201c\u8bfb\u53d6\u6e90\u6587\u4ef6\u2192\u5199\u5165\u76ee\u6807\u6587\u4ef6\u2192\u91cd\u65b0\u8bfb\u53d6\u76ee\u6807\u6587\u4ef6\u201d\u7684\u987a\u5e8f\u6267\u884c\u3002',
    )).toBe(true);
  });

  it('keeps explicit local customer documents on the artifact contract', () => {
    expect(buildActionContract('读取 D:\\work\\customer-brief.txt，并在 D:\\work\\customer-followup.md 创建客户跟进方案并验证文件').kind)
      .toBe('artifact_work');
    expect(buildActionContract('先聊一句：你认为这份方案最需要客户补充什么？不要修改文件。').kind)
      .toBe('none');
    expect(buildActionContract('分析这个客户线索并推进销售跟进').kind)
      .toBe('customer_operations');
  });

  it('keeps the field TXT creation request on the artifact contract despite a negated software clause', () => {
    const contract = buildActionContract('在 C:\\Users\\test-user\\Documents 创建 Lumi现场验收_晨星716.txt，写三行，重读核验，不外发，不开其他软件');
    expect(contract.kind).toBe('artifact_work');
    expect(contract.preferredTools).toContain('write_file');
    expect(contract.verificationTools).toEqual(expect.arrayContaining([
      'desktop_path_info',
      'work_product_verify',
    ]));
  });

  it('does not treat a read-only knowledge-base inventory as artifact creation', () => {
    const contract = buildActionContract('请检查当前个人知识库是否可用，报告文档数量、已索引数量和最近错误。只读取真实状态，不导入、不修改任何内容。');
    expect(contract.kind).toBe('none');
  });

  it('accepts a requested artifact readback only when it follows the write', () => {
    const task = '在 C:\\Users\\test-user\\Documents 创建 Lumi现场验收_晨星716.txt，写入后重读核验';
    const contract = buildActionContract(task);
    const target = 'C:\\Users\\test-user\\Documents\\Lumi现场验收_晨星716.txt';
    const read = { name: 'extract_document_text', arguments: { filePath: target }, result: '三行内容' };
    const write = { name: 'write_file', arguments: { path: target }, result: `File written: ${target}` };
    expect(hasCoreActionEvidence(contract, [read, write], task)).toBe(false);
    expect(hasCoreActionEvidence(contract, [write, read], task)).toBe(true);
  });

  it('accepts native semantic text writes with a later same-path readback', () => {
    const target = 'C:\\Users\\me\\Desktop\\note.txt';
    const task = `After creating the file, read it back and verify the exact content. Target: ${target}`;
    const contract = buildActionContract(task);
    const write = {
      name: 'desktop_write_text_file',
      arguments: { path: target, content: 'hello' },
      result: JSON.stringify({ ok: true, status: 'verified', readBackMatched: true }),
      terminalVerification: { status: 'verified' as const, strategy: 'measured' as const, reason: 'native byte read-back matched' },
      capability: {
        capabilityId: 'desktop.files.text.write',
        lane: 'files' as const,
        operation: 'mutate' as const,
        risk: 'high' as const,
        sideEffects: [{ type: 'local_write' as const, scope: 'one exact native host text-file path', reversible: false }],
        verification: {
          strategy: 'measured' as const,
          required: true,
          requiredFields: ['path', 'readBackMatched'],
          requiredValues: { readBackMatched: true },
          successSignals: ['native byte read-back matched'],
          limitations: [],
        },
      },
    };
    const read = {
      name: 'read_file',
      arguments: { path: target },
      result: 'hello',
      terminalVerification: { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'text read returned' },
    };

    expect(contract.kind).toBe('artifact_work');
    expect(hasCoreActionEvidence(contract, [read, write], task)).toBe(false);
    expect(hasCoreActionEvidence(contract, [write, read], task)).toBe(true);
  });

  it('requires both exact launch and matching active-window evidence for launch verification', () => {
    const task = '请打开 Windows 计算器。打开后读取当前活动窗口，只有窗口标题和进程能证明是计算器时才报告完成。';
    const contract = buildActionContract(task);
    const opened = {
      name: 'desktop_open',
      arguments: { target: '计算器' },
      result: JSON.stringify({ status: 'verified', targetMatched: true, verified: true, actualTarget: { title: '计算器', processName: 'CalculatorApp.exe' } }),
      terminalVerification: { status: 'verified' as const, strategy: 'state_diff' as const, reason: 'matched' },
    };
    const active = {
      name: 'desktop_active_window',
      arguments: {},
      result: JSON.stringify({ title: '计算器', processName: 'CalculatorApp.exe' }),
    };
    expect(contract.kind).toBe('desktop_operation');
    expect(hasCoreActionEvidence(contract, [opened], task)).toBe(false);
    expect(hasCoreActionEvidence(contract, [opened, active], task)).toBe(true);
  });

  it('does not treat the letters ai inside a local main path as an external AI surface', () => {
    const text = '读取 D:\\LumiCore\\.codex-run\\acceptance-main\\customer-brief.txt，然后根据文件里的事实，在 D:\\LumiCore\\.codex-run\\acceptance-main\\customer-followup.md 创建中文跟进方案。这是本地文件任务，直接执行并验证文件。';

    expect(buildActionContract(text).kind).toBe('artifact_work');
  });

  it('extracts only explicitly required exact artifact strings', () => {
    expect(extractExplicitArtifactTextRequirements('在“已知风险”里明确写出“负责人：刘工”，其他事实不变。'))
      .toEqual(['负责人：刘工']);
  });

  it('separates authorized external AI history reads from new external AI submissions', () => {
    const text = '读取 ChatGPT 里的聊天历史并同步新增消息';
    const contract = buildActionContract(text);
    expect(requiresExternalAiHistory(text)).toBe(true);
    expect(contract.kind).toBe('external_ai_history');
    expect(contract.preferredTools).toEqual(expect.arrayContaining([
      'external_ai_history_query',
      'external_ai_history_sync',
      'external_ai_history_status',
    ]));
    expect(contract.preferredTools).not.toContain('desktop_ai_ask');

    const externalRequest = buildActionContract('Ask ChatGPT for an answer, then collect it.');
    expect(externalRequest.kind).toBe('external_ai_request');
  });

  it('keeps negated model-memory and browser constraints out of active external-AI routes', () => {
    const text = '律师版实机验收·法条与类案：基于案件ID case-001，只使用当前已配置且可核验的权威来源，输出检索问题、来源状态和可核验结果。禁止凭模型记忆编造法条，不要登录外部网站；完成后告诉我任务回执状态。';
    expect(requiresDesktopAiRequest(text)).toBe(false);
    expect(requiresAuthenticatedWebResult(text)).toBe(false);
    expect(buildActionContract(text).kind).not.toBe('external_ai_request');
    expect(buildActionContract(text).kind).not.toBe('browser_account');
  });
  it('treats editing inside the current app as a desktop action contract', () => {
    const contract = buildActionContract('\u5728\u8fd9\u91cc\u9762\u5199\u4e00\u7bc7\u68c0\u8ba8\u4e66\u7ed9\u6211');

    expect(contract.kind).toBe('desktop_operation');
    expect(contract.preferredTools).toContain('desktop_ui_snapshot');
    expect(contract.preferredTools).toContain('computer_use');
  });

  it('keeps the exact recovered-WPS create-and-type phrase on the strong desktop contract', () => {
    const task = [
      '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002',
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- appTarget: WPS Office',
      '- unfinished: yes',
    ].join('\n');

    const contract = buildActionContract(task);
    expect(requiresCurrentAppUiMutation(task)).toBe(true);
    expect(extractCurrentAppTarget(task)).toBe('WPS Office');
    expect(contract.kind).toBe('desktop_operation');
    expect(contract.preferredTools).toContain('desktop_ui_type');
    expect(contract.preferredTools).not.toContain('write_file');
  });

  it('rejects the real WPS failure ledger even when write_file created a project text file', () => {
    const task = [
      '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002',
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- appTarget: WPS Office',
      '- unfinished: yes',
    ].join('\n');
    const records = [{
      name: 'desktop_open',
      arguments: { target: 'WPS' },
      result: 'Opened app WPS Office',
    }, {
      name: 'desktop_ui_focus',
      arguments: { nameContains: 'WPS Office' },
      result: '{"status":"ok","action":"focus","selectedAfter":{"name":"WPS Office"}}',
    }, {
      name: 'desktop_ui_snapshot',
      arguments: { root: 'active' },
      result: '{"root":{"name":"WPS Office","controls":[{"name":"Home"}]}}',
    }, {
      name: 'ocr_screen',
      arguments: {},
      result: 'WPS Office \u9996\u9875\uff1a\u7a7a\u767d\u6587\u6863\u672a\u6253\u5f00\u3002',
    }, {
      name: 'desktop_keyboard_press',
      arguments: { key: 'ctrl+n' },
      result: 'Pressed: ctrl+n',
    }, {
      name: 'write_file',
      arguments: { path: 'D:\\LumiCore\\Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5.txt' },
      result: 'File written: D:\\LumiCore\\Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5.txt',
    }];

    const contract = buildActionContract(task);
    expect(hasCurrentAppUiMutationEvidence(records, task)).toBe(false);
    expect(hasCoreActionEvidence(contract, records, task)).toBe(false);
  });

  it('accepts recovered-WPS editing only after foreground UI actuation and post-action verification', () => {
    const task = [
      '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002',
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- appTarget: WPS Office',
    ].join('\n');
    const records = [{
      name: 'desktop_active_window',
      arguments: {},
      result: '{"title":"WPS Office","process_name":"wps.exe"}',
    }, {
      name: 'desktop_keyboard_press',
      arguments: { key: 'ctrl+n' },
      result: 'Pressed: ctrl+n',
    }, {
      name: 'desktop_clipboard_write',
      arguments: { text: 'Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5' },
      result: 'Clipboard updated',
    }, {
      name: 'desktop_keyboard_press',
      arguments: { key: 'ctrl+v' },
      result: 'Pressed: ctrl+v',
    }, {
      name: 'ocr_screen',
      arguments: {},
      result: 'WPS Office \u6587\u6863\u6b63\u6587\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5',
    }];

    expect(hasCurrentAppUiMutationEvidence(records, task)).toBe(true);
    expect(hasCoreActionEvidence(buildActionContract(task), records, task)).toBe(true);
  });

  it('requires an in-app save action and save-state verification for a save claim', () => {
    const task = [
      '\u5728\u8fd9\u91cc\u9762\u8f93\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002',
      '## Recent action continuation context',
      '- appTarget: WPS Office',
    ].join('\n');
    const typed = [{
      name: 'desktop_active_window',
      arguments: {},
      result: '{"title":"WPS Office","process_name":"wps.exe"}',
    }, {
      name: 'desktop_ui_type',
      arguments: { name: '\u6b63\u6587', text: 'Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5' },
      result: '{"status":"ok","action":"type","typedLength":10}',
    }, {
      name: 'ocr_screen',
      arguments: {},
      result: 'WPS Office \u6587\u6863\u6b63\u6587\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5',
    }];

    expect(claimsCurrentAppSaveCompletion('\u5df2\u5728 WPS \u8f93\u5165\u5e76\u4fdd\u5b58\u6210\u529f\u3002')).toBe(true);
    expect(hasCurrentAppSaveEvidence(typed, task)).toBe(false);
    expect(hasCurrentAppSaveEvidence([
      ...typed,
      {
        name: 'desktop_keyboard_press',
        arguments: { key: 'ctrl+s' },
        result: 'Pressed: ctrl+s',
      },
      {
        name: 'desktop_ui_snapshot',
        arguments: { root: 'active' },
        result: '{"root":{"name":"Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5.docx - WPS Office"}}',
      },
    ], task)).toBe(true);
  });

  it('uses a geometry-receipt contract for extraction-only desktop images', () => {
    const task = '\u8bfb\u53d6\u684c\u9762\u4e0a\u7684\u8bbe\u8ba1\u8349\u7a3f.jpg\uff0c\u63d0\u53d6\u51e0\u4f55\u4fe1\u606f\uff0c\u5148\u4e0d\u8981\u7ed8\u5236\uff0c\u53ea\u544a\u8bc9\u6211\u63d0\u53d6\u662f\u5426\u6210\u529f\u3002';
    const contract = buildActionContract(task);
    const failed = [{
      name: 'floorplan_extract_geometry',
      arguments: { imagePath: 'C:\\Users\\test-user\\Desktop\\\u8bbe\u8ba1\u8349\u7a3f.jpg' },
      result: JSON.stringify({
        parsed: false,
        failedStage: 'topology',
        geometryReady: false,
        geometryVerified: false,
        geometryReceiptPath: '',
      }),
    }];
    const verified = [{
      name: 'floorplan_extract_geometry',
      arguments: { imagePath: 'C:\\Users\\test-user\\Desktop\\\u8bbe\u8ba1\u8349\u7a3f.jpg' },
      result: JSON.stringify({
        parsed: true,
        geometryReady: true,
        geometryVerified: true,
        executableGeometryAvailable: true,
        geometryReceiptPath: 'C:\\Users\\test-user\\LumiCore\\data\\cad\\geometry_receipts\\verified.json',
      }),
    }];

    expect(requiresCadGeometryExtractionOnly(task)).toBe(true);
    expect(contract.kind).toBe('cad_drafting');
    expect(contract.label).toBe('CAD source-geometry extraction');
    expect(contract.preferredTools).toContain('floorplan_extract_geometry');
    expect(contract.requiredEvidence.join(' ')).not.toMatch(/active window|process|screen state/i);
    expect(hasVerifiedCadGeometryExtractionEvidence(failed)).toBe(false);
    expect(hasCoreActionEvidence(contract, failed, task)).toBe(false);
    expect(hasVerifiedCadGeometryExtractionEvidence(verified)).toBe(true);
    expect(hasCoreActionEvidence(contract, verified, task)).toBe(true);
  });

  it('keeps a plain AutoCAD launch as a desktop-open contract', () => {
    const task = '打开AutoCAD。';
    const contract = buildActionContract(task);

    expect(contract.kind).toBe('desktop_operation');
    expect(contract.coreAction).toContain('exactly');
    expect(contract.preferredTools).toContain('desktop_open');
    expect(contract.preferredTools).not.toContain('cad_generate_dxf');
    const launchOnly = {
      id: 'open-autocad',
      name: 'desktop_open',
      arguments: { target: 'AutoCAD' },
      result: 'Opened app AutoCAD via public desktop shortcut',
    };
    expect(hasCoreActionEvidence(contract, [launchOnly], task)).toBe(false);
    expect(hasCoreActionEvidence(contract, [{
      ...launchOnly,
      result: JSON.stringify({
        ok: true,
        status: 'verified',
        target: 'AutoCAD',
        targetMatched: true,
        actualTarget: { processName: 'acad.exe', title: 'Drawing1.dwg - AutoCAD' },
      }),
    }], task)).toBe(true);
  });

  it('requires a desktop-open receipt to match the requested application', () => {
    const autoCadTask = '\u6253\u5f00 AutoCAD\u3002';
    const autoCadContract = buildActionContract(autoCadTask);

    expect(hasCoreActionEvidence(autoCadContract, [{
      id: 'wrong-autocad-open',
      name: 'desktop_open',
      arguments: { target: 'mspaint.exe' },
      result: JSON.stringify({ ok: true, status: 'opened', target: 'mspaint.exe' }),
    }], autoCadTask)).toBe(false);
    expect(hasCoreActionEvidence(autoCadContract, [{
      id: 'correct-autocad-open',
      name: 'desktop_open',
      arguments: { target: 'acad.exe' },
      result: JSON.stringify({
        ok: true,
        status: 'verified',
        target: 'acad.exe',
        targetMatched: true,
        actualTarget: { processName: 'acad.exe', title: 'Drawing1.dwg - AutoCAD' },
      }),
    }], autoCadTask)).toBe(true);

    const wpsTask = '\u6253\u5f00 WPS\u3002';
    const wpsContract = buildActionContract(wpsTask);
    expect(hasCoreActionEvidence(wpsContract, [{
      id: 'correct-wps-open',
      name: 'desktop_open',
      arguments: { target: 'WPS' },
      result: JSON.stringify({
        ok: true,
        status: 'verified',
        target: 'WPS',
        targetMatched: true,
        actualTarget: { processName: 'wps.exe', title: 'WPS Writer' },
      }),
    }], wpsTask)).toBe(true);
    expect(hasCoreActionEvidence(wpsContract, [{
      id: 'wrong-wps-open',
      name: 'desktop_open',
      arguments: { target: 'mspaint.exe' },
      result: 'Opened app Microsoft Paint',
    }], wpsTask)).toBe(false);

    const weChatTask = '\u6253\u5f00\u5fae\u4fe1\u3002';
    const weChatContract = buildActionContract(weChatTask);
    expect(hasCoreActionEvidence(weChatContract, [{
      id: 'correct-wechat-open',
      name: 'desktop_open',
      arguments: { target: 'Weixin.exe' },
      result: JSON.stringify({
        ok: true,
        status: 'verified',
        target: 'Weixin.exe',
        targetMatched: true,
        actualTarget: { processName: 'Weixin.exe', title: '微信' },
      }),
    }], weChatTask)).toBe(true);
  });

  it('accepts a successful browser-open receipt for a requested website', () => {
    const task = '打开中国裁判文书网。';
    const contract = buildActionContract(task);

    expect(contract.kind).toBe('desktop_operation');
    expect(hasCoreActionEvidence(contract, [{
      id: 'open-wenshu',
      name: 'browser_open_task',
      arguments: { url: 'https://wenshu.court.gov.cn/', open: true },
      result: JSON.stringify({ opened: true, result: 'Opened: https://wenshu.court.gov.cn/' }),
    }], task)).toBe(true);
  });

  it('rejects a browser receipt for the wrong application or website target', () => {
    const autoCadTask = '\u6253\u5f00 AutoCAD\u3002';
    expect(hasCoreActionEvidence(buildActionContract(autoCadTask), [{
      name: 'browser_open_task',
      arguments: { url: 'https://www.google.com', open: true },
      result: JSON.stringify({ opened: true, url: 'https://www.google.com' }),
    }], autoCadTask)).toBe(false);

    const courtTask = '\u6253\u5f00\u4e2d\u56fd\u88c1\u5224\u6587\u4e66\u7f51\u3002';
    expect(hasCoreActionEvidence(buildActionContract(courtTask), [{
      name: 'browser_open_task',
      arguments: { url: 'https://example.com/', open: true },
      result: JSON.stringify({ opened: true, url: 'https://example.com/' }),
    }], courtTask)).toBe(false);

    const browserTask = '\u6253\u5f00\u6d4f\u89c8\u5668\u3002';
    expect(hasCoreActionEvidence(buildActionContract(browserTask), [{
      name: 'browser_open_task',
      arguments: { url: 'https://www.google.com', open: true },
      result: JSON.stringify({ opened: true, url: 'https://www.google.com' }),
    }], browserTask)).toBe(true);
  });

  it('does not treat a complaint containing app/action words as a new action contract', () => {
    expect(buildActionContract('你打开画图做什么？').kind).toBe('none');
    expect(buildActionContract('你怎么运行了这么久才回我？').kind).toBe('none');
  });

  it('classifies foreground messaging as a send contract', () => {
    const contract = buildActionContract('\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89');

    expect(contract.kind).toBe('messaging_send');
    expect(contract.preferredTools).toContain('wechat_send_message');
    expect(contract.requiredEvidence.join(' ')).toContain('sent=true');
    expect(hasCoreActionEvidence(contract, [{
      id: '1',
      name: 'desktop_open',
      arguments: { target: '\u5fae\u4fe1' },
      result: 'Opened WeChat',
    }])).toBe(false);
    expect(hasCoreActionEvidence(contract, [{
      id: '2',
      name: 'wechat_send_message',
      arguments: {},
      result: '{"sent":true}',
    }])).toBe(true);
  });

  it('does not turn a negated message boundary into a send contract', () => {
    const contract = buildActionContract(
      'Inspect running desktop AI applications and report detected evidence. Do not open apps, click, type, or send messages.',
    );

    expect(contract.kind).toBe('desktop_operation');
    expect(contract.preferredTools).not.toContain('wechat_send_message');
  });

  it('does not let injected attachment prose reclassify a CAD task as messaging', () => {
    const text = [
      '把这幅图画成cad图',
      '## Current Turn Attachments',
      'The user attached these files to the current message. Treat them as part of the user request.',
      'Local path: C:\\Users\\me\\LumiCore\\data\\knowledge\\plan.jpg',
    ].join('\n\n');
    const contract = buildActionContract(text);

    expect(contract.kind).toBe('cad_drafting');
    expect(requiresVisibleAutoCadExecution(text)).toBe(true);
    expect(contract.preferredTools).toContain('mcp_cad-drafting_autocad_playback_file');
    expect(contract.preferredTools).not.toContain('cad_generate_dxf');
    expect(contract.preferredTools).not.toContain('wechat_send_message');
  });

  it('treats message as a send action only when it has a directed recipient', () => {
    expect(buildActionContract('Message Alice that I will arrive at three.').kind).toBe('messaging_send');
    expect(buildActionContract('The current message has an image attachment.').kind).not.toBe('messaging_send');
    expect(buildActionContract("Reply with exactly 'OK' and nothing else.").kind).not.toBe('messaging_send');
  });

  it('treats directed person-to-person sends as real messaging work', () => {
    const contract = buildActionContract('\u7ed9\u5f20\u4e09\u53d1\u4e0b\u5348\u4e09\u70b9\u5f00\u4f1a');

    expect(contract.kind).toBe('messaging_send');
    expect(contract.coreAction).toContain('recipient');
    expect(hasCoreActionEvidence(contract, [{
      id: '1',
      name: 'desktop_active_window',
      arguments: {},
      result: 'WeChat is active',
    }])).toBe(false);
  });

  it('accepts a matching verified WeChat file delivery without confusing it with a text send', () => {
    const task = '\u628a\u9886\u822a\u5458\u8ba1\u52122026\u53d1\u7ed9\u6211';
    const contract = buildActionContract(task);
    const delivered = {
      id: 'file-send-1',
      name: 'wechat_send_file',
      arguments: { filePath: 'C:\\Users\\owner\\Desktop\\\u9886\u822a\u5458\u8ba1\u52122026.docx' },
      result: JSON.stringify({
        sent: true,
        verificationStatus: 'provider_accepted',
        verificationMethod: 'wechat_ilink_provider_ack',
        fileName: '\u9886\u822a\u5458\u8ba1\u52122026.docx',
        messageId: 'wx-file-1',
      }),
    };

    expect(contract.kind).toBe('messaging_send');
    expect(contract.preferredTools).toContain('wechat_send_file');
    expect(contract.requiredEvidence.join(' ')).toContain('wechat_send_file');
    expect(hasCoreActionEvidence(contract, [delivered], task)).toBe(true);
    expect(hasCoreActionEvidence(contract, [{
      ...delivered,
      arguments: { filePath: 'C:\\Users\\owner\\Desktop\\\u5176\u4ed6\u6587\u4ef6.docx' },
      result: JSON.stringify({ sent: true, fileName: '\u5176\u4ed6\u6587\u4ef6.docx' }),
    }], task)).toBe(false);
  });

  it('classifies foreground chat reading separately from sending', () => {
    const contract = buildActionContract('\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9');

    expect(contract.kind).toBe('messaging_read');
    expect(contract.preferredTools).toContain('wechat_read_recent_chat');
    expect(contract.preferredTools).not.toContain('wechat_send_message');
    expect(hasCoreActionEvidence(contract, [{
      id: '1',
      name: 'desktop_open',
      arguments: { target: '\u5fae\u4fe1' },
      result: 'Focused WeChat',
    }])).toBe(false);
    expect(hasCoreActionEvidence(contract, [{
      id: '2',
      name: 'wechat_read_recent_chat',
      arguments: { contact: '\u963f\u9646' },
      result: '{"read":true,"contentSummary":"visible chat"}',
    }])).toBe(true);
  });

  it('creates non-messaging contracts for other real-world actions', () => {
    expect(buildActionContract('\u6253\u5f00\u6d4f\u89c8\u5668\u81ea\u52a8\u767b\u5f55').kind).toBe('browser_account');
    expect(buildActionContract('\u89c6\u9891\u7f51\u7ad9\u81ea\u52a8\u8bc4\u8bba').kind).toBe('public_post');
    expect(buildActionContract('CAD\u81ea\u52a8\u753b\u56fe').kind).toBe('cad_drafting');
    expect(buildActionContract('\u5e2e\u6211\u76ef\u76d8\u80a1\u7968').kind).toBe('stock_monitor');
    expect(buildActionContract('\u5f8b\u5e08\u7684\u4ee3\u7406\u8bcd').kind).toBe('legal_document');
    const legalMeeting = buildActionContract('\u628a\u8fd9\u6b21\u529e\u6848\u4f1a\u8bae\u6574\u7406\u6210\u6848\u4ef6\u4f1a\u8bae\u7eaa\u8981');
    expect(legalMeeting.kind).toBe('legal_document');
    expect(legalMeeting.preferredTools).toContain('legal_meeting_minutes_to_case');
    const legalReasoning = buildActionContract('\u6309\u4e09\u6bb5\u8bba\u505a\u4e00\u4efd\u6848\u4ef6\u6cd5\u5f8b\u5206\u6790');
    expect(legalReasoning.kind).toBe('legal_document');
    expect(legalReasoning.coreAction).toContain('\u4e09\u6bb5\u8bba');
    expect(legalReasoning.requiredEvidence).toContain('\u4e09\u6bb5\u8bba\u63a8\u7406\u94fe/\u6cd5\u5f8b\u4f9d\u636e-\u4e8b\u5b9e\u8bc1\u636e-\u6db5\u6444\u7ed3\u8bba\u8bc1\u636e');
    expect(legalReasoning.preferredTools).toContain('legal_case_reasoning_matrix');
    expect(legalReasoning.verificationTools).toContain('legal_case_reasoning_matrix');
    const legalAssetTrace = buildActionContract('\u67e5\u88ab\u6267\u884c\u4eba\u8d22\u4ea7\u7ebf\u7d22\u548c\u80a1\u6743\u7a7f\u900f');
    expect(legalAssetTrace.kind).toBe('legal_document');
    expect(legalAssetTrace.preferredTools).toContain('legal_trace_assets');
    expect(legalAssetTrace.preferredTools).toContain('legal_equity_penetration');
    const legalRemoteIntake = buildActionContract('\u98de\u4e66\u53d1\u7ed9 Lumi bot \u7684\u6cd5\u9662\u77ed\u4fe1\u94fe\u63a5\uff0c\u81ea\u52a8\u5165\u6848');
    expect(legalRemoteIntake.kind).toBe('legal_document');
    expect(legalRemoteIntake.preferredTools).toContain('legal_message_intake_to_case');
    expect(legalRemoteIntake.preferredTools).toContain('legal_generate_citation_verification_report');
  });

  it('classifies customer, ecommerce, and composite design work as evidence-gated operations', () => {
    expect(buildActionContract('Analyze this customer lead and advance the sales follow-up.').kind).toBe('customer_operations');
    expect(buildActionContract('Analyze this ecommerce campaign ROI and optimize the store listing.').kind).toBe('ecommerce_operations');
    expect(buildActionContract('Create a full interior design package with a PPT, renders, and budget schedule.').kind).toBe('design_delivery');
    expect(buildActionContract('Create a store publish draft but do not publish it.').kind).toBe('ecommerce_operations');
    expect(buildActionContract('客户微信：接管抖店账号，分析广告并准备短视频脚本。').kind).toBe('ecommerce_operations');
    expect(buildActionContract('根据客户发来的户型图完成装修设计交付。').kind).toBe('design_delivery');
  });

  it('does not accept local takeover packages as customer or ecommerce completion evidence', () => {
    const customerText = 'Analyze this customer lead and score the sales opportunity.';
    const customer = buildActionContract(customerText);
    expect(hasCoreActionEvidence(customer, [{
      id: 'customer-package',
      name: 'legacy_scripted_customer_package',
      arguments: {},
      result: '{"artifactReady":true,"completionEligible":false}',
    }], customerText)).toBe(false);
    expect(hasCoreActionEvidence(customer, [{
      id: 'lead-analysis',
      name: 'mcp_sales-customer-ops_lead_score',
      arguments: { leadText: 'Customer asked for a 30-seat annual plan and a quote.' },
      result: '{"grade":"A","signals":["budget","timeline"],"nextAction":"prepare scoped proposal"}',
    }], customerText)).toBe(true);

    const followUpText = 'Analyze this customer lead and advance the sales follow-up.';
    const followUp = buildActionContract(followUpText);
    expect(hasCoreActionEvidence(followUp, [{
      id: 'lead-only',
      name: 'mcp_sales-customer-ops_lead_score',
      arguments: { leadText: 'Customer requested a quote.' },
      result: '{"grade":"hot","nextBestAction":"follow up"}',
    }], followUpText)).toBe(false);
    expect(hasCoreActionEvidence(followUp, [{
      id: 'lead-analysis',
      name: 'mcp_sales-customer-ops_lead_score',
      arguments: { leadText: 'Customer requested a quote.' },
      result: '{"grade":"hot","nextBestAction":"follow up"}',
    }, {
      id: 'sent-follow-up',
      name: 'wechat_send_message',
      arguments: { contact: 'Customer', message: 'Here is the requested next step.' },
      result: '{"sent":true,"verificationStatus":"verified"}',
    }], followUpText)).toBe(true);

    const ecommerceText = 'Analyze this ecommerce campaign ROI.';
    const ecommerce = buildActionContract(ecommerceText);
    expect(hasCoreActionEvidence(ecommerce, [{
      id: 'growth-package',
      name: 'legacy_scripted_ecommerce_package',
      arguments: {},
      result: '{"artifactReady":true,"completionEligible":false}',
    }], ecommerceText)).toBe(false);
    expect(hasCoreActionEvidence(ecommerce, [{
      id: 'roi',
      name: 'mcp_ecommerce-ops_campaign_roi_analyzer',
      arguments: { campaignText: 'Campaign A spend 300 revenue 1500 orders 20.' },
      result: '{"roas":5,"contributionAfterAds":225,"recommendation":"scale within margin guardrail"}',
    }], ecommerceText)).toBe(true);
  });

  it('requires every requested design output and source inspection', () => {
    const text = 'Based on the attached PDF, create an interior design PPT and finished render.';
    const contract = buildActionContract(text);
    const draftOnly = [{
      id: 'package',
      name: 'legacy_scripted_design_package',
      arguments: {},
      result: '{"artifactReady":true,"completionEligible":false}',
    }];
    const completed = [{
      id: 'read',
      name: 'read_pdf',
      arguments: { path: 'D:\\brief.pdf' },
      result: 'Extracted room dimensions and design constraints.',
    }, {
      id: 'ppt',
      name: 'create_ppt',
      arguments: { title: 'Interior concept' },
      result: 'created: D:\\output\\concept.pptx',
    }, {
      id: 'render',
      name: 'generate_image',
      arguments: { prompt: 'Interior render grounded in the supplied brief' },
      result: '{"image_url":"https://example.test/render.png"}',
    }, {
      id: 'verify',
      name: 'work_product_verify',
      arguments: {},
      result: '{"status":"pass","artifactChecks":[{"path":"D:\\\\output\\\\concept.pptx","exists":true}]}',
    }];

    expect(contract.kind).toBe('design_delivery');
    expect(hasCoreActionEvidence(contract, draftOnly, text)).toBe(false);
    expect(hasCoreActionEvidence(contract, completed, text)).toBe(true);
  });

  it('does not accept an underspecified full-design package as complete', () => {
    const text = 'Complete the full interior design delivery package.';
    const contract = buildActionContract(text);
    const oneDocument = [{
      id: 'ppt',
      name: 'create_ppt',
      arguments: { title: 'Generic interior concept' },
      result: 'created: D:\\output\\generic.pptx',
    }, {
      id: 'verify',
      name: 'work_product_verify',
      arguments: {},
      result: '{"status":"pass","artifactChecks":[{"path":"D:\\\\output\\\\generic.pptx","exists":true}]}',
    }];

    expect(contract.kind).toBe('design_delivery');
    expect(hasCoreActionEvidence(contract, oneDocument, text)).toBe(false);
  });

  it('requires a public commit plus post-submit page feedback', () => {
    const text = 'Post this comment on the video website.';
    const contract = buildActionContract(text);
    expect(hasCoreActionEvidence(contract, [{
      id: 'open',
      name: 'mcp_playwright_browser_snapshot',
      arguments: {},
      result: 'Video page with comment box.',
    }], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [{
      id: 'commit',
      name: 'mcp_playwright_browser_click',
      arguments: { element: 'Post comment button' },
      result: 'Clicked the post comment button.',
    }, {
      id: 'receipt',
      name: 'mcp_playwright_browser_snapshot',
      arguments: {},
      result: 'Comment is visible. Posted successfully.',
    }], text)).toBe(true);
  });

  it('requires stronger evidence when the user asks for visible AutoCAD execution', () => {
    const text = '\u684c\u9762\u4e0a\u6709\u4e2a\u300c\u963f\u9646\u300d\u6587\u4ef6\u5939\uff0c\u6839\u636e\u91cc\u9762\u7684\u56fe\u7247\u751f\u6210 CAD \u56fe\u7eb8\uff0c\u5e76\u5728 AutoCAD \u91cc\u5b9e\u9645\u753b\u51fa\u6765';

    expect(requiresVisibleAutoCadExecution(text)).toBe(true);
    expect(hasVisibleAutoCadExecutionEvidence([{
      id: 'folder',
      name: 'mcp_cad-drafting_cad_renovation_folder_workflow',
      arguments: {},
      result: '{"cadFiles":[{"path":"C:\\\\Users\\\\me\\\\Desktop\\\\plan.dxf"}]}',
    }])).toBe(false);
    expect(hasVisibleAutoCadExecutionEvidence([{
      id: 'run',
      name: 'legacy_autocad_batch',
      arguments: { scriptPath: 'C:\\\\Users\\\\me\\\\Desktop\\\\plan.scr' },
      result: '{"status":"completed","completionMarkerExists":true}',
    }])).toBe(false);
    expect(hasVisibleAutoCadExecutionEvidence([{
      id: 'mcp-run',
      name: 'mcp_cad-drafting_autocad_playback_file',
      arguments: { operationsPath: 'C:\\Users\\me\\Desktop\\plan_operations.json' },
      result: '{"status":"completed","transport":"mcp_autocad_com","visiblePlayback":true,"completionMarkerExists":true,"geometryVerified":true,"entityCountMatches":true,"operationCount":46,"expectedEntityCount":46,"entitiesAdded":46,"operationSetId":"verified-operation-set"}',
    }])).toBe(true);
    expect(buildActionContract(text).preferredTools).toContain('cad_prepare_autocad_operations');
    expect(buildActionContract(text).preferredTools).toContain('mcp_cad-drafting_autocad_playback_file');
    expect(buildActionContract(text).preferredTools).not.toContain('cad_generate_dxf');
  });

  it('does not accept a folder inventory or default grid as source-grounded CAD', () => {
    const text = 'Based on the attached floor plan image, create an editable CAD DXF file.';
    const contract = buildActionContract(text);
    const inventoryOnly = [{
      id: 'inventory',
      name: 'mcp_cad-drafting_cad_renovation_folder_workflow',
      arguments: { folderPath: 'C:\\source' },
      result: '{"workflowState":"awaiting_image_geometry_extraction","cadFiles":[]}',
    }, {
      id: 'verify-inventory',
      name: 'work_product_verify',
      arguments: {},
      result: '{"status":"pass"}',
    }];
    const grounded = [{
      id: 'geometry',
      name: 'floorplan_extract_geometry',
      arguments: { imagePath: 'C:\\source\\plan.png', knownDimensions: '9000 x 7600 mm' },
      result: '{"geometryReady":true,"geometryVerified":true,"geometryReceiptPath":"C:\\\\source\\\\plan.geometry-receipt.json","cadGenerateDxfArgs":{"width":9000,"height":7600,"sourcePath":"C:\\\\source\\\\plan.png","walls":[{"x1":0,"y1":0,"x2":9000,"y2":0}],"rooms":[{"name":"Living","x":0,"y":0,"width":4500,"height":3800}]}}',
    }, {
      id: 'dxf',
      name: 'cad_generate_dxf',
      arguments: { sourcePath: 'C:\\source\\plan.png', width: 9000, height: 7600, walls: [{ x1: 0, y1: 0, x2: 9000, y2: 0 }] },
      result: '{"path":"C:\\\\output\\\\plan.dxf","bytes":2400,"geometryVerified":true,"geometryValidation":{"passed":true},"geometryReceiptPath":"C:\\\\source\\\\plan.geometry-receipt.json"}',
    }, {
      id: 'verify-dxf',
      name: 'work_product_verify',
      arguments: {},
      result: '{"status":"pass","artifactChecks":[{"path":"C:\\\\output\\\\plan.dxf","exists":true}]}',
    }];

    expect(contract.kind).toBe('cad_drafting');
    expect(hasCoreActionEvidence(contract, inventoryOnly, text)).toBe(false);
    expect(hasCoreActionEvidence(contract, grounded, text)).toBe(true);
  });

  it('requires MCP marker evidence and excludes script fallback for an explicit MCP-only run', () => {
    const text = 'Draw this visibly in AutoCAD stroke by stroke. Use AutoCAD MCP only; do not use LISP, scripts, or fallback.';
    const fallback = [{
      id: 'fallback',
      name: 'cad_generate_dxf',
      arguments: {},
      result: '{"status":"completed","completionMarkerExists":true}',
    }];
    const mcp = [{
      id: 'mcp',
      name: 'mcp_cad-drafting_autocad_playback_file',
      arguments: {},
      result: '{"status":"completed","transport":"mcp_autocad_com","visiblePlayback":true,"completionMarkerExists":true,"geometryVerified":true,"entityCountMatches":true,"operationCount":46,"expectedEntityCount":46,"entitiesAdded":46,"operationSetId":"verified-operation-set"}',
    }];

    expect(requiresAutoCadMcpPlayback(text)).toBe(true);
    expect(buildActionContract(text).preferredTools).toContain('cad_prepare_autocad_operations');
    expect(buildActionContract(text).preferredTools).not.toContain('cad_generate_dxf');
    expect(hasVisibleAutoCadExecutionEvidence(fallback, text)).toBe(false);
    expect(hasVisibleAutoCadExecutionEvidence(mcp, text)).toBe(true);
  });

  it('keeps CAD primary when a browser preview is explicitly rejected', () => {
    const contract = buildActionContract(
      'Draw this in AutoCAD. Do not use a browser preview or DXF-only delivery.',
    );

    expect(contract.kind).toBe('cad_drafting');
  });

  it('treats AutoCAD installation inspection as desktop observation', () => {
    const contract = buildActionContract(
      'Inspect the installed AutoCAD launch target and do not open anything.',
    );

    expect(contract.kind).toBe('desktop_operation');
  });

  it('treats desktop file listing plus active-window inspection as observation, not artifact delivery', () => {
    const text = '\u7ec4\u5efa\u56e2\u961f\uff0c\u5206\u4e24\u6b65\u6267\u884c\uff1a\u5148\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff0c\u518d\u5217\u51fa\u684c\u9762\u6587\u4ef6\uff0c\u6700\u540e\u6839\u636e\u771f\u5b9e\u5de5\u5177\u7ed3\u679c\u544a\u8bc9\u6211\u7a97\u53e3\u6807\u9898\u548c\u6587\u4ef6\u6570\u91cf\u3002';
    const contract = buildActionContract(text);
    const verification = {
      terminalVerification: {
        status: 'verified' as const,
        strategy: 'terminal_receipt' as const,
        reason: 'Fresh native desktop observation.',
      },
    };
    const activeOnly = [{
      name: 'desktop_active_window',
      arguments: {},
      result: '{"title":"WPS Writer","process_name":"wps.exe"}',
      ...verification,
    }];
    const complete = [...activeOnly, {
      name: 'desktop_list_files',
      arguments: { path: '~/Desktop' },
      result: '[]',
      ...verification,
    }];

    expect(contract.kind).toBe('desktop_operation');
    expect(contract.label).toBe('\u684c\u9762\u72b6\u6001\u8bfb\u53d6');
    expect(contract.preferredTools).toEqual([
      'desktop_active_window',
      'desktop_list_files',
    ]);
    expect(hasCoreActionEvidence(contract, activeOnly, text)).toBe(false);
    expect(hasCoreActionEvidence(contract, complete, text)).toBe(true);
  });

  it('treats an unattached deictic open-file request as exact current-document work', () => {
    const text = '分析打开的这份文件';
    const contract = buildActionContract(text);
    const verification = {
      status: 'verified' as const,
      strategy: 'terminal_receipt' as const,
      reason: 'test receipt',
    };
    const read = {
      name: 'extract_document_text',
      arguments: { filePath: 'C:\\Users\\Tester\\Desktop\\Deck.pptx' },
      result: JSON.stringify({ ok: true, content: 'verified deck content' }),
      terminalVerification: verification,
    };
    const discovery = {
      name: 'search_files',
      arguments: { directory: 'C:\\Users\\Tester\\Desktop', pattern: 'Deck.pptx' },
      result: JSON.stringify([{ path: 'C:\\Users\\Tester\\Desktop\\Deck.pptx' }]),
      terminalVerification: verification,
    };

    expect(contract).toMatchObject({
      kind: 'desktop_operation',
      label: 'Current authoring document inspection',
    });
    expect(hasCoreActionEvidence(contract, [{
      name: 'desktop_active_window',
      arguments: {},
      result: JSON.stringify({ ok: true, processName: 'lumi-core.exe', title: 'LumiCore' }),
      terminalVerification: verification,
    }, read], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [{
      name: 'desktop_active_window',
      arguments: {},
      result: JSON.stringify({ ok: true, processName: 'wpp.exe', title: 'Deck.pptx - WPS Office' }),
      terminalVerification: verification,
    }, read], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [{
      name: 'desktop_active_window',
      arguments: {},
      result: JSON.stringify({ ok: true, processName: 'wpp.exe', title: 'Deck.pptx - WPS Office' }),
      terminalVerification: verification,
    }, discovery, read], text)).toBe(true);

    for (const injectedHeader of [
      'Recent action continuation context',
      'Internal client-surface continuation context',
    ]) {
      const contextual = buildActionContract([
        text,
        `## ${injectedHeader}`,
        '- prior state: still waiting for an exact current-document anchor',
      ].join('\n\n'));
      expect(contextual).toMatchObject({
        kind: 'desktop_operation',
        label: 'Current authoring document inspection',
      });
    }

    const attached = buildActionContract([
      text,
      '## Current Turn Attachments',
      '### 1. Deck.pptx',
      'Local path: C:\\Users\\Tester\\LumiCore\\data\\knowledge\\Deck.pptx',
      '[BEGIN UNTRUSTED ATTACHMENT DATA]',
      'deck content',
      '[END UNTRUSTED ATTACHMENT DATA]',
    ].join('\n\n'));
    expect(attached.label).not.toBe('Current authoring document inspection');
  });

  it('does not complete current WPS analysis from an active-window candidate alone', () => {
    const text = '[LUMI_REGRESSION:S3] 请分析当前 WPS 活动窗口里的演示文稿。当前文档路径未知，未确认文件名前不要读取。';
    const contract = buildActionContract(text);
    const activeCandidate = {
      name: 'desktop_active_window',
      arguments: {},
      result: JSON.stringify({
        ok: true,
        title: 'WPS-Quarterly-Review-Draft.pptx - WPS Office',
        processName: 'wps.exe',
        documentName: 'WPS-Quarterly-Review-Draft.pptx',
      }),
      terminalVerification: {
        status: 'verified' as const,
        strategy: 'terminal_receipt' as const,
        reason: 'foreground observation returned',
      },
    };
    const exactRead = {
      name: 'read_file',
      arguments: { path: '~/Desktop/WPS-Quarterly-Review-Final.pptx' },
      result: JSON.stringify({ ok: true, content: 'verified final presentation content' }),
      terminalVerification: {
        status: 'verified' as const,
        strategy: 'terminal_receipt' as const,
        reason: 'exact target contents returned',
      },
    };
    const matchingRead = {
      ...exactRead,
      arguments: { path: '~/Desktop/WPS-Quarterly-Review-Draft.pptx' },
    };
    const matchingDiscovery = {
      name: 'desktop_list_files',
      arguments: { path: '~/Desktop' },
      result: JSON.stringify([{
        name: 'WPS-Quarterly-Review-Draft.pptx',
        path: '~/Desktop/WPS-Quarterly-Review-Draft.pptx',
      }]),
      terminalVerification: activeCandidate.terminalVerification,
    };

    expect(contract).toMatchObject({
      kind: 'desktop_operation',
      label: 'Current authoring document inspection',
    });
    expect(hasCoreActionEvidence(contract, [activeCandidate], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [activeCandidate, exactRead], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [activeCandidate, matchingRead], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [activeCandidate, matchingDiscovery, matchingRead], text)).toBe(true);
    expect(hasCoreActionEvidence(contract, [{
      ...activeCandidate,
      result: JSON.stringify({
        ok: true,
        title: 'WPS Office',
        processName: 'wps.exe',
      }),
    }, matchingRead], text)).toBe(false);
  });

  it('uses one verified background Office document but rejects empty or ambiguous window candidates', () => {
    const text = '分析 WPS 当前打开的文件';
    const contract = buildActionContract(text);
    const verification = {
      status: 'verified' as const,
      strategy: 'measured' as const,
      reason: 'native process/window snapshot',
    };
    const activeLumi = {
      name: 'desktop_active_window',
      arguments: {},
      result: JSON.stringify({ ok: true, processName: 'lumi-core.exe', title: 'LumiCore' }),
      terminalVerification: { ...verification, strategy: 'terminal_receipt' as const },
    };
    const running = (windowTitles: string[]) => ({
      name: 'desktop_running_processes',
      arguments: { top: 50 },
      result: JSON.stringify([{
        pid: 4200,
        name: 'wpp.exe',
        window_title: windowTitles[0] || '',
        window_titles: windowTitles,
        cpu_percent: 0,
        memory_mb: 120,
      }]),
      terminalVerification: verification,
    });
    const discovery = {
      name: 'search_files',
      arguments: { directory: '~/Desktop', pattern: 'Roadshow.pptx' },
      result: JSON.stringify([{ path: '~/Desktop/Roadshow.pptx' }]),
      terminalVerification: { ...verification, strategy: 'terminal_receipt' as const },
    };
    const read = {
      name: 'extract_document_text',
      arguments: { filePath: '~/Desktop/Roadshow.pptx' },
      result: JSON.stringify({ ok: true, content: 'roadshow content' }),
      terminalVerification: { ...verification, strategy: 'terminal_receipt' as const },
    };

    expect(hasCoreActionEvidence(contract, [
      activeLumi,
      running(['Roadshow.pptx - WPS Office']),
      discovery,
      read,
    ], text)).toBe(true);
    expect(hasCoreActionEvidence(contract, [
      activeLumi,
      running([]),
      discovery,
      read,
    ], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [
      activeLumi,
      running([
        'Roadshow.pptx - WPS Office',
        'Budget.xlsx - WPS Office',
      ]),
      discovery,
      read,
    ], text)).toBe(false);
  });

  it('recognizes a unique background Microsoft Word document for a Word-specific request', () => {
    const text = '请分析 Microsoft Word 当前打开的文档';
    const contract = buildActionContract(text);
    const verification = {
      status: 'verified' as const,
      strategy: 'terminal_receipt' as const,
      reason: 'native verified receipt',
    };
    const records = [{
      name: 'desktop_running_processes',
      arguments: { top: 50 },
      result: JSON.stringify([{
        pid: 5200,
        name: 'WINWORD.EXE',
        window_title: 'Contract.docx - Microsoft Word',
        window_titles: ['Contract.docx - Microsoft Word'],
      }]),
      terminalVerification: verification,
    }, {
      name: 'desktop_list_files',
      arguments: { path: '~/Documents' },
      result: JSON.stringify([{ path: '~/Documents/Contract.docx' }]),
      terminalVerification: verification,
    }, {
      name: 'read_docx',
      arguments: { filePath: '~/Documents/Contract.docx' },
      result: JSON.stringify({ ok: true, content: 'contract content' }),
      terminalVerification: verification,
    }];

    expect(hasCoreActionEvidence(contract, records, text)).toBe(true);
  });

  it('fails closed on the wrong authoring app and malformed document-read evidence', () => {
    const text = '请分析当前 WPS 活动窗口里的演示文稿。';
    const contract = buildActionContract(text);
    const verification = {
      status: 'verified' as const,
      strategy: 'terminal_receipt' as const,
      reason: 'test receipt',
    };
    const wpsWindow = {
      name: 'desktop_active_window',
      arguments: {},
      result: JSON.stringify({ ok: true, processName: 'wps.exe', title: '季度复盘.pptx - WPS Office' }),
      terminalVerification: verification,
    };
    const wordWindowWithMisleadingTitle = {
      ...wpsWindow,
      result: JSON.stringify({
        ok: true,
        processName: 'WINWORD.EXE',
        title: 'WPS 使用说明.docx - Microsoft Word',
      }),
    };
    const validRead = {
      name: 'extract_document_text',
      arguments: { filePath: '~/Desktop/季度复盘.pptx' },
      result: '第一页：季度目标与实际完成情况。',
      terminalVerification: verification,
    };
    const discovery = {
      name: 'desktop_list_files',
      arguments: { path: '~/Desktop' },
      result: JSON.stringify([{
        name: '季度复盘.pptx',
        path: '~/Desktop/季度复盘.pptx',
      }]),
      terminalVerification: verification,
    };

    expect(hasCoreActionEvidence(contract, [wordWindowWithMisleadingTitle, validRead], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [wpsWindow, {
      ...validRead,
      arguments: { password: 'does-not-identify-a-file' },
    }], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [wpsWindow, {
      ...validRead,
      result: JSON.stringify({ ok: false, status: 'not_found', error: 'missing' }),
    }], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [wpsWindow, {
      ...validRead,
      result: JSON.stringify({ ok: true, content: '' }),
    }], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [wpsWindow, validRead], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [wpsWindow, discovery, validRead], text)).toBe(true);

    const wpsWindowWithKnownPath = {
      ...wpsWindow,
      result: JSON.stringify({
        ok: true,
        processName: 'wps.exe',
        currentDocument: {
          name: '季度复盘.pptx',
          path: 'C:\\Users\\Tester\\Desktop\\季度复盘.pptx',
          pathStatus: 'resolved',
        },
      }),
    };
    expect(hasCoreActionEvidence(contract, [wpsWindowWithKnownPath, validRead], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [wpsWindowWithKnownPath, {
      ...validRead,
      arguments: { filePath: 'c:/users/tester/desktop/季度复盘.pptx' },
    }], text)).toBe(true);
  });

  it('threads TaskCapsule current and rejected targets into current-document completion evidence', () => {
    const text = '\u8bf7\u5206\u6790\u5f53\u524d WPS \u6d3b\u52a8\u7a97\u53e3\u91cc\u7684\u6f14\u793a\u6587\u7a3f\u3002';
    const contract = buildActionContract(text);
    const currentPath = 'C:\\Users\\Tester\\Desktop\\Quarterly-Review.pptx';
    const rejectedPath = 'D:\\Archive\\Quarterly-Review.pptx';
    const sameBasenameWrongDirectory = 'E:\\Other\\Quarterly-Review.pptx';
    const verification = {
      status: 'verified' as const,
      strategy: 'terminal_receipt' as const,
      reason: 'exact semantic document read',
    };
    const wpsWindow = {
      name: 'desktop_active_window',
      arguments: {},
      result: JSON.stringify({
        ok: true,
        processName: 'wps.exe',
        title: 'Quarterly-Review.pptx - WPS Office',
      }),
      terminalVerification: verification,
    };
    const read = (path: string, id: string) => ({
      id,
      name: 'extract_document_text',
      arguments: { filePath: path },
      result: JSON.stringify({ ok: true, content: `verified content from ${path}` }),
      terminalVerification: verification,
    });
    const capsule = {
      schemaVersion: 1,
      taskId: 'task-wps-corrected-target',
      revision: 4,
      status: 'executing',
      unfinished: true,
      goal: text,
      currentInstruction: text,
      target: {
        label: 'Quarterly-Review.pptx',
        application: 'WPS',
        window: 'Quarterly-Review.pptx - WPS Office',
        object: 'Quarterly-Review.pptx',
        path: currentPath,
        location: 'Desktop',
        status: 'confirmed',
        source: 'tool_receipt',
      },
      paths: [rejectedPath, currentPath],
      allowedSearchRoots: ['C:\\Users\\Tester\\Desktop'],
      analysisReady: true,
      nextAction: 'analyze',
      latestCorrection: {
        text: `Use ${currentPath}, not ${rejectedPath}.`,
        previousTarget: rejectedPath,
        replacementTarget: currentPath,
        observedAt: '2026-08-27T00:00:00.000Z',
      },
      completedSteps: [],
      blocker: '',
      toolSummaries: [],
      rejectedTargets: [{
        identity: rejectedPath,
        reason: 'Rejected by the user correction.',
        observedAt: '2026-08-27T00:00:00.000Z',
      }],
      doNotRetry: [],
      updatedAt: '2026-08-27T00:00:01.000Z',
    } satisfies TaskCapsuleV1;
    const currentRead = read('c:/users/tester/desktop/Quarterly-Review.pptx', 'current-read');
    const lateRejectedRead = read(rejectedPath, 'late-rejected-read');
    const wrongDirectoryRead = read(sameBasenameWrongDirectory, 'same-basename-wrong-directory');
    const legacyDiscovery = {
      name: 'search_files',
      arguments: { directory: 'D:\\Archive', pattern: 'Quarterly-Review.pptx' },
      result: JSON.stringify([{ path: rejectedPath }]),
      terminalVerification: verification,
    };

    // Without a capsule, the title still needs one exact discovery result.
    expect(hasCoreActionEvidence(contract, [wpsWindow, lateRejectedRead], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [wpsWindow, legacyDiscovery, lateRejectedRead], text)).toBe(true);
    expect(hasCoreActionEvidence(contract, [wpsWindow, legacyDiscovery, lateRejectedRead], text, capsule)).toBe(false);
    expect(hasCoreActionEvidence(contract, [wpsWindow, wrongDirectoryRead], text, capsule)).toBe(false);
    expect(hasCoreActionEvidence(contract, [wpsWindow, currentRead], text, capsule)).toBe(true);
    // A rejected receipt arriving after the accepted read is historical only.
    expect(hasCoreActionEvidence(
      contract,
      [wpsWindow, currentRead, lateRejectedRead],
      text,
      capsule,
    )).toBe(true);
    expect(taskCompletionFromReceipts(
      text,
      recordsToTaskReceipts([wpsWindow, lateRejectedRead]),
      capsule,
    ).complete).toBe(false);
    expect(taskCompletionFromReceipts(
      text,
      recordsToTaskReceipts([wpsWindow, currentRead, lateRejectedRead]),
      capsule,
    ).complete).toBe(true);
  });

  it('completes an exact read-only file inspection from verified same-path semantic content', () => {
    const exactPath = 'C:\\Users\\Tester\\Documents\\s8-marker.txt';
    const text = `Inspect the exact marker inside ${exactPath} and report its contents.`;
    const contract = buildActionContract(text);
    const verifiedRead = {
      name: 'read_file',
      arguments: { path: 'c:/users/tester/documents/s8-marker.txt' },
      result: 'S8_ACTION_CONTRACT_VERIFIED',
      receipt: {
        kind: 'text_readback_metadata',
        byteLength: 27,
        contentDigest: 'deterministic-test-digest',
      },
      terminalVerification: {
        status: 'verified' as const,
        strategy: 'terminal_receipt' as const,
        reason: 'Exact file contents returned.',
      },
    };

    expect(contract.kind).toBe('artifact_work');
    expect(hasCoreActionEvidence(contract, [verifiedRead], text)).toBe(true);
    expect(hasCoreActionEvidence(contract, [{
      ...verifiedRead,
      terminalVerification: undefined,
    }], text)).toBe(false);
  });

  it('does not complete a file mutation from its preparatory read receipt', () => {
    const exactPath = 'C:\\Users\\Tester\\Documents\\s8-marker.txt';
    const text = `Modify ${exactPath} to contain a new marker; inspect the current contents first.`;
    const contract = buildActionContract(text);
    const preparatoryRead = {
      name: 'read_file',
      arguments: { path: exactPath },
      result: 'old marker',
      terminalVerification: {
        status: 'verified' as const,
        strategy: 'terminal_receipt' as const,
        reason: 'Source contents returned.',
      },
    };

    expect(contract.kind).toBe('artifact_work');
    expect(hasCoreActionEvidence(contract, [preparatoryRead], text)).toBe(false);
  });

  it('does not accept a model-selected file from a vague search request as the anchored target', () => {
    const text = 'Find the marker file somewhere under C:\\Users\\Tester\\Documents, read it, and report its contents.';
    const contract = buildActionContract(text);
    const unanchoredRead = {
      name: 'read_file',
      arguments: { path: 'C:\\Users\\Tester\\Documents\\guessed-marker.txt' },
      result: 'guessed marker',
      terminalVerification: {
        status: 'verified' as const,
        strategy: 'terminal_receipt' as const,
        reason: 'A file was read, but it was not user-anchored.',
      },
    };

    expect(contract.kind).toBe('artifact_work');
    expect(hasCoreActionEvidence(contract, [unanchoredRead], text)).toBe(false);
  });

  it('requires authenticated result evidence for login-then-search browser work', () => {
    const text = '\u6253\u5f00\u4e2d\u56fd\u88c1\u5224\u6587\u4e66\u7f51\uff0c\u81ea\u52a8\u767b\u5f55\u8d26\u53f7\u627e\u4e00\u4e0b\u6d59\u6c5f\u7701\u7684\u6848\u4ef6';

    expect(buildActionContract(text).kind).toBe('browser_account');
    expect(requiresAuthenticatedWebResult(text)).toBe(true);
    expect(buildActionContract(text).preferredTools.slice(0, 4)).toEqual([
      'web_login_profile_list',
      'web_login_profile_save_from_preset',
      'web_login_run',
      'url_fetch_logged_in',
    ]);
    expect(hasAuthenticatedWebResultEvidence([{
      id: 'login-page',
      name: 'mcp_playwright_browser_snapshot',
      arguments: {},
      result: 'Page URL: https://wenshu.court.gov.cn/website/wenshu/181010CARHS5BS3C/index.html?open=login\\n登录/注册',
    }], text)).toBe(false);
    expect(hasAuthenticatedWebResultEvidence([{
      id: 'result-page',
      name: 'mcp_playwright_browser_snapshot',
      arguments: {},
      result: 'Page URL: https://wenshu.court.gov.cn/search\\n浙江省 案件 检索结果 列表 裁判文书',
    }], text)).toBe(true);
  });

  it('requires a real visual probe for visual-model availability instead of file-search success', () => {
    const text = '\u68c0\u67e5\u89c6\u89c9\u6a21\u578b\u5f53\u524d\u662f\u5426\u53ef\u7528';
    const contract = buildActionContract(text);
    const verified = {
      status: 'verified' as const,
      strategy: 'terminal_receipt' as const,
      reason: 'Fresh terminal result.',
    };
    const search = {
      name: 'search_files',
      arguments: { path: 'D:\\lumiOS', pattern: 'vision' },
      result: JSON.stringify({ ok: true, matches: ['vision_routing.ts'] }),
      terminalVerification: verified,
    };
    const visual = {
      name: 'ocr_screen',
      arguments: { query: '\u8bc6\u522b\u5f53\u524d\u7a97\u53e3' },
      result: '\u5f53\u524d\u662f LumiCore \u804a\u5929\u754c\u9762\u3002',
      terminalVerification: verified,
    };

    expect(requiresVisualModelAvailabilityCheck(text)).toBe(true);
    expect(contract).toMatchObject({ kind: 'desktop_operation', label: 'Live visual-perception availability check' });
    expect(hasVisualModelAvailabilityEvidence([search])).toBe(false);
    expect(hasCoreActionEvidence(contract, [search], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [search, visual], text)).toBe(true);
  });

  it('recognizes the observed Aliyun page when the process-name verifier reports target mismatch', () => {
    const text = '\u6253\u5f00\u963f\u91cc\u4e91\u5b98\u7f51';
    const records = [{
      name: 'desktop_open',
      arguments: { target: 'https://www.aliyun.com' },
      result: JSON.stringify({
        ok: false,
        status: 'target_mismatch',
        target: 'https://www.aliyun.com',
        targetMatched: false,
        actualTarget: {
          title: '\u963f\u91cc\u4e91-\u8ba1\u7b97\uff0c\u4e3a\u4e86\u65e0\u6cd5\u8ba1\u7b97\u7684\u4ef7\u503c - \u5938\u514b',
          processName: 'quark.exe',
        },
      }),
      terminalVerification: {
        status: 'failed' as const,
        strategy: 'state_diff' as const,
        reason: 'The terminal receipt reported target_mismatch.',
      },
    }];

    expect(hasRequestedDesktopOpenEvidence(records, text)).toBe(true);
    expect(hasCoreActionEvidence(buildActionContract(text), records, text)).toBe(true);
  });

  it('requires observed playing state after a generic NetEase key dispatch', () => {
    const text = '\u6253\u5f00\u7f51\u6613\u4e91\u5e76\u64ad\u653e\u97f3\u4e50';
    const verified = {
      status: 'verified' as const,
      strategy: 'state_diff' as const,
      reason: 'Fresh target state returned.',
    };
    const records = [{
      name: 'desktop_active_window',
      arguments: {},
      result: JSON.stringify({ title: '\u6708\u7259\u513f - Ice Paper', process_name: 'cloudmusic.exe' }),
      terminalVerification: verified,
    }, {
      name: 'desktop_keyboard_press',
      arguments: { key: 'space', expectedProcessId: 24716 },
      result: JSON.stringify({ ok: true, status: 'verified', targetMatched: true }),
      terminalVerification: verified,
    }];

    expect(requiresMediaPlaybackAction(text)).toBe(true);
    expect(buildActionContract(text)).toMatchObject({ kind: 'desktop_operation', label: 'Verified music playback' });
    expect(hasRequestedDesktopOpenEvidence(records, text, '\u7f51\u6613\u4e91')).toBe(true);
    expect(hasMediaPlaybackEvidence(records, text)).toBe(false);
    expect(hasCoreActionEvidence(buildActionContract(text), records, text)).toBe(false);

    const withPlayingState = [...records, {
      name: 'desktop_ui_snapshot',
      arguments: { root: 'active' },
      result: JSON.stringify({ status: 'ok', playerState: 'playing' }),
      terminalVerification: verified,
    }];
    expect(hasMediaPlaybackEvidence(withPlayingState, text)).toBe(true);
    expect(hasCoreActionEvidence(buildActionContract(text), withPlayingState, text)).toBe(true);
  });

  it('keeps the field playback correction under the media contract and rejects unrelated receipts', () => {
    const text = '\u90a3\u4f60\u76f4\u63a5\u653e\u5f53\u524d\u7684\u97f3\u4e50';
    const verified = {
      status: 'verified' as const,
      strategy: 'terminal_receipt' as const,
      reason: 'The adapter returned a terminal observation.',
    };
    const records = [{
      name: 'desktop_list_apps',
      arguments: { query: '\u7f51\u6613\u4e91' },
      result: JSON.stringify([{ app_id: '\u7f51\u6613\u4e91\u97f3\u4e50' }]),
      terminalVerification: verified,
    }, {
      name: 'desktop_open',
      arguments: { target: '\u7f51\u6613\u4e91\u97f3\u4e50' },
      result: JSON.stringify({
        ok: false,
        status: 'target_mismatch',
        targetMatched: false,
        actualTarget: { title: 'LumiCore', processName: 'lumi-core.exe' },
      }),
      terminalVerification: {
        status: 'failed' as const,
        strategy: 'terminal_receipt' as const,
        reason: 'The foreground application did not match NetEase Cloud Music.',
      },
    }, {
      name: 'desktop_active_window',
      arguments: {},
      result: JSON.stringify({ title: 'LumiCore', process_name: 'lumi-core.exe' }),
      terminalVerification: verified,
    }, {
      name: 'desktop_keyboard_press',
      arguments: { key: 'alt+space', expectedProcessId: 78084 },
      result: JSON.stringify({
        ok: true,
        status: 'verified',
        targetMatched: true,
        actualTarget: { title: 'LumiCore', process_name: 'lumi-core.exe' },
      }),
      terminalVerification: verified,
    }];

    expect(requiresMediaPlaybackAction(text)).toBe(true);
    expect(buildActionContract(text)).toMatchObject({
      applies: true,
      kind: 'desktop_operation',
      label: 'Verified music playback',
    });
    expect(hasMediaPlaybackEvidence(records, text)).toBe(false);
    expect(hasCoreActionEvidence(buildActionContract(text), records, text)).toBe(false);
    expect(taskCompletionFromReceipts(text, recordsToTaskReceipts(records))).toMatchObject({
      complete: false,
    });
  });

  it('renders a reusable prompt section with stages and evidence', () => {
    const prompt = formatActionContractPrompt(buildActionContract('\u89c6\u9891\u7f51\u7ad9\u81ea\u52a8\u8bc4\u8bba'));

    expect(prompt).toContain('Lumi Action Contract');
    expect(prompt).toContain('Core action');
    expect(prompt).toContain('Preparation is not completion');
    expect(prompt).toContain('Required completion evidence');
  });
});
