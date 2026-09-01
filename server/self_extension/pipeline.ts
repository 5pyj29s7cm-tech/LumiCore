import { getAdapterRegistry } from '../adapters/registry';
import { listExtensionRuntimeSnapshots } from '../extensions/registry';
import { getMarketplaceSkills } from '../marketplace/registry';
import { mcpManager } from '../mcp/client';
import { getExtensionRuntimeStates, type ExtensionRuntimeStatus } from '../skills/runtime_state';
import { CapabilityManifestEntry, ToolDefinition } from '../tools/types';
import {
  isCapabilityLearningRecordVerified,
  listCapabilityLearningRecords,
} from './capability_memory';

export interface SelfExtensionPlanOptions {
  userId?: string;
  scopeDomain?: 'personal' | 'work';
  orgId?: string;
  goal: string;
  domain?: string;
  clientState?: Record<string, any> | null;
  tools?: ToolDefinition[];
  capabilityManifest?: CapabilityManifestEntry[];
}

export interface SelfExtensionPlan {
  goal: string;
  domain: string;
  generatedAt: string;
  readiness: 'use_existing' | 'install_or_repair_skill' | 'generate_skill_draft' | 'research_adapter' | 'core_change_needed';
  resolution: {
    decision:
      | 'reuse_learned_route'
      | 'use_existing_coverage'
      | 'repair_or_install_skill'
      | 'research_adapter'
      | 'generate_skill_draft'
      | 'core_change_needed';
    primarySource: 'learned_capability' | 'adapter' | 'tool' | 'signed_extension' | 'installed_skill' | 'marketplace_skill' | 'planned_adapter' | 'none';
    reason: string;
    preferredTools: string[];
    shouldCreateNewCapability: boolean;
  };
  existingCoverage: {
    adapters: Array<{ id: string; label: string; status: string; actions: string[]; notes?: string }>;
    tools: Array<{ name: string; securityLevel: string; description: string }>;
    signedExtensions: Array<{
      extensionId: string;
      revisionId: string;
      name: string;
      version: string;
      kind: 'provider' | 'plugin' | 'hybrid';
      registered: boolean;
      usable: boolean;
      runtimeStatus: string;
      toolNames: string[];
      providerId: string;
      providerModelIds: string[];
    }>;
    installedSkills: Array<{
      name: string;
      description: string;
      broken?: boolean;
      toolCount?: number;
      configured: boolean;
      enabled: boolean;
      keyReady: boolean;
      registered: boolean;
      usable: boolean;
      runtimeStatus: ExtensionRuntimeStatus;
      toolNames: string[];
    }>;
    marketplaceSkills: Array<{
      id: string;
      name: string;
      installSource: 'bundled' | 'community';
      installable: boolean;
      installed: boolean;
      requiresSetup?: boolean;
      setupNote?: string;
      usable: boolean;
      runtimeStatus: ExtensionRuntimeStatus | 'not_installed';
      toolNames: string[];
    }>;
    learnedCapabilities: Array<{ id: string; domain: string; goal: string; status: string; verified: boolean; route: string; preferredTools: string[]; summary: string }>;
  };
  gap: {
    missing: string[];
    riskLevel: 'low' | 'medium' | 'high';
    reason: string;
  };
  pipeline: Array<{
    step: string;
    status: 'available_now' | 'confirm_first' | 'needs_research' | 'needs_core_work';
    tool?: string;
    args?: Record<string, any>;
    notes: string;
  }>;
  safety: string[];
}

