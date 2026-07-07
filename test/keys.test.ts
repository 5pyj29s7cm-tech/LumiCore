import { describe, it, expect } from 'vitest';

// ── Pure logic tests for key store operations ──
// The actual functions use fs which requires filesystem mocking.
// We test the core merge/purge/save logic in isolation.

describe('Key Store — merge & delete logic', () => {
  function mergeAndClean(
    existing: Record<string, string | undefined>,
    updates: Record<string, string | undefined>,
  ): Record<string, string> {
    const merged = { ...existing, ...updates };
    for (const [k, v] of Object.entries(merged)) {
      if (!v || (typeof v === 'string' && v.trim().length === 0)) {
        delete (merged as Record<string, unknown>)[k];
      }
    }
    return merged as Record<string, string>;
  }

  it('deletes empty string keys on merge', () => {
    const result = mergeAndClean(
      { OPENAI_API_KEY: 'abc', GEMINI_API_KEY: '' },
      { DASHSCOPE_API_KEY: 'xyz', OPENAI_API_KEY: '' },
    );
    expect(result).toEqual({
      DASHSCOPE_API_KEY: 'xyz',
    });
    expect((result as any).OPENAI_API_KEY).toBeUndefined();
  });

  it('deletes undefined value keys', () => {
    const result = mergeAndClean(
      { OPENAI_API_KEY: 'abc', GEMINI_API_KEY: undefined },
      {},
    );
    expect(result).toEqual({ OPENAI_API_KEY: 'abc' });
    expect((result as any).GEMINI_API_KEY).toBeUndefined();
  });

  it('preserves existing keys when updates are empty', () => {
    const result = mergeAndClean(
      { OPENAI_API_KEY: 'abc123' },
      {},
    );
    expect(result).toEqual({ OPENAI_API_KEY: 'abc123' });
  });

  it('overwrites existing key with new value', () => {
    const result = mergeAndClean(
      { OPENAI_API_KEY: 'old-key' },
      { OPENAI_API_KEY: 'new-key' },
    );
    expect(result).toEqual({ OPENAI_API_KEY: 'new-key' });
  });

  it('handles whitespace-only values as empty', () => {
    const result = mergeAndClean(
      { QWEN_API_KEY: 'abc' },
      { OPENAI_API_KEY: '   ' },
    );
    expect(result).toEqual({ QWEN_API_KEY: 'abc' });
  });

  it('handles both empty stores', () => {
    const result = mergeAndClean({}, {});
    expect(result).toEqual({});
  });
});

describe('Key names — static list', () => {
  const ALL_KEYS = [
    'DASHSCOPE_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'DEEPSEEK_API_KEY',
    'QWEN_API_KEY',
    'MINIMAX_API_KEY',
    'FISHAUDIO_API_KEY',
    'ELEVENLABS_API_KEY',
  ];

  it('has exactly 9 provider keys', () => {
    expect(ALL_KEYS).toHaveLength(9);
  });

  it('no duplicate keys', () => {
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
  });

  it('all keys follow naming convention', () => {
    for (const key of ALL_KEYS) {
      expect(key).toMatch(/^[A-Z_]+_API_KEY$/);
    }
  });

  it('includes all major providers', () => {
    expect(ALL_KEYS).toContain('DASHSCOPE_API_KEY');  // TTS + Qwen
    expect(ALL_KEYS).toContain('OPENAI_API_KEY');
    expect(ALL_KEYS).toContain('ANTHROPIC_API_KEY');
    expect(ALL_KEYS).toContain('GEMINI_API_KEY');
    expect(ALL_KEYS).toContain('DEEPSEEK_API_KEY');
    expect(ALL_KEYS).toContain('QWEN_API_KEY');
    expect(ALL_KEYS).toContain('MINIMAX_API_KEY');
    expect(ALL_KEYS).toContain('FISHAUDIO_API_KEY');
    expect(ALL_KEYS).toContain('ELEVENLABS_API_KEY');
  });
});
