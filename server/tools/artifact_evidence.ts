import path from 'node:path';
import crypto from 'node:crypto';
import type { ToolExecutionRecord } from './types';
import { parseReceiptObject, toolRecordTerminalPayload, toolRecordTerminalText } from './receipt_payload';

// Compatibility for built-ins whose older persisted receipts lack capability
// metadata. New tools are recognized through their declared local-write effect.
const PRODUCERS = /^(?:write_file|desktop_write_text_file|create_(?:docx|xlsx|pptx?|pdf)|modify_(?:docx|xlsx)|cad_generate_dxf|cad_prepare_autocad_operations|mcp_cad-drafting_autocad_playback_file|transcribe_audio_to_text_file|generate_.*(?:dxf|ppt|file))$/iu;
const READERS = /^(?:read_file|read_docx|read_xlsx|read_pdf|pdf_to_text|extract_document_text)$/iu;

export function isArtifactProducerRecord(record: Pick<ToolExecutionRecord, 'name' | 'capability'>): boolean {
  return PRODUCERS.test(record.name) || (['files', 'office', 'media', 'cad'].includes(record.capability?.lane || '')
    && ['create', 'mutate'].includes(record.capability?.operation || '')
    && Boolean(record.capability?.sideEffects?.some(effect => effect.type === 'local_write')));
}

export function isArtifactReaderRecord(record: ToolExecutionRecord): boolean {
  return READERS.test(record.name);
}

/** Readback metadata proves a read occurred; it is not the document text. */
export function artifactReadbackText(record: ToolExecutionRecord): string | undefined {
  const payload = toolRecordTerminalPayload(record);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const data = payload as Record<string, unknown>;
    if (data.kind === 'text_readback_metadata') {
      // Bounded or legacy compacted results are usable only when their digest
      // still matches the original read. Never treat a summary as exact content.
      const result = String(record.result || '');
      return crypto.createHash('sha256').update(result, 'utf8').digest('hex') === data.contentDigest ? result : undefined;
    }
    for (const field of ['text', 'content', 'rawText']) if (typeof data[field] === 'string') return data[field] as string;
  }
  return typeof payload === 'string' ? payload : toolRecordTerminalText(record);
}

export function sameArtifactPath(left: string, right: string): boolean {
  const normalize = (value: string) => /^[a-z]:[\\/]|^\\\\/iu.test(value)
    ? path.win32.normalize(value.replace(/\//gu, '\\')).toLowerCase()
    : path.posix.normalize(value);
  return Boolean(left && right && normalize(left) === normalize(right));
}

/** Producer receipts describe outputs; a mutation's input is never its output. */
export function artifactPathFromRecord(record: ToolExecutionRecord): string {
  const args = record.arguments || {};
  if (isArtifactProducerRecord(record)) {
    const receipt = parseReceiptObject(toolRecordTerminalPayload(record));
    const output = receipt?.path || receipt?.filePath || receipt?.outputPath || receipt?.savedPath;
    if (typeof output === 'string' && output.trim()) return output.trim();
    const requestedOutput = args.outputPath || args.destination || args.targetPath
      || (/^(?:write_file|desktop_write_text_file)$/iu.test(record.name) ? args.path || args.filePath : '');
    if (typeof requestedOutput === 'string' && requestedOutput.trim()) return requestedOutput.trim();
    // Historical creation receipts can contain a human-readable output path.
    // Never scan the input arguments to invent evidence of a produced file.
    const text = toolRecordTerminalText(record);
    return text.match(/([A-Za-z]:[\\/][^\r\n"<>|*?]+?\.(?:docx|xlsx|pptx|pdf|md|txt|csv|json|dxf|dwg|svg|png|jpe?g|webp|html))/iu)?.[1]?.trim()
      || text.match(/((?:\/[^\s"']+)+\.(?:docx|xlsx|pptx|pdf|md|txt|csv|json|dxf|dwg|svg|png|jpe?g|webp|html))/iu)?.[1]?.trim() || '';
  }
  return String(args.path || args.filePath || args.targetPath || args.target || args.outputPath || '').trim();
}

export function artifactRecordMatchesTurn(record: ToolExecutionRecord, turn: { requestId?: string; taskId?: string }): boolean {
  return (['requestId', 'taskId'] as const).every(key => {
    const expected = turn[key];
    if (!expected) return true;
    const actual = [record[key], record.envelope?.[key]].filter(Boolean);
    return actual.length > 0 && actual.every(value => value === expected);
  });
}

export function resolveArtifactDelivery(records: ToolExecutionRecord[], accept: (record: ToolExecutionRecord) => boolean = record => !record.error) {
  const producer = [...records].reverse().find(record => isArtifactProducerRecord(record) && accept(record) && artifactPathFromRecord(record));
  if (!producer) return null;
  const outputPath = artifactPathFromRecord(producer);
  const readback = records.slice(records.indexOf(producer) + 1).find(record =>
    isArtifactReaderRecord(record) && accept(record)
    && artifactRecordMatchesTurn(record, { requestId: producer.requestId || producer.envelope?.requestId, taskId: producer.taskId || producer.envelope?.taskId })
    && sameArtifactPath(outputPath, artifactPathFromRecord(record)));
  return { producer, outputPath, readback };
}
