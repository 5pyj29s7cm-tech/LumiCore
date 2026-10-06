import type { TaskTargetEvidenceRecord, EvidenceCandidate, SupportedAuthoringApplication } from './contracts';
import { compact, objectValue, firstString, primaryTaskText, capsuleTaskText, parseTaskTargetJson, normalizedIdentity, unique } from './values';
import { ACTIVE_WINDOW_TOOLS, WINDOW_KEYS, APPLICATION_KEYS, WPS_RE, FILE_NAME_RE, TARGET_NAME_KEYS, TARGET_PATH_KEYS, RUNNING_PROCESS_TOOLS, DOCUMENT_INTERFACE_RE, DISCOVERY_TOOLS } from './recognition';
import { displayableFileName, concreteTargetPath, directoryWithin, targetReferenceMatches, fileName } from './paths';
import { isAllowedTaskSearchDirectory, isUnconfirmedRuntimeCandidate, isStandardUserDirectory } from './search_scope';

export function recordSucceeded(record: TaskTargetEvidenceRecord): boolean {
  if (!record || compact(record.error, 300)) return false;
  if (record.outcome && record.outcome !== 'success') return false;
  if (record.terminalVerification?.status === 'failed') return false;
  const payload = objectValue(record.receipt ?? record.result);
  const status = compact(payload.status, 80).toLowerCase();
  return payload.ok !== false
    && payload.success !== false
    && !/^(?:failed|error|blocked|denied|forbidden|timeout|timed_out|cancelled|canceled|not_found)$/.test(status);
}

export function activeWindowCandidate(record: TaskTargetEvidenceRecord): EvidenceCandidate | null {
  const name = compact(record.name, 160).toLowerCase();
  if (!ACTIVE_WINDOW_TOOLS.has(name) || !recordSucceeded(record)) return null;
  const payload = objectValue(record.receipt ?? record.result);
  const window = firstString(payload, WINDOW_KEYS, 300);
  const applicationValue = firstString(payload, APPLICATION_KEYS, 160);
  const signature = `${applicationValue} ${window}`;
  const application = WPS_RE.test(signature) ? 'WPS' : compact(applicationValue, 160);
  const object = displayableFileName(window.match(FILE_NAME_RE)?.[1] || firstString(payload, TARGET_NAME_KEYS, 220));
  const pathValue = firstString(payload, TARGET_PATH_KEYS, 500);
  const candidatePath = displayableFileName(pathValue) ? pathValue : '';
  const label = object || displayableFileName(candidatePath);
  return {
    label,
    application,
    window,
    object: label,
    path: candidatePath,
    location: '',
    status: label ? 'confirmed' : 'unresolved',
    source: 'active_window',
    kind: 'active_window',
  };
}

export function supportedAuthoringApplication(processName: string): SupportedAuthoringApplication | '' {
  const executable = compact(processName, 160).split(/[\\/]/).pop()?.trim() || '';
  if (/^(?:wps|wpp|et|wpsoffice)(?:\.exe)?$/i.test(executable) || /^WPS Office$/i.test(executable)) return 'WPS';
  if (/^(?:winword(?:\.exe)?|Microsoft Word)$/i.test(executable)) return 'Microsoft Word';
  if (/^(?:excel(?:\.exe)?|Microsoft Excel)$/i.test(executable)) return 'Microsoft Excel';
  if (/^(?:powerpnt(?:\.exe)?|Microsoft PowerPoint)$/i.test(executable)) return 'Microsoft PowerPoint';
  return '';
}

export function requestedAuthoringApplication(taskText: string, applicationHint = ''): SupportedAuthoringApplication | 'any' {
  const task = `${primaryTaskText(taskText)} ${capsuleTaskText(taskText)} ${compact(applicationHint, 160)}`;
  if (WPS_RE.test(task)) return 'WPS';
  if (/(?:Microsoft\s+)?PowerPoint|POWERPNT\.EXE/iu.test(task)) return 'Microsoft PowerPoint';
  if (/(?:Microsoft\s+)?Excel|EXCEL\.EXE/iu.test(task)) return 'Microsoft Excel';
  if (/(?:Microsoft\s+)?Word|WINWORD\.EXE/iu.test(task)) return 'Microsoft Word';
  return 'any';
}

export function candidateMatchesRequestedAuthoringApplication(
  candidate: EvidenceCandidate,
  taskText: string,
  applicationHint = '',
): boolean {
  const actual = supportedAuthoringApplication(candidate.application);
  if (!actual) return false;
  const requested = requestedAuthoringApplication(taskText, applicationHint);
  return requested === 'any' || actual === requested;
}

