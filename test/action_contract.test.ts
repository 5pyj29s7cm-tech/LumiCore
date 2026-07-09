import { describe, expect, it } from 'vitest';
import { buildActionContract, formatActionContractPrompt, hasCoreActionEvidence } from '../server/cognition/action_contract';

describe('Lumi action contract', () => {
  it('classifies foreground messaging as a send contract', () => {
    const contract = buildActionContract('\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89');

    expect(contract.kind).toBe('messaging_send');
    expect(contract.preferredTools).toContain('wechat_send_message');
    expect(contract.requiredEvidence.join(' ')).toContain('sent=true');
    expect(hasCoreActionEvidence(contract, [{
      id: '1',
      name: 'desktop_open',
      arguments: { target: '\u5fae\u4fe1' },
      result: 'Opened WeChat',
    }])).toBe(false);
    expect(hasCoreActionEvidence(contract, [{
      id: '2',
      name: 'wechat_send_message',
      arguments: {},
      result: '{"sent":true}',
    }])).toBe(true);
  });

  it('creates non-messaging contracts for other real-world actions', () => {
    expect(buildActionContract('\u6253\u5f00\u6d4f\u89c8\u5668\u81ea\u52a8\u767b\u5f55').kind).toBe('browser_account');
    expect(buildActionContract('\u89c6\u9891\u7f51\u7ad9\u81ea\u52a8\u8bc4\u8bba').kind).toBe('public_post');
    expect(buildActionContract('CAD\u81ea\u52a8\u753b\u56fe').kind).toBe('cad_drafting');
    expect(buildActionContract('\u5e2e\u6211\u76ef\u76d8\u80a1\u7968').kind).toBe('stock_monitor');
    expect(buildActionContract('\u5f8b\u5e08\u7684\u4ee3\u7406\u8bcd').kind).toBe('legal_document');
  });

  it('renders a reusable prompt section with stages and evidence', () => {
    const prompt = formatActionContractPrompt(buildActionContract('\u89c6\u9891\u7f51\u7ad9\u81ea\u52a8\u8bc4\u8bba'));

    expect(prompt).toContain('Lumi Action Contract');
    expect(prompt).toContain('Core action');
    expect(prompt).toContain('Preparation is not completion');
    expect(prompt).toContain('Required completion evidence');
  });
});
