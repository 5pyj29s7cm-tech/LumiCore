import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildActionContract } from '../server/cognition/action_contract';
import { routeToolsForTurn } from '../server/cognition/tool_router';
import { executeToolCall } from '../server/tools/execution_engine';
import {
  canAutoApproveAction,
  classifyAction,
  classifyActionRisk,
  evaluateActionConstitution,
} from '../server/tools/action_constitution';
import { registerDesktopTools } from '../server/tools/definitions/desktop_tools';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import {
  clearAllPendingConfirmationsForTests,
  recordPendingConfirmation,
} from '../server/tools/pending_confirmation';
import { ToolRegistry } from '../server/tools/registry';

function declarations(names: string[]) {
  return names.map(name => ({
    type: 'function' as const,
    function: {
      name,
      description: name === 'desktop_write_text_file'
        ? 'Write exact text to an exact native host file path.'
        : name,
      parameters: { type: 'object', properties: {} },
    },
  }));
}

describe('native desktop text-file capability', () => {
  it('is a high-risk local write that cannot be auto-approved', () => {
    const registry = new ToolRegistry();
    registerDesktopTools(registry);
    const manifest = registry.getCapabilityManifestEntry('desktop_write_text_file');

    expect(manifest).toMatchObject({
      capabilityId: 'desktop.files.text.write',
      lane: 'files',
      risk: 'high',
      requiresConfirmation: true,
      operation: 'mutate',
    });
    expect(classifyAction('desktop_write_text_file')).toBe('local_write');
    expect(classifyActionRisk('desktop_write_text_file')).toBe('high');
    expect(canAutoApproveAction('desktop_write_text_file')).toBe(false);
    expect(evaluateActionConstitution(
      'desktop_write_text_file',
      { path: '~/Desktop/note.txt', content: 'hello' },
      'safe',
      undefined,
      manifest,
    )).toMatchObject({ level: 'confirm', domain: 'local_write' });
  });

  it('routes artifact creation to the semantic native writer without shell fallback', () => {
    const contract = buildActionContract('Create a text file at C:\\Users\\me\\Desktop\\note.txt with exact content hello.');
    expect(contract.preferredTools).toContain('desktop_write_text_file');

    const route = routeToolsForTurn(
      'Create a text file at C:\\Users\\me\\Desktop\\note.txt with exact content hello.',
      declarations([
        'desktop_write_text_file',
        'write_file',
        'read_file',
        'desktop_path_info',
        'desktop_run_command',
      ]),
    );
    expect(route.toolNames).toContain('desktop_write_text_file');
  });

  it('produces a verified canonical receipt only after exact native byte read-back', async () => {
    const registry = new ToolRegistry();
    registerDesktopTools(registry);
    const content = '确认续接自动回读通过';
    const desktopRelay = vi.fn(async (name: string, args: Record<string, any>) => {
      expect(name).toBe('desktop_write_text_file');
      expect(args).toEqual({
        path: '~/Desktop/note.txt',
        content,
        encoding: 'utf-8',
        overwritePolicy: 'fail_if_exists',
      });
      return JSON.stringify({
        success: true,
        status: 'verified',
        path: 'C:\\Users\\me\\Desktop\\note.txt',
        bytesWritten: Buffer.byteLength(content, 'utf8'),
        encoding: 'utf-8',
        overwritePolicy: 'fail_if_exists',
        overwritten: false,
        readBackMatched: true,
      });
    });
    const requestConfirmation = vi.fn(async () => true);

    const record = await executeToolCall({
      registry,
      name: 'desktop_write_text_file',
      arguments: { path: '~/Desktop/note.txt', content },
      context: { desktopRelay, requestConfirmation },
    });

    expect(requestConfirmation).toHaveBeenCalledOnce();
    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(record.envelope?.status).toBe('verified_success');
    expect(JSON.parse(record.result)).toMatchObject({
      ok: true,
      status: 'verified',
      receiptType: 'native_text_file_write',
      path: 'C:\\Users\\me\\Desktop\\note.txt',
      readBackMatched: true,
      contentSha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
      verificationScope: 'native_byte_read_back',
    });
  });

  it('lets the existing read_file tool fall back to the native text relay for host paths', async () => {
    const registry = new ToolRegistry();
    registerFileOpsTools(registry);
    const desktopRelay = vi.fn(async (name: string, args: Record<string, any>) => {
      expect(name).toBe('desktop_read_text_file');
      expect(args.path).toMatch(/Desktop[\\/]relay-only\.txt$/);
      return JSON.stringify({
        success: true,
        path: args.path,
        content: 'native read-back',
        bytesRead: 16,
        encoding: 'utf-8',
      });
    });

    const result = await registry.execute('read_file', {
      path: path.join(os.homedir(), 'Desktop', 'relay-only.txt'),
    }, { desktopRelay });
    expect(result).toBe('native read-back');
    expect(desktopRelay).toHaveBeenCalledOnce();
  });

  it('shows the exact path and a bounded content summary in one-time confirmation', () => {
    clearAllPendingConfirmationsForTests();
    const content = 'x'.repeat(400);
    const pending = recordPendingConfirmation('u-native-write', 'desktop_write_text_file', {
      path: '~/Desktop/note.txt',
      content,
      encoding: 'utf-8',
      overwritePolicy: 'replace',
    });

    expect(pending.target).toBe('~/Desktop/note.txt');
    expect(pending.safeArgs).toMatchObject({
      path: '~/Desktop/note.txt',
      encoding: 'utf-8',
      overwritePolicy: 'replace',
      contentSummary: {
        characters: 400,
        truncated: true,
        sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
      },
    });
    expect(String((pending.safeArgs as any).contentSummary.preview)).toHaveLength(120);
    expect(pending.safeArgs).not.toHaveProperty('content');
    clearAllPendingConfirmationsForTests();
  });
});