export function runningAuthoringWindowCandidates(
  record: TaskTargetEvidenceRecord,
  taskText: string,
  applicationHint = '',
): EvidenceCandidate[] {
  const name = compact(record.name, 160).toLowerCase();
  if (
    !RUNNING_PROCESS_TOOLS.has(name)
    || !recordSucceeded(record)
    || record.terminalVerification?.status !== 'verified'
  ) return [];
  const parsed = parseTaskTargetJson(record.receipt ?? record.result);
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (['processes', 'items', 'results']
          .map(key => (parsed as Record<string, unknown>)[key])
          .find(Array.isArray) as unknown[] | undefined) || []
      : [];
  const candidates: EvidenceCandidate[] = [];
  const seen = new Set<string>();
  for (const rawItem of items.slice(0, 100)) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    const processName = firstString(item, ['name', ...APPLICATION_KEYS], 160);
    const application = supportedAuthoringApplication(processName);
    if (!application) continue;
    const requested = requestedAuthoringApplication(taskText, applicationHint);
    if (requested !== 'any' && requested !== application) continue;
    const rawTitles = Array.isArray(item.window_titles)
      ? item.window_titles
      : Array.isArray(item.windowTitles)
        ? item.windowTitles
        : [];
    const titles = [
      ...rawTitles,
      firstString(item, ['window_title', 'windowTitle'], 300),
    ];
    for (const rawTitle of titles) {
      if (typeof rawTitle !== 'string') continue;
      const window = compact(rawTitle, 300);
      const object = displayableFileName(window.match(FILE_NAME_RE)?.[1]);
      if (!window || !object) continue;
      const identity = normalizedIdentity(`${application}|${object}`);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      candidates.push({
        label: object,
        application,
        window,
        object,
        path: '',
        location: '',
        status: 'confirmed',
        source: 'running_window',
        kind: 'running_window',
      });
      if (candidates.length >= 16) return candidates;
    }
  }
  return candidates;
}

export function documentCandidate(record: TaskTargetEvidenceRecord): EvidenceCandidate | null {
  const name = compact(record.name, 160);
  const documentInterface = DOCUMENT_INTERFACE_RE.test(name);
  const verifiedArtifactMutation = /^(?:write_file|desktop_write_text_file|create_docx|create_xlsx|create_ppt|create_pdf)$/i.test(name)
    && record.terminalVerification?.status === 'verified';
  if ((!documentInterface && !verifiedArtifactMutation) || !recordSucceeded(record)) return null;
  const args = objectValue(record.arguments);
  const payload = objectValue(record.receipt ?? record.result);
  const pathValue = firstString(args, TARGET_PATH_KEYS, 500) || firstString(payload, TARGET_PATH_KEYS, 500);
  const object = displayableFileName(
    firstString(payload, TARGET_NAME_KEYS, 220)
      || firstString(args, TARGET_NAME_KEYS, 220)
      || pathValue,
  );
  const applicationValue = firstString(payload, APPLICATION_KEYS, 160);
  const application = WPS_RE.test(`${name} ${applicationValue}`) ? 'WPS' : compact(applicationValue, 160);
  const window = firstString(payload, WINDOW_KEYS, 300);
  if (!object && !pathValue && !window) return null;
  return {
    label: object || displayableFileName(pathValue),
    application,
    window,
    object,
    path: displayableFileName(pathValue) ? pathValue : '',
    location: '',
    status: object || displayableFileName(pathValue) ? 'confirmed' : 'unresolved',
    source: documentInterface ? 'document_interface' : 'tool_receipt',
    kind: documentInterface ? 'document_interface' : 'tool_receipt',
  };
}

function resultItems(value: unknown): Record<string, unknown>[] {
  const parsed = parseTaskTargetJson(value);
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (['files', 'entries', 'items', 'results']
          .map(key => (parsed as Record<string, unknown>)[key])
          .find(Array.isArray) as unknown[] | undefined) || []
      : [];
  return raw.slice(0, 100).flatMap(item => {
    if (typeof item === 'string') return [{ path: item }];
    return item && typeof item === 'object' && !Array.isArray(item)
      ? [item as Record<string, unknown>]
      : [];
  });
}

export function discoveryCandidate(
  record: TaskTargetEvidenceRecord,
  taskText: string,
  preferredName: string,
  preferredReference: string,
  sourcePaths: string[],
): EvidenceCandidate | null {
  const name = compact(record.name, 160).toLowerCase();
  if (!DISCOVERY_TOOLS.has(name) || !recordSucceeded(record) || !preferredName) return null;
  const args = objectValue(record.arguments);
  const directory = firstString(args, ['directory', 'path'], 500);
  if (!isAllowedTaskSearchDirectory(directory, taskText, sourcePaths)) return null;
  const matches = resultItems(record.receipt ?? record.result).flatMap(item => {
    const candidatePath = firstString(item, TARGET_PATH_KEYS, 500) || firstString(item, TARGET_NAME_KEYS, 220);
    if (!candidatePath || isUnconfirmedRuntimeCandidate(candidatePath, taskText)) return [];
    const resolvedCandidate = concreteTargetPath(candidatePath)
      ? candidatePath
      : `${directory.replace(/[\\/]+$/, '')}/${candidatePath}`;
    if (!directoryWithin(resolvedCandidate, directory)) return [];
    return targetReferenceMatches(resolvedCandidate, preferredReference || preferredName)
      ? [resolvedCandidate]
      : [];
  });
  const exact = unique(matches, 3);
  if (exact.length !== 1) return null;
  const resolvedPath = exact[0];
  return {
    label: fileName(resolvedPath),
    application: '',
    window: '',
    object: fileName(resolvedPath),
    path: resolvedPath,
    location: isStandardUserDirectory(resolvedPath) ? 'bounded_user_files' : '',
    status: 'confirmed',
    source: 'tool_receipt',
    kind: 'discovery',
  };
}