const DOMAIN_HINTS: Array<{ domain: string; patterns: RegExp[]; keywords: string[] }> = [
  { domain: 'music', patterns: [/music|netease|song|playlist|lyric|网易云|音乐|歌单|歌词|播放|切歌/i], keywords: ['music', 'netease', 'song', 'playlist', 'lyric', '音乐', '歌单', '歌词', '播放'] }, // i18n-allow: Reviewed multilingual capability input recognition; not user-visible copy.
  { domain: 'cad_bim', patterns: [/cad|dxf|dwg|revit|ifc|bim|floor.?plan|户型|施工图|图纸|装修|建模/i], keywords: ['cad', 'dxf', 'revit', 'ifc', 'bim', 'floorplan', 'drawing', '户型', '施工图', '图纸', '建模'] }, // i18n-allow: Reviewed multilingual capability input recognition; not user-visible copy.
  { domain: 'messaging', patterns: [/wechat|wecom|feishu|lark|message|reply|微信|企微|企业微信|飞书|消息|回复/i], keywords: ['wechat', 'feishu', 'wecom', 'message', 'reply', '微信', '企业微信', '飞书', '消息', '回复'] }, // i18n-allow: Reviewed multilingual capability input recognition; not user-visible copy.
  { domain: 'legal', patterns: [/legal|law|case|contract|court|律师|律所|案件|合同|法院|庭审|法律/i], keywords: ['legal', 'case', 'contract', 'court', 'law', '律师', '案件', '合同', '法院'] }, // i18n-allow: Reviewed multilingual capability input recognition; not user-visible copy.
  { domain: 'design', patterns: [/design|logo|poster|ui|ux|image|视觉|设计|海报|图片|品牌/i], keywords: ['design', 'image', 'poster', 'brand', 'ui', '设计', '海报', '图片', '品牌'] }, // i18n-allow: Reviewed multilingual capability input recognition; not user-visible copy.
  { domain: 'finance', patterns: [/finance|invoice|expense|stock|财务|财税|发票|报销|股票|预算|税务/i], keywords: ['finance', 'invoice', 'expense', 'stock', 'budget', '财务', '财税', '发票', '报销', '税务'] }, // i18n-allow: Reviewed multilingual capability input recognition; not user-visible copy.
  { domain: 'usage_monitoring', patterns: [/token|usage|cost|model|算力|用量|模型|扣费|消耗|令牌/i], keywords: ['usage', 'token', 'model', 'provider', 'cost', '算力', '用量', '模型', '扣费', '消耗'] }, // i18n-allow: Reviewed multilingual capability input recognition; not user-visible copy.
  { domain: 'client_control', patterns: [/open|switch|mode|client|window|组织|聊天窗|聊天|模式|打开|切换|窗口|客户端/i], keywords: ['client', 'window', 'mode', 'open', 'action', '组织', '聊天', '模式', '打开', '切换', '窗口'] }, // i18n-allow: Reviewed multilingual capability input recognition; not user-visible copy.
  { domain: 'files', patterns: [/file|folder|document|pdf|docx|文件|文件夹|文档|资料/i], keywords: ['file', 'folder', 'document', 'pdf', 'docx', '文件', '文件夹', '文档', '资料'] }, // i18n-allow: Reviewed multilingual capability input recognition; not user-visible copy.
];

