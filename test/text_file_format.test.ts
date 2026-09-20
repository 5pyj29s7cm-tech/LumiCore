import './helpers';
import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerDesktopTools } from '../server/tools/definitions/desktop_tools';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';

describe('structured files cannot be overwritten by text adapters', () => {
  it.each(['write_file', 'desktop_write_text_file'])('rejects %s before asking for approval or writing', async name => {
    const registry = new ToolRegistry();
    registerDesktopTools(registry); registerFileOpsTools(registry);
    const requestConfirmation = vi.fn(async () => true), desktopRelay = vi.fn();
    for (const extension of ['xlsx', 'docx', 'pdf']) {
      await expect(registry.execute(name, { path: `D:/fixtures/report.${extension}`, content: '' }, { requestConfirmation, desktopRelay, localExecution: true } as any)).rejects.toThrow('structured document');
    }
    expect(requestConfirmation).not.toHaveBeenCalled(); expect(desktopRelay).not.toHaveBeenCalled();
  });
});
