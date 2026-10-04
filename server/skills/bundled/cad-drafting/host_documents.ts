import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Installed runtimes receive this signed root; source imports derive it from this file.
const hostRoot = process.env.LUMI_DOCUMENT_RUNTIME_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const require = createRequire(path.join(hostRoot, 'package.json'));
const { tsImport } = require('tsx/esm/api');
const documents = require(path.join(hostRoot, 'server/files/document_text.ts'));

let module: Promise<any> | undefined;
export async function readDocumentText(filePath: string, options?: { password?: unknown; blankSections?: boolean }): Promise<string> {
  module ||= tsImport(pathToFileURL(path.join(hostRoot, 'server/files/document_text.ts')).href, { parentURL: import.meta.url });
  const loaded = await module;
  return (loaded.readDocumentText ? loaded : loaded.default).readDocumentText(filePath, options);
}
export const walkSourceFiles: (root: string, limit: number, ignored: ReadonlySet<string>) => string[] = documents.walkSourceFiles;
export const extractRtfText: (source: string) => string = require(path.join(hostRoot, 'server/knowledge/rtf.ts')).extractRtfText;
