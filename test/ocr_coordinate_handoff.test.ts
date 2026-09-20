import './helpers';
import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerOCRTools } from '../server/tools/definitions/ocr_tools';
import { analyzeScreen } from '../server/llm/adapter';
import { buildToolExecutionEnvelope } from '../server/tools/execution_envelope';

vi.mock('../server/llm/adapter', () => ({ analyzeScreen: vi.fn() }));
vi.mock('../server/llm/vision_preferences', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/vision_preferences')>(),
  getUserPreferredVision: () => ({ provider: 'relay', model: 'test-vision' }),
}));

describe('OCR to desktop action handoff', () => {
  it.each(['ocr_screen', 'ocr_region'])('preserves %s observations containing failure words without inventing task completion', async name => {
    const registry = new ToolRegistry(); registerOCRTools(registry);
    const context = { desktopRelay: vi.fn().mockResolvedValue('synthetic-capture'), llmGetters: { getRelay: () => ({}) } };
    const description = 'chat.deepseek.com/sign_in shows a login form. No error message is visible. The prior login failed.';
    vi.mocked(analyzeScreen).mockResolvedValueOnce(description);
    const result = await registry.execute(name, { query: 'Read the login state', x: 0, y: 0, width: 100, height: 100 }, context as any);
    expect(JSON.parse(result)).toMatchObject({ status: 'observed', description });
    const envelope = buildToolExecutionEnvelope({ name, arguments: {}, result, terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Observation returned.' } });
    expect(envelope.status).toBe('verified_success');
    expect((envelope.result as any).loggedIn).toBeUndefined();
    vi.mocked(analyzeScreen).mockRejectedValueOnce(new Error('Vision provider timeout'));
    const failed = await registry.execute(name, { query: 'Read the login state' }, context as any);
    expect(buildToolExecutionEnvelope({ name, arguments: {}, result: failed }).status).toBe('failed');
  });
  it('does not spend another vision request inventing raw multi-monitor click coordinates', async () => {
    const registry = new ToolRegistry();
    registerOCRTools(registry);
    const desktopRelay = vi.fn();
    const result = JSON.parse(await registry.execute('ocr_screen', { query: '找出播放按钮并给出绝对坐标' }, { desktopRelay } as any));
    expect(result).toMatchObject({ status: 'requires_grounded_desktop_control', nextTool: 'computer_use' });
    expect(desktopRelay).not.toHaveBeenCalled();
  });
});