export function buildSelfExtensionPlan(options: SelfExtensionPlanOptions): SelfExtensionPlan {
  const goal = String(options.goal || '').trim();
  const domain = options.domain || inferDomain(goal);
  const keywords = extractKeywords(goal, domain);
  const registry = getAdapterRegistry({
    userId: options.userId || 'anonymous',
    clientState: options.clientState || null,
    includePlanned: true,
  });
  const tools = options.tools || [];
  let signedExtensionRuntime: ReturnType<typeof listExtensionRuntimeSnapshots> = [];
  try {
    signedExtensionRuntime = listExtensionRuntimeSnapshots({ userId: options.userId || 'anonymous' });
  } catch {
    // The planner also runs during isolated startup/tests before DB hydration.
  }
  const localSkills = mcpManager.listLocalSkills();
  const runtimeByName = new Map(
    getExtensionRuntimeStates(options.capabilityManifest || [])
      .map(state => [state.name, state]),
  );
  const marketplace = getMarketplaceSkills();

  const matchingAdapters = registry.adapters
    .filter(adapter => matchesAny([
      adapter.id,
      adapter.label,
      adapter.category,
      adapter.notes || '',
      adapter.actions.join(' '),
      ...(adapter.surfaces || []),
    ].join(' '), keywords))
    .sort((a, b) => scoreAdapterMatch(b, domain, keywords) - scoreAdapterMatch(a, domain, keywords))
    .map(adapter => ({
      id: adapter.id,
      label: adapter.label,
      status: adapter.status,
      actions: adapter.actions,
      notes: adapter.notes,
    }));

  const matchingTools = tools
    .filter(tool => matchesAny(`${tool.name} ${tool.description}`, keywords))
    .sort((a, b) => scoreToolMatch(b, domain, keywords) - scoreToolMatch(a, domain, keywords))
    .slice(0, 20)
    .map(tool => ({
      name: tool.name,
      securityLevel: tool.securityLevel,
      description: trim(tool.description, 220),
    }));

  const matchingSignedExtensions: SelfExtensionPlan['existingCoverage']['signedExtensions'] = signedExtensionRuntime
    .filter(extension => matchesAny([
      extension.extensionId,
      extension.name,
      extension.kind,
      extension.providerId,
      extension.providerModelIds.join(' '),
      extension.registeredToolNames.join(' '),
    ].join(' '), keywords))
    .slice(0, 12)
    .map(extension => ({
      extensionId: extension.extensionId,
      revisionId: extension.revisionId,
      name: extension.name,
      version: extension.version,
      kind: extension.kind,
      registered: extension.registered,
      usable: extension.usable,
      runtimeStatus: extension.runtimeStatus,
      toolNames: [...extension.registeredToolNames],
      providerId: extension.providerId,
      providerModelIds: [...extension.providerModelIds],
    }));

  const matchingLocalSkills = localSkills
    .filter(skill => matchesAny(`${skill.name} ${skill.description || ''} ${skill.generatedFrom || ''}`, keywords))
    .map(skill => ({
      name: skill.name,
      description: skill.description,
      broken: skill.broken,
      toolCount: skill.toolCount,
      configured: runtimeByName.get(skill.name)?.configured ?? false,
      enabled: runtimeByName.get(skill.name)?.enabled ?? false,
      keyReady: runtimeByName.get(skill.name)?.keyReady ?? true,
      registered: runtimeByName.get(skill.name)?.registered ?? false,
      usable: runtimeByName.get(skill.name)?.usable ?? false,
      runtimeStatus: runtimeByName.get(skill.name)?.status || 'not_configured',
      toolNames: runtimeByName.get(skill.name)?.toolNames || [],
    }));

  const matchingMarketplace: SelfExtensionPlan['existingCoverage']['marketplaceSkills'] = marketplace
    .filter(skill => matchesAny(`${skill.id} ${skill.name} ${skill.description} ${skill.category} ${skill.setupNote || ''}`, keywords))
    .slice(0, 12)
    .map(skill => {
      const runtimeName = skill.id.replace(/^skill-/i, '');
      const runtime = runtimeByName.get(runtimeName);
      return ({
      id: skill.id,
      name: skill.name,
      installSource: skill.installSource,
      installable: skill.installSource === 'bundled'
        && skill.runtimeInstallable !== false
        && Boolean(skill.installPath),
      installed: runtime?.packagePresent ?? skill.installed,
      requiresSetup: skill.requiresSetup || skill.requiresApiKey || false,
      setupNote: skill.setupNote,
      usable: runtime?.usable ?? false,
      runtimeStatus: runtime?.status || ('not_installed' as const),
      toolNames: runtime?.toolNames || [],
    });
    });
  const learnedCapabilities = listCapabilityLearningRecords({
    userId: options.userId || 'anonymous',
    scopeDomain: options.scopeDomain === 'work' && options.orgId ? 'work' : 'personal',
    orgId: options.scopeDomain === 'work' ? String(options.orgId || '') : '',
    domain,
    goal,
    limit: 8,
  }).map(record => ({
    id: record.id,
    domain: record.domain,
    goal: record.goal,
    status: record.status,
    verified: isCapabilityLearningRecordVerified(record),
    route: record.selectedRoute.label,
    preferredTools: record.nextUse.preferredTools,
    summary: record.experiment.summary,
  }));

  const coverageReady = matchingAdapters.some(adapter => ['ready', 'available', 'draft_only'].includes(adapter.status))
    || matchingTools.some(tool => tool.securityLevel === 'safe' || tool.securityLevel === 'confirm')
    || matchingSignedExtensions.some(extension => extension.usable)
    || matchingLocalSkills.some(skill => skill.usable)
    || learnedCapabilities.some(record => record.verified);
  const repairableSkill = matchingLocalSkills.some(skill => !skill.usable);
  const installableSkill = matchingMarketplace.some(skill => skill.installable && !skill.installed);
  const plannedAdapter = matchingAdapters.some(adapter => adapter.status === 'planned');
  const highRisk = /(send|post|pay|purchase|delete|remove|desktop|wechat|cad|revit|微信|发送|付款|删除|桌面|键鼠|施工图|生产图)/i.test(goal);

  const readiness: SelfExtensionPlan['readiness'] =
    coverageReady ? 'use_existing'
      : repairableSkill || installableSkill ? 'install_or_repair_skill'
      : plannedAdapter || shouldResearch(domain, goal) || canGenerateSkill(domain, goal) ? 'research_adapter'
      : 'core_change_needed';
  const resolution = buildResolution(readiness, {
    matchingTools,
    matchingAdapters,
    matchingSignedExtensions,
    matchingLocalSkills,
    matchingMarketplace,
    learnedCapabilities,
    repairableSkill,
    installableSkill,
    plannedAdapter,
  });

  return {
    goal,
    domain,
    generatedAt: new Date().toISOString(),
    readiness,
    resolution,
    existingCoverage: {
      adapters: matchingAdapters,
      tools: matchingTools,
      signedExtensions: matchingSignedExtensions,
      installedSkills: matchingLocalSkills,
      marketplaceSkills: matchingMarketplace,
      learnedCapabilities,
    },
    gap: buildGap(goal, domain, readiness, {
      coverageReady,
      repairableSkill,
      installableSkill,
      plannedAdapter,
      highRisk,
    }),
    pipeline: buildPipeline(goal, domain, readiness, {
      matchingTools,
      matchingAdapters,
      matchingSignedExtensions,
      matchingLocalSkills,
      matchingMarketplace,
      learnedCapabilities,
      highRisk,
    }),
    safety: [
      'Check learned capability routes, adapters, tools, signed extensions, installed skills, and marketplace skills before creating anything new.',
      'Use existing explicit tools and client actions before generating new tools.',
      'Use capability_research before connecting a new external ecosystem, GitHub project, MCP server, CAD/BIM bridge, or online AI service.',
      'generate_skill, install_skill, client_repair_skill, desktop control, external app automation, messaging, provider changes, and file writes remain confirmation-sensitive.',
      'Do not silently modify Lumi core code. For core changes, produce a plan and ask the user/developer to apply and verify it.',
      'Never claim a capability is installed, repaired, or connected until the corresponding tool ran and the state or health check confirms it.',
    ],
  };
}

