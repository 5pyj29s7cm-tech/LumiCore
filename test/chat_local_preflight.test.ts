import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildChatAttachmentContext,
  shouldRunVisibleActionPreflight,
} from '../server/socket/chat';
import {
  classifyComplexity,
  shouldAttemptOrchestration,
} from '../server/agents/orchestrator';

describe('chat local action preflight', () => {
  it('does not scan desktop folders for a runtime-state inspection', () => {
    expect(shouldRunVisibleActionPreflight(
      '\u8bf7\u53ea\u8bfb\u53d6\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u6807\u9898\u548c\u684c\u9762\u8fd0\u884c\u72b6\u6001',
      [],
    )).toBe(false);
  });

  it('does not select file-domain tools before the model sees the request', () => {
    expect(shouldRunVisibleActionPreflight(
      '\u8bf7\u8bfb\u53d6\u684c\u9762\u4e0a\u7684\u6848\u4ef6\u6587\u4ef6\u5939',
      [],
    )).toBe(false);
    expect(shouldRunVisibleActionPreflight(
      'Please review the contract.pdf file on the desktop',
      [],
    )).toBe(false);
    expect(shouldRunVisibleActionPreflight(
      'Use this floor plan to create a CAD drawing.',
      [{
        fileName: 'floor-plan.png',
        path: 'C:\\Uploads\\floor-plan.png',
        content: null,
        preview: null,
        transcript: null,
        mimeType: 'image/png',
        kind: 'image',
      }],
    )).toBe(false);
  });

  it('does not pre-read an explicit artifact output path before creating it', () => {
    expect(shouldRunVisibleActionPreflight(
      '请在 C:\\Users\\Administrator\\Documents\\Lumi主程序实机验收_20260816.txt 创建文件，写入后必须重读核验。',
      [],
    )).toBe(false);
  });

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

  it('keeps ordinary desktop control on Lumi but honors an explicit team request', () => {
    const ordinary = '\u5217\u51fa\u684c\u9762\u6587\u4ef6';
    expect(shouldAttemptOrchestration({
      channel: 'chat',
      text: ordinary,
      complexity: classifyComplexity(ordinary, { userId: 'ordinary_desktop' }),
      allowToolUse: true,
      clientActionOnly: false,
      selfRepair: false,
      capabilityLane: 'desktop_control',
      cognitionCategory: 'command',
    })).toBe(false);

    const team = '\u7ec4\u5efa\u56e2\u961f\uff0c\u5148\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff0c\u518d\u5217\u51fa\u684c\u9762\u6587\u4ef6\u3002';
    expect(shouldAttemptOrchestration({
      channel: 'chat',
      text: team,
      complexity: classifyComplexity(team, { userId: 'team_desktop' }),
      allowToolUse: true,
      clientActionOnly: false,
      selfRepair: false,
      capabilityLane: 'desktop_control',
      cognitionCategory: 'command',
    })).toBe(true);
  });
});
