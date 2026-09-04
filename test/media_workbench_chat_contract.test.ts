import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('media workbench chat contract', () => {
  it('sends the validated media envelope without unrelated conversation attachments', () => {
    const frontend = source('src/components/AgentChatPage.tsx');
    expect(frontend).toContain('const mediaRequest = normalizeStructuredMediaRequest(request);');
    expect(frontend).toMatch(/void sendText\(requestText, \[\], \{\s*mediaRequest,\s*includeConversationAttachments: false,/s);
    expect(frontend).toContain('...(options.mediaRequest ? { mediaRequest: options.mediaRequest } : {})');
  });

  it('binds the envelope to a durable task and propagates cancellation to tool HTTP work', () => {
    const backend = source('server/socket/chat.ts');
    expect(backend).toContain('normalizeStructuredMediaRequest(data.mediaRequest)');
    expect(backend).toContain('buildStructuredMediaDeterministicToolRecoveryCall(');
    expect(backend).toContain('executionSignal: abortController.signal');
    expect(backend).not.toContain("agent:chat RECEIVED:', JSON.stringify(data)");
  });
});
