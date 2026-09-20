/** Location names are operands, never instructions about Lumi's own state. */
export function withoutLocationLiterals(text: string): string {
  return String(text || '')
    .replace(/https?:\/\/[^\s\u3002\uff0c\uff1b\uff01\uff1f,;!?]+/giu, ' ')
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\|(?<![\w:])\/)[^\r\n<>|*?"'\u3002\uff0c\uff1b,;]+?\.(?:xlsx?|xlsm|docx?|pptx?|pdf|csv|tsv|txt|md|json|html?|png|jpe?g|webp|mp4|wav|mp3)(?=$|[\s\u3002\uff0c\uff1b\uff01\uff1f,;.!?"'])/giu, ' ');
}
