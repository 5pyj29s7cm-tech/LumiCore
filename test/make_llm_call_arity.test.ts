import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

interface MakeLlmCallSite {
  file: string;
  line: number;
  argumentCount: number;
}

const SERVER_ROOT = fileURLToPath(new URL('../server/', import.meta.url));
const EXPECTED_ARGUMENT_COUNT = 15;

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(absolutePath);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];
    return [absolutePath];
  });
}

function collectMakeLlmCallSites(): MakeLlmCallSite[] {
  const sites: MakeLlmCallSite[] = [];

  for (const file of productionTypeScriptFiles(SERVER_ROOT)) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      // A call expression cannot match the makeLLMCall function declaration,
      // so this scans production invocations without counting its definition.
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'makeLLMCall'
      ) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        sites.push({
          file: path.relative(SERVER_ROOT, file).replace(/\\/g, '/'),
          line: position.line + 1,
          argumentCount: node.arguments.length,
        });
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return sites.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line,
  );
}

const productionCallSites = collectMakeLlmCallSites();

describe('production makeLLMCall provider getter contract', () => {
  it('discovers production call sites', () => {
    expect(productionCallSites.length).toBeGreaterThan(0);
  });

  it.each(productionCallSites)('$file:$line passes every provider getter', callSite => {
    expect(callSite.argumentCount).toBe(EXPECTED_ARGUMENT_COUNT);
  });
});
