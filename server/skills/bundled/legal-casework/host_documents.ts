import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';
import { tsImport } from 'tsx/esm/api';

const require = createRequire(import.meta.url);
// The manager binds these exact host files alongside the trusted tsx runtime.
const hostRoot = path.resolve(path.dirname(require.resolve('tsx/package.json')), '../..');
const documents = require(path.join(hostRoot, 'server/files/document_text.ts'));

let module: Promise<any> | undefined;
export async function readDocumentText(filePath: string, options?: { password?: unknown; blankSections?: boolean }): Promise<string> {
  module ||= tsImport(pathToFileURL(path.join(hostRoot, 'server/files/document_text.ts')).href, { parentURL: import.meta.url });
  const loaded = await module;
  return (loaded.readDocumentText ? loaded : loaded.default).readDocumentText(filePath, options);
}
export const walkSourceFiles: (root: string, limit: number, ignored: ReadonlySet<string>) => string[] = documents.walkSourceFiles;
export const extractRtfText: (source: string) => string = require(path.join(hostRoot, 'server/knowledge/rtf.ts')).extractRtfText;
