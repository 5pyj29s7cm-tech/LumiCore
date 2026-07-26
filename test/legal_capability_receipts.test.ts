import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';

let cleanup = () => {};
let registerLegalTools: (registry: ToolRegistry) => void;

beforeAll(async () => {
  const app = await makeApp();
  cleanup = app.cleanup;
  ({ registerLegalTools } = await import('../server/tools/definitions/legal_tools'));
});

afterAll(() => cleanup());

describe('legal capability terminal receipts', () => {
  it('keeps case text readable while verifying the persisted case mutation', async () => {
    const registry = new ToolRegistry();
    registerLegalTools(registry);
    const caseName = `Receipt case ${Date.now()}`;
    const record = await executeToolCall({
      registry,
      name: 'legal_case_workspace',
      arguments: {
        orgId: `legal-receipt-${Date.now()}`,
        userId: 'vitest',
        caseName,
        facts: 'A contract was performed but payment remains outstanding.',
      },
    });

    expect(record.result).toContain(caseName);
    expect(record.result).toContain('案件ID：');
    expect(record.receipt).toMatchObject({
      ok: true,
      status: 'updated',
      persisted: true,
    });
    expect((record.receipt as any).changedCaseIds).toHaveLength(1);
    expect(record.terminalVerification?.status).toBe('verified');
  });

  it('reports a blocked delivery gate as failure even when audit files were written', async () => {
    const registry = new ToolRegistry();
    registerLegalTools(registry);
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-legal-receipt-'));
    try {
      const record = await executeToolCall({
        registry,
        name: 'legal_finalize_delivery_package',
        arguments: {
          orgId: `legal-blocked-receipt-${Date.now()}`,
          userId: 'vitest',
          caseName: 'Blocked delivery receipt',
          content: 'This draft has facts but no verified current-law citation.',
          outputDir,
          includeDocx: false,
        },
        context: {
          allowLocalFileWrites: true,
          localWriteIntentReason: 'Test explicitly requests a local legal package.',
        },
      });

      expect(record.result).toContain('正式交付包未生成');
      expect(record.receipt).toMatchObject({ ok: false, status: 'blocked' });
      expect(record.terminalVerification?.status).toBe('failed');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
