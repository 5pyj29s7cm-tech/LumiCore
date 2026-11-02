import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  buildDrawingIngestQa,
  buildIfcSpaceAuditPlan,
  buildRevitReadOnlyPlan,
  buildSiteSurveyReport,
  normalizeFfeSchedule,
} from './interior_delivery.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function list(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/\n|,|;|，|；/).map(s => s.trim()).filter(Boolean);
}

const server = new McpServer({ name: 'design-studio-pack', version: '3.1.0' }, { capabilities: { tools: {} } });

server.registerTool('design_brief_builder', {
  description: 'Build a practical creative/design brief from project goals, audience, channels, brand constraints, and deliverables.',
  inputSchema: {
    projectName: z.string().describe('Project or campaign name'),
    audience: z.string().describe('Target audience'),
    goals: z.union([z.string(), z.array(z.string())]).describe('Business or design goals'),
    channels: z.union([z.string(), z.array(z.string())]).optional().describe('Channels: app, web, poster, social, packaging, etc.'),
    constraints: z.string().optional().describe('Brand, legal, production, budget, or deadline constraints'),
  },
}, async (args: any) => ok({
  projectName: args.projectName,
  audience: args.audience,
  goals: list(args.goals),
  channels: list(args.channels),
  creativeProblem: `Create a design response for ${args.audience} that serves ${list(args.goals).join(', ') || 'the stated goals'}.`,
  deliverables: ['Mood direction', 'Copy tone', 'Layout system', 'Asset checklist', 'Review criteria'],
  constraints: args.constraints || '',
  nextSteps: [
    'Collect references and non-references.',
    'Choose 2-3 visual directions before producing final assets.',
    'Define typography, color, spacing, imagery, and motion rules.',
    'Prepare export specs for the actual channel.',
  ],
}));

server.registerTool('design_review_checklist', {
  description: 'Review a UI, brand, poster, landing page, or visual asset against professional design criteria.',
  inputSchema: {
    artifactType: z.string().describe('UI screen, landing page, logo, poster, deck, packaging, etc.'),
    platform: z.string().optional().describe('iOS, Android, desktop, web, print, social media, etc.'),
    concerns: z.string().optional().describe('Known concerns or review focus'),
  },
}, async (args: any) => ok({
  artifactType: args.artifactType,
  platform: args.platform || 'general',
  checklist: [
    'Message hierarchy is clear within 3 seconds.',
    'Typography scale matches the density and purpose of the surface.',
    'Spacing, alignment, and rhythm are consistent.',
    'Color contrast and states are accessible.',
    'Primary action is visually obvious and not competing with decoration.',
    'Assets are export-ready for the target platform.',
    'Brand cues are present without crowding the main task.',
  ],
  reviewFocus: args.concerns || '',
  outputFormat: ['Severity', 'Issue', 'Why it matters', 'Suggested fix'],
}));

server.registerTool('visual_direction_board', {
  description: 'Create 2-3 visual direction concepts with mood, palette, typography, image style, and generation prompts.',
  inputSchema: {
    brand: z.string().describe('Brand/product/person/venue name'),
    mood: z.string().describe('Desired mood or keywords'),
    audience: z.string().optional().describe('Target audience'),
    mustAvoid: z.string().optional().describe('Things to avoid'),
  },
}, async (args: any) => {
  const base = `${args.brand}, ${args.mood}, ${args.audience || 'general audience'}`;
  return ok({
    brand: args.brand,
    directions: [
      {
        name: 'Quiet Premium',
        palette: ['charcoal', 'warm white', 'muted gold', 'soft gray'],
        type: 'Elegant sans serif with restrained contrast',
        imagery: 'Real product or place photography, calm lighting, minimal props',
        prompt: `${base}, quiet premium editorial photography, restrained composition, natural light`,
      },
      {
        name: 'Operational Clarity',
        palette: ['ink black', 'signal blue', 'white', 'cool gray'],
        type: 'Dense functional UI typography',
        imagery: 'Screens, workflows, tables, process visuals',
        prompt: `${base}, precise interface system, clean information design, professional workflow`,
      },
      {
        name: 'Expressive Energy',
        palette: ['deep green', 'electric cyan', 'coral', 'black'],
        type: 'Confident geometric display paired with readable body text',
        imagery: 'Dynamic angles, close-up details, motion cues',
        prompt: `${base}, expressive campaign visual, energetic composition, crisp detail`,
      },
    ],
    avoid: args.mustAvoid || '',
  });
});

