export function extractFirstCompleteSpeechSentence(text: string): string | null {
  const normalized = String(text || '').trimStart();
  const match = normalized.match(/^(.+?[。！？.!?\n])(?:\s|$|.)/u);
  const sentence = String(match?.[1] || '').trim();
  // i18n-allow -- Unicode speech-content range, not user-visible copy.
  if (sentence.length < 2 || !/[a-zA-Z一-鿿㐀-䶿\d]/u.test(sentence)) return null;
  return sentence;
}
