import fs from 'fs';
import { describe, expect, it } from 'vitest';
import { registerOfficeTools } from '../server/tools/definitions/office_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';

describe('cross-platform presentation generation', () => {
  it('creates and verifies a real PPTX artifact without claiming it was opened', async () => {
    const registry = new ToolRegistry();
    registerOfficeTools(registry);
    const record = await executeToolCall({
      registry,
      name: 'create_ppt',
      arguments: {
        title: 'Lumi presentation receipt',
        filename: `lumi_presentation_receipt_${Date.now()}.pptx`,
        theme: 'ocean',
        slides: [
          { title: 'Verified output', bullets: ['Shared schema', 'Cross-platform writer'] },
          { title: 'One capability, one receipt', layout: 'quote', subtitle: 'LumiOS' },
        ],
      },
      context: {
        allowLocalFileWrites: true,
        localWriteIntentReason: 'The test explicitly requests a presentation artifact.',
      },
    });

    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    const payload = JSON.parse(record.result);
    expect(payload).toMatchObject({ ok: true, status: 'created', contentSlides: 2, totalSlides: 4 });
    expect(payload).not.toHaveProperty('opened');
    expect(fs.existsSync(payload.outputPath)).toBe(true);
    expect(fs.readFileSync(payload.outputPath).subarray(0, 2).toString()).toBe('PK');
    fs.rmSync(payload.outputPath, { force: true });
  });
});
