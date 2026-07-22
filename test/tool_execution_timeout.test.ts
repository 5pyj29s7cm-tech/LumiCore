import { describe, expect, it } from 'vitest';
import { getToolExecutionTimeoutMs } from '../server/tools/registry';

describe('tool execution timeouts', () => {
  it('allows visible web login enough time for the maximum manual handoff window', () => {
    expect(getToolExecutionTimeoutMs('web_login_run')).toBeGreaterThan(225_000);
    expect(getToolExecutionTimeoutMs('url_fetch_logged_in')).toBeGreaterThan(225_000);
  });

  it('does not apply the generic 30-second ceiling to vision OCR tools', () => {
    expect(getToolExecutionTimeoutMs('ocr_image_file')).toBe(90_000);
    expect(getToolExecutionTimeoutMs('ocr_screen')).toBe(90_000);
  });
});
