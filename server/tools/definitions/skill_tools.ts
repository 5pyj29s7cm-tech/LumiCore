/**
 * Lumi Skill Management Tools — generate, list, and install MCP skills.
 *
 * These tools let the LLM agent create new reusable tools from natural language
 * descriptions, inspect existing skills, and install skill packages from disk.
 */
import fs from 'fs';
import path from 'path';
import type { ToolRegistry } from '../registry';
import {
  generateSkill,
  isGeneratedSkillDraftLocation,
  readGeneratedSkillDraft,
  validateGeneratedSkillDraftForInstall,
} from '../../skills/generator';
import {
  activateInstalledSkill,
  mcpManager,
  normalizeSkillInstallName,
  SKILLS_DIR,
  unregisterServerTools,
} from '../../mcp';
import type { ToolContext } from '../types';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import {
  getMarketplaceSkills,
  getSkillById,
  recordInstall,
  searchSkills,
} from '../../marketplace/registry';
import { getExtensionRuntimeStates } from '../../skills/runtime_state';
import { createBundledSkillIdentity } from '../../marketplace/official_identity';

// Module-level LLM getters, set during registration
let _llmGetters: {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
  getOllama?: () => any;
  getLmStudio?: () => any;
  getArk?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
} | null = null;

export function setSkillLLMGetters(getters: typeof _llmGetters): void {
  _llmGetters = getters;
}

function hostSkillMutationBlocked(context?: ToolContext): string | null {
  if (
    context?.authenticated !== true
    || context.authRole !== 'admin'
    || context.localExecution !== true
    || context.executionBoundary !== 'trusted_local'
  ) {
    return 'Host-level skill changes require the authenticated local desktop administrator. Remote, unverified, and organization execution surfaces may inspect capabilities but cannot generate, install, or activate host code.';
  }
  if (context?.domain === 'work' || context?.orgId) {
    return 'Host-level skill changes are not performed from an organization workspace. A local system administrator can install or generate the skill in desktop settings; the organization workspace can then use the approved capability.';
  }
  return null;
}

function recordMarketplaceInstallBestEffort(skillId: string): void {
  try {
    recordInstall(skillId);
  } catch (error: any) {
    console.warn(`[SkillHall] Runtime activation succeeded, but install analytics could not be recorded for ${skillId}:`, error?.message || error);
  }
}

async function generateSkillHandler(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const blocked = hostSkillMutationBlocked(context);
  if (blocked) throw new Error(blocked);
  if (!_llmGetters) {
    throw new Error('Skill generation is unavailable because LLM providers have not finished initializing.');
  }

  const description = String(args.description || '').trim();
  if (!description) {
    throw new Error('A specific skill description is required.');
  }

  const result = await generateSkill(
    {
      description,
      ...(args.provider ? { provider: args.provider as any } : {}),
      ...(args.model ? { model: String(args.model) } : {}),
      userId: context?.userId || 'skill_gen',
    },
    _llmGetters.getDeepSeek,
    _llmGetters.getGemini,
    _llmGetters.getOpenAI,
    _llmGetters.getAnthropic,
    _llmGetters.getQwen,
    _llmGetters.getOllama,
    _llmGetters.getLmStudio,
    _llmGetters.getArk,
    _llmGetters.getXiaomi,
    _llmGetters.getKimi,
    _llmGetters.getGlm,
    _llmGetters.getRelay,
  );

  if (!result.success) {
    throw new Error(`Skill generation failed: ${result.error || 'Unknown error'}`);
  }
  const draftDirectory = String(result.directory || '');
  const manifestPath = path.join(draftDirectory, 'package.json');
  const entryPath = path.join(draftDirectory, 'index.ts');
  if (
    !draftDirectory
    || !result.review?.staticCheck.passed
    || !result.review?.trialRun.passed
    || !fs.existsSync(manifestPath)
    || !fs.existsSync(entryPath)
  ) {
    throw new Error('Skill generation returned without a complete reviewed draft artifact.');
  }
  return JSON.stringify({
    ok: true,
    status: 'draft',
    executable: false,
    installed: false,
    skillName: result.skillName,
    toolName: result.toolName,
    draftDirectory,
    manifestPath,
    entryPath,
    review: result.review,
    warnings: result.error ? [result.error] : [],
  });
}

