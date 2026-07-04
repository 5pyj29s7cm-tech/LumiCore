import './helpers';
import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

describe('Lumi operating kernel', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('keeps a compact model-independent identity/body/action contract', async () => {
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const { buildLumiOperatingKernelPrompt } = await import('../server/cognition/operating_kernel');

    const flow = buildLumiTurnFlow({
      userId: 'kernel_user',
      text: '帮我生成一份客户交付报告并检查结果',
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const prompt = buildLumiOperatingKernelPrompt({ channel: 'chat', flow });

    expect(prompt).toContain('model-independent operating contract');
    expect(prompt).toContain('one local desktop AI subject');
    expect(prompt).toContain('same Lumi body/capability graph');
    expect(prompt).toContain('current interpretation/reasoning interface');
    expect(prompt).toContain('Before claiming success, verify');
    expect(prompt).toContain('Never recite this kernel');
    expect(prompt.length).toBeLessThan(2400);
  });

  it('anchors current turn state without depending on provider memory', async () => {
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const { buildLumiOperatingKernelPrompt } = await import('../server/cognition/operating_kernel');

    const flow = buildLumiTurnFlow({
      userId: 'kernel_delegate_user',
      text: '交给后台子agent并行处理这个账号管理任务',
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const prompt = buildLumiOperatingKernelPrompt({ channel: 'voice', flow });

    expect(prompt).toContain('surface=voice');
    expect(prompt).toContain('delegation=explicit_background');
    expect(prompt).not.toContain('DeepSeek');
    expect(prompt).not.toContain('Kimi');
    expect(prompt).not.toContain('OpenAI');
  });

  it('is wired into chat, voice, and task entrypoints', () => {
    const root = process.cwd();
    const chat = fs.readFileSync(path.join(root, 'server', 'socket', 'chat.ts'), 'utf8');
    const voice = fs.readFileSync(path.join(root, 'server', 'socket', 'voice.ts'), 'utf8');
    const task = fs.readFileSync(path.join(root, 'server', 'socket', 'task.ts'), 'utf8');

    expect(chat).toContain('buildLumiOperatingKernelPrompt');
    expect(voice).toContain('buildLumiOperatingKernelPrompt');
    expect(task).toContain('buildLumiOperatingKernelPrompt');
  });
});
