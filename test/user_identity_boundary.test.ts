import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

describe('user identity boundary', () => {
  it('accepts only explicit forms of address and ignores task entity names', async () => {
    const { extractExplicitUserAddress } = await import('../server/personality/user_identity');

    expect(extractExplicitUserAddress('\u4f60\u5e94\u8be5\u79f0\u547c\u6211\u6bdb\u5148\u751f')).toBe('\u6bdb\u5148\u751f');
    expect(extractExplicitUserAddress('\u4ee5\u540e\u8bf7\u53eb\u6211\u8001\u6bdb\u5427')).toBe('\u8001\u6bdb');
    expect(extractExplicitUserAddress('My name is Morgan Lee.')).toBe('Morgan Lee');
    expect(extractExplicitUserAddress('\u6253\u5f00\u5fae\u4fe1\u95ee\u95ee\u963f\u9646\u5728\u5e72\u561b')).toBeNull();
    expect(extractExplicitUserAddress('\u684c\u9762\u4e0a\u6709\u4e2a\u963f\u9646\u6587\u4ef6\u5939')).toBeNull();
  });

  it('migrates the latest explicit correction from conversation history', async () => {
    const { addMessage } = await import('../server/conversation/manager');
    const {
      getUserIdentityPreference,
      resolveUserIdentityPreference,
    } = await import('../server/personality/user_identity');
    const userId = 'identity-history-user';

    addMessage({
      userId,
      role: 'user',
      content: '\u4f60\u5e94\u8be5\u79f0\u547c\u6211\u6bdb\u5148\u751f',
      domain: 'personal',
    });

    expect(resolveUserIdentityPreference(userId)?.preferredAddress).toBe('\u6bdb\u5148\u751f');
    expect(getUserIdentityPreference(userId)?.sourceInteractionId).toBeTruthy();
  });

  it('keeps preferences user-scoped and lets a new explicit statement replace the old one', async () => {
    const {
      getUserIdentityPreference,
      resolveUserIdentityPreference,
    } = await import('../server/personality/user_identity');
    const firstUser = 'identity-scope-user-a';
    const secondUser = 'identity-scope-user-b';

    resolveUserIdentityPreference(firstUser, '\u8bf7\u53eb\u6211\u6bdb\u5148\u751f');
    expect(getUserIdentityPreference(secondUser)).toBeNull();
    resolveUserIdentityPreference(firstUser, '\u4ee5\u540e\u8bf7\u53eb\u6211\u8001\u6bdb');
    expect(getUserIdentityPreference(firstUser)?.preferredAddress).toBe('\u8001\u6bdb');
  });

  it('places the confirmed address above retrieved memory and external entity names', async () => {
    const {
      formatUserIdentityBoundary,
      resolveUserIdentityPreference,
    } = await import('../server/personality/user_identity');
    const userId = 'identity-prompt-user';
    resolveUserIdentityPreference(userId, '\u4f60\u53ef\u4ee5\u53eb\u6211\u6bdb\u5148\u751f');

    const prompt = formatUserIdentityBoundary(userId);
    expect(prompt).toContain(JSON.stringify('\u6bdb\u5148\u751f'));
    expect(prompt).toContain('Treat this as authoritative');
    expect(prompt).toContain('contacts, chat recipients, filenames, folders');
    expect(prompt).toContain('do not use them as spoken titles');
  });

  it('rejects inferred name memories sourced only from contacts or files', async () => {
    const { isSupportedUserIdentityMemory } = await import('../server/memory/extractor');
    const inferred = {
      content: '\u7528\u6237\u7684\u540d\u5b57\u662f\u963f\u9646',
      keywords: ['\u540d\u5b57', '\u963f\u9646'],
    };
    const confirmed = {
      content: '\u7528\u6237\u5e0c\u671b\u88ab\u79f0\u547c\u4e3a\u6bdb\u5148\u751f',
      keywords: ['\u79f0\u547c', '\u6bdb\u5148\u751f'],
    };

    expect(isSupportedUserIdentityMemory(inferred, '\u6253\u5f00\u963f\u9646\u6587\u4ef6\u5939')).toBe(false);
    expect(isSupportedUserIdentityMemory(inferred, '\u5fae\u4fe1\u95ee\u95ee\u963f\u9646\u5728\u5e72\u561b')).toBe(false);
    expect(isSupportedUserIdentityMemory(confirmed, '\u4f60\u5e94\u8be5\u79f0\u547c\u6211\u6bdb\u5148\u751f')).toBe(true);
  });
});
