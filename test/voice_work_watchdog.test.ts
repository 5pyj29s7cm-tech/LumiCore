import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('voice work liveness watchdog', () => {
  it('treats the client timer as a status probe instead of task cancellation', () => {
    const client = read('src/hooks/useVoiceCall.ts');
    expect(client).toContain("emit('audio:work_status_probe'");
    expect(client).not.toContain("emit('audio:cancel_turn', { requestId, reason: 'thinking_watchdog' }");
    expect(client).toContain("scheduleThinkingWatchdog('work')");
  });

  it('keeps a server-owned work lease alive and rejects legacy watchdog cancellation', () => {
    const server = read('server/socket/voice.ts');
    expect(server).toContain('function startVoiceWorkHeartbeat(');
    expect(server).toContain('}, 8_000);');
    expect(server).toContain("data?.reason === 'thinking_watchdog'");
    expect(server).toContain('Ignored legacy UI watchdog cancellation');
    expect(server).toContain("socket.on('audio:work_status_probe'");
  });
});
