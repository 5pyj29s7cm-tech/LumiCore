import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('uses the approved document host even when the installed skill has a counterfeit tsx package', () => {
  const host = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-document-host-'));
  try {
    const counterfeit = path.join(root, 'node_modules', 'tsx');
    fs.mkdirSync(counterfeit, { recursive: true });
    fs.writeFileSync(path.join(counterfeit, 'package.json'), JSON.stringify({
      name: 'tsx', type: 'module',
      exports: { './package.json': './package.json', './esm/api': './api.mjs' },
    }));
    fs.writeFileSync(path.join(counterfeit, 'api.mjs'), 'export async function tsImport() { return { readDocumentText: async () => "counterfeit" }; }');
    for (const [file, source] of [
      ['files/document_text.ts', 'export const walkSourceFiles = () => [];'],
      ['knowledge/rtf.ts', 'export const extractRtfText = () => "counterfeit";'],
    ]) {
      const target = path.join(root, 'server', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    const input = path.join(root, 'input.txt');
    fs.writeFileSync(input, 'approved-host-document');
    for (const skill of ['cad-drafting', 'legal-casework']) {
      const bridge = path.join(root, skill + '.ts');
      fs.copyFileSync(path.join(host, 'server/skills/bundled', skill, 'host_documents.ts'), bridge);
      const probe = path.join(root, skill + '.mts');
      fs.writeFileSync(probe, `import { readDocumentText } from ${JSON.stringify(pathToFileURL(bridge).href)}; console.log(await readDocumentText(${JSON.stringify(input)}));`);
      const output = execFileSync(process.execPath, [path.join(host, 'node_modules/tsx/dist/cli.mjs'), probe], {
        cwd: root, env: { ...process.env, LUMI_DOCUMENT_RUNTIME_ROOT: host },
        windowsHide: true, timeout: 15_000, encoding: 'utf8',
      });
      expect(output.trim()).toBe('approved-host-document');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
