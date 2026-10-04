/** Location names are operands, never instructions about Lumi's own state. */
export function withoutLocationLiterals(text: string, preserveKind = false): string {
  const mask = (value: string) => preserveKind
    ? (value.match(/\.([a-z0-9]{1,8})$/iu)?.[1] ? ` [file.${value.match(/\.([a-z0-9]{1,8})$/iu)![1]}] ` : ' [location] ')
    : ' ';
  return String(text || '')
    .replace(/https?:\/\/[^\s\u3002\uff0c\uff1b\uff01\uff1f,;!?]+/giu, ' ')
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\|(?<![\w:])\/)[^\r\n<>|*?"'\u3002\uff0c\uff1b,;]+?\.(?:xlsx?|xlsm|docx?|pptx?|pdf|csv|tsv|txt|md|json|html?|png|jpe?g|webp|mp4|wav|mp3)(?=$|[\s\u3002\uff0c\uff1b\uff01\uff1f,;.!?"'])/giu, mask)
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\|(?<![\w:])\/)[^\s<>|*?"'\u3002\uff0c\uff1b,;]+/giu, mask);
}
