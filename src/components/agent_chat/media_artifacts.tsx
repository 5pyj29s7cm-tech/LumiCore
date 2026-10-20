import { type MediaGenerationExpectation, mediaGenerationToolForOperation, resolveMediaGenerationOperation, type MediaGenerationArtifact, type MediaGenerationKind, extractMediaGenerationArtifacts } from "@/lib/mediaGenerationArtifacts";
import { chatArtifactKind } from "../../../shared/chat_artifacts";
import { legacyChatArtifacts } from "@/lib/chatArtifactLinks";
import { type GeneratedFileLink } from "./contracts";
export const MEDIA_GENERATION_TOOL_NAMES = new Set(['generate_image', 'ai_edit_image', 'generate_video']);


export function isExpectedMediaGenerationTool(expectation: MediaGenerationExpectation, toolName: string): boolean {
  return mediaGenerationToolForOperation(resolveMediaGenerationOperation(expectation)) === toolName;
}


function parsePersistedToolRecords(value: unknown): Array<Record<string, any>> {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}


export function extractPersistedMediaArtifacts(message: any): MediaGenerationArtifact[] {
  const records = parsePersistedToolRecords(message?.toolCalls);
  const collected: MediaGenerationArtifact[] = [];
  for (const record of records) {
    const toolName = String(record.name || record.toolName || '').trim();
    if (!MEDIA_GENERATION_TOOL_NAMES.has(toolName) && !['get_image_generation_status', 'get_video_generation_status'].includes(toolName)) continue;
    const fallbackKind: MediaGenerationKind = ['generate_video', 'get_video_generation_status'].includes(toolName) ? 'video' : 'image';
    const args = record.arguments && typeof record.arguments === 'object'
      ? record.arguments
      : record.args && typeof record.args === 'object'
        ? record.args
        : {};
    const persistedOperation = String(args.operation || '').trim();
    const operation: NonNullable<MediaGenerationArtifact['operation']> = toolName === 'ai_edit_image'
      ? 'image_edit'
      : toolName === 'generate_video'
        ? (persistedOperation === 'image_to_video' || String(args.first_frame_image || '').trim()
            ? 'image_to_video'
            : 'text_to_video')
        : 'text_to_image';
    const artifacts = extractMediaGenerationArtifacts(record.result, fallbackKind).map(artifact => ({
      ...artifact,
      requestId: String(record.requestId || message?.requestId || '').trim() || undefined,
      operation: artifact.operation || operation,
      prompt: String(args.prompt || '').trim() || undefined,
      model: artifact.model || String((record.result as any)?.model || '').trim() || undefined,
    }));
    collected.push(...artifacts);
  }
  const seen = new Set<string>();
  return collected.filter(artifact => {
    const key = `${artifact.kind}:${artifact.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


export function generatedFileKind(fileName: string): GeneratedFileLink['kind'] {
  return chatArtifactKind(fileName);
}


export function extractGeneratedFiles(text: string, conversationId?: string): GeneratedFileLink[] {
  const canExposeFiles =
    /(?:Verified generated files|Generated and verified these files exist|Audio transcription result|Text file:|Output file:|Saved to:|已生成)/i.test(text || '');
  if (!canExposeFiles) return [];

  return legacyChatArtifacts(text, conversationId);
}
