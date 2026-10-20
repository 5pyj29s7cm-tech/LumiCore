import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { CASE_ARCHIVE_FIELDS, defineLegalTool } from '../server/regions/packs/cn/legal_tools/tool_contracts';
import type { ToolRegistry } from '../server/tools/registry';
import type { ToolDefinition } from '../server/tools/types';

const archiveKeys = ['caseId', 'caseName', 'caseType', 'persistCase', 'orgId', 'userId'];
function publicContract(definitions: ToolDefinition[]) {
  const rows = JSON.parse(JSON.stringify(definitions));
  for (const tool of rows) {
    if (archiveKeys.every(key => tool.parameters.properties[key])) {
      // The shared archive fields deliberately use one consistent explanation.
      // Their types, requiredness, rights and all other tool metadata stay fixed.
      for (const key of archiveKeys) delete tool.parameters.properties[key].description;
    }
  }
  return rows;
}

describe('legal registration public contract', () => {
  it('preserves ordered tool identities, schemas, rights and capability evidence from the original registry', () => {
    const definitions: ToolDefinition[] = [];
    registerLegalTools({ register: (definition: ToolDefinition) => { definitions.push(definition); return true; } } as unknown as ToolRegistry);
    const expected = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test/fixtures/legal_registration_contract.json'), 'utf8'));

    // Reviewed optional time inputs extend the original schema without changing its rights or required fields.
    const temporalTools = new Set(["legal_verify_citation","legal_generate_citation_verification_report","legal_finalize_delivery_package","legal_case_reasoning_matrix","legal_case_workspace","legal_case_workflow_status","legal_message_intake_to_case"]);
    for (const tool of definitions.filter(tool => temporalTools.has(tool.name))) {
      const prior = expected.find((row: ToolDefinition) => row.name === tool.name);
      for (const key of ['factDate', 'procedureDate', 'temporalReviews']) {
        expect(tool.parameters.required || []).not.toContain(key);
        expect(prior.parameters.properties).not.toHaveProperty(key);
      }
      expect(tool.parameters.properties).toMatchObject({ factDate: { type: 'string' }, procedureDate: { type: 'string' }, temporalReviews: { type: 'array' } });
    }
    const comparable = JSON.parse(JSON.stringify(definitions));
    for (const tool of comparable.filter((row: ToolDefinition) => temporalTools.has(row.name))) {
      for (const key of ['factDate', 'procedureDate', 'temporalReviews']) delete tool.parameters.properties[key];
    }
    const quoteTool = comparable.find((row: ToolDefinition) => row.name === 'legal_verify_citation');
    expect(quoteTool.parameters.required || []).not.toContain('quotedText');
    expect(quoteTool.parameters.properties.quotedText).toMatchObject({ type: 'string' });
    delete quoteTool.parameters.properties.quotedText;
    expect(publicContract(comparable)).toEqual(publicContract(expected));
    expect(new Set(definitions.map(tool => tool.name)).size).toBe(32);
    const archiveTools = definitions.filter(tool => archiveKeys.every(key => tool.parameters.properties[key]));
    expect(archiveTools).toHaveLength(16);
    for (const tool of archiveTools) {
      for (const key of archiveKeys) expect(tool.parameters.properties[key]).toEqual(CASE_ARCHIVE_FIELDS[key]);
    }
  });

  it('rejects a cancelled attempt before calling the legal handler', async () => {
    const controller = new AbortController();
    const handler = vi.fn(async () => 'receipt');
    const tool = defineLegalTool({ name: 'test', description: 'test', properties: {}, handler });
    controller.abort();
    await expect(tool.handler({}, { executionSignal: controller.signal } as any)).rejects.toMatchObject({ name: 'AbortError' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a late result after cancellation while retaining the original attempt signal', async () => {
    const controller = new AbortController();
    let resolve!: (value: string) => void;
    const gate = new Promise<string>(done => { resolve = done; });
    const tool = defineLegalTool({ name: 'test', description: 'test', properties: {}, handler: () => gate });
    const attempt = tool.handler({}, { executionSignal: controller.signal } as any);
    controller.abort(); resolve('late receipt');
    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('isolates mutable schema projections while keeping an authorized handler result unchanged', async () => {
    const properties = { nested: { type: 'object', properties: { value: { type: 'string' } } } };
    const tool = defineLegalTool({ name: 'test', description: 'test', properties, handler: async () => 'receipt' });
    properties.nested.properties.value.type = 'number';
    expect(tool.parameters.properties.nested.properties.value.type).toBe('string');
    await expect(tool.handler({})).resolves.toBe('receipt');
  });
});