function buildGap(
  goal: string,
  domain: string,
  readiness: SelfExtensionPlan['readiness'],
  facts: {
    coverageReady: boolean;
    repairableSkill: boolean;
    installableSkill: boolean;
    plannedAdapter: boolean;
    highRisk: boolean;
  },
): SelfExtensionPlan['gap'] {
  if (facts.coverageReady) {
    return {
      missing: [],
      riskLevel: facts.highRisk ? 'medium' : 'low',
      reason: 'Existing adapters, tools, or installed skills appear able to cover this request.',
    };
  }
  const missing: string[] = [];
  if (facts.repairableSkill) missing.push('A matching installed skill exists but needs repair.');
  if (facts.installableSkill) missing.push('A matching marketplace/bundled skill exists but is not installed or needs setup.');
  if (facts.plannedAdapter) missing.push('A matching adapter is planned but not yet wired for real execution.');
  if (!missing.length && readiness === 'generate_skill_draft') missing.push('No direct tool was found; this looks like a repeatable workflow suitable for a generated skill.');
  if (!missing.length && readiness === 'research_adapter') missing.push('No direct integration was found; the external ecosystem needs research before installation or adapter work.');
  if (!missing.length) missing.push('No existing tool, skill, or adapter confidently covers the request.');
  return {
    missing,
    riskLevel: facts.highRisk ? 'high' : domain === 'client_control' || domain === 'usage_monitoring' ? 'low' : 'medium',
    reason: readinessToReason(readiness),
  };
}

