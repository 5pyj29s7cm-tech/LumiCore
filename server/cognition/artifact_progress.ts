import type { ToolExecutionRecord } from '../tools/types';
import fs from 'node:fs';
import { isExplicitArtifactCreationText, independentActionClauses } from './normalized_action_intent';
import { requestedSingleArtifact } from './artifact_write_scope';
import { buildTaskTargetAnchorProjection, canonicalPathIdentity } from '../conversation/task_target_anchor';
import { withoutLocationLiterals } from './location_literals';
import { artifactReadbackText, artifactPathFromRecord, isArtifactProducerRecord, sameArtifactPath, resolveArtifactDelivery } from '../tools/artifact_evidence';
import { missingSpreadsheetRequirements } from './spreadsheet_requirements';
import { CN_EXECUTION_EVIDENCE_MESSAGES as CN } from "../regions/messages/execution_evidence_messages";


/** Evidence only: keep independently named outputs and their original content apart. */
export function requestedArtifactInstructions(input: string): Array<{ text: string; path: string }> {
  const parts: string[] = [];
  let start = 0, quote = '';
  // i18n-allow: quote delimiters in user-supplied document content.
  const pairs: Record<string, string> = { '“': '”', '‘': '’', '"': '"', "'": "'", '`': '`' };
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) { if (char === quote) quote = ''; continue; }
    if (pairs[char] && !(char === "'" && /[a-z]/iu.test(input[index - 1] || '') && /[a-z]/iu.test(input[index + 1] || ''))) { quote = pairs[char]; continue; }
    if (/[，,；;。\n]/u.test(char) || char === '.' && /\s|^$/u.test(input[index + 1] || '')) {
      parts.push(input.slice(start, index + 1)); start = index + 1;
    }
  }
  parts.push(input.slice(start));
  const instructions: Array<{ text: string; path: string }> = [];
  for (const part of parts) {
    // Quoted document data is never another output instruction. A quoted
    // concrete path remains a valid operand for its unquoted create verb.
    // i18n-allow: quoted document payload recognition.
    const probe = part.replace(/“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'|`[^`]*`/gu, literal => {
      const value = literal.slice(1, -1).trim();
      return buildTaskTargetAnchorProjection({ taskText: value }).target.path === value ? literal : ' ';
    });
    const affirmative = independentActionClauses(withoutLocationLiterals(probe).replace(/\bfor\s+example\b/giu, '例如'), true).length > 0; // i18n-allow: reuse the existing hypothetical-clause boundary.
    const artifact = affirmative && isExplicitArtifactCreationText(probe) ? requestedSingleArtifact(probe) : null;
    if (artifact) instructions.push({ text: part.trim(), path: artifact.path });
    else if (affirmative && instructions.length) {
      const referenced = buildTaskTargetAnchorProjection({ taskText: probe }).target.path;
      if (!referenced || sameArtifactPath(referenced, instructions[instructions.length - 1].path)) instructions[instructions.length - 1].text += part;
    }
  }
  const paths = new Set(instructions.map(item => canonicalPathIdentity(item.path)));
  return paths.size > 1 || instructions.length === 1 ? instructions : [];
}

export interface ArtifactContentRequirement {
  kind: 'text' | 'section' | 'blank_section';
  value: string;
}

/** Only explicit, mechanically checkable requirements; never model-written claims. */
export function extractExplicitArtifactTextRequirements(input: string): string[] {
  const requirements: string[] = [];
  const patterns = [
    // i18n-allow: Exact user-supplied content recognition.
    /(?:明确写出|原样写入|精确写入|(?:只|仅)写入|内容(?:为|是)|必须(?:包含|写入))\s*[：:]?\s*[“"]([^”"]{1,200})[”"]/gu,
    /第(?:[一二三四五六七八九十百\d]+)行\s*[：:]?\s*[“"]([^”"\r\n]{1,1000})[”"]/gu, // i18n-allow: Line numbers in user instructions.
    /\b(?:exactly\s+(?:include|write)|must\s+(?:include|contain))\s*[：:]?\s*[“"]([^”"]{1,200})[”"]/giu,
  ];
  for (const pattern of patterns) for (const match of String(input || '').matchAll(pattern)) {
    const value = match[1].trim();
    if (value && !requirements.includes(value)) requirements.push(value);
  }
  return requirements.slice(0, 20);
}

