import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpManager } from '../server/mcp/client';
import { registerSkillTools, setSkillLLMGetters } from '../server/tools/definitions/skill_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';

const temporaryDirectories: string[] = [];

function temporarySkillDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe('skill lifecycle terminal receipts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setSkillLLMGetters(null);
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records unavailable draft generation as failure instead of a successful error string', async () => {
    setSkillLLMGetters(null);
    const registry = new ToolRegistry();
    registerSkillTools(registry);
    const record = await executeToolCall({
      registry,
      name: 'generate_skill',
      arguments: { description: 'Create a reviewed test draft' },
      context: { requestConfirmation: async () => true },
    });

    expect(record.error).toContain('LLM providers');
    expect(record.result).toBe('');
    expect(record.terminalVerification?.status).toBe('failed');
  });

  it('separates installed package evidence from runtime connection state', async () => {
    const sourceDirectory = temporarySkillDirectory('lumi-skill-source-');
    fs.writeFileSync(path.join(sourceDirectory, 'package.json'), JSON.stringify({ name: 'receipt-skill', version: '1.0.0' }));
    fs.writeFileSync(path.join(sourceDirectory, 'index.ts'), 'export const receipt = true;');
    const installDirectory = temporarySkillDirectory('lumi-skill-installed-');
    fs.writeFileSync(path.join(installDirectory, 'package.json'), JSON.stringify({ name: 'receipt-skill', version: '1.0.0' }));
    vi.spyOn(mcpManager, 'installSkillValidated').mockResolvedValue(installDirectory);

    const registry = new ToolRegistry();
    registerSkillTools(registry);
    const record = await executeToolCall({
      registry,
      name: 'install_skill',
      arguments: { directory: sourceDirectory, name: 'receipt-skill' },
      context: { requestConfirmation: async () => true },
    });

    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(record.result)).toMatchObject({
      ok: true,
      status: 'installed',
      skillName: 'receipt-skill',
      runtimeStatus: 'restart_required',
      generatedDraft: false,
    });
  });
});