function buildResolution(
  readiness: SelfExtensionPlan['readiness'],
  facts: {
    matchingTools: Array<{ name: string; securityLevel: string; description: string }>;
    matchingAdapters: Array<{ id: string; label: string; status: string; actions: string[]; notes?: string }>;
    matchingSignedExtensions: SelfExtensionPlan['existingCoverage']['signedExtensions'];
    matchingLocalSkills: SelfExtensionPlan['existingCoverage']['installedSkills'];
    matchingMarketplace: SelfExtensionPlan['existingCoverage']['marketplaceSkills'];
    learnedCapabilities: SelfExtensionPlan['existingCoverage']['learnedCapabilities'];
    repairableSkill: boolean;
    installableSkill: boolean;
    plannedAdapter: boolean;
  },
): SelfExtensionPlan['resolution'] {
  const learned = facts.learnedCapabilities.find(record => record.verified);
  if (learned) {
    return {
      decision: 'reuse_learned_route',
      primarySource: 'learned_capability',
      reason: `A persisted learned route already covers this request: ${learned.route}.`,
      preferredTools: learned.preferredTools,
      shouldCreateNewCapability: false,
    };
  }

  const readyAdapter = facts.matchingAdapters.find(adapter => ['ready', 'available', 'draft_only'].includes(adapter.status));
  if (readyAdapter) {
    return {
      decision: 'use_existing_coverage',
      primarySource: 'adapter',
      reason: `A matching adapter already exists: ${readyAdapter.label}.`,
      preferredTools: readyAdapter.actions,
      shouldCreateNewCapability: false,
    };
  }

  const readySignedExtension = facts.matchingSignedExtensions.find(extension => extension.usable);
  if (readySignedExtension) {
    return {
      decision: 'use_existing_coverage',
      primarySource: 'signed_extension',
      reason: `A matching signed extension is already callable: ${readySignedExtension.name}.`,
      preferredTools: readySignedExtension.toolNames,
      shouldCreateNewCapability: false,
    };
  }

  const readyTool = facts.matchingTools.find(tool => tool.securityLevel === 'safe' || tool.securityLevel === 'confirm');
  if (readyTool) {
    return {
      decision: 'use_existing_coverage',
      primarySource: 'tool',
      reason: `A matching tool already exists: ${readyTool.name}.`,
      preferredTools: [readyTool.name],
      shouldCreateNewCapability: false,
    };
  }

  const installedSkill = facts.matchingLocalSkills.find(skill => skill.usable);
  if (installedSkill) {
    return {
      decision: 'use_existing_coverage',
      primarySource: 'installed_skill',
      reason: `A matching installed skill already exists: ${installedSkill.name}.`,
      preferredTools: installedSkill.toolNames,
      shouldCreateNewCapability: false,
    };
  }

  if (facts.repairableSkill || facts.installableSkill) {
    const marketplaceSkill = facts.matchingMarketplace.find(skill => skill.installable && !skill.installed);
    return {
      decision: 'repair_or_install_skill',
      primarySource: facts.repairableSkill ? 'installed_skill' : 'marketplace_skill',
      reason: facts.repairableSkill
        ? 'A matching skill exists but needs repair before Lumi should invent a new route.'
        : `A matching skill can be installed or set up${marketplaceSkill ? `: ${marketplaceSkill.name}` : ''}.`,
      preferredTools: facts.repairableSkill ? ['client_repair_skill'] : ['skill_marketplace_install'],
      shouldCreateNewCapability: false,
    };
  }

  if (facts.plannedAdapter || readiness === 'research_adapter') {
    return {
      decision: 'research_adapter',
      primarySource: facts.plannedAdapter ? 'planned_adapter' : 'none',
      reason: facts.plannedAdapter
        ? 'A planned adapter exists, so Lumi should research/finish that route before creating a parallel one.'
        : 'No existing route covers this request; research an integration candidate before installing or executing anything.',
      preferredTools: ['capability_research'],
      shouldCreateNewCapability: true,
    };
  }

  if (readiness === 'generate_skill_draft') {
    return {
      decision: 'generate_skill_draft',
      primarySource: 'none',
      reason: 'No existing route covers this repeatable workflow; a reusable skill draft is appropriate after confirmation.',
      preferredTools: ['generate_skill'],
      shouldCreateNewCapability: true,
    };
  }

  return {
    decision: 'core_change_needed',
    primarySource: 'none',
    reason: 'The request appears to need core client/server work rather than another tool wrapper.',
    preferredTools: [],
    shouldCreateNewCapability: true,
  };
}