async function listSkillsHandler(registry: ToolRegistry): Promise<string> {
  try {
    const states = getExtensionRuntimeStates(registry.getCapabilityManifest());
    return JSON.stringify({
      ok: true,
      status: 'listed',
      count: states.length,
      skills: states,
      nextAction: states.some(state => state.usable)
        ? 'Reuse a callable skill whose exact tool names match the task.'
        : 'No callable local skill is available. Search the Skill Hall, then approved external MCP candidates; generate a reviewed draft only if the capability is still missing.',
    });
  } catch (err: any) {
    throw new Error(`Skill listing failed: ${err.message || String(err)}`);
  }
}

async function installSkillHandler(
  args: Record<string, any>,
  registry: ToolRegistry,
  context?: ToolContext,
): Promise<string> {
  const blocked = hostSkillMutationBlocked(context);
  if (blocked) throw new Error(blocked);
  const dir = String(args.directory || '').trim();
  if (!dir || !path.isAbsolute(dir)) {
    throw new Error('An absolute skill source directory is required.');
  }

  let pendingInstallName = '';
  let activationCommitted = false;
  let validatedSnapshot = '';
  try {
    const generatedDraftLocation = isGeneratedSkillDraftLocation(dir);
    const generatedDraft = readGeneratedSkillDraft(dir);
    if (!generatedDraftLocation) {
      throw new Error('Arbitrary local skill execution is disabled. Install an official Skill Hall entry, configure a curated MCP server, or generate a Lumi draft that is bound to its exact review hash.');
    }
    if (generatedDraftLocation && !generatedDraft) {
      throw new Error('Generated skill draft metadata is missing or invalid. Regenerate and review the draft instead of installing it as an ordinary local skill.');
    }
    if (generatedDraftLocation && context?.userConfirmed !== true) {
      throw new Error('Generated skill installation requires approval of its reviewed permissions, risk, side effects, and non-executing validation result.');
    }
    const approvedContentHash = String(args.reviewHash || '').trim();
    if (generatedDraftLocation && approvedContentHash !== generatedDraft!.review.contentHash) {
      throw new Error('Generated skill approval must include the exact reviewHash returned with the draft. The reviewed artifact may have changed.');
    }
    const validation = generatedDraftLocation
      ? await validateGeneratedSkillDraftForInstall(dir)
      : null;
    if (validation && !validation.valid) {
      throw new Error(`Generated skill draft validation failed: ${validation.errors.join(' | ')}`);
    }
    if (validation) {
      if (!validation.validatedDirectory || validation.review?.contentHash !== approvedContentHash) {
        throw new Error('Generated skill validation did not return the exact approved immutable snapshot.');
      }
      validatedSnapshot = validation.validatedDirectory;
    }
    const requestedName = String(args.name || '').trim();
    if (validation && requestedName && normalizeSkillInstallName(requestedName) !== validation.skillName) {
      throw new Error(`Generated skill approval is bound to the reviewed name "${validation.skillName}"; it cannot be installed as "${requestedName}".`);
    }
    const name = validation?.skillName
      || requestedName
      || dir.split(/[/\\]/).pop()
      || 'unknown';
    const destDir = await mcpManager.installSkillValidated(
      name,
      validatedSnapshot || dir,
      validation?.review
        ? {
            approvedGeneratedDraft: {
              approvedAt: new Date().toISOString(),
              review: validation.review as unknown as Record<string, unknown>,
            },
          }
        : undefined,
    );
    const installedSkillName = path.basename(destDir);
    pendingInstallName = installedSkillName;
    const manifestPath = path.join(destDir, 'package.json');
    if (!fs.existsSync(manifestPath) || fs.statSync(manifestPath).size === 0) {
      throw new Error('Skill installer returned without a non-empty installed package manifest.');
    }
    const activation = await activateInstalledSkill(installedSkillName, {
      registry,
      rollbackInstallOnFailure: true,
    });
    activationCommitted = true;
    return JSON.stringify({
      ok: true,
      status: 'installed',
      skillName: installedSkillName,
      installDirectory: destDir,
      manifestPath,
      runtimeStatus: activation.runtimeStatus,
      usable: activation.usable,
      toolCount: activation.toolCount,
      registeredToolNames: activation.registeredToolNames,
      manifestCapabilityIds: activation.manifestCapabilityIds,
      generatedDraft: generatedDraftLocation,
    });
  } catch (err: any) {
    const rollbackErrors: string[] = [];
    if (pendingInstallName && !activationCommitted) {
      try {
        await mcpManager.disconnectServer(pendingInstallName);
      } catch (rollbackError: any) {
        rollbackErrors.push(`disconnect: ${rollbackError?.message || rollbackError}`);
      }
      unregisterServerTools(pendingInstallName, registry);
      try {
        mcpManager.uninstallSkill(pendingInstallName);
      } catch (rollbackError: any) {
        rollbackErrors.push(`uninstall: ${rollbackError?.message || rollbackError}`);
      }
    }
    throw new Error(
      `Skill installation failed: ${err.message || String(err)}`
      + (rollbackErrors.length > 0 ? ` Rollback incomplete (${rollbackErrors.join(' | ')}).` : ''),
    );
  } finally {
    if (validatedSnapshot) {
      try { fs.rmSync(validatedSnapshot, { recursive: true, force: true }); } catch {}
    }
  }
}

