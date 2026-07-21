import { describe, expect, it } from 'vitest';
import { normalizeSpeechCommand, speechCommandKey } from '../server/cognition/speech_normalization';

describe('speech command normalization', () => {
  it('collapses adjacent duplicate clauses from one STT final', () => {
    expect(normalizeSpeechCommand('\u6253\u5f00WPS\u3002\u6253\u5f00WPS\u3002')).toBe('\u6253\u5f00WPS\u3002');
    expect(normalizeSpeechCommand('\u6253\u5f00WPS\uff0c\u6253\u5f00WPS')).toBe('\u6253\u5f00WPS,');
  });

  it('joins provider-spelled Latin application tokens generically', () => {
    expect(normalizeSpeechCommand('\u6253\u5f00 W P S')).toBe('\u6253\u5f00 WPS');
  });

  it('does not collapse different consecutive actions', () => {
    expect(normalizeSpeechCommand('\u6253\u5f00WPS\u3002\u65b0\u5efa\u6587\u6863\u3002')).toBe('\u6253\u5f00WPS\u3002 \u65b0\u5efa\u6587\u6863\u3002');
  });

  it('produces a punctuation-insensitive duplicate key', () => {
    expect(speechCommandKey('\u6253\u5f00 WPS\uff01')).toBe(speechCommandKey('\u6253\u5f00WPS'));
  });
});
