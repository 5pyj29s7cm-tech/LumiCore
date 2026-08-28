import { describe, expect, it } from 'vitest';
import { shouldBlockForDesktopControlPause } from '../server/cognition/desktop_control_pause';

const verified = {
  status: 'verified' as const,
  strategy: 'terminal_receipt' as const,
  reason: 'Verified native desktop result.',
};

const taskText = '\u5e2e\u6211\u5206\u6790\u4e00\u4e0b WPS \u5f53\u524d\u6253\u5f00\u7684\u6587\u4ef6\uff0c\u5148\u544a\u8bc9\u6211\u5b83\u4e3b\u8981\u8bb2\u4e86\u4ec0\u4e48\u3002';
const exactPath = 'C:\\Users\\Administrator\\Desktop\\Lumi_\u8def\u6f14.pptx';

const completeRecords = [{
  name: 'desktop_running_processes',
  arguments: {},
  result: JSON.stringify({
    processes: [{ name: 'wpp.exe', window_titles: ['Lumi_\u8def\u6f14.pptx - WPS Office'] }],
  }),
  terminalVerification: verified,
}, {
  name: 'desktop_list_files',
  arguments: { directory: 'C:\\Users\\Administrator\\Desktop' },
  result: JSON.stringify({ files: [{ path: exactPath }] }),
  terminalVerification: verified,
}, {
  name: 'extract_document_text',
  arguments: { filePath: exactPath },
  result: JSON.stringify({ ok: true, content: 'Lumi Core \u7684\u4e2a\u4eba\u8fde\u7eed\u6027\u4e0e\u53ef\u9a8c\u8bc1\u884c\u52a8\u3002' }),
  terminalVerification: verified,
}];

describe('desktop control pause terminal adjudication', () => {
  it('does not overwrite a verified completed current-document read', () => {
    expect(shouldBlockForDesktopControlPause({
      pauseReason: 'desktop_control_paused_for_user_activity',
      taskText,
      toolRecords: completeRecords,
    })).toBe(false);
  });

  it('keeps an incomplete current-document task blocked and resumable', () => {
    expect(shouldBlockForDesktopControlPause({
      pauseReason: 'desktop_control_paused_for_user_activity',
      taskText,
      toolRecords: completeRecords.slice(0, 2),
    })).toBe(true);
  });

  it('does not replace an exact waiting-confirmation terminal state', () => {
    expect(shouldBlockForDesktopControlPause({
      pauseReason: 'desktop_control_paused_for_user_activity',
      waitingForConfirmation: true,
      taskText: '\u5220\u9664\u8fd9\u4e2a\u6587\u4ef6',
      toolRecords: [],
    })).toBe(false);
  });
});
