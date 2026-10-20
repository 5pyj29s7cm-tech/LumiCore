import type { ParsedToolCall } from "../../tools/types";
import type { ToolDeclaration } from './contracts';
import { containsInternalToolProtocol } from '../../../shared/public_execution_language';

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
 * Normalize legacy markup only for tools declared on this exact model request.
 * Structured tool calls still take precedence in the provider adapters.
 */
export function parseLegacyXmlToolCalls(
  text: string | null,
  toolDeclarations: ToolDeclaration[],
): ParsedToolCall[] | null {
  const allowed = new Set(toolDeclarations.map(declaration => declaration.function.name));
  if (allowed.size === 0) return null;
  const names = [...allowed].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const callRe = new RegExp(
    '<invoke\\s+name=["\']([^"\']+)["\'][^>]*>([\\s\\S]*?)<\\/invoke>'
      + '|<(' + names + ')\\s*>([\\s\\S]*?)<\\/\\3\\s*>',
    'gi',
  );
  const calls: ParsedToolCall[] = [];
  for (const match of String(text || '').matchAll(callRe)) {
    const name = decodeBasicXmlEntities(match[1] || match[3]).trim();
    if (!allowed.has(name)) continue;
    const body = (match[2] || match[4] || '').trim();
    let args: Record<string, unknown> = {};
    if (body) {
      const parameterRe = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
      const parameters = [...body.matchAll(parameterRe)];
      if (parameters.length && !body.replace(parameterRe, '').trim()) {
        args = Object.fromEntries(parameters.map(parameter => [
          decodeBasicXmlEntities(parameter[1]).trim(), parseLegacyParameterValue(parameter[2]),
        ]));
      } else {
        try { args = JSON.parse(decodeBasicXmlEntities(body)); } catch { continue; }
        if (!args || Array.isArray(args) || typeof args !== 'object') continue;
      }
    }
    calls.push({ id: `legacy-xml-${calls.length}-${name}`, name, arguments: args });
  }
  return calls.length > 0 ? calls : null;
}

export function createLegacyProtocolChunkFilter(onChunk: (chunk: string) => void) {
  let suppressed = false;
  let pending = '';
  return {
    emit(chunk: string) {
      if (suppressed) return;
      pending += chunk;
      while (pending) {
        const start = pending.search(/<|&lt;|&(?:l(?:t)?)?$/iu);
        if (start < 0) { onChunk(pending); pending = ''; return; }
        if (start > 0) { onChunk(pending.slice(0, start)); pending = pending.slice(start); }
        const end = />|&gt;/iu.exec(pending);
        const token = end ? pending.slice(0, end.index + end[0].length) : pending;
        if (containsInternalToolProtocol(token)) { suppressed = true; pending = ''; return; }
        if (!end) return;
        const length = end.index + end[0].length;
        onChunk(pending.slice(0, length));
        pending = pending.slice(length);
      }
    },
    flush() {
      if (!suppressed && pending && !/^(?:<|&lt;)\s*\/?\s*[a-z]/iu.test(pending)) onChunk(pending);
      pending = '';
    },
  };
}
