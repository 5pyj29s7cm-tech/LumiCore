import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

interface RepoCandidate {
  fullName: string;
  url: string;
  description: string;
  stars: number;
  forks: number;
  language: string;
  license: string;
  updatedAt: string;
  topics: string[];
  readmeExcerpt?: string;
}

const AEC_SEED_REPOS = [
  'IfcOpenShell/IfcOpenShell',
  'ThatOpen/engine_web-ifc',
  'xBimTeam/XbimEssentials',
  'mcp-servers-for-revit/mcp-servers-for-revit',
  'oakplank/RevitMCP',
  'autodesk-platform-services/aps-sample-revit-mcp-tools-bundle',
  'Sam-AEC/aec-model-bridge',
];

function githubHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'LumiCore-Capability-Research',
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { headers: githubHeaders(), signal: controller.signal });
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function decodeBase64(value: string): string {
  return Buffer.from(String(value || '').replace(/\s/g, ''), 'base64').toString('utf-8');
}

async function fetchRepo(fullName: string): Promise<RepoCandidate | null> {
  const clean = String(fullName || '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(clean)) return null;
  try {
    const repo = await fetchJson(`https://api.github.com/repos/${clean}`);
    let readmeExcerpt = '';
    try {
      const readme = await fetchJson(`https://api.github.com/repos/${clean}/readme`);
      if (readme?.content) readmeExcerpt = decodeBase64(readme.content).slice(0, 2400);
    } catch {}
    return {
      fullName: repo.full_name || clean,
      url: repo.html_url || `https://github.com/${clean}`,
      description: repo.description || '',
      stars: Number(repo.stargazers_count || 0),
      forks: Number(repo.forks_count || 0),
      language: repo.language || '',
      license: repo.license?.spdx_id || '',
      updatedAt: repo.updated_at || '',
      topics: Array.isArray(repo.topics) ? repo.topics : [],
      readmeExcerpt,
    };
  } catch {
    return null;
  }
}

async function searchRepos(query: string, limit: number): Promise<string[]> {
  const q = encodeURIComponent(query);
  const data = await fetchJson(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${Math.min(Math.max(limit, 1), 10)}`);
  return (data.items || [])
    .map((item: any) => String(item.full_name || ''))
    .filter(Boolean);
}

function daysSince(dateText: string): number {
  const time = Date.parse(dateText || '');
  if (!Number.isFinite(time)) return 9999;
  return Math.max(0, Math.round((Date.now() - time) / 86400000));
}

function scoreCandidate(repo: RepoCandidate, _goal: string): { score: number; fit: string[]; risks: string[]; integration: string } {
  const haystack = [
    repo.fullName,
    repo.description,
    repo.language,
    repo.license,
    repo.topics.join(' '),
    repo.readmeExcerpt || '',
  ].join('\n').toLowerCase();
  let score = 0;
  const fit: string[] = [];
  const risks: string[] = [];

  if (/ifc|building information|openbim|bim/.test(haystack)) {
    score += 24;
    fit.push('IFC/BIM data model fit');
  }
  if (/revit|pyrevit|autodesk/.test(haystack)) {
    score += 24;
    fit.push('Revit workflow fit');
  }
  if (/mcp|model context protocol/.test(haystack)) {
    score += 22;
    fit.push('MCP-compatible or MCP-inspired integration');
  }
  if (/dynamo|api|plugin|add-in|addin|websocket/.test(haystack)) {
    score += 12;
    fit.push('Automation/plugin execution path');
  }
  if (/typescript|javascript|node/.test(haystack)) {
    score += 8;
    fit.push('Close to Lumi Node/TypeScript runtime');
  }
  if (/python/.test(haystack)) {
    score += 6;
    fit.push('Python automation/runtime available');
  }
  if (repo.stars >= 1000) score += 12;
  else if (repo.stars >= 100) score += 8;
  else if (repo.stars >= 20) score += 4;
  const age = daysSince(repo.updatedAt);
  if (age <= 30) score += 8;
  else if (age <= 180) score += 4;
  else risks.push('Repository may be stale');

  if (!repo.license || repo.license === 'NOASSERTION') {
    score -= 3;
    risks.push('License needs manual review');
  }
  if (/^GPL/i.test(repo.license)) {
    score -= 10;
    risks.push('GPL license may not fit core bundling; prefer optional integration or architecture reference');
  } else if (/LGPL/i.test(repo.license)) {
    score -= 3;
    risks.push('LGPL license is usually workable as an optional/dynamic runtime, but should not be blindly bundled into proprietary core code');
  }
  if (/revit/.test(haystack) && !/plugin|add-in|addin|pyrevit|mcp|websocket|api/.test(haystack)) {
    risks.push('Revit control path is unclear');
  }

  let integration = 'Reference only';
  if (/ifcopenshell/i.test(repo.fullName)) integration = 'Best for optional Python IFC generator/runtime';
  else if (/web-ifc/i.test(repo.fullName)) integration = 'Best for Node/TypeScript IFC validation, preview, and light write/read';
  else if (/xbim/i.test(repo.fullName)) integration = 'Best for .NET IFC workflows if Lumi adds a Windows/.NET helper';
  else if (/revit.*mcp|mcp.*revit/i.test(repo.fullName) || (/revit/.test(haystack) && /mcp/.test(haystack))) integration = 'Best for optional Revit MCP adapter with user-installed Revit add-in';
  else if (/aec-model-bridge/i.test(repo.fullName)) integration = 'Architecture reference; license requires care';
  else if (/autodesk-platform-services/i.test(repo.fullName)) integration = 'Cloud Revit automation reference, not local-first default';

  return { score: Math.max(0, Math.min(score, 100)), fit, risks, integration };
}

function buildPlan(goal: string, candidates: Array<RepoCandidate & ReturnType<typeof scoreCandidate>>): string[] {
  const goalText = goal.toLowerCase();
  const hasIfc = candidates.some(c => /ifc/i.test(c.fullName + c.description));
  const hasRevitMcp = candidates.some(c => /revit/i.test(c.fullName + c.description) && /mcp/i.test(c.fullName + c.description + c.readmeExcerpt));
  const plan = [
    'Keep Lumi local-first: extract geometry from images/files into Lumi structured building data first.',
    hasIfc
      ? 'Add an IFC export/import validation layer using a mature IFC library, preferably IfcOpenShell first and web-ifc for Node-side validation later.'
      : 'Search for a mature IFC writer before attempting direct RVT output.',
    'Generate DXF, IFC, and Dynamo/pyRevit scripts from the same structured building data so CAD/BIM outputs stay consistent.',
  ];
  if (hasRevitMcp) {
    plan.push('Treat Revit control as an optional adapter: user installs a Revit add-in/MCP bridge, Lumi connects to it, then runs explicit create/update/check commands.');
  } else {
    plan.push('Do not rely on mouse/keyboard drawing in Revit as the primary path; use scripts or a Revit API bridge first.');
  }
  plan.push('Before installing third-party code, show repo, license, runtime requirements, and a rollback plan for user confirmation.');
  if (/cad|revit|bim|ifc|dynamo/i.test(goalText)) {
    plan.push('For production accuracy, require at least one confirmed scale/dimension before claiming precise CAD/BIM output.');
  }
  return plan;
}

async function capabilityResearchHandler(args: Record<string, any>): Promise<string> {
  const goal = String(args.goal || args.query || 'Find reusable CAD/Revit/IFC integrations for Lumi').trim();
  const domain = String(args.domain || 'aec_bim_cad').trim();
  const limit = Math.min(Math.max(Number(args.limit) || 8, 3), 12);
  const repos = new Set<string>();

  if (Array.isArray(args.repositories)) {
    for (const repo of args.repositories) repos.add(String(repo));
  }

  if (domain === 'aec_bim_cad' || /cad|revit|bim|ifc|dynamo|autocad/i.test(goal)) {
    for (const repo of AEC_SEED_REPOS) repos.add(repo);
  }

  if (args.search !== false) {
    const queries = [
      goal,
      /revit|bim|ifc|cad/i.test(goal) ? 'Revit MCP IFC CAD GitHub' : `${goal} MCP GitHub`,
    ];
    for (const query of queries) {
      try {
        const found = await searchRepos(query, 5);
        for (const repo of found) repos.add(repo);
      } catch {}
    }
  }

  const candidates: Array<RepoCandidate & ReturnType<typeof scoreCandidate>> = [];
  for (const repo of Array.from(repos).slice(0, limit + 8)) {
    const candidate = await fetchRepo(repo);
    if (!candidate) continue;
    const evaluation = scoreCandidate(candidate, goal);
    candidates.push({ ...candidate, ...evaluation });
  }

  candidates.sort((a, b) => b.score - a.score || b.stars - a.stars);
  const top = candidates.slice(0, limit);

  return JSON.stringify({
    ok: true,
    status: 'researched',
    goal,
    domain,
    generatedAt: new Date().toISOString(),
    candidates: top.map(candidate => ({
      repo: candidate.fullName,
      url: candidate.url,
      stars: candidate.stars,
      forks: candidate.forks,
      language: candidate.language,
      license: candidate.license || 'unknown',
      updatedAt: candidate.updatedAt,
      score: candidate.score,
      fit: candidate.fit,
      risks: candidate.risks,
      suggestedIntegration: candidate.integration,
      description: candidate.description,
    })),
    recommendedPlan: buildPlan(goal, top),
    safety: [
      'This tool only researches and evaluates candidates.',
      'Do not install, clone, execute, or connect third-party code without explicit user confirmation.',
      'Prefer optional adapters for GPL, unclear-license, or heavy native-runtime projects.',
    ],
  }, null, 2);
}

export function registerCapabilityResearchTools(registry: ToolRegistry): void {
  registry.register({
    name: 'capability_research',
    description:
      'Research GitHub/MCP/library candidates for extending Lumi with a new capability, then evaluate technical fit, license risk, integration route, and a safe implementation plan. Use this when Lumi needs to learn how to connect new ecosystems such as CAD, Revit, IFC, Dynamo, local AI apps, or industry tools. This tool does not install or execute third-party code.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Capability goal to research, e.g. "Revit IFC generation and control for Lumi".' },
        query: { type: 'string', description: 'Alias for goal.' },
        domain: { type: 'string', description: 'Optional domain. Use aec_bim_cad for CAD/Revit/IFC/BIM research.' },
        repositories: { type: 'array', description: 'Optional explicit GitHub repositories, e.g. ["IfcOpenShell/IfcOpenShell"].', items: { type: 'string' } },
        search: { type: 'boolean', description: 'Whether to search GitHub in addition to explicit/seed repositories. Defaults to true.' },
        limit: { type: 'number', description: 'Maximum candidate count to return, 3-12.' },
      },
      required: [],
    },
    handler: capabilityResearchHandler,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'capability.external.research',
      family: 'capability-research',
      lane: 'system',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'network_read', scope: 'public integration metadata', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'goal', 'candidates', 'recommendedPlan'],
        requiredValues: { ok: true, status: 'researched' },
        successStatuses: ['researched'],
        failureStatuses: ['failed'],
        successSignals: ['public integration candidates and a bounded plan were returned'],
        limitations: ['Research never approves, installs, connects, or executes third-party code.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'capability.external.research',
      operation: 'observe',
      subjectArgument: 'goal',
      limitations: ['Candidate metadata is advisory and is not installation authority.'],
    }),
  });
}
