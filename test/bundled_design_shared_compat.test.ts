import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getIndustryWorkflowContracts } from '../server/industry/workflow_contracts';
import { buildAutocadComPlaybackScript, readAutocadOperationPayload } from '../server/skills/bundled/cad-drafting/autocad_control';

const captured = vi.hoisted(() => ({ tools: new Map<string, { schema: Record<string, any>; handler: (args: any) => Promise<any> }>(), identity: {} as { name?: string; version?: string }, connect: vi.fn(), spawn: vi.fn(() => { throw new Error('A pure bundle test must never spawn a process'); }) }));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: class {
  constructor(identity: { name: string; version: string }) { captured.identity = identity; }
  registerTool(name: string, options: { inputSchema: Record<string, any> }, handler: (args: any) => Promise<any>) { if (captured.tools.has(name)) throw new Error('Duplicate tool'); captured.tools.set(name, { schema: options.inputSchema, handler }); }
  connect = captured.connect;
} }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawn: captured.spawn,
  exec: captured.spawn,
  execFile: captured.spawn,
  execSync: captured.spawn,
  execFileSync: captured.spawn,
  spawnSync: captured.spawn,
  fork: captured.spawn,
}));
beforeAll(async () => { await import('../server/skills/bundled/design-studio-pack/index'); });
const root = path.join(process.cwd(), 'server/skills/bundled');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-design-bundle-'));
afterAll(() => { expect(captured.spawn).not.toHaveBeenCalled(); fs.rmSync(temporary, { recursive: true, force: true }); });
async function call(name: string, args: Record<string, unknown>) {
  const tool = captured.tools.get(name); expect(tool, name).toBeDefined();
  const input = z.object(tool!.schema).parse(args);
  return JSON.parse((await tool!.handler(input)).content[0].text);
}

describe('shared design bundle preserves old tools and interior stages', () => {
  it('registers eleven unique pure tools under the existing MCP identity and manifest', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'design-studio-pack/package.json'), 'utf8'));
    expect(captured.identity).toEqual({ name: 'design-studio-pack', version: '3.1.0' });
    expect(pkg.version).toBe('3.1.0'); expect(pkg.lumi.toolCount).toBe(11); expect(captured.tools.size).toBe(11);
    expect(pkg.lumi.capabilityDefault.sideEffects).toEqual([]);
    expect(captured.connect).toHaveBeenCalledTimes(1); // Mock only: no transport/child runtime was opened.
  });
  it('keeps the original creative brief schema and result', async () => {
    const result = await call('design_brief_builder', { projectName: 'Fixture', audience: 'Readers', goals: ['Clarity'], channels: 'web;print', constraints: 'Keep supplied facts' });
    expect(result).toMatchObject({ projectName: 'Fixture', audience: 'Readers', goals: ['Clarity'], channels: ['web', 'print'], constraints: 'Keep supplied facts' });
    expect(result.deliverables).toEqual(['Mood direction', 'Copy tone', 'Layout system', 'Asset checklist', 'Review criteria']);
  });
  it('keeps the original review checklist and output format', async () => {
    const result = await call('design_review_checklist', { artifactType: 'UI screen', platform: 'web', concerns: 'Contrast' });
    expect(result).toMatchObject({ artifactType: 'UI screen', platform: 'web', reviewFocus: 'Contrast', outputFormat: ['Severity', 'Issue', 'Why it matters', 'Suggested fix'] });
    expect(result.checklist).toHaveLength(7);
  });
  it('keeps all three original visual directions without claiming generated images', async () => {
    const result = await call('visual_direction_board', { brand: 'Fixture', mood: 'calm', mustAvoid: 'logos' });
    expect(result.directions.map((entry: { name: string }) => entry.name)).toEqual(['Quiet Premium', 'Operational Clarity', 'Expressive Energy']);
    expect(result.avoid).toBe('logos'); expect(result).not.toHaveProperty('filePath');
  });
  it('preserves project and layout analysis inputs, missing measurements and review obligations', async () => {
    const brief = await call('interior_project_brief', { projectName: 'Room', projectType: 'residence', spaces: 'Living room;Kitchen' });
    const layout = await call('space_planning_checklist', { projectType: 'residence', spaces: ['Kitchen'] });
    expect(brief.requiredSpaces).toEqual(['Living room', 'Kitchen']); expect(brief.grossArea).toBe('to be verified');
    expect(layout.spaces).toEqual(['Kitchen']); expect(layout.checklist).toHaveLength(6);
  });
  it('preserves visualization fixed conditions and missing drawing-evidence rejection', async () => {
    const visual = await call('interior_visual_direction', { spaceType: 'Kitchen', style: 'calm', fixedLayout: 'Keep wall A', mustAvoid: 'extra doors' });
    expect(visual.fixedConditions).toBe('Keep wall A'); expect(visual.negativeConstraints).toContain('extra doors');
    const qa = await call('drawing_ingest_qa', { projectName: 'Room', sources: ['scan.pdf'] });
    expect(qa.status).toBe('needs_review'); expect(qa.evidenceGaps.length).toBeGreaterThan(0);
  });
  it('keeps IFC/Revit as read-only plans rather than executing connectors', async () => {
    const ifc = await call('ifc_space_audit_plan', { modelPath: 'fixture.ifc' });
    const revit = await call('revit_readonly_review_plan', { objective: 'Review finishes' });
    expect(ifc.prohibitedOperations).toContain('ifc_save'); expect(revit.blockedOperations).toContain('revit_send_code_to_revit'); expect(revit.mode).toBe('read-only');
  });
  it('preserves original FF&E rows and separates observed/reported site evidence', async () => {
    const ffe = await call('ffe_schedule_normalize', { recordsJson: JSON.stringify([{ code: 'C1', name: 'Chair', custom: 'original' }]) });
    expect(ffe.records[0].sourceRecord.custom).toBe('original');
    const site = await call('site_survey_report', { projectName: 'Room', observations: ['Measured wall'], reportedInfo: ['Reported ceiling'] });
    expect(site.directObservations).toEqual(['Measured wall']); expect(site.reportedButNotObserved).toEqual(['Reported ceiling']);
  });
  it('provides every bundled design tool required by the current five-stage contracts', () => {
    const prefix = 'mcp_design-studio-pack_';
    const required = getIndustryWorkflowContracts('design').flatMap(contract => contract.requiredToolReceipts || []).filter(name => name.startsWith(prefix));
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) expect(captured.tools.has(name.slice(prefix.length)), name).toBe(true);
  });
});

