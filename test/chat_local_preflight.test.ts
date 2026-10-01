import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildChatAttachmentContext,
} from '../server/socket/chat';

describe('chat local action preflight', () => {

  it('leaves post-write verification planning inside the shared model/tool loop', () => {
    const chat = readFileSync(path.join(process.cwd(), 'server/socket/chat.ts'), 'utf8');
    expect(chat).not.toContain('buildRequestedArtifactReadback');
    expect(chat).not.toContain('chat_post_write_verification');
    expect(chat).not.toContain('post-write-verification-');
  });

  it('passes attachment metadata/data without prescribing a domain extractor', () => {
    const context = buildChatAttachmentContext([{
      fileName: 'floor-plan.png',
      path: 'C:\\Uploads\\floor-plan.png',
      content: 'untrusted uploaded description',
      preview: null,
      transcript: null,
      mimeType: 'image/png',
      size: 128,
      kind: 'image',
    }]);

    expect(context).toContain('floor-plan.png');
    expect(context).toContain('image/png');
    expect(context).toContain('[BEGIN UNTRUSTED ATTACHMENT DATA]');
    expect(context).not.toContain('floorplan_extract_geometry');
    expect(context).not.toContain('ocr_image_file');
    expect(context).not.toContain('transcribe_audio_to_text_file');
  });

});