function marketplaceScope(context?: ToolContext) {
  return {
    ownerUid: context?.userId,
    userId: context?.userId,
    domain: context?.domain,
    orgId: context?.orgId,
  };
}

async function searchSkillMarketplaceHandler(
  args: Record<string, any>,
  registry: ToolRegistry,
  context?: ToolContext,
): Promise<string> {
  const query = String(args.query || '').trim();
  const limit = Math.max(1, Math.min(30, Math.floor(Number(args.limit) || 12)));
  const lang = String(args.language || '').toLowerCase() === 'zh' ? 'zh' : undefined;
  const runtimeByName = new Map(
    getExtensionRuntimeStates(registry.getCapabilityManifest())
      .map(state => [state.name, state]),
  );
  const skills = (query
    ? searchSkills(query, lang, marketplaceScope(context))
    : getMarketplaceSkills(lang, marketplaceScope(context)))
    .sort((left, right) => (
      Number(right.installed) - Number(left.installed)
      || right.rating - left.rating
      || right.downloads - left.downloads
      || left.name.localeCompare(right.name)
    ))
    .slice(0, limit)
    .map(skill => {
      const runtime = runtimeByName.get(normalizeSkillInstallName(skill.id.replace(/^skill-/i, '')));
      return ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      author: skill.author,
      version: skill.version,
      installed: skill.installed,
      packagePresent: runtime?.packagePresent ?? false,
      officialIdentityStatus: skill.officialIdentityStatus,
      identityConflict: skill.officialIdentityStatus === 'conflict',
      conflictReason: skill.conflictReason,
      configured: runtime?.configured ?? false,
      enabled: skill.officialIdentityStatus === 'conflict' ? false : (runtime?.enabled ?? false),
      keyReady: runtime?.keyReady ?? !skill.requiresApiKey,
      runtimeStatus: skill.officialIdentityStatus === 'conflict'
        ? 'identity_conflict'
        : (runtime?.status || 'not_configured'),
      registered: skill.officialIdentityStatus === 'conflict' ? false : (runtime?.registered ?? false),
      usable: skill.officialIdentityStatus === 'conflict' ? false : (runtime?.usable ?? false),
      registeredToolNames: skill.officialIdentityStatus === 'conflict' ? [] : (runtime?.toolNames || []),
      installSource: skill.installSource,
      toolCount: skill.toolCount,
      rating: skill.rating,
      downloads: skill.downloads,
      requiresApiKey: skill.requiresApiKey === true,
      apiKeyEnv: skill.apiKeyEnv,
      requiresSetup: skill.requiresSetup === true,
      setupNote: skill.setupNote,
      installable: skill.installSource === 'bundled'
        && skill.runtimeInstallable !== false
        && Boolean(skill.installPath),
    });
    });
  return JSON.stringify({
    ok: true,
    status: 'listed',
    query,
    count: skills.length,
    skills,
    nextAction: skills.length > 0
      ? 'Reuse an installed callable skill first. Installing a new marketplace skill requires explicit confirmation and runtime registration.'
      : 'No marketplace match was found. Inspect external MCP candidates, then generate a reviewed draft only if the capability is still missing.',
  });
}