export function artifactContentRequirements(task: string): ArtifactContentRequirement[] {
  const result: ArtifactContentRequirement[] = extractExplicitArtifactTextRequirements(task).map(value => ({ kind: 'text', value }));
  const instruction = result.reduce((text, requirement) => text.replaceAll(requirement.value, ''), task);
  // Explicit short section lists, not arbitrary nouns from the task or document.
  // i18n-allow: Document structure requirements in user instructions.
  const lists = /(?:整理为|分为|分成|章节(?:为|包括)|结构(?:为|包括)|包含以下(?:部分|章节))\s*[：:]?\s*([^。！？!?；;\n]{1,160})/gu;
  for (const match of instruction.matchAll(lists)) {
    if (/(?:不要|无需|不用|不必|不需要)\s*$/u.test(instruction.slice(Math.max(0, match.index! - 12), match.index))) continue; // i18n-allow: Negated structure requests.
    const items = match[1].replace(/[，,]?\s*(?:这|等)?[一二三四五六七八九十\d]+(?:个)?部分\s*$/u, '').split(/[、，,]|以及|和/u); // i18n-allow: Section-list grammar.
    if (items.length < 2 || items.length > 12) continue;
    for (const item of items) {
      const blank = /^(?:留空|空白)(?:的)?/u.test(item.trim()) || /(?:留空|保持空白)$/u.test(item.trim()); // i18n-allow: Explicit blank section.
      const value = item.trim().replace(/^(?:留空|空白)(?:的)?|(?:留空|保持空白)$/gu, '').replace(/^[“"「]|[”"」]$/gu, '').trim(); // i18n-allow: Section label extraction.
      if (value && value.length <= 24 && !/[\/:.]/u.test(value)) result.push({ kind: blank ? 'blank_section' : 'section', value });
    }
  }
  return result.filter((item, index) => result.findIndex(other => other.kind === item.kind && other.value === item.value) === index).slice(0, 32);
}

function heading(line: string): string {
  // i18n-allow: Numbering and blank labels in document headings.
  return line.trim().replace(/^#{1,6}\s*|^[（(]?[一二三四五六七八九十\d]+[）)、.．]\s*/u, '')
    .replace(/[（(](?:留空|空白|待填写|blank|pending)[）)]\s*$/iu, '').replace(/[：:]\s*$/u, '').trim();
}

function matchesHeading(line: string, value: string): boolean {
  const candidate = heading(line);
  return candidate === value || candidate.length <= value.length + 8 && candidate.endsWith(value);
}

function isBlankPlaceholder(value: string): boolean {
  // These are placeholders only. A substantive decision plus "pending" fails.
  // i18n-allow: Blank-field marker recognition in actual document content.
  return !value.replace(/会议尚未举行|会议尚未召开|此处留空|待会议结束后由记录人补充填写|待(?:会后|会议结束后)?(?:补充)?填写|待定|留空|空白|尚未填写|\b(?:TBD|blank|pending|to be filled(?: in)?(?: after the meeting)?)\b/giu, '')
    .replace(/[\s_\-—.。；;，,：:（）()\[\]【】]/gu, '');
}

export function checkArtifactContent(requirements: ArtifactContentRequirement[], content?: string) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  return requirements.map(requirement => {
    let status: 'pending' | 'passed' | 'missing' | 'not_blank' = 'pending';
    if (content !== undefined) {
      if (requirement.kind === 'text') status = content.includes(requirement.value) ? 'passed' : 'missing';
      else {
        const index = lines.findIndex(line => matchesHeading(line, requirement.value));
        status = index >= 0 ? 'passed' : 'missing';
        if (index >= 0 && requirement.kind === 'blank_section') {
          const remainder: string[] = [];
          for (const line of lines.slice(index + 1)) {
            if (requirements.some(other => other.kind !== 'text' && other.value !== requirement.value && matchesHeading(line, other.value))) break;
            remainder.push(line);
          }
          if (!isBlankPlaceholder(remainder.join('\n'))) status = 'not_blank';
        }
      }
    }
    return { ...requirement, status };
  });
}

