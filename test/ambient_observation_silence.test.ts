import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('silent ambient observation', () => {
  it('retains desktop and clipboard context without emitting unsolicited suggestions', () => {
    const ambient = source('server/socket/ambient.ts');

    expect(ambient).toContain('socket.on("ambient:window_update"');
    expect(ambient).toContain('pushActivityEvent(uid, event)');
    expect(ambient).toContain('socket.on("ambient:clipboard_report"');
    expect(ambient).toContain("detectClipboardChange(uid, data.text || '')");

    expect(ambient).not.toContain('processActivityEvent');
    expect(ambient).not.toContain('../context/proactive_triggers');
    expect(ambient).not.toContain("emit('agent:proactive'");
  });
});

