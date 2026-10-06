

/** Decode the transport only. Never rewrite escapes or repair source semantics. */
export function parseGeneratedSkillResponse(text: string): Record<string, any> {
  const blocks = text.trim().match(/^```json\s*\r?\n([\s\S]*?)\r?\n```\s*```(?:typescript|ts)\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (blocks) {
    const metadata = JSON.parse(blocks[1]);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid skill metadata');
    return { ...metadata, handlerCode: blocks[2] };
  }
  // Existing model adapters may still return the previous all-JSON protocol.
  const json = text.trim().replace(/^```json\s*\r?\n/i, '').replace(/\r?\n```$/, '');
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid skill draft JSON');
  return parsed;
}