function buildPipeline(
  goal: string,
  domain: string,
  readiness: SelfExtensionPlan['readiness'],
  facts: {
    matchingTools: Array<{ name: string; securityLevel: string; description: string }>;
    matchingAdapters: Array<{ id: string; label: string; status: string; actions: string[]; notes?: string }>;
    matchingSignedExtensions: SelfExtensionPlan['existingCoverage']['signedExtensions'];
    matchingLocalSkills: SelfExtensionPlan['existingCoverage']['installedSkills'];
    matchingMarketplace: SelfExtensionPlan['existingCoverage']['marketplaceSkills'];
    learnedCapabilities: SelfExtensionPlan['existingCoverage']['learnedCapabilities'];
    highRisk: boolean;
  },
): SelfExtensionPlan['pipeline'] {
  const pipeline: SelfExtensionPlan['pipeline'] = [
    {
      step: 'Inspect current body and adapters',
      status: 'available_now',
      tool: 'adapter_registry_list',
      args: { includePlanned: true },
      notes: 'Confirm what Lumi already has before inventing a new tool.',
    },
  ];

  pipeline.push({
    step: 'Inspect installed signed extensions and Providers',
    status: 'available_now',
    tool: 'extension_registry_list',
    args: {},
    notes: 'Only extensions whose exact signed revision is currently registered and usable count as existing coverage.',
  });

  pipeline.push({
    step: 'Search the Skill Hall for an approved reusable capability',
    status: 'available_now',
    tool: 'skill_marketplace_search',
    args: { query: goal },
    notes: 'Only an exact official bundled result is installable. Community entries remain discovery metadata until a separate immutable review flow exists.',
  });

  const learned = facts.learnedCapabilities.find(record => record.verified);
  if (learned) {
    pipeline.push({
      step: 'Reuse learned capability route',
      status: facts.highRisk ? 'confirm_first' : 'available_now',
      tool: learned.preferredTools[0] || 'capability_learning_list',
      args: { goal, domain },
      notes: `Lumi already learned this interface route: ${learned.route}. Prefer it before generating tools or modifying core code.`,
    });
  }

  if (domain === 'usage_monitoring') {
    pipeline.push({
      step: 'Query model and token usage',
      status: 'available_now',
      tool: 'usage_get_summary',
      args: { range: 'today', groupBy: 'provider_model' },
      notes: 'Use the native usage summary tool instead of guessing from chat history.',
    });
  }

  if (facts.matchingTools.length > 0 || facts.matchingAdapters.some(adapter => adapter.status !== 'planned')) {
    pipeline.push({
      step: 'Use existing explicit actions first',
      status: facts.highRisk ? 'confirm_first' : 'available_now',
      tool: facts.matchingTools[0]?.name || facts.matchingAdapters[0]?.actions[0],
      notes: facts.highRisk
        ? 'The request may affect desktop apps, messaging, CAD/BIM, or user files, so confirmation may be required.'
        : 'A matching tool or adapter already exists.',
    });
  }

  const unavailableSkill = facts.matchingLocalSkills.find(skill => !skill.usable);
  if (unavailableSkill) {
    pipeline.push({
      step: unavailableSkill.broken ? 'Repair matching installed skill' : 'Restore matching installed skill to a callable state',
      status: 'confirm_first',
      tool: 'client_repair_skill',
      args: { skillName: unavailableSkill.name },
      notes: `Current state: ${unavailableSkill.runtimeStatus}. Repair/reconfigure is confirmation-sensitive and must end with exact live tool registration.`,
    });
  }

  const installable = facts.matchingMarketplace.find(skill => skill.installable && !skill.installed);
  if (installable) {
    pipeline.push({
      step: 'Install matching official bundled skill',
      status: 'confirm_first',
      tool: 'skill_marketplace_install',
      args: { skillId: installable.id },
      notes: `Candidate: ${installable.name}. Install this exact Skill Hall id, then require live registration before use.`,
    });
  }

  const readySignedExtension = facts.matchingSignedExtensions.find(extension => extension.usable);
  if (readySignedExtension) {
    pipeline.push({
      step: 'Reuse callable signed extension',
      status: facts.highRisk ? 'confirm_first' : 'available_now',
      tool: readySignedExtension.toolNames[0] || 'extension_registry_list',
      args: readySignedExtension.toolNames[0] ? { goal } : {},
      notes: `Use ${readySignedExtension.name}@${readySignedExtension.version}; its live tools are bound to revision ${readySignedExtension.revisionId}.`,
    });
  } else {
    const unavailableSignedExtension = facts.matchingSignedExtensions[0];
    if (unavailableSignedExtension) {
      pipeline.push({
        step: 'Verify matching signed extension runtime',
        status: 'available_now',
        tool: 'extension_registry_test',
        args: { extensionId: unavailableSignedExtension.extensionId, version: unavailableSignedExtension.version },
        notes: `The signed extension is recorded as ${unavailableSignedExtension.runtimeStatus}, not callable. Do not treat its declared tools as available.`,
      });
    }
  }

  if (
    !installable
    && !facts.matchingLocalSkills.some(skill => skill.usable)
    && !facts.matchingSignedExtensions.some(extension => extension.usable)
  ) {
    pipeline.push({
      step: 'Inspect curated external MCP candidates',
      status: 'available_now',
      tool: 'external_control_candidates',
      args: { industry: domain },
      notes: 'This is read-only discovery. A candidate must still be explicitly reviewed and connected before it can publish tools.',
    });
  }

  if (
    !installable
    && !facts.matchingSignedExtensions.some(extension => extension.usable)
    && (readiness === 'research_adapter' || shouldResearch(domain, goal) || canGenerateSkill(domain, goal))
  ) {
    pipeline.push({
      step: 'Research integration candidates',
      status: 'needs_research',
      tool: 'capability_research',
      args: { goal, domain: domain === 'cad_bim' ? 'aec_bim_cad' : domain, limit: 6 },
      notes: 'Research does not install or execute third-party code.',
    });
  }

  if (
    !installable
    && !facts.matchingTools.length
    && !facts.matchingSignedExtensions.some(extension => extension.usable)
    && canGenerateSkill(domain, goal)
  ) {
    pipeline.push({
      step: 'Generate a reusable skill draft',
      status: 'confirm_first',
      tool: 'generate_skill',
      args: { description: buildSkillDescription(goal, domain) },
      notes: 'Available only after the same task records a clear Skill Hall search, curated MCP discovery, and external integration research. Generated drafts remain pure-computation, separately reviewed MCP packages.',
    });
  }

  if (readiness === 'core_change_needed') {
    pipeline.push({
      step: 'Escalate to core adapter/client work',
      status: 'needs_core_work',
      notes: 'This likely needs a repo code change, UI wiring, provider integration, or database/API addition. Lumi should produce a patch plan instead of pretending it can self-install core behavior.',
    });
  }

  return pipeline;
}

