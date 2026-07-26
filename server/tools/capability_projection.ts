import type { CapabilityLane, CapabilityManifestEntry, CapabilityOperation } from './types';

const CAPABILITY_OPERATION_BY_VERB: Record<string, CapabilityOperation> = {
  get: 'observe', list: 'observe', read: 'observe', search: 'observe', find: 'observe',
  inspect: 'observe', capture: 'observe', snapshot: 'observe', status: 'observe',
  query: 'observe', grep: 'observe', fetch: 'observe', presets: 'observe', info: 'observe',
  idle: 'observe', poll: 'observe', diff: 'observe', today: 'observe', ocr: 'observe',
  review: 'observe', trace: 'observe', lookup: 'observe', research: 'observe',
  candidates: 'observe', constitution: 'observe', scan: 'observe', stats: 'observe',
  penetration: 'observe', extract: 'observe', analyze: 'observe', collect: 'observe',
  recent: 'observe', upcoming: 'observe', check: 'test', health: 'test', verify: 'test',
  validate: 'test', test: 'test', probe: 'test', create: 'create', generate: 'create',
  build: 'create', draft: 'create', prepare: 'create', export: 'create', new: 'create',
  merge: 'create', split: 'create', convert: 'create', transcribe: 'create', plan: 'create',
  strategy: 'create', reasoning: 'create', discovery: 'create', to: 'create', from: 'create',
  minutes: 'create', send: 'communicate', reply: 'communicate', message: 'communicate',
  post: 'communicate', publish: 'communicate', ask: 'communicate', roundtable: 'communicate',
  write: 'mutate', save: 'mutate', edit: 'mutate', modify: 'mutate', update: 'mutate',
  set: 'mutate', open: 'mutate', close: 'mutate', run: 'mutate', execute: 'mutate',
  install: 'mutate', repair: 'mutate', remove: 'mutate', delete: 'mutate', move: 'mutate',
  focus: 'mutate', click: 'mutate', type: 'mutate', invoke: 'mutate', playback: 'mutate',
  start: 'mutate', show: 'mutate', stage: 'mutate', commit: 'mutate', terminate: 'mutate',
  ingest: 'mutate', upgrade: 'mutate', drag: 'mutate', press: 'mutate', use: 'mutate',
  exec: 'mutate', enroll: 'mutate', forget: 'mutate', import: 'mutate', process: 'mutate',
  finalize: 'mutate', action: 'mutate', intake: 'mutate', configure: 'mutate',
  register: 'mutate', cycle: 'mutate', continue: 'mutate', orchestrate: 'mutate',
  autorun: 'mutate', learn: 'mutate', workspace: 'mutate', execution: 'mutate',
  refresh: 'mutate', autofix: 'mutate', stop: 'mutate', cancel: 'mutate', advance: 'mutate',
};

export function inferCapabilityOperation(toolName: string): CapabilityOperation {
  const tokens = String(toolName || '').toLowerCase().split(/[_\-\s]+/).filter(Boolean);
  for (const token of tokens) {
    const operation = CAPABILITY_OPERATION_BY_VERB[token];
    if (operation) return operation;
  }
  return 'unknown';
}

export function inferCapabilityFamily(toolName: string): string {
  const tokens = String(toolName || '').toLowerCase().split(/[_\-\s]+/).filter(Boolean);
  if (tokens.length === 0) return 'general';
  const firstNonAction = tokens.find(token => !CAPABILITY_OPERATION_BY_VERB[token] && token !== 'mcp');
  return firstNonAction || tokens[0];
}

export function inferCapabilityLane(toolName: string, family: string): CapabilityLane {
  const value = `${toolName} ${family}`.toLowerCase();
  if (/^(?:client_|focus_home)|\bclient\b/.test(value)) return 'client';
  if (/(?:desktop_|computer_use|mouse_|keyboard_|clipboard|window_control|screen|uia|native_ui)/.test(value)) return 'desktop';
  if (/(?:cad_|autocad|dxf|dwg|floorplan|design-studio|drawing)/.test(value)) return 'cad';
  if (/(?:neteasemusic|spotify|music|melody|audio|tts|stt|voice|image|video|ocr)/.test(value)) return 'media';
  if (/(?:legal|law|court|case|ecommerce|customer|finance|stock|medical|education|insurance|logistics|restaurant|manufacturing)/.test(value)) return 'industry';
  if (/(?:web_|browser_|url_|playwright|crawler|fetcher)/.test(value)) return 'web';
  if (/(?:wechat|weixin|feishu|message|messaging|email|mail|calendar)/.test(value)) return 'messaging';
  if (/(?:docx|xlsx|ppt|pdf|office|wps|document|spreadsheet)/.test(value)) return 'office';
  if (/(?:file|directory|path_|filesystem|grep)/.test(value)) return 'files';
  if (/(?:knowledge|embedding|indexing)/.test(value)) return 'knowledge';
  if (/(?:memory|sleep|dream|personality)/.test(value)) return 'memory';
  if (/(?:agent|skill|capability|self_extension|work_takeover|external_control|adapter|hermes|autonomy|workflow)/.test(value)) return 'agents';
  if (/(?:system|runtime|health|process|network|usage|diagnostic)/.test(value)) return 'system';
  return 'general';
}