server.registerTool('interior_project_brief', {
  description: 'Build a practical project brief for space planning and interior design. Excludes branding, UI, facade, massing, structural calculation, and permitting design.',
  inputSchema: {
    projectName: z.string().describe('Project name'),
    projectType: z.string().describe('Residence, office, retail, restaurant, hospitality, etc.'),
    grossArea: z.string().optional().describe('Known gross or usable area with units'),
    occupants: z.string().optional().describe('Users, headcount, household, staff, or visitor profile'),
    spaces: z.union([z.string(), z.array(z.string())]).describe('Required rooms, zones, or functions'),
    priorities: z.union([z.string(), z.array(z.string())]).optional().describe('Functional and experience priorities'),
    budget: z.string().optional().describe('Budget range and what it includes'),
    constraints: z.string().optional().describe('Existing conditions, must-keeps, exclusions, deadline, and consultant constraints'),
  },
}, async (args: any) => ok({
  projectName: args.projectName,
  scope: 'space planning and interior design only',
  projectType: args.projectType,
  grossArea: args.grossArea || 'to be verified',
  occupants: args.occupants || 'to be confirmed',
  requiredSpaces: list(args.spaces),
  priorities: list(args.priorities),
  budget: args.budget || 'to be confirmed',
  existingConstraints: args.constraints || '',
  requiredInputs: [
    'Measured base plan with dimensions and level changes',
    'Photos of every wall, opening, ceiling, shaft, and service point',
    'Known structural, fire, MEP, and property-management constraints',
    'Furniture, equipment, storage, accessibility, and maintenance requirements',
  ],
  decisions: [
    'Confirm fixed versus changeable building conditions',
    'Approve area allocation and adjacency before styling',
    'Approve layout before visualization',
    'Coordinate structure, fire, and MEP before handoff',
  ],
}));

server.registerTool('space_planning_checklist', {
  description: 'Create a space-planning review checklist covering zoning, adjacency, circulation, dimensions, furniture, accessibility, and building-condition coordination.',
  inputSchema: {
    projectType: z.string().describe('Residence, office, retail, restaurant, hospitality, etc.'),
    spaces: z.union([z.string(), z.array(z.string())]).describe('Rooms, zones, or functions to plan'),
    existingConditions: z.string().optional().describe('Structure, columns, openings, heights, shafts, fire, and MEP constraints'),
    priorities: z.string().optional().describe('Known planning goals or concerns'),
  },
}, async (args: any) => ok({
  projectType: args.projectType,
  spaces: list(args.spaces),
  existingConditions: args.existingConditions || 'not supplied',
  priorities: args.priorities || '',
  checklist: [
    'Separate fixed, changeable, unknown, and consultant-confirmed conditions.',
    'Verify area allocation and adjacency against real activities and occupancy.',
    'Trace primary, secondary, service, emergency, and accessible circulation.',
    'Check door swings, clear widths, turning radii, furniture use zones, and storage access.',
    'Check daylight, ventilation, acoustic conflicts, wet-area routing, and ceiling/service zones.',
    'Record every assumption and create a survey or consultant verification item.',
  ],
  outputFormat: ['Finding', 'Evidence or assumption', 'Impact', 'Recommended action', 'Owner for verification'],
}));

server.registerTool('interior_visual_direction', {
  description: 'Create comparable interior visualization directions from an approved layout and fixed building conditions. Does not create brand, campaign, UI, facade, or massing concepts.',
  inputSchema: {
    spaceType: z.string().describe('Room or interior space type'),
    style: z.string().describe('Desired atmosphere or interior style'),
    fixedLayout: z.string().describe('Approved layout, openings, fixed furniture, and conditions that must not change'),
    materials: z.string().optional().describe('Approved or preferred material palette'),
    lighting: z.string().optional().describe('Daylight and artificial-lighting direction'),
    mustAvoid: z.string().optional().describe('Elements, changes, or visual traits to avoid'),
  },
}, async (args: any) => {
  const base = `${args.spaceType}, ${args.style}, preserve this exact spatial logic: ${args.fixedLayout}`;
  return ok({
    spaceType: args.spaceType,
    scope: 'interior visualization only',
    fixedConditions: args.fixedLayout,
    directions: [
      {
        name: 'Calm Natural',
        palette: ['warm white', 'natural wood', 'soft stone', 'muted textile'],
        lighting: args.lighting || 'soft daylight with warm layered ambient and task lighting',
        prompt: `${base}, calm natural interior, ${args.materials || 'natural wood and matte mineral finishes'}, realistic scale, soft daylight, physically plausible materials, professional interior photography`,
      },
      {
        name: 'Refined Contrast',
        palette: ['warm gray', 'charcoal accent', 'light oak', 'brushed metal'],
        lighting: args.lighting || 'controlled contrast with concealed ambient and focused task lighting',
        prompt: `${base}, refined contemporary interior, ${args.materials || 'light oak, warm gray, restrained dark accents'}, controlled contrast, realistic scale, professional interior photography`,
      },
    ],
    negativeConstraints: [
      'Do not change structure, columns, openings, ceiling height, or approved layout.',
      'Do not add impossible windows, doors, stairs, or service points.',
      'Avoid distorted furniture, circulation blockage, decorative clutter, logos, posters, UI, and facade imagery.',
      args.mustAvoid || '',
    ].filter(Boolean),
  });
});

