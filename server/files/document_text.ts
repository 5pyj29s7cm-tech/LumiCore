import fs from 'fs';
import path from 'path';

/** Read source documents through the same parsers as knowledge and document tools. */
export async function readDocumentText(filePath: string, options: { password?: unknown; blankSections?: boolean } = {}): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (['.txt', '.md', '.csv', '.json', '.log'].includes(ext)) return fs.readFileSync(filePath, 'utf-8');
  if (ext === '.rtf') return (await import('../knowledge/rtf')).extractRtfText(fs.readFileSync(filePath, 'utf-8'));
  if (ext === '.docx') return String((await (await import('mammoth')).extractRawText({ path: filePath })).value || '');
  if (ext === '.xlsx') return (await import('../utils/spreadsheet')).workbookToText(filePath, { blankSections: options.blankSections });
  if (ext === '.xls') throw new Error('Legacy .xls files are not supported. Convert the file to .xlsx or .csv first.');
  if (ext === '.pptx') return (await import('../knowledge/pptx')).extractPptxText(filePath);
  if (ext === '.pdf') return (await import('../utils/pdf_text')).extractPdfText(filePath, options.password);
  throw new Error('Unsupported file type: ' + (ext || '(none)'));
}

/** Bounded traversal skips hidden entries and never follows directory symlinks. */
export function walkSourceFiles(root: string, maxFiles: number, ignoredDirectories: ReadonlySet<string>): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) visit(full);
      } else if (entry.isFile()) files.push(full);
    }
  };
  visit(root);
  return files;
}