async function installMarketplaceSkillHandler(
  args: Record<string, any>,
  registry: ToolRegistry,
  context?: ToolContext,
): Promise<string> {
  const blocked = hostSkillMutationBlocked(context);
  if (blocked) throw new Error(blocked);
  if (context?.userConfirmed !== true) {
    throw new Error('Marketplace skill installation requires explicit confirmation of the selected skill and its runtime permissions.');
  }
  const skillId = String(args.skillId || '').trim();
  if (!skillId) throw new Error('A marketplace skillId is required. Search the Skill Hall first.');
  const skill = getSkillById(skillId, undefined, marketplaceScope(context));
  if (!skill) throw new Error(`Marketplace skill "${skillId}" was not found.`);
  if (skill.installSource !== 'bundled') {
    throw new Error(`Marketplace skill "${skill.name}" is discoverable but is not an approved Lumi package. No files were installed or executed.`);
  }
  if (!skill.installPath || !fs.existsSync(skill.installPath)) {
    throw new Error(`Marketplace skill "${skill.name}" has no installable package. No runtime was changed.`);
  }
  if (skill.runtimeInstallable === false) {
    throw new Error(
      `Marketplace skill "${skill.name}" uses an external executable that is not pinned to an approved runtime identity. Configure a reviewed external MCP candidate instead.`,
    );
  }
  const skillName = normalizeSkillInstallName(skill.id.replace(/^skill-/i, ''));
  const existingConfig = mcpManager.getConfig()[skillName];
  const packagePresent = fs.existsSync(path.join(SKILLS_DIR, skillName));
  if (existingConfig || packagePresent) {
    throw new Error(
      `The official Skill Hall id "${skillName}" is already occupied locally. `
      + 'Lumi will not repair, activate, or label that package as official without matching immutable provenance. Remove the conflicting package explicitly, then install the official entry again.',
    );
  }
  const installDirectory = await mcpManager.installSkillValidated(skillName, skill.installPath, {
    managedSkill: createBundledSkillIdentity(skillId, skill.installPath),
  });
  const newlyInstalled = true;
  const config = mcpManager.getConfig()[skillName];
  if (config?.enabled !== true && config?.installationState !== 'pending') {
    if (newlyInstalled) recordMarketplaceInstallBestEffort(skillId);
    return JSON.stringify({
      ok: true,
      status: 'configuration_required',
      skillId,
      skillName,
      installDirectory,
      installed: true,
      runtimeStatus: 'configuration_required',
      usable: false,
      requiresApiKey: config?.requiresApiKey === true,
      apiKeyEnv: config?.apiKeyEnv,
      registeredToolNames: [],
      manifestCapabilityIds: [],
      note: 'The package is installed, but Lumi cannot use it until its required configuration is supplied and the skill is enabled.',
    });
  }
  const activation = await activateInstalledSkill(skillName, {
    registry,
    rollbackInstallOnFailure: newlyInstalled,
  });
  if (newlyInstalled) recordMarketplaceInstallBestEffort(skillId);
  return JSON.stringify({
    ok: true,
    status: newlyInstalled ? 'installed' : 'available',
    skillId,
    skillName,
    installDirectory,
    installed: true,
    ...activation,
  });
}

