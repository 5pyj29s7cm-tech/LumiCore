export type CnMessagingBindingCommand =
  | { kind: 'bind'; code: string }
  | { kind: 'status' }
  | { kind: 'invalid' };

export function parseCnMessagingBindingCommand(text: string): CnMessagingBindingCommand | null {
  const normalized = String(text || '').trim();
  if (!normalized) return null;

  const codeMatch = normalized.match(
    /^绑定\s*(?:Lumi|露米)?\s*([A-Z0-9_-]{4,16})\s*[。.!！]?$/i,
  );
  if (codeMatch) return { kind: 'bind', code: codeMatch[1].toUpperCase() };

  if (/^(?:我)?\s*(?:(?:已经|已|现在|是否|有没有)\s*)?绑定(?:成功|完成|好了|好)?(?:了|吗|了吗|没有)?\s*[?？。.!！]*$/i.test(normalized)) {
    return { kind: 'status' };
  }

  if (/^绑定\s*(?:lumi(?:\s|$)|露米(?:\s|$))/i.test(normalized)) {
    return { kind: 'invalid' };
  }
  return null;
}
