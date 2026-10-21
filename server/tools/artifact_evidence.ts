import { normalizePathIdentity } from '../../shared/file_identity';
import crypto from 'node:crypto';
import type { ToolExecutionRecord } from './types';
import { parseReceiptObject, toolRecordTerminalPayload, toolRecordTerminalText, toolRecordSucceeded } from './receipt_payload';

// Compatibility for built-ins whose older persisted receipts lack capability
// metadata. New tools are recognized through their declared local-write effect.
const PRODUCERS = /^(?:write_file|desktop_write_text_file|create_(?:docx|xlsx|pptx?|pdf)|modify_(?:docx|xlsx)|cad_generate_dxf|cad_prepare_autocad_operations|mcp_cad-drafting_autocad_playback_file|transcribe_audio_to_text_file|generate_.*(?:dxf|ppt|file))$/iu;
const READERS = /^(?:read_file|read_docx|read_xlsx|read_pdf|pdf_to_text|extract_document_text)$/iu;

export function isArtifactProducerRecord(record: Pick<ToolExecutionRecord, 'name' | 'capability'>): boolean {
  return PRODUCERS.test(record.name) || (['files', 'office', 'media', 'cad'].includes(record.capability?.lane || '')
    && ['create', 'mutate'].includes(record.capability?.operation || '')
    && Boolean(record.capability?.sideEffects?.some(effect => effect.type === 'local_write')));
}

/** Explicit retrieval can deliver an existing file without claiming it was created. */
export function isArtifactDeliveryRecord(record: ToolExecutionRecord): boolean {
  if (isArtifactProducerRecord(record)) return true;
  const receipt = parseReceiptObject(toolRecordTerminalPayload(record));
  return !record.error && record.terminalVerification?.status === 'verified'
    && record.capability?.operation === 'observe' && Boolean(record.capability.sideEffects?.length)
    && record.capability.sideEffects.every(effect => effect.type === 'local_read')
    && record.capability.verification?.successStatuses?.includes('retrieved') === true
    && receipt?.ok === true && receipt.verified === true && receipt.success !== false && !receipt.error && receipt.status === 'retrieved'
    && typeof receipt.outputPath === 'string' && Array.isArray(receipt.artifacts)
    && receipt.artifacts.some((artifact: any) => typeof artifact?.path === 'string'
      && sameArtifactPath(artifact.path, receipt.outputPath) && Number.isSafeInteger(artifact.size) && artifact.size > 0
      && typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256));
}

export function isArtifactReaderRecord(record: ToolExecutionRecord): boolean {
  return READERS.test(record.name);
}

export function artifactReadbackMetadata(record: ToolExecutionRecord) {
  const text = String(record.result || '');
  return isArtifactReaderRecord(record) && toolRecordSucceeded(record) && text ? {
    kind: 'text_readback_metadata', encoding: 'UTF-8',
    lineCount: text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length,
    byteLength: Buffer.byteLength(text, 'utf8'),
    contentDigest: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
  } : null;
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
  const identity = (value: string) => normalizePathIdentity(value, /^[a-z]:[\\/]|^\\\\/iu.test(value) ? 'win32' : 'linux');
  return Boolean(left && right && identity(left) === identity(right));
}

/** Producer receipts describe outputs; a mutation's input is never its output. */
export function artifactPathFromRecord(record: ToolExecutionRecord): string {
  const args = record.arguments || {};
  if (isArtifactDeliveryRecord(record)) {
    const receipt = parseReceiptObject(toolRecordTerminalPayload(record));
    const output = isArtifactProducerRecord(record) ? receipt?.path || receipt?.filePath || receipt?.outputPath || receipt?.savedPath : receipt?.outputPath;
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
    const expected = String(turn[key] || '').trim();
    if (!expected) return true;
    const actual = [record[key], record.envelope?.[key]].map(value => String(value || '').trim()).filter(Boolean);
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

/** Callers supply already verified records; generated output readbacks are never original source exceptions. */
export function artifactReadbackTextSources(records: ToolExecutionRecord[], originalText: readonly string[] = []) {
  const reads = records.filter(isArtifactReaderRecord).map(record => ({ record, text: artifactReadbackText(record) || '' }));
  const requestedSource = (record: ToolExecutionRecord) => {
    const target = artifactPathFromRecord(record);
    if (!target) return false;
    // A tool-selected runtime/log read is not user input. Only an exact path
    // literal in the original server-owned request can grant this exception.
    return originalText.some(text => {
      const index = text.indexOf(target);
      return index >= 0 && (index === 0 || "\"'` \r\n\t".includes(text[index - 1]))
        && (index + target.length === text.length || "\"'` \r\n\t".includes(text[index + target.length]));
    });
  };
  return { verifiedText: reads.map(item => item.text), sourceText: reads.filter(({ record }) => requestedSource(record) && !records.some(producer => isArtifactProducerRecord(producer)
    && sameArtifactPath(artifactPathFromRecord(producer), artifactPathFromRecord(record)))).map(item => item.text) };
}
