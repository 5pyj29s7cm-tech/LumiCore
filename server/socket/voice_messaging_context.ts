// i18n-allow: Chinese recipient-pronoun recognition tokens; not user-visible copy.
const RECIPIENT_PRONOUNS = new Set([
  '\u4ed6', '\u5979', '\u5b83', '\u5bf9\u65b9', '\u90a3\u4e2a\u4eba', '\u8fd9\u4e2a\u4eba', // i18n-allow: input recognition
]);

function parseMaybeJson(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function normalizeToolCalls(value: unknown): any[] {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return [parsed];
  return [];
}

function isConcreteRecipient(value: unknown): boolean {
  const contact = String(value || '').trim();
  return Boolean(contact) && !RECIPIENT_PRONOUNS.has(contact);
}

export function resolveWeChatRecipientFromHistory(
  args: Record<string, any>,
  history: any[],
): Record<string, any> {
  const requestedContact = String(args?.contact || '').trim();
  if (!RECIPIENT_PRONOUNS.has(requestedContact)) return args;

  const recent = Array.isArray(history) ? history.slice(-24).reverse() : [];
  for (const record of recent) {
    const calls = normalizeToolCalls(record?.toolCalls ?? record?.tool_calls).reverse();
    for (const call of calls) {
      const name = String(call?.name || call?.toolName || call?.tool_name || '').trim();
      if (name !== 'wechat_send_message') continue;
      const callArgs = parseMaybeJson(call?.arguments ?? call?.args) || {};
      const contact = String(callArgs?.contact || '').trim();
      if (isConcreteRecipient(contact)) return { ...args, contact };
    }
  }
  return args;
}
