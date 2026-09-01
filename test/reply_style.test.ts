import { describe, expect, it } from 'vitest';
import { buildTextReplyStyleOverlay } from '../server/cognition/reply_style';

describe('shared text reply style', () => {
  it('keeps task updates readable without exposing internal execution plumbing', () => {
    const overlay = buildTextReplyStyleOverlay('task');

    expect(overlay).toContain('blank line between paragraphs');
    expect(overlay).toContain('verified outcome');
    expect(overlay).toContain('exact blocker');
    expect(overlay).toContain('Do not dump tool names, task ids, receipt schemas');
    expect(overlay).toContain('Do not produce a single dense wall of text');
  });
});
