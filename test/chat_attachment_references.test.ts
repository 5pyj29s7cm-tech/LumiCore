import { describe, expect, it } from 'vitest';
import {
  chatAttachmentIdentity,
  chatAttachmentRequestMatchesScope,
  createChatAttachmentReference,
  mergeChatAttachmentReferences,
  parseChatAttachmentContext,
  serializeChatAttachmentContext,
} from '../src/lib/chatAttachmentReferences';

describe('chat attachment references', () => {
  it('builds an existing knowledge-file reference without file content upload', () => {
    const attachment = createChatAttachmentReference({
      fileId: 'case-notes.pdf',
      fileName: 'Case Notes.pdf',
      path: 'C:\\Lumi\\knowledge\\case-notes.pdf',
      rawSize: 2048,
      openUrl: '/api/files/download/case-notes.pdf?inline=1',
    });

    expect(attachment).toMatchObject({
      fileId: 'case-notes.pdf',
      fileName: 'Case Notes.pdf',
      path: 'C:\\Lumi\\knowledge\\case-notes.pdf',
      size: 2048,
      kind: 'file',
      downloadUrl: '/api/files/download/case-notes.pdf?inline=1',
      content: null,
    });
  });

  it('deduplicates equivalent Windows paths case-insensitively', () => {
    const first = createChatAttachmentReference({ fileName: 'notes.md', path: 'C:\\Data\\Notes.md' });
    const duplicate = createChatAttachmentReference({ fileName: 'notes.md', path: 'c:/data/notes.md' });
    const result = mergeChatAttachmentReferences([first], [duplicate]);

    expect(chatAttachmentIdentity(first)).toBe(chatAttachmentIdentity(duplicate));
    expect(result.attachments).toHaveLength(1);
    expect(result.added).toHaveLength(0);
    expect(result.duplicateCount).toBe(1);
  });

  it('enforces the same eight-file limit as the chat backend', () => {
    const existing = Array.from({ length: 7 }, (_, index) => (
      createChatAttachmentReference({ fileName: `${index}.txt`, path: `C:\\Data\\${index}.txt` })
    ));
    const incoming = [
      createChatAttachmentReference({ fileName: '7.txt', path: 'C:\\Data\\7.txt' }),
      createChatAttachmentReference({ fileName: '8.txt', path: 'C:\\Data\\8.txt' }),
    ];

    const result = mergeChatAttachmentReferences(existing, incoming);
    expect(result.attachments).toHaveLength(8);
    expect(result.added).toHaveLength(1);
    expect(result.overflowCount).toBe(1);
  });

  it('keeps knowledge-file references inside the active personal or organization scope', () => {
    expect(chatAttachmentRequestMatchesScope({ domain: 'personal' }, 'personal')).toBe(true);
    expect(chatAttachmentRequestMatchesScope({ domain: 'work', orgId: 'org-a' }, 'personal')).toBe(false);
    expect(chatAttachmentRequestMatchesScope({ domain: 'work', orgId: 'org-a' }, 'work', 'org-a')).toBe(true);
    expect(chatAttachmentRequestMatchesScope({ domain: 'work', orgId: 'org-a' }, 'work', 'org-b')).toBe(false);
    expect(chatAttachmentRequestMatchesScope({ domain: 'work' }, 'work')).toBe(false);
  });

  it('restores verified conversation attachment context without persisting image data URLs', () => {
    const attachment = createChatAttachmentReference({
      fileId: 'evidence.pdf',
      fileName: 'Evidence.pdf',
      path: 'C:\\Lumi\\knowledge\\evidence.pdf',
      content: 'extracted evidence',
      preview: 'data:image/png;base64,too-large-to-persist',
    });

    const savedAt = Date.parse('2026-08-09T00:00:00.000Z');
    const serialized = serializeChatAttachmentContext([attachment], savedAt);
    const restored = parseChatAttachmentContext(serialized, savedAt + 1);

    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      fileName: 'Evidence.pdf',
      path: 'C:\\Lumi\\knowledge\\evidence.pdf',
      content: null,
      transcript: null,
      preview: null,
    });
    expect(serialized).not.toContain('extracted evidence');
    expect(serialized).not.toContain('too-large-to-persist');
    expect(parseChatAttachmentContext(serialized, savedAt + 31 * 24 * 60 * 60 * 1000)).toEqual([]);
  });
});