export interface CapabilityRoutingProjection {
  toolName: string;
  capabilityId: string;
  family: string;
  lane: CapabilityLane;
  operation: CapabilityOperation;
  provider?: string;
  intents: string[];
  routingTerms: string[];
  deprecated: boolean;
  executable: boolean;
}

export interface CapabilityRoutingQuery {
  lanes?: CapabilityLane[];
  terms?: RegExp;
  availableToolNames?: Set<string>;
}

export function selectCapabilityRoutingProjections(
  entries: CapabilityRoutingProjection[],
  query: CapabilityRoutingQuery = {},
): CapabilityRoutingProjection[] {
  const lanes = new Set(query.lanes || []);
  return entries.filter(entry => {
    if (entry.deprecated || !entry.executable) return false;
    if (query.availableToolNames && !query.availableToolNames.has(entry.toolName)) return false;
    if (lanes.size > 0 && !lanes.has(entry.lane)) return false;
    if (!query.terms) return true;
    query.terms.lastIndex = 0;
    return query.terms.test([
      entry.toolName,
      entry.capabilityId,
      entry.family,
      entry.provider || '',
      ...entry.intents,
      ...entry.routingTerms,
    ].join(' '));
  });
}

export interface CapabilityManifestQuery {
  lanes?: CapabilityLane[];
  operations?: CapabilityOperation[];
  capabilityIds?: string[];
  capabilityIdPrefixes?: string[];
  families?: string[];
  domains?: string[];
  providers?: string[];
  terms?: Array<string | RegExp>;
  executableOnly?: boolean;
  includeDeprecated?: boolean;
}

function normalizedSet(values?: string[]): Set<string> {
  return new Set((values || []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
}

function manifestSearchText(entry: CapabilityManifestEntry): string {
  return [
    entry.toolName,
    entry.capabilityId,
    entry.family,
    entry.provider || '',
    entry.description,
    ...entry.domains,
    ...entry.intents,
    ...entry.routingTerms,
  ].join(' ').toLowerCase();
}

/** Generic manifest selector shared by routing, diagnostics, adapters, and self-awareness. */
export function selectManifestCapabilities(
  manifest: CapabilityManifestEntry[],
  query: CapabilityManifestQuery = {},
): CapabilityManifestEntry[] {
  const lanes = new Set(query.lanes || []);
  const operations = new Set(query.operations || []);
  const capabilityIds = normalizedSet(query.capabilityIds);
  const capabilityIdPrefixes = (query.capabilityIdPrefixes || [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const families = normalizedSet(query.families);
  const domains = normalizedSet(query.domains);
  const providers = normalizedSet(query.providers);

  return manifest.filter(entry => {
    if (query.executableOnly !== false && !entry.executable) return false;
    if (query.includeDeprecated !== true && entry.deprecated) return false;
    if (lanes.size > 0 && !lanes.has(entry.lane)) return false;
    if (operations.size > 0 && !operations.has(entry.operation)) return false;
    if (capabilityIds.size > 0 && !capabilityIds.has(entry.capabilityId.toLowerCase())) return false;
    if (
      capabilityIdPrefixes.length > 0
      && !capabilityIdPrefixes.some(prefix => entry.capabilityId.toLowerCase().startsWith(prefix))
    ) return false;
    if (families.size > 0 && !families.has(entry.family.toLowerCase())) return false;
    if (providers.size > 0 && !providers.has(String(entry.provider || '').toLowerCase())) return false;
    if (
      domains.size > 0
      && !entry.domains.some(domain => domains.has(domain.toLowerCase()))
    ) return false;
    if (query.terms?.length) {
      const haystack = manifestSearchText(entry);
      const matched = query.terms.some(term => (
        typeof term === 'string'
          ? haystack.includes(term.toLowerCase())
          : (term.lastIndex = 0, term.test(haystack))
      ));
      if (!matched) return false;
    }
    return true;
  });
}

export function projectToolDeclarationForRouting(declaration: {
  function: { name: string; description?: string };
}): CapabilityRoutingProjection {
  const toolName = String(declaration.function.name || '').trim();
  const family = inferCapabilityFamily(toolName);
  const description = String(declaration.function.description || '').trim();
  const nameTerms = toolName.split(/[_\-\s]+/).filter(Boolean);
  return {
    toolName,
    capabilityId: toolName,
    family,
    lane: inferCapabilityLane(toolName, family),
    operation: inferCapabilityOperation(toolName),
    intents: description ? [description] : [],
    routingTerms: Array.from(new Set([...nameTerms, description].filter(Boolean))),
    deprecated: false,
    executable: true,
  };
}