export function registerSkillTools(registry: ToolRegistry): void {
  registry.register({
    name: 'skill_marketplace_search',
    description:
      'Search Lumi Skill Hall before creating new code. Returns existing official/community skills, whether each is installed and callable, setup requirements, and its stable skillId. Use this first for a missing capability; reuse an installed skill before researching external MCP or generating a new draft.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Capability or workflow to find. Empty lists the highest-priority Skill Hall entries.' },
        language: { type: 'string', enum: ['en', 'zh'], description: 'Optional display language.' },
        limit: { type: 'number', description: 'Maximum results, 1-30. Defaults to 12.' },
      },
      required: [],
    },
    handler: (args, context) => searchSkillMarketplaceHandler(args, registry, context),
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'skills.marketplace.search',
      family: 'skill-lifecycle',
      lane: 'system',
      operation: 'observe',
      risk: 'low',
      sideEffects: [],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'count', 'skills'],
        requiredValues: { ok: true, status: 'listed' },
        successStatuses: ['listed'],
        failureStatuses: ['failed'],
        successSignals: ['Skill Hall results were read from the current marketplace registry'],
        limitations: ['Discovery does not install, enable, or prove a skill can complete the current task.'],
      },
    }),
  });

  registry.register({
    name: 'skill_marketplace_install',
    description:
      'Install one exact Skill Hall entry selected by skill_marketplace_search. Requires explicit confirmation. Completion means the MCP process connected, returned tools, and those exact tools entered the live LumiCore capability manifest; a package needing API configuration is reported as installed but not usable.',
    parameters: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: 'Exact stable skillId returned by skill_marketplace_search.' },
      },
      required: ['skillId'],
    },
    handler: (args, context) => installMarketplaceSkillHandler(args, registry, context),
    permission: 'admin',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'skills.marketplace.install',
      family: 'skill-lifecycle',
      lane: 'system',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'installation', scope: 'selected Skill Hall package in the local Lumi skill directory', reversible: true },
        { type: 'local_state_change', scope: 'MCP runtime configuration and live capability manifest', reversible: true },
        { type: 'process_execution', scope: 'selected MCP skill process and dependency preparation', reversible: false },
      ],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'skillId', 'skillName', 'installed', 'runtimeStatus', 'usable', 'registeredToolNames', 'manifestCapabilityIds'],
        requiredValues: { ok: true, installed: true, runtimeStatus: 'registered', usable: true },
        successStatuses: ['installed', 'available'],
        failureStatuses: ['configuration_required', 'failed', 'blocked'],
        successSignals: ['the selected Skill Hall package is connected and its exact tools are executable in the current manifest'],
        limitations: ['Runtime registration does not by itself prove the new skill completed the user\'s domain task.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'skills.marketplace.install',
      operation: 'mutate',
      subjectArgument: 'skillId',
      limitations: ['A separate real task receipt is required before claiming the installed skill achieved a business result.'],
    }),
  });

  registry.register({
    name: 'generate_skill',
    description:
      'Generate an isolated, non-executable MCP skill draft from an explicit user request. ' +
      'The draft receives static analysis, a permission/side-effect declaration, protocol/type validation, and reproducible lock validation without executing generated code. ' +
      'It is never scanned or installed automatically; install_skill requires a separate explicit approval.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description:
            'Natural language description of what the skill should do. Be specific: describe the inputs, the processing logic, error handling, and expected output format.',
        },
        provider: {
          type: 'string',
          description: 'LLM provider to use for code generation. Default: deepseek.',
          enum: ['deepseek', 'qwen', 'openai', 'gemini', 'anthropic'],
        },
        model: {
          type: 'string',
          description: 'Specific model name. Default: inherit the current user selection.',
        },
      },
      required: ['description'],
    },
    handler: (args, context) => generateSkillHandler(args, context),
    permission: 'admin',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'skills.draft.generate',
      family: 'skill-lifecycle',
      lane: 'system',
      operation: 'create',
      risk: 'high',
      sideEffects: [
        { type: 'external_state_change', scope: 'configured LLM generation request', reversible: false },
        { type: 'local_write', scope: 'isolated non-executable skill draft in user data', reversible: true },
        { type: 'process_execution', scope: 'dependency lock preparation with lifecycle scripts disabled; generated handler code is not executed', reversible: false },
      ],
      verification: {
        strategy: 'artifact',
        required: true,
        requiredFields: ['ok', 'status', 'executable', 'installed', 'skillName', 'toolName', 'draftDirectory', 'manifestPath', 'entryPath', 'review'],
        requiredValues: {
          ok: true,
          status: 'draft',
          executable: false,
          installed: false,
          'review.status': 'draft',
          'review.staticCheck.passed': true,
          'review.trialRun.passed': true,
          'review.requiresUserApproval': true,
        },
        successStatuses: ['draft'],
        failureStatuses: ['failed', 'installed'],
        requiredArtifacts: ['manifestPath', 'entryPath'],
        successSignals: ['reviewed draft artifacts exist only in the isolated draft directory'],
        limitations: ['Draft validation does not authorize installation or prove production safety.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'skills.draft.generate',
      operation: 'create',
      subjectArgument: 'description',
      limitations: ['The generated result is intentionally non-executable and requires a separate reviewed installation.'],
    }),
  });

  registry.register({
    name: 'list_skills',
    description:
      'List all locally installed MCP skills in ~/lumi_skills/. ' +
      'Shows skill name, description, tool count, and whether it was auto-generated. ' +
      'Use before generating new skills to check for duplicates.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: () => listSkillsHandler(registry),
    permission: 'public',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'skills.local.list',
      family: 'skill-lifecycle',
      lane: 'system',
      operation: 'observe',
      risk: 'low',
      sideEffects: [],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'count', 'skills'],
        requiredValues: { ok: true, status: 'listed' },
        successStatuses: ['listed'],
        failureStatuses: ['failed'],
        successSignals: ['current package, configuration, key, health, and live manifest state was projected'],
        limitations: ['A registered tool still needs a real task receipt to prove a business outcome.'],
      },
    }),
  });

  registry.register({
    name: 'install_skill',
    description:
      'Validate and install one Lumi-generated MCP draft from its isolated review directory into ~/lumi_skills/. ' +
      'Generated Lumi drafts are rechecked for source integrity, declared permissions, static safety, protocol/type correctness, and reproducible locks without executing generated code, then require explicit user confirmation. ' +
      'After confirmation, installation succeeds only when the MCP process connects, returns tools, and those exact tools are registered in the current capability manifest.',
    parameters: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the reviewed Lumi-generated skill draft directory containing index.ts and package.json.',
        },
        name: {
          type: 'string',
          description: 'Skill name. Defaults to the directory basename.',
        },
        reviewHash: {
          type: 'string',
          description: 'For a generated draft, the exact review.contentHash returned by generate_skill and explicitly approved by the user.',
        },
      },
      required: ['directory'],
    },
    handler: (args, context) => installSkillHandler(args, registry, context),
    permission: 'admin',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'skills.package.install',
      family: 'skill-lifecycle',
      lane: 'system',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'installation', scope: 'user-maintained Lumi skills directory', reversible: true },
        { type: 'local_state_change', scope: 'MCP skill runtime configuration', reversible: true },
        { type: 'process_execution', scope: 'dependency preparation and skill validation', reversible: false },
        { type: 'network_read', scope: 'package registries required by declared dependencies', reversible: true },
      ],
      verification: {
        strategy: 'artifact',
        required: true,
        requiredFields: ['ok', 'status', 'skillName', 'installDirectory', 'manifestPath', 'runtimeStatus', 'usable', 'toolCount', 'registeredToolNames', 'manifestCapabilityIds'],
        requiredValues: { ok: true, status: 'installed', runtimeStatus: 'registered', usable: true },
        successStatuses: ['installed'],
        failureStatuses: ['failed', 'blocked'],
        requiredArtifacts: ['manifestPath'],
        successSignals: ['installed package manifest exists and the connected tools are present in the current capability manifest'],
        limitations: ['Registration proves the tool is usable by LumiCore; a real task receipt is still required to prove its domain outcome.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'skills.package.install',
      operation: 'mutate',
      subjectArgument: 'directory',
      limitations: ['The activation receipt proves current runtime registration, not success on an arbitrary user task.'],
    }),
  });
}