function inferDomain(goal: string): string {
  for (const hint of DOMAIN_HINTS) {
    if (hint.patterns.some(pattern => pattern.test(goal))) return hint.domain;
  }
  return 'general';
}

function extractKeywords(goal: string, domain: string): string[] {
  const hint = DOMAIN_HINTS.find(item => item.domain === domain);
  const words = goal
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map(word => word.trim())
    .filter(word => word.length >= 2)
    .slice(0, 16);
  return Array.from(new Set([...(hint?.keywords || []), ...words]));
}

function matchesAny(text: string, keywords: string[]): boolean {
  const haystack = text.toLowerCase();
  return keywords.some(keyword => keyword && haystack.includes(keyword.toLowerCase()));
}

function scoreAdapterMatch(adapter: { id: string; label: string; category: string; status: string; actions: string[]; notes?: string }, domain: string, keywords: string[]): number {
  const text = `${adapter.id} ${adapter.label} ${adapter.category} ${adapter.actions.join(' ')} ${adapter.notes || ''}`.toLowerCase();
  let score = 0;
  if (domain === 'usage_monitoring' && /usage|token/.test(text)) score += 80;
  if (domain === 'client_control' && /client|action_router|mode|window/.test(text)) score += 70;
  if (domain === 'cad_bim' && /cad|bim|ifc|revit|dxf/.test(text)) score += 70;
  if (domain === 'messaging' && /message|wechat|feishu|wecom/.test(text)) score += 70;
  if (adapter.id.includes(domain.replace('_', '.')) || adapter.id.includes(domain)) score += 50;
  if (adapter.category === 'system' && ['usage_monitoring', 'client_control'].includes(domain)) score += 10;
  if (adapter.status === 'ready') score += 8;
  if (adapter.status === 'planned') score -= 15;
  for (const keyword of keywords) {
    if (keyword && text.includes(keyword.toLowerCase())) score += 1;
  }
  return score;
}