describe('bundled CAD compatibility is pure and receipt bounded', () => {
  function payload(version = 3, start = 270, end = 0) {
    const operations = [{ kind: 'arc', layer: 'DOOR_SWING', cx: 0, cy: 0, r: 900, start, end }];
    const geometryHash = crypto.createHash('sha256').update('synthetic verified geometry').digest('hex');
    const operationSetId = crypto.createHash('sha256').update(JSON.stringify({ geometryHash, operations })).digest('hex');
    const file = path.join(temporary, crypto.randomUUID() + '.json');
    fs.writeFileSync(file, JSON.stringify({ version, geometryHash, operationSetId, geometryVerified: true, geometryVerificationRequired: false, expectedEntityCount: 1, operations }));
    return file;
  }
  it('keeps the five CAD names and aligns manifest/runtime at 1.7.2', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'cad-drafting/package.json'), 'utf8'));
    const source = fs.readFileSync(path.join(root, 'cad-drafting/index.ts'), 'utf8');
    expect(pkg.version).toBe('1.7.2'); expect(pkg.lumi.toolCount).toBe(5); expect(source).toContain("version: '1.7.2'");
    expect([...source.matchAll(/registerTool\('([^']+)'/g)].map(match => match[1])).toEqual(['cad_space_program', 'cad_drafting_checklist', 'autocad_playback_file', 'autocad_new_document', 'cad_renovation_folder_workflow']);
  });
  it('embeds the already validated v3 operations and does not reread a mutable source while drawing', () => {
    const file = payload(), verified = readAutocadOperationPayload(file);
    fs.writeFileSync(file, '{"operations":["untrusted later change"]}');
    const script = buildAutocadComPlaybackScript(verified, { operationsPath: file, completionMarkerPath: path.join(temporary, 'marker.json') });
    expect(script).toContain(Buffer.from(JSON.stringify(verified.operations)).toString('base64'));
    expect(script).not.toContain('$payload = Get-Content'); expect(script).not.toContain('$swap = $start');
  });
  it.each([[2, 270, 0], [3, -1, 90], [3, 0, 360], [3, 90, 90]])('rejects unsupported version/arc (%s,%s,%s) before process launch', (version, start, end) => {
    expect(() => readAutocadOperationPayload(payload(version, start, end))).toThrow();
  });
});
