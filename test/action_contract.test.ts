import { describe, expect, it } from 'vitest';
import {
  buildActionContract,
  formatActionContractPrompt,
  hasCoreActionEvidence,
  hasVisibleAutoCadExecutionEvidence,
  requiresVisibleAutoCadExecution,
} from '../server/cognition/action_contract';

describe('Lumi action contract', () => {
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

  it('treats directed person-to-person sends as real messaging work', () => {
    const contract = buildActionContract('\u7ed9\u5f20\u4e09\u53d1\u4e0b\u5348\u4e09\u70b9\u5f00\u4f1a');

    expect(contract.kind).toBe('messaging_send');
    expect(contract.coreAction).toContain('\u6536\u4ef6\u4eba');
    expect(hasCoreActionEvidence(contract, [{
      id: '1',
      name: 'desktop_active_window',
      arguments: {},
      result: 'WeChat is active',
    }])).toBe(false);
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
      name: 'cad_run_autocad_draw_script',
      arguments: { scriptPath: 'C:\\\\Users\\\\me\\\\Desktop\\\\plan.scr' },
      result: '{"status":"completed","completionMarkerExists":true}',
    }])).toBe(true);
  });

  it('renders a reusable prompt section with stages and evidence', () => {
    const prompt = formatActionContractPrompt(buildActionContract('\u89c6\u9891\u7f51\u7ad9\u81ea\u52a8\u8bc4\u8bba'));

    expect(prompt).toContain('Lumi Action Contract');
    expect(prompt).toContain('Core action');
    expect(prompt).toContain('Preparation is not completion');
    expect(prompt).toContain('Required completion evidence');
  });
});
