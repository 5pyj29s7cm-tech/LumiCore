import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { extractMediaGenerationArtifacts } from '../src/lib/mediaGenerationArtifacts';

// Read the real history-to-gallery path; a recovery query is not a new generation.
const source = fs.readFileSync('src/components/AgentChatPage.tsx', 'utf8');
const ast = ts.createSourceFile('AgentChatPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function expression(name: string, context: Record<string, unknown>) {
  let code = '';
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) code = node.getText(ast);
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) code = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!code) throw new Error(`Production expression missing: ${name}`);
  return vm.runInNewContext(ts.transpileModule(`(${code})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
}
const generationNames = expression('MEDIA_GENERATION_TOOL_NAMES', {});
const gallery = expression('extractPersistedMediaArtifacts', {
  MEDIA_GENERATION_TOOL_NAMES: generationNames,
  parsePersistedToolRecords: expression('parsePersistedToolRecords', {}),
  extractMediaGenerationArtifacts,
});
const result = { ok: true, status: 'generated', verified: true, verificationStatus: 'verified',
  images: ['C:/synthetic-generated/recovered.png'], artifacts: [{ type: 'image', path: 'C:/synthetic-generated/recovered.png' }] };

it.each(['generate_image', 'get_image_generation_status'])('displays a verified %s artifact after history reload', name => {
  const artifacts = gallery({ requestId: 'owned-history-request', toolCalls: JSON.stringify([
    { name, arguments: name === 'generate_image' ? { prompt: 'Synthetic image' } : { recoveryId: 'synthetic-recovery' }, result: JSON.stringify(result) },
  ]) });
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0]).toMatchObject({ kind: 'image', operation: 'text_to_image', requestId: 'owned-history-request',
    path: 'C:/synthetic-generated/recovered.png', url: '/api/files/generated?path=C%3A%2Fsynthetic-generated%2Frecovered.png&inline=1' });
});

it('does not expose pending query output or treat a query as fresh generation parameters', () => {
  expect(generationNames.has('get_image_generation_status')).toBe(false);
  expect(gallery({ toolCalls: [{ name: 'get_image_generation_status', result: { ...result, ok: false, verified: false, status: 'pending' } }] })).toEqual([]);
  expect(gallery({ toolCalls: [{ name: 'unrelated_tool', result }] })).toEqual([]);
});
