// i18n-allow: A directory operand ends before the explicit artifact creation predicate.
const DIRECTORY_ARTIFACT_INSTRUCTION = /(^|[，,。；;！？!?\n])(\s*(?:请\s*)?(?:在|in)\s+)((?:[A-Za-z]:[\\/]|\/)[^\r\n"'<>|?*，,。；;！？!]+?)(\s+(?:创建|新建|生成|create|write)\s+)([^\s\\/:"'<>|?*]+\.(?:txt|md|csv|json|docx?|xlsx?|pptx?|pdf))(?=$|[\s，,。；;！？!?])/iu;
const DIRECTORY_ARTIFACT_INSTRUCTIONS = new RegExp(DIRECTORY_ARTIFACT_INSTRUCTION.source, 'giu');

export function directoryArtifactPath(text: string): string {
  const match = text.match(DIRECTORY_ARTIFACT_INSTRUCTION);
  if (!match) return '';
  const directory = match[3].replace(/[\\/]+$/u, '');
  return `${directory}${directory.includes('\\') ? '\\' : '/'}${match[5]}`;
}

/** Location names are operands, never instructions about Lumi's own state. */
export function withoutLocationLiterals(text: string, preserveKind = false): string {
  const mask = (value: string) => preserveKind
    ? (value.match(/\.([a-z0-9]{1,8})$/iu)?.[1] ? ` [file.${value.match(/\.([a-z0-9]{1,8})$/iu)![1]}] ` : ' [location] ')
    : ' ';
  return String(text || '')
    .replace(DIRECTORY_ARTIFACT_INSTRUCTIONS, (_match, boundary, prefix, directory, predicate, filename) =>
      boundary + prefix + mask(directory) + predicate + mask(filename))
    .replace(/[`“‘「『"']([^\\/:<>|*?"'`“”‘’「」『』\r\n，,；;。！？!]{1,160}\.(?:xlsx?|xlsm|docx?|pptx?|pdf|rtf|txt|md|csv|tsv|json|html?|wps|et|dps|png|jpe?g|webp|bmp|gif|tiff?|mp4|wav|mp3))[`”’」』"']/giu, (_match, value: string) => mask(value))
    .replace(/https?:\/\/[^\s\u3002\uff0c\uff1b\uff01\uff1f,;!?]+/giu, ' ')
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\|(?<![\w:])\/)[^\r\n<>|*?"'\u3002\uff0c\uff1b\uff01\uff1f,;!]+?\.(?:xlsx?|xlsm|docx?|pptx?|pdf|csv|tsv|txt|md|json|html?|png|jpe?g|webp|mp4|wav|mp3)(?=$|[\s\u3002\uff0c\uff1b\uff01\uff1f,;.!?"'])/giu, mask)
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\|(?<![\w:])\/)[^\s<>|*?"'\u3002\uff0c\uff1b\uff01\uff1f,;!]+/giu, mask);
}
