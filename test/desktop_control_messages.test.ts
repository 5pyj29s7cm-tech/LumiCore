import './helpers';
import { describe, expect, it } from 'vitest';
import { formatDesktopControlPausePresentation } from '../server/regions/packs/cn/desktop_control_messages';

describe('desktop control pause presentation', () => {
  it.each([
    '请继续处理当前文档',
    'Continue processing the current document',
  ])('keeps natural text separate from the stable pause reason for %s', task => {
    const presentation = formatDesktopControlPausePresentation(task);
    expect(presentation.reason).toBe('desktop_control_paused_for_user_activity');
    expect(presentation.text).not.toContain('desktop_control_paused_for_user_activity');
    expect(presentation.text.length).toBeGreaterThan(20);
  });
});
