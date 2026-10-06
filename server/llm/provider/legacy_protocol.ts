import type { ParsedToolCall } from "../../tools/types";
import type { ToolDeclaration } from './contracts';

export function decodeBasicXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function parseLegacyParameterValue(value: string): unknown {
  const decoded = decodeBasicXmlEntities(value).trim();
  if (!decoded) return '';
  try { return JSON.parse(decoded); } catch { return decoded; }
}

/**
 * Some OpenAI-compatible models occasionally print the older XML function-call
 * protocol in message content instead of returning structured tool_calls. Only
 * convert names that were declared for this exact model request.
 */
export function parseLegacyXmlToolCalls(
  text: string | null,
  toolDeclarations: ToolDeclaration[],
): ParsedToolCall[] | null {
  const raw = String(text || '');
  if (!/<(?:function_calls|invoke)\b/i.test(raw)) return null;
  const allowed = new Set(toolDeclarations.map(declaration => declaration.function.name));
  if (allowed.size === 0) return null;

  const calls: ParsedToolCall[] = [];
  const invokeRe = /<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
  for (const match of raw.matchAll(invokeRe)) {
    const name = decodeBasicXmlEntities(match[1]).trim();
    if (!allowed.has(name)) continue;
    const args: Record<string, any> = {};
    const body = match[2] || '';
    const parameterRe = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
    for (const parameter of body.matchAll(parameterRe)) {
      args[decodeBasicXmlEntities(parameter[1]).trim()] = parseLegacyParameterValue(parameter[2]);
    }
    calls.push({
      id: `legacy-xml-${calls.length}-${name}`,
      name,
      arguments: args,
    });
  }
  return calls.length > 0 ? calls : null;
}

export function createLegacyProtocolChunkFilter(onChunk: (chunk: string) => void) {
  let state: 'pending' | 'normal' | 'suppressed' = 'pending';
  let pending = '';
  const prefixes = ['<function_calls', '<tool_calls', '<invoke', '```xml<function_calls', '```xml<tool_calls'];
  return {
    emit(chunk: string) {
      if (state === 'normal') { onChunk(chunk); return; }
      if (state === 'suppressed') return;
      pending += chunk;
      const probe = pending.trimStart().replace(/\s+/g, '').toLowerCase();
      if (!probe) return;
      if (prefixes.some(prefix => prefix.startsWith(probe))) return;
      if (prefixes.some(prefix => probe.startsWith(prefix))) {
        state = 'suppressed';
        pending = '';
        return;
      }
      state = 'normal';
      onChunk(pending);
      pending = '';
    },
    flush() {
      if (state === 'pending' && pending) onChunk(pending);
      pending = '';
    },
  };
}
