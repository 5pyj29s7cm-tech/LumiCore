import type { ActionIntentAnalysis } from './normalized_action_intent';
import { buildTaskTargetAnchorProjection, canonicalPathIdentity, outputDocumentInstruction, sourceDocumentInstruction, type AcceptedTaskTarget } from '../conversation/task_target_anchor';
import { hasAffirmativeArtifactMutationAction, normalizeActionIntent } from './normalized_action_intent';
import path from 'node:path';
import os from 'node:os';
import { directoryArtifactPath, withoutLocationLiterals } from './location_literals';
import { affirmativeActionInstructionClauses, negatedActionInstructions } from './action_instruction_clauses';

/** Resolve one named artifact only in an explicit absolute or standard user folder. */
export function resolveExplicitUserArtifactPath(text: string, folderContext = ''): string {
  if ((text.match(/\.(?:xlsx?|docx?|pptx?|pdf|txt|md|csv|json)(?![a-z])/giu) || []).length !== 1) return '';
  const inDirectory = directoryArtifactPath(text);
  if (inDirectory) return inDirectory;
  const target = buildTaskTargetAnchorProjection({ taskText: text }).target;
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(target.path)) return target.path;
  // i18n-allow: standard user-directory input grammar; names and paths are operands.
  const folderPattern = /桌面(?:上|中|里|内|下|的|(?=[，,\s“”"']|$))|\bdesktop\b|文档(?:目录|文件夹)|\bdocuments\b|下载(?:目录|文件夹)|\bdownloads\b/iu;
  const folderText = withoutLocationLiterals(text).match(folderPattern)?.[0]
    || withoutLocationLiterals(folderContext).match(folderPattern)?.[0] || '';
  // i18n-allow: Existing input grammar identifies explicit output paths and prohibitions; not display text.
  const folder = /桌面|desktop/iu.test(folderText) ? 'Desktop'
    // i18n-allow: Existing input grammar identifies explicit output paths and prohibitions; not display text.
    : /文档|documents/iu.test(folderText) ? 'Documents'
      // i18n-allow: Existing input grammar identifies explicit output paths and prohibitions; not display text.
      : /下载|downloads/iu.test(folderText) ? 'Downloads' : '';
  return folder && target.object && !/[\\/]/u.test(target.object)
    ? path.join(os.homedir(), folder, target.object) : '';
}

function mixedTaskOutputPath(text: string): string {
  const sourceText = sourceDocumentInstruction(text);
  // i18n-allow: Existing input grammar identifies explicit output paths and prohibitions; not display text.
  const hasReadSource = /(?:读取|读入|分析|\b(?:read|load|inspect)\b)[^。！？!?；;\n]{0,700}\.(?:xlsx?|docx?|pptx?|pdf|txt|md|csv|json)(?![a-z])/iu.test(text);
  // The existing destination grammar separates merge inputs from their result.
  if (!hasReadSource && (!outputDocumentInstruction(text) || !hasAffirmativeArtifactMutationAction(text))) return '';
  const outputs: string[] = [];
  // Only an affirmative output clause with one filename can select a result.
  // i18n-allow: multilingual file-output clause and same-directory recognition.
  for (const { probe, start } of affirmativeActionInstructionClauses(text)) {
    const clause = probe.replace(/[，,。！？!?；;\n]+$/u, '');
    const destination = outputDocumentInstruction(clause);
    if (destination ? !hasAffirmativeArtifactMutationAction(clause)
      // i18n-allow: Existing input grammar identifies explicit output paths and prohibitions; not display text.
      : !/(?:生成|创建|写入|导出|另存|保存(?:到|为|成))|\b(?:create|write|export|save)\b/iu.test(clause)) continue;
    // i18n-allow: Existing input grammar identifies explicit output paths and prohibitions; not display text.
    if (/(?:不要|别|禁止|不必|无需)|\b(?:do not|don't|never)\b/iu.test(clause)) continue;
    const outputText = destination || clause;
    if ((outputText.match(/\.(?:xlsx?|docx?|pptx?|pdf|txt|md|csv|json)(?![a-z])/giu) || []).length !== 1) continue;
    const folderContext = destination && /\.(?:xlsx?|docx?|pptx?|pdf|txt|md|csv|json)(?![a-z])/iu.test(sourceText) ? sourceText : '';
    const outputPath = resolveExplicitUserArtifactPath(outputText, folderContext);
    if (outputPath) { outputs.push(outputPath); continue; }
    // i18n-allow: Existing input grammar identifies explicit output paths and prohibitions; not display text.
    if (!/(?:同目录|同一目录|同一文件夹)|\bsame\s+(?:directory|folder)\b/iu.test(clause)) continue;
    const filename = clause.match(/(?:^|\s|["'“])([^\s/\\:"'“”<>，,。；;]+\.(?:xlsx?|docx?|pptx?|pdf|txt|md|csv|json))(?=$|[\s"'”])/iu)?.[1];
    const source = buildTaskTargetAnchorProjection({ taskText: text.slice(0, start) }).target.path;
    if (filename && source) {
      const paths = /^[a-z]:[\\/]|^\\\\/iu.test(source) ? path.win32 : path.posix;
      outputs.push(paths.join(paths.dirname(source), filename));
    }
  }
  const unique = outputs.filter((output, index) => outputs.findIndex(other => canonicalPathIdentity(other) === canonicalPathIdentity(output)) === index);
  return unique.length === 1 ? unique[0] : '';
}

const OUTPUT_TOOLS = new Set(['write_file', 'desktop_write_text_file', 'create_xlsx', 'modify_xlsx', 'create_docx', 'create_ppt', 'create_pdf']);

/** A single explicitly named deliverable retains its format throughout the loop. */
export function requestedSingleArtifact(text: string, analysis?: ActionIntentAnalysis): { path: string; producer: string; reader: string } | null {
  const fileCount = (text.match(/\.(?:xlsx?|docx?|pptx?|pdf|txt|md|csv|json)(?![a-z])/giu) || []).length;
  const mixedOutput = fileCount > 1 ? mixedTaskOutputPath(text) : '';
  const intent = mixedOutput ? { operation: 'create', sideEffectClass: 'local_write', target: mixedOutput } : normalizeActionIntent(text, analysis);
  const target = mixedOutput || (fileCount === 1 ? requestedArtifactSaveAsPath(text) || resolveExplicitUserArtifactPath(text) : '') || intent.target;
  if (intent.operation !== 'create' || intent.sideEffectClass !== 'local_write' || !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(target)) return null;
  // Mixed source/output or multi-deliverable requests need their full plan;
  // do not reinterpret the first filename as the only requested output.
  if (!mixedOutput && fileCount !== 1) return null;
  const extension = target.match(/\.([a-z]+)$/iu)?.[1].toLowerCase();
  const tools: Record<string, [string, string]> = {
    xlsx: ['create_xlsx', 'read_xlsx'], docx: ['create_docx', 'read_docx'],
    pptx: ['create_ppt', 'extract_document_text'], pdf: ['create_pdf', 'read_pdf'],
    txt: ['write_file', 'read_file'], md: ['write_file', 'read_file'],
    csv: ['write_file', 'read_file'], json: ['write_file', 'read_file'],
  };
  const selected = extension && tools[extension];
  return selected ? { path: target, producer: selected[0], reader: selected[1] } : null;
}

export function matchesRequestedArtifactOutput(text: string, outputPath: string, analysis?: ActionIntentAnalysis): boolean {
  const requested = requestedSingleArtifact(text, analysis)?.path || requestedArtifactSaveAsPath(text);
  return !requested || canonicalPathIdentity(outputPath) === canonicalPathIdentity(requested);
}

export function requestedArtifactSaveAsPath(text: string): string {
  const destination = outputDocumentInstruction(text);
  if (!destination) return '';
  return resolveExplicitUserArtifactPath(destination, sourceDocumentInstruction(text));
}

export function requestedArtifactFormatBlockReason(text: string, toolName: string, args: Record<string, unknown>, analysis?: ActionIntentAnalysis): string | null {
  const artifact = requestedSingleArtifact(text, analysis);
  const producers = new Set(['write_file', 'desktop_write_text_file', 'create_xlsx', 'create_docx', 'create_ppt', 'create_pdf']);
  if (!artifact || !producers.has(toolName)) return null;
  if (toolName === artifact.producer || (artifact.producer === 'write_file' && toolName === 'desktop_write_text_file')) {
    const actualOutput = ['create_xlsx', 'create_docx', 'create_pdf'].includes(toolName) ? args.outputPath
      : toolName === 'write_file' ? args.path || args.filePath
        : toolName === 'desktop_write_text_file' ? args.path : undefined;
    if (['create_xlsx', 'create_docx', 'create_pdf', 'write_file', 'desktop_write_text_file'].includes(toolName)
      && (!actualOutput || canonicalPathIdentity(String(actualOutput)) !== canonicalPathIdentity(artifact.path))) {
      return `The output must use the exact file path requested in this turn: ${artifact.path}.`;
    }
    return null;
  }
  return `The requested artifact is ${artifact.path}. Use its ${artifact.producer} capability; do not create a different document format.`;
}

/** A scoped output exception cannot override a whole-file write prohibition. */
export function hasUnscopedArtifactWriteProhibition(text: string): boolean {
  // i18n-allow: Existing whole-file prohibition grammar, applied only to actual negative instructions.
  return negatedActionInstructions(text).some(({ instruction }) => /^(?:(?:再|继续|重新)\s*)?(?:修改|创建|保存|写入)\s*(?:任何|所有|新)?文件|^(?:create|save|modify|write(?:\s+to)?)\s+(?:any|all)\s+files?\b/iu.test(instruction));
}

/** A local output is allowed while the explicitly preserved input stays read-only. */
export function preservedSourceOutputScope(text: string): { sourceText: string; outputText: string; outputPaths?: string[] } | null {
  // i18n-allow: input recognition for a preserved source and separately requested output.
  const preserve = /(?:不修改|不要修改|不改动|不要改动|不覆盖|不要覆盖)(?:原|源)文件|(?:原|源)文件(?:不动|不变|不要(?:修改|改动|覆盖))|(?:保持|保留)(?:原|源)文件(?:原样|不变)|\b(?:do not|don't|without)\s+(?:modify|modifying|edit|editing|change|changing|overwrite|overwriting)\s+(?:the\s+)?(?:original|source)\s+file\b/iu;
  if (!preserve.test(text)) return null;
  if (hasUnscopedArtifactWriteProhibition(text)) return null;
  // i18n-allow: only an affirmative output clause grants this narrow exception.
  const output = /(?:另存(?:为)?|导出(?:为|到)?|保存(?:为|成)(?=\s*(?:(?:一份)?(?:新|副本)|[A-Za-z]:[\\/]|\/))|\b(?:save\s+(?:a\s+copy\s+)?as|export\s+(?:to|as))\b)/iu.exec(text);
  if (!output) {
    const created = affirmativeActionInstructionClauses(text).filter(clause => clause.start > 0 && requestedSingleArtifact(clause.probe));
    return created.length ? { sourceText: text.slice(0, created[0].start), outputText: created.map(clause => clause.probe).join('\n'),
      outputPaths: created.map(clause => requestedSingleArtifact(clause.probe)!.path) } : null;
  }
  // i18n-allow: a negated export does not authorize a local write.
  if (/(?:不要|别|不|禁止|无需)\s*$|\b(?:do not|don't|without)\s*$/iu.test(text.slice(Math.max(0, output.index - 24), output.index))) return null;
  return { sourceText: text.slice(0, output.index), outputText: text.slice(output.index + output[0].length) };
}

export function isPreservedSourceOutputTool(name: string): boolean {
  return OUTPUT_TOOLS.has(name);
}

export function preservedSourceOutputTools(text: string, acceptedTarget?: AcceptedTaskTarget): string[] {
  const scope = preservedSourceOutputScope(text);
  if (!scope) return [];
  if (scope.outputPaths) return [...new Set(scope.outputPaths.flatMap(output => /\.xlsx?$/i.test(output) ? ['create_xlsx', 'modify_xlsx']
    : /\.docx?$/i.test(output) ? ['create_docx'] : /\.pptx?$/i.test(output) ? ['create_ppt'] : /\.pdf$/i.test(output) ? ['create_pdf'] : ['write_file']))];
  const output = buildTaskTargetAnchorProjection({ taskText: scope.outputText }).target.path;
  if (/\.xlsx?$/i.test(output)) return ['create_xlsx', 'modify_xlsx'];
  if (!output && /\.xlsx?$/i.test(buildTaskTargetAnchorProjection({ taskText: scope.sourceText }).target.path || acceptedTarget?.target.path || '')) return ['modify_xlsx', 'create_xlsx'];
  if (/\.docx?$/i.test(output)) return ['create_docx'];
  if (/\.pptx?$/i.test(output)) return ['create_ppt'];
  if (/\.pdf$/i.test(output)) return ['create_pdf'];
  return ['write_file'];
}

export function preservedSourceWriteBlockReason(input: {
  text: string;
  toolName: string;
  arguments: Record<string, unknown>;
  acceptedTarget?: AcceptedTaskTarget;
}): string | null {
  const scope = preservedSourceOutputScope(input.text);
  if (!scope || !isPreservedSourceOutputTool(input.toolName)) return null;
  const outputs = scope.outputPaths || [buildTaskTargetAnchorProjection({ taskText: scope.outputText }).target.path].filter(Boolean);
  const explicitSource = buildTaskTargetAnchorProjection({ taskText: scope.sourceText }).target.path;
  const inheritedSource = input.acceptedTarget?.source !== 'current_turn' ? input.acceptedTarget?.target.path : '';
  const sources = affirmativeActionInstructionClauses(scope.sourceText).map(clause => normalizeActionIntent(clause.probe))
    .filter(intent => intent.rule === 'explicit-local-artifact-read' && intent.target).map(intent => intent.target);
  if (!sources.length && (explicitSource || inheritedSource)) sources.push(explicitSource || inheritedSource || '');
  // Match each handler's actual input, including alias priority. An ignored
  // outputPath/filePath must never authorize a write through args.path.
  const targetValue = input.toolName === 'write_file'
    ? input.arguments.path || input.arguments.filePath
    : input.toolName === 'desktop_write_text_file'
      ? input.arguments.path
      : input.toolName === 'create_ppt'
        ? input.arguments.filename
        : ['create_xlsx', 'modify_xlsx', 'create_docx', 'create_pdf'].includes(input.toolName)
          ? input.arguments.outputPath
          : undefined;
  const target = String(targetValue || '');
  const targetId = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(target) ? canonicalPathIdentity(target) : '';
  if (!targetId) return 'A separately saved artifact requires one concrete output path.';
  if (sources.some(source => targetId === canonicalPathIdentity(source))) return 'The user required the original file to remain unchanged. Save the result to a different file.';
  if (outputs.length && !outputs.some(output => targetId === canonicalPathIdentity(output))) return 'The output path does not match the separately saved artifact requested in this turn.';
  if (!outputs.length && !sources.length) return 'The source or separate output path must be resolved before saving a copy.';
  return null;
}
