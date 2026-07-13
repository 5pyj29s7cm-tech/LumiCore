import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runRenovationFolderWorkflow } from './renovation_workflow';
import { runAutocadComPlayback } from './autocad_control';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function safeName(value: string): string {
  return (value || 'lumi_cad_draft').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 80) || 'lumi_cad_draft';
}

function line(x1: number, y1: number, x2: number, y2: number): string {
  return `0\nLINE\n8\nLUMI_WALLS\n10\n${x1}\n20\n${y1}\n30\n0\n11\n${x2}\n21\n${y2}\n31\n0\n`;
}

function text(x: number, y: number, value: string, height = 220): string {
  return `0\nTEXT\n8\nLUMI_LABELS\n10\n${x}\n20\n${y}\n30\n0\n40\n${height}\n1\n${value.replace(/\n/g, ' ')}\n`;
}

function rect(x: number, y: number, w: number, h: number): string {
  return line(x, y, x + w, y) + line(x + w, y, x + w, y + h) + line(x + w, y + h, x, y + h) + line(x, y + h, x, y);
}

const server = new McpServer({ name: 'cad-drafting', version: '1.3.1' }, { capabilities: { tools: {} } });

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

server.registerTool('cad_generate_simple_dxf', {
  description: 'Generate a simple editable DXF draft with an outer rectangle and labeled room blocks. Saves the DXF to the Desktop/LumiCAD folder by default.',
  inputSchema: {
    title: z.string().describe('Drawing title and output filename'),
    widthMm: z.number().describe('Outer width in millimeters'),
    heightMm: z.number().describe('Outer height in millimeters'),
    rooms: z.array(z.string()).optional().describe('Room labels to place as conceptual blocks'),
    outputDirectory: z.string().optional().describe('Optional output directory'),
  },
}, async (args: any) => {
  const width = Math.max(Number(args.widthMm || 0), 1000);
  const height = Math.max(Number(args.heightMm || 0), 1000);
  const rooms = Array.isArray(args.rooms) ? args.rooms.map(String).filter(Boolean) : [];
  const dir = String(args.outputDirectory || path.join(os.homedir(), 'Desktop', 'LumiCAD'));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${safeName(String(args.title || 'lumi_cad_draft'))}.dxf`);
  let entities = rect(0, 0, width, height);
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(rooms.length, 1))));
  const rows = Math.max(1, Math.ceil(Math.max(rooms.length, 1) / cols));
  const cellW = width / cols;
  const cellH = height / rows;
  rooms.forEach((room: string, index: number) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = col * cellW;
    const y = row * cellH;
    entities += rect(Math.round(x), Math.round(y), Math.round(cellW), Math.round(cellH));
    entities += text(Math.round(x + cellW * 0.12), Math.round(y + cellH * 0.5), room, Math.max(160, Math.min(cellW, cellH) * 0.08));
  });
  entities += text(0, height + 500, `${args.title || 'Lumi CAD Draft'} - conceptual draft, verify before production`, 220);
  const dxf = `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
  fs.writeFileSync(filePath, dxf, 'utf-8');
  return ok({ path: filePath, widthMm: width, heightMm: height, roomCount: rooms.length, note: 'Editable DXF draft generated. Review dimensions and construction details before use.' });
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
  description: 'Control the real Windows AutoCAD application through its COM automation API and visibly create each validated line, circle, arc, or text operation one at a time. Reads a Lumi-generated operations JSON file, opens a separate drawing by default, refreshes AutoCAD after every operation, waits between strokes, and writes a completion marker only after the visible playback finishes. This is Lumi MCP automation for AutoCAD, not an Autodesk-official MCP server.',
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
  description: 'Read a local renovation/floor-plan folder and generate editable DXF drafting bases, a layout draft, MEP point suggestions, proposal notes, material data, and design-delivery handoff content. Pair with the client design_delivery_workflow when Lumi should also create a customer-facing PPT/PDF package, open CAD/Revit handoff files, and prepare WeChat delivery drafts.',
  inputSchema: {
    folderPath: z.string().describe('Local folder containing sketches, floor-plan images, measurements, notes, PDFs, Office files, or renovation requirements'),
    projectName: z.string().optional().describe('Project name used in generated documents and CAD titles'),
    stylePreference: z.string().optional().describe('Preferred interior style, if known'),
    knownDimensions: z.string().optional().describe('Known overall dimensions or calibration dimensions, for example 9000mm x 7600mm'),
    budget: z.string().optional().describe('Known budget range'),
    outputDir: z.string().optional().describe('Optional output directory. Defaults to a LumiCAD renovation folder inside folderPath.'),
    writeFiles: z.boolean().optional().describe('Writes markdown, CSV, DXF, and SVG files by default. Set false only for preview-only analysis.'),
    maxFiles: z.number().int().min(1).max(400).optional().describe('Maximum number of files to scan recursively'),
    maxChars: z.number().int().min(10000).max(900000).optional().describe('Maximum extracted text characters to include in analysis'),
  },
}, async (args: any) => ok(await runRenovationFolderWorkflow(args)));

const transport = new StdioServerTransport();
await server.connect(transport);