function scoreToolMatch(tool: ToolDefinition, domain: string, keywords: string[]): number {
  const text = `${tool.name} ${tool.description}`.toLowerCase();
  let score = 0;
  if (domain === 'usage_monitoring' && tool.name === 'usage_get_summary') score += 100;
  if (domain === 'client_control' && tool.name === 'client_action') score += 100;
  if (tool.name.includes(domain.replace('_', ''))) score += 30;
  if (tool.securityLevel === 'safe') score += 8;
  for (const keyword of keywords) {
    if (keyword && text.includes(keyword.toLowerCase())) score += 1;
  }
  return score;
}

function shouldResearch(domain: string, goal: string): boolean {
  return ['cad_bim', 'messaging', 'design', 'finance', 'legal'].includes(domain)
    || /github|mcp|api|adapter|connect|integrat|对接|接入|控制|自动/i.test(goal);
}

function canGenerateSkill(domain: string, goal: string): boolean {
  if (['client_control', 'usage_monitoring'].includes(domain)) return false;
  if (/core|client|window|provider|permission|database|schema|内核|客户端|权限|数据库|模型供应商/i.test(goal)) return false;
  return true;
}

function readinessToReason(readiness: SelfExtensionPlan['readiness']): string {
  if (readiness === 'use_existing') return 'Use existing adapters/tools first.';
  if (readiness === 'install_or_repair_skill') return 'A skill exists but must be installed, set up, or repaired.';
  if (readiness === 'generate_skill_draft') return 'A reusable generated skill is the likely next step.';
  if (readiness === 'research_adapter') return 'A new ecosystem adapter needs research before implementation.';
  return 'This appears to require a core code/API/UI change.';
}

function buildSkillDescription(goal: string, domain: string): string {
  return [
    `Create a Lumi MCP skill for this goal: ${goal}`,
    `Domain: ${domain}.`,
    'The skill must expose one clear tool with a JSON schema, validate inputs, avoid destructive actions, and return structured JSON.',
    'It must not send messages, control external apps, make purchases, delete files, or install third-party code without explicit confirmation.',
  ].join('\n');
}

function trim(value: string, max: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
