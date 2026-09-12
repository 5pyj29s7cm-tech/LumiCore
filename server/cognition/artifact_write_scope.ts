import { buildTaskTargetAnchorProjection, canonicalPathIdentity, type AcceptedTaskTarget } from '../conversation/task_target_anchor';
import { normalizeActionIntent } from './normalized_action_intent';
import path from 'node:path';

function mixedTaskOutputPath(text: string): string {
  // A list of two requested outputs is not an input/output transformation.
  // i18n-allow: explicit source-file read recognition.
  if (!/(?:读取|读入|分析|\b(?:read|load|inspect)\b)[^。！？!?；;\n]{0,700}\.(?:xlsx?|docx?|pptx?|pdf|txt|md|csv|json)(?![a-z])/iu.test(text)) return '';
  const outputs: string[] = [];
  // Only an affirmative output clause with one filename can select a result.
  // i18n-allow: multilingual file-output clause and same-directory recognition.
  for (const clause of text.split(/[，,。！？!?；;\n]/u)) {
    if (!/(?:生成|创建|写入|导出|另存|保存到)|\b(?:create|write|export|save)\b/iu.test(clause)
      || /(?:不要|别|禁止|不必|无需)|\b(?:do not|don't|never)\b/iu.test(clause)) continue; // i18n-allow: negated output recognition.
    if ((clause.match(/\.(?:xlsx?|docx?|pptx?|pdf|txt|md|csv|json)(?![a-z])/giu) || []).length !== 1) continue;
    const absolute = buildTaskTargetAnchorProjection({ taskText: clause }).target.path;
    if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(absolute)) { outputs.push(absolute); continue; }
    if (!/(?:同目录|同一目录|同一文件夹)|\bsame\s+(?:directory|folder)\b/iu.test(clause)) continue; // i18n-allow: explicit output directory relation.
    const filename = clause.match(/(?:^|\s|["'“])([^\s/\\:"'“”<>，,。；;]+\.(?:xlsx?|docx?|pptx?|pdf|txt|md|csv|json))(?=$|[\s"'”])/iu)?.[1];
    const source = buildTaskTargetAnchorProjection({ taskText: text.slice(0, text.indexOf(clause)) }).target.path;
    if (filename && source) {
      const paths = /^[a-z]:[\\/]|^\\\\/iu.test(source) ? path.win32 : path.posix;
      outputs.push(paths.join(paths.dirname(source), filename));
    }
  }
  return outputs.length === 1 ? outputs[0] : '';
}

const OUTPUT_TOOLS = new Set(['write_file', 'desktop_write_text_file', 'create_xlsx', 'modify_xlsx', 'create_docx', 'create_ppt', 'create_pdf']);

/** A single explicitly named deliverable retains its format throughout the loop. */
export function requestedSingleArtifact(text: string): { path: string; producer: string; reader: string } | null {
  const fileCount = (text.match(/\.(?:xlsx?|docx?|pptx?|pdf|txt|md|csv|json)(?![a-z])/giu) || []).length;
  const mixedOutput = fileCount > 1 ? mixedTaskOutputPath(text) : '';
  const intent = mixedOutput ? { operation: 'create', sideEffectClass: 'local_write', target: mixedOutput } : normalizeActionIntent(text);
  if (intent.operation !== 'create' || intent.sideEffectClass !== 'local_write' || !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(intent.target)) return null;
  // Mixed source/output or multi-deliverable requests need their full plan;
  // do not reinterpret the first filename as the only requested output.
  if (!mixedOutput && fileCount !== 1) return null;
  const extension = intent.target.match(/\.([a-z]+)$/iu)?.[1].toLowerCase();
  const tools: Record<string, [string, string]> = {
    xlsx: ['create_xlsx', 'read_xlsx'], docx: ['create_docx', 'read_docx'],
    pptx: ['create_ppt', 'extract_document_text'], pdf: ['create_pdf', 'read_pdf'],
    txt: ['write_file', 'read_file'], md: ['write_file', 'read_file'],
    csv: ['write_file', 'read_file'], json: ['write_file', 'read_file'],
  };
  const selected = extension && tools[extension];
  return selected ? { path: intent.target, producer: selected[0], reader: selected[1] } : null;
}

export function matchesRequestedArtifactOutput(text: string, outputPath: string): boolean {
  const requested = requestedSingleArtifact(text);
  return !requested || canonicalPathIdentity(outputPath) === canonicalPathIdentity(requested.path);
}

export function requestedArtifactFormatBlockReason(text: string, toolName: string, args: Record<string, unknown>): string | null {
  const artifact = requestedSingleArtifact(text);
  const producers = new Set(['write_file', 'desktop_write_text_file', 'create_xlsx', 'create_docx', 'create_ppt', 'create_pdf']);
  if (!artifact || !producers.has(toolName)) return null;
  if (toolName === artifact.producer || (artifact.producer === 'write_file' && toolName === 'desktop_write_text_file')) {
    const actualOutput = toolName === 'create_xlsx' ? args.outputPath
      : toolName === 'write_file' ? args.path || args.filePath
        : toolName === 'desktop_write_text_file' ? args.path : undefined;
    if (['create_xlsx', 'write_file', 'desktop_write_text_file'].includes(toolName)
      && (!actualOutput || canonicalPathIdentity(String(actualOutput)) !== canonicalPathIdentity(artifact.path))) {
      return `The output must use the exact file path requested in this turn: ${artifact.path}.`;
    }
    return null;
  }
  return `The requested artifact is ${artifact.path}. Use its ${artifact.producer} capability; do not create a different document format.`;
}

/** A local output is allowed while the explicitly preserved input stays read-only. */
export function preservedSourceOutputScope(text: string): { sourceText: string; outputText: string } | null {
  // i18n-allow: input recognition for a preserved source and separately requested output.
  const preserve = /(?:不修改|不要修改|不改动|不要改动|不覆盖|不要覆盖)(?:原|源)文件|(?:原|源)文件(?:不动|不变)|(?:保持|保留)(?:原|源)文件(?:原样|不变)|\b(?:do not|don't|without)\s+(?:modify|modifying|edit|editing|change|changing|overwrite|overwriting)\s+(?:the\s+)?(?:original|source)\s+file\b/iu;
  if (!preserve.test(text)) return null;
  // i18n-allow: an unscoped prohibition still forbids all file mutations.
  if (/(?:不修改|不要修改|禁止修改|不要创建|不要保存)(?:任何|所有|新)?文件|\b(?:do not|don't)\s+(?:create|save|modify)\s+(?:any|all)\s+files?\b/iu.test(text)) return null;
  // i18n-allow: only an affirmative output clause grants this narrow exception.
  const output = /(?:另存(?:为)?|导出(?:为|到)?|保存(?:为|成)(?:一份)?(?:新|副本)|\b(?:save\s+(?:a\s+copy\s+)?as|export\s+(?:to|as))\b)/iu.exec(text);
  if (!output) return null;
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
  const output = buildTaskTargetAnchorProjection({ taskText: scope.outputText }).target.path;
  const explicitSource = buildTaskTargetAnchorProjection({ taskText: scope.sourceText }).target.path;
  const inheritedSource = input.acceptedTarget?.source !== 'current_turn' ? input.acceptedTarget?.target.path : '';
  const source = explicitSource || inheritedSource || '';
  // Match each handler's actual input, including alias priority. An ignored
  // outputPath/filePath must never authorize a write through args.path.
  const targetValue = input.toolName === 'write_file'
    ? input.arguments.path || input.arguments.filePath
    : input.toolName === 'desktop_write_text_file'
      ? input.arguments.path
      : input.toolName === 'create_ppt'
        ? input.arguments.filename
        : ['create_xlsx', 'modify_xlsx'].includes(input.toolName)
          ? input.arguments.outputPath
          : undefined;
  const target = String(targetValue || '');
  const targetId = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(target) ? canonicalPathIdentity(target) : '';
  if (!targetId) return 'A separately saved artifact requires one concrete output path.';
  if (source && targetId === canonicalPathIdentity(source)) return 'The user required the original file to remain unchanged. Save the result to a different file.';
  if (output && targetId !== canonicalPathIdentity(output)) return 'The output path does not match the separately saved artifact requested in this turn.';
  if (!output && !source) return 'The source or separate output path must be resolved before saving a copy.';
  return null;
}