server.registerTool('drawing_ingest_qa', {
  description: 'Check scanned plans, PDFs, and measured drawings for source quality, revision evidence, scale references, and geometry-extraction readiness.',
  inputSchema: {
    projectName: z.string().describe('Interior project name'),
    sources: z.union([z.string(), z.array(z.string())]).describe('Project-local source drawing or scan references'),
    knownDimensions: z.string().optional().describe('Independently verified dimensions with units'),
    evidenceNotes: z.string().optional().describe('Survey source, drawing title, issue date, revision, scale, and limitations'),
    intendedUse: z.string().optional().describe('The downstream design task that needs this evidence'),
  },
}, async (args: any) => ok(buildDrawingIngestQa(args)));

server.registerTool('ifc_space_audit_plan', {
  description: 'Prepare a bounded, read-only IFC review sequence for interior spaces, materials, relationships, validation, and clash evidence.',
  inputSchema: {
    modelPath: z.string().describe('IFC file path inside the Lumi project data root'),
    scope: z.string().optional().describe('Rooms, levels, disciplines, elements, or coordination scope'),
    checks: z.union([z.string(), z.array(z.string())]).optional().describe('Requested IFC checks'),
    constraints: z.string().optional().describe('Known schema, coordinate, revision, phase, or consultant constraints'),
  },
}, async (args: any) => ok(buildIfcSpaceAuditPlan(args)));

server.registerTool('revit_readonly_review_plan', {
  description: 'Prepare a safe read-only Revit query plan for interior room, view, element, material, parameter, and model-review evidence.',
  inputSchema: {
    objective: z.string().describe('The exact review question to answer from Revit'),
    targetScope: z.string().optional().describe('Active view, selected elements, room set, category, phase, link, or level'),
    activeView: z.string().optional().describe('Known active-view name and type'),
    requiredEvidence: z.union([z.string(), z.array(z.string())]).optional().describe('Evidence required in the review output'),
  },
}, async (args: any) => ok(buildRevitReadOnlyPlan(args)));

server.registerTool('ffe_schedule_normalize', {
  description: 'Normalize an FF&E, lighting, equipment, or finish schedule while preserving source records and avoiding guessed unit or price conversions.',
  inputSchema: {
    recordsJson: z.string().describe('JSON array containing source schedule rows'),
    defaultCurrency: z.string().optional().describe('Currency code to use only where a row omits one'),
  },
}, async (args: any) => ok(normalizeFfeSchedule(args)));

server.registerTool('site_survey_report', {
  description: 'Build an interior site-survey evidence register that keeps direct observations, reported information, photos, limitations, and follow-ups separate.',
  inputSchema: {
    projectName: z.string().describe('Interior project name'),
    observations: z.union([z.string(), z.array(z.string())]).describe('Directly observed or measured site facts'),
    reportedInfo: z.union([z.string(), z.array(z.string())]).optional().describe('Information reported by a client, property manager, contractor, or consultant'),
    photos: z.union([z.string(), z.array(z.string())]).optional().describe('Project-local photo references and captions'),
    limitations: z.union([z.string(), z.array(z.string())]).optional().describe('Access, visibility, measurement, or concealed-condition limitations'),
    followups: z.union([z.string(), z.array(z.string())]).optional().describe('Required remeasurements, consultant checks, or missing evidence'),
  },
}, async (args: any) => ok(buildSiteSurveyReport(args)));

const transport = new StdioServerTransport();
await server.connect(transport);
