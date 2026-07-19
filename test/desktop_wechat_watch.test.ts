import { describe, expect, it } from 'vitest';
import {
  classifyDesktopWechatSummaryRisk,
  extractDesktopWechatObservation,
  normalizeDesktopWechatWatchConfig,
} from '../server/messaging/desktop_wechat_watch';

describe('desktop WeChat duty mode', () => {
  it('extracts deduplicated unread signals and conservative contact names from native UI trees', () => {
    const observation = extractDesktopWechatObservation({
      status: 'ok',
      capturedNodes: 8,
      trees: [
        {
          name: 'WeChat',
          controlType: 'Window',
          children: [
            { name: 'Alice 2 new messages', controlType: 'Text', children: [] },
            { name: 'Alice 2 new messages', controlType: 'Text', children: [] },
            { name: '\u674e\u59d0 3\u6761\u65b0\u6d88\u606f', controlType: 'Text', children: [] },
          ],
        },
      ],
    });

    expect(observation.appFound).toBe(true);
    expect(observation.accessible).toBe(true);
    expect(observation.signals).toHaveLength(2);
    expect(observation.signals.map(signal => signal.contact).sort()).toEqual(['Alice', '\u674e\u59d0'].sort());
    expect(observation.signals.map(signal => signal.unreadCount).sort()).toEqual([2, 3]);
    expect(observation.fingerprint).toMatch(/^[a-f0-9]{24}$/);
  });

  it('treats an app-level badge as a detection without inventing a contact', () => {
    const observation = extractDesktopWechatObservation({
      status: 'ok',
      tree: { name: 'WeChat (4)', controlType: 'Window', children: [] },
    });

    expect(observation.signals).toHaveLength(1);
    expect(observation.signals[0]).toMatchObject({ contact: '', unreadCount: 4 });
  });

  it('resets the unread baseline whenever duty mode is explicitly toggled', () => {
    const previous = normalizeDesktopWechatWatchConfig({
      enabled: false,
      baselineInitialized: true,
      lastSignalFingerprint: 'old',
    });
    const enabled = normalizeDesktopWechatWatchConfig({ enabled: true }, previous, true);

    expect(enabled.enabled).toBe(true);
    expect(enabled.baselineInitialized).toBe(false);
    expect(enabled.lastSignalFingerprint).toBe('');
    expect(enabled.pollIntervalSeconds).toBeGreaterThanOrEqual(10);
    expect(enabled.idleBeforeInspectSeconds).toBeGreaterThanOrEqual(15);
  });

  it('preserves a stored baseline during ordinary config loading', () => {
    const stored = normalizeDesktopWechatWatchConfig({
      enabled: true,
      baselineInitialized: true,
      lastSignalFingerprint: 'stored-fingerprint',
    });

    expect(stored.baselineInitialized).toBe(true);
    expect(stored.lastSignalFingerprint).toBe('stored-fingerprint');
  });

  it('routes money and commitment topics to high-risk review', () => {
    expect(classifyDesktopWechatSummaryRisk('Please confirm the refund amount and payment deadline.').risk).toBe('high');
    expect(classifyDesktopWechatSummaryRisk('\u8bf7\u786e\u8ba4\u5408\u540c\u4ef7\u683c\u548c\u4ed8\u6b3e\u65f6\u95f4').risk).toBe('high');
    expect(classifyDesktopWechatSummaryRisk('The sender shared a casual greeting.').risk).toBe('low');
  });
});
