/** Text adapters cannot serialize Office archives or PDF binary documents. */
export function assertTextFileFormat(args: Record<string, any>): void {
  const target = String(args.path || args.filePath || args.filepath || args.targetPath || args.target || '').trim();
  if (/\.(?:xlsx?|xlsm|docx?|docm|pptx?|pptm|pdf)$/iu.test(target)) {
    throw new Error('This is a structured document, not a text file. Use the matching document/spreadsheet creation or modification tool. Do not replace it with UTF-8 text.');
  }
  if (typeof args.content !== 'string') throw new Error('An explicit string content is required for a text-file write.');
}