/** One receipt-derived checkpoint shared by execution, finalization and status. */
export function projectArtifactProgress(task: string, records: ToolExecutionRecord[], options: {
  readbackRequired: boolean; openRequired: boolean; openVerified: (path: string) => boolean;
  acceptsOutput: (path: string) => boolean;
}) {
  const instructions = requestedArtifactInstructions(task);
  const target = instructions.length === 1 ? instructions[0].path : '';
  const delivery = resolveArtifactDelivery(records, record => !record.error
    && (!isArtifactProducerRecord(record) || (target ? sameArtifactPath(target, artifactPathFromRecord(record)) : options.acceptsOutput(artifactPathFromRecord(record)))));
  if (!delivery) return null;
  const requirements = /\.(?:docx|pdf|txt|md|html?)$/iu.test(delivery.outputPath) ? artifactContentRequirements(task) : [];
  let content = delivery.readback ? artifactReadbackText(delivery.readback) : undefined;
  // The existing bounded plain-text writer can verify exact text directly
  // against its local output. Keep that single-call path; binary office files
  // need their declared parser. Explicit tool readback remains a separate step.
  if (content === undefined && requirements.length && /\.(?:txt|md|html?)$/iu.test(delivery.outputPath)) {
    try {
      const stat = fs.statSync(delivery.outputPath);
      if (stat.isFile() && stat.size <= 1_048_576) content = fs.readFileSync(delivery.outputPath, 'utf8');
    } catch { /* Missing/unreadable output cannot satisfy content checks. */ }
  }
  const checks = checkArtifactContent(requirements, content);
  const missingContent = checks.filter(check => check.status !== 'passed');
  const spreadsheet = missingSpreadsheetRequirements(task, records);
  const readbackRequired = options.readbackRequired || requirements.length > 0 && content === undefined;
  const opened = options.openRequired && options.openVerified(delivery.outputPath);
  const next = readbackRequired && !delivery.readback ? 'readback'
    : missingContent.length ? 'repair_content' : spreadsheet.length ? 'repair_workbook'
      : options.openRequired && !opened ? 'open' : 'complete';
  return {
    savedPath: delivery.outputPath, producer: delivery.producer.name,
    readBack: Boolean(delivery.readback), readbackRequired, contentChecks: checks,
    missingContent, missingSpreadsheetRequirements: spreadsheet,
    openRequestedAndPending: options.openRequired && !opened,
    opened: Boolean(opened), next, complete: next === 'complete',
  };
}

export function artifactProgressFeedback(progress: NonNullable<ReturnType<typeof projectArtifactProgress>>, task: string) {
  const zh = /[\u3400-\u9fff]/u.test(task);
  const completed = [zh ? CN.artifactSavedStage : 'File saved',
    ...(progress.readBack ? [zh ? CN.artifactReadStage : 'Latest saved version read back'] : []),
    ...progress.contentChecks.filter(c => c.status === 'passed').map(c => zh ? CN.artifactCheckedStage(c.value) : `Checked: ${c.value}`),
    ...(progress.opened ? [zh ? CN.artifactOpenStage : 'Opened in the requested application'] : [])];
  const incomplete = [
    ...(progress.readbackRequired && !progress.readBack ? [zh ? CN.artifactPendingRead : 'Latest saved version has not been read back'] : []),
    ...progress.missingContent.filter(c => c.status !== 'pending').map(c => c.status === 'not_blank'
      ? zh ? CN.artifactNotBlank(c.value) : `Required blank section contains text: ${c.value}`
      : zh ? CN.artifactMissingContent(c.value) : `Required content missing: ${c.value}`),
    ...(progress.missingSpreadsheetRequirements.length ? [zh ? CN.spreadsheetIncomplete(progress.missingSpreadsheetRequirements)
      : `Workbook requirements missing: ${progress.missingSpreadsheetRequirements.join(', ')}`] : []),
    ...(progress.openRequestedAndPending ? [zh ? CN.artifactPendingOpen : 'Requested application open is unverified'] : []),
  ];
  const nextSteps = progress.complete ? [] : [progress.next === 'readback'
    ? zh ? CN.artifactNextRead : 'Read the saved version and verify the requirements.'
    : progress.next === 'open' ? zh ? CN.artifactNextOpen : 'Open the saved file and verify the target window.'
      : zh ? CN.artifactNextRepair : 'Repair the listed requirements, preserve existing work, then read back the new version.'];
  return { completed, incomplete, nextSteps, evidence: [progress.savedPath] };
}

export function formatArtifactProgress(progress: NonNullable<ReturnType<typeof projectArtifactProgress>>, task: string): string {
  const details = artifactProgressFeedback(progress, task);
  return [...details.completed, progress.savedPath, ...details.incomplete, ...details.nextSteps,
    ...(!progress.complete ? [/[\u3400-\u9fff]/u.test(task) ? CN.artifactStillIncomplete : 'The whole task is not complete.'] : [])].join('\n');
}
