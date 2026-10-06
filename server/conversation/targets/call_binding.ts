import { artifactPathFromRecord, isArtifactProducerRecord } from "../../tools/artifact_evidence";
import { firstString, objectValue } from './values';
import { TARGET_PATH_KEYS } from './recognition';
import type { TaskTargetAnchorV1, TaskTargetEvidenceRecord, TaskTargetToolCallGuardResult, TaskTargetAnchorProjectionV1 } from './contracts';
import { canonicalPathIdentity, concreteTargetPath, targetReferenceMatches, displayableFileName, fileNamesMatchByPathFlavor } from './paths';

export function callTarget(args: Record<string, unknown>): string {
  return firstString(objectValue(args), [
    ...TARGET_PATH_KEYS,
    'directory',
  ], 500);
}

export function argumentsWithAnchoredDocumentPath(
  toolName: string,
  args: Record<string, unknown>,
  anchoredPath: string,
): Record<string, unknown> | null {
  const name = toolName.toLowerCase();
  if (name === 'read_file') return { ...args, path: anchoredPath };
  if (name === 'read_files_batch') return { ...args, paths: [anchoredPath] };
  if (name === 'ocr_image_file') return { ...args, imagePath: anchoredPath };
  if (/^(?:read_docx|read_xlsx|read_pdf|pdf_to_text|extract_document_text)$/i.test(name)) {
    return { ...args, filePath: anchoredPath };
  }
  for (const key of [
    'path', 'filePath', 'filepath', 'documentPath', 'documentpath',
    'sourcePath', 'sourcepath', 'inputPath', 'inputpath', 'targetPath', 'targetpath',
    'imagePath', 'imagepath', 'target', 'file',
  ]) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      return { ...args, [key]: anchoredPath };
    }
  }
  return null;
}

export function targetMatchesAnchor(candidate: string, anchor: TaskTargetAnchorV1): boolean {
  const anchoredPath = canonicalPathIdentity(anchor.path);
  if (anchoredPath && concreteTargetPath(anchor.path)) {
    return concreteTargetPath(candidate)
      && canonicalPathIdentity(candidate) === anchoredPath;
  }
  return [anchor.path, anchor.object, anchor.label]
    .filter(Boolean)
    .some(value => targetReferenceMatches(candidate, value));
}

export function verifiedProducedDocumentPath(record: TaskTargetEvidenceRecord): string {
  if (record.error || record.outcome === 'failure' || record.terminalVerification?.status !== 'verified') return '';
  const toolRecord = { name: record.name || '', arguments: record.arguments, capability: record.capability,
    result: typeof record.result === 'string' ? record.result : JSON.stringify(record.result),
    receipt: typeof record.receipt === 'string' ? record.receipt : JSON.stringify(record.receipt) };
  if (!isArtifactProducerRecord(toolRecord)) return '';
  const receipt = objectValue(record.receipt);
  const result = objectValue(record.result);
  if ([receipt, result].some(value => value.ok === false || /^(?:failed|error|cancelled|waiting_confirmation|unknown_outcome)$/iu.test(String(value.status || '')))) return '';
  const produced = artifactPathFromRecord(toolRecord);
  return concreteTargetPath(produced) && displayableFileName(produced) ? produced : '';
}

/** A verification read may inspect an output already produced by this task. */
export function isVerifiedProducedDocumentTarget(target: string, records: TaskTargetEvidenceRecord[]): boolean {
  const identity = canonicalPathIdentity(target);
  if (!identity || !concreteTargetPath(target)) return false;
  return records.some(record => canonicalPathIdentity(verifiedProducedDocumentPath(record)) === identity);
}

export function targetKeepsAnchoredObjectIdentity(candidate: string, anchor: TaskTargetAnchorV1): boolean {
  if (!candidate) return true;
  const anchoredReference = anchor.path || anchor.object || anchor.label;
  return Boolean(
    anchoredReference
    && fileNamesMatchByPathFlavor(candidate, anchoredReference),
  );
}

export function blocked(
  code: NonNullable<TaskTargetToolCallGuardResult['code']>,
  reason: string,
  anchor: TaskTargetAnchorProjectionV1,
  question?: string,
): TaskTargetToolCallGuardResult {
  return {
    allowed: false,
    status: 'blocked',
    code,
    reason,
    ...(question ? { clarification: { required: true, question } } : {}),
    anchor,
  };
}
