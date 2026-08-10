import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('focus socket contract', () => {
  it('mounts authenticated focus handlers and derives scope on the server', () => {
    const root = process.cwd();
    const runtime = readFileSync(path.join(root, 'server/runtime/socket.ts'), 'utf8');
    const focus = readFileSync(path.join(root, 'server/socket/focus.ts'), 'utf8');

    expect(runtime).toContain('registerFocusHandlers(socket, getUserId, io)');
    expect(focus).toContain("socket.on('focus:list'");
    expect(focus).toContain("socket.on('focus:update'");
    expect(focus).toContain('resolveSocketScope(socket, userId, data)');
    expect(focus).toContain('updateConversationActionFocus({');
    expect(focus).not.toContain('data.userId');
  });
});
