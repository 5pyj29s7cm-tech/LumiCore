import './helpers';
import { describe, expect, it } from 'vitest';
import {
  getSystemAppMatches,
  isAppDiscoveryNoise,
  isSystemAppDetected,
} from '../shared/system_apps';

describe('computer adaptation app detection', () => {
  const scannedApps = [
    '\u9489\u9489',
    '\u4f01\u4e1a\u5fae\u4fe1',
    '\u7f51\u6613\u4e91\u97f3\u4e50',
    '\u5fae\u4fe1',
    '\u5378\u8f7d\u4f01\u4e1a\u5fae\u4fe1',
    '\u5378\u8f7d\u7f51\u6613\u4e91\u97f3\u4e50',
    'QQ',
    'QQ\u98de\u8f66',
    'QQ\u98de\u8f66\uff08\u6062\u590d\u6a21\u5f0f\uff09',
    'QzoneMusicUninst',
    'WXWorkUpgrader',
    'cloudmusic_reporter',
  ];

  it('recognizes localized messaging and music shortcuts from the real scan shape', () => {
    expect(getSystemAppMatches(scannedApps, 'wechat')).toEqual([
      '\u9489\u9489',
      '\u4f01\u4e1a\u5fae\u4fe1',
      '\u5fae\u4fe1',
      'QQ',
    ]);
    expect(getSystemAppMatches(scannedApps, 'netease')).toEqual(['\u7f51\u6613\u4e91\u97f3\u4e50']);
    expect(isSystemAppDetected(scannedApps, 'wechat')).toBe(true);
    expect(isSystemAppDetected(scannedApps, 'netease')).toBe(true);
  });

  it('does not treat uninstallers, helpers, or QQ games as usable apps', () => {
    expect(isAppDiscoveryNoise('\u5378\u8f7d\u5fae\u4fe1')).toBe(true);
    expect(isAppDiscoveryNoise('WXWorkUpgrader')).toBe(true);
    expect(isAppDiscoveryNoise('CopilotUpdate')).toBe(true);
    expect(isAppDiscoveryNoise('\u8f93\u51fa AutoCAD 2026 \u8bbe\u7f6e')).toBe(true);
    expect(isAppDiscoveryNoise('AutoCAD Open in Desktop')).toBe(true);
    expect(isAppDiscoveryNoise(`AutoCAD 2026 - \ufffd\u0000`)).toBe(true);
    expect(getSystemAppMatches(['QQ\u98de\u8f66', 'QzoneMusicUninst'], 'wechat')).toEqual([]);
    expect(getSystemAppMatches(['cloudmusic_reporter'], 'netease')).toEqual([]);
  });

  it('recognizes common non-Chinese messaging and music clients', () => {
    expect(isSystemAppDetected(['Feishu', 'Microsoft Teams'], 'wechat')).toBe(true);
    expect(isSystemAppDetected(['Spotify', 'foobar2000'], 'netease')).toBe(true);
  });
});
