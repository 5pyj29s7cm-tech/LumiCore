/** Explicit offline Designer maintenance; importing this module has no side effects. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDataMergeCli } from './merge-legal-data-root';
export const runDesignerDataMergeCli = (args = process.argv.slice(2)) => runDataMergeCli('designer', args);
if (process.argv[1] && /^merge-designer-data-root\.(?:ts|mjs)$/.test(path.basename(process.argv[1])) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runDesignerDataMergeCli().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
