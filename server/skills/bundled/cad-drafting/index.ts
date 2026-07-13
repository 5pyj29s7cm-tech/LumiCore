import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runRenovationFolderWorkflow } from './renovation_workflow';
import { runAutocadComPlayback } from './autocad_control';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: 'cad-drafting', version: '1.6.1' }, { capabilities: { tools: {} } });

server.registerTool('cad_space_program', {
  description: 'Create a room/space program with estimated areas, adjacency notes, and drafting assumptions.',
  inputSchema: {
    projectName: z.string().describe('Project name'),
    totalArea: z.number().optional().describe('Total area in square meters'),
    rooms: z.array(z.string()).describe('Room names or functional zones'),
    constraints: z.string().optional().describe('Site, budget, structure, daylight, circulation, or client constraints'),
  },
}, async (args: any) => {
  const rooms = Array.isArray(args.rooms) ? args.rooms.map(String).filter(Boolean) : [];
  const total = Number(args.totalArea || rooms.length * 12 || 60);
  const base = Math.max(total / Math.max(rooms.length, 1), 4);
  return ok({
    projectName: args.projectName,
    totalArea: total,
    rooms: rooms.map((name: string, index: number) => ({
      name,
      estimatedArea: Math.round(base * (index === 0 ? 1.3 : 1) * 10) / 10,
      adjacency: index === 0 ? 'Primary circulation anchor' : `Near ${rooms[Math.max(0, index - 1)] || 'entry'}`,
    })),
    constraints: args.constraints || '',
    draftingAssumptions: ['Rectangular starter layout', 'Dimensions are conceptual', 'Verify walls, columns, MEP, and code constraints before production'],
  });
});

server.registerTool('cad_drafting_checklist', {
  description: 'Produce a CAD drawing QA checklist for plans, elevations, sections, furniture layouts, or construction documents.',
  inputSchema: {
    drawingType: z.string().describe('Plan, elevation, section, layout, construction drawing, etc.'),
    stage: z.string().optional().describe('Concept, schematic, design development, construction, as-built'),
  },
}, async (args: any) => ok({
  drawingType: args.drawingType,
  stage: args.stage || 'concept',
  checklist: [
    'Title block, scale, north arrow, revision, and drawing number are present.',
    'Key dimensions and levels are readable and non-conflicting.',
    'Rooms, doors, windows, fixed furniture, and circulation are labeled.',
    'Line weights distinguish walls, openings, furniture, annotations, and reference elements.',
    'Layer names and units are consistent.',
    'Code, structure, MEP, and site constraints are flagged for professional review.',
  ],
}));

server.registerTool('autocad_playback_file', {
  description: 'Control real Windows AutoCAD through COM and visibly create each source-verified entity one at a time. The operation-set identity, progress state, and entity delta are verified. Interrupted runs resume the same document or stop instead of replaying duplicates. A completion marker is written only after every expected entity exists.',
  inputSchema: {
    operationsPath: z.string().describe('Path to the operations JSON produced by cad_prepare_autocad_operations.'),
    completionMarkerPath: z.string().describe('Marker file written only after every AutoCAD operation completes.'),
    strokeDelayMs: z.number().int().min(100).max(5000).optional().describe('Visible delay after every drawing operation. Defaults to 450ms.'),
    createNewDocument: z.boolean().optional().describe('Open a separate blank AutoCAD document before playback. Defaults true to avoid modifying an existing drawing.'),
    savePath: z.string().optional().describe('Optional DWG path to save after playback. Omit to leave the drawing open for review without saving.'),
  },
}, async (args: any) => ok(await runAutocadComPlayback({
  operationsPath: String(args.operationsPath || ''),
  completionMarkerPath: String(args.completionMarkerPath || ''),
  strokeDelayMs: args.strokeDelayMs,
  createNewDocument: args.createNewDocument !== false,
  savePath: args.savePath ? String(args.savePath) : undefined,
})));

server.registerTool('cad_renovation_folder_workflow', {
  description: 'Inventory a local renovation/floor-plan folder, extract readable source facts, identify likely reference drawings, and prepare the verified next-tool plan. This scan never generates CAD, BIM, renders, budgets, material schedules, or a client delivery package. Continue with floorplan_extract_geometry and the requested real output tools.',
  inputSchema: {
    folderPath: z.string().describe('Local folder containing sketches, floor-plan images, measurements, notes, PDFs, Office files, or renovation requirements'),
    projectName: z.string().optional().describe('Project name used in generated documents and CAD titles'),
    stylePreference: z.string().optional().describe('Preferred interior style, if known'),
    knownDimensions: z.string().optional().describe('Known overall dimensions or calibration dimensions, for example 9000mm x 7600mm'),
    budget: z.string().optional().describe('Known budget range'),
    outputDir: z.string().optional().describe('Optional output directory. Defaults to a LumiCAD renovation folder inside folderPath.'),
    writeFiles: z.boolean().optional().describe('Writes source-inventory and execution-plan Markdown files by default. Set false for an in-memory preview.'),
    maxFiles: z.number().int().min(1).max(400).optional().describe('Maximum number of files to scan recursively'),
    maxChars: z.number().int().min(10000).max(900000).optional().describe('Maximum extracted text characters to include in analysis'),
  },
}, async (args: any) => ok(await runRenovationFolderWorkflow(args)));

const transport = new StdioServerTransport();
await server.connect(transport);
