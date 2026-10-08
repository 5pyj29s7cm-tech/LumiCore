import type { ToolRegistry } from "../../tools/registry";
import type { ToolExecutionRecord, ToolContext } from "../../tools/types";
import { executionBeforeWorkflowSave } from "../../skills/authoring_intent";
import { buildActionEvidenceContract, requiresArtifactOpen } from "../../cognition/action_contract";
import { requestedSingleArtifact } from "../../cognition/artifact_write_scope";
import { getExactRegisteredExtensionToolNames } from "../../extensions/registry";

export const MAX_DYNAMIC_DISCOVERY_TOOLS = 8;

export function parseDiscoveredModelToolNames(
  records: ToolExecutionRecord[],
  discoveryToolName: string,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  // A model may first ask a broad inventory question and then refine it after
  // seeing the receipt. Read newest-to-oldest so the refined, current query
  // owns the bounded dynamic slots instead of being permanently crowded out
  // by the first broad result. Registry policy still filters every declaration
  // later, and this never raises MAX_DYNAMIC_DISCOVERY_TOOLS.
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record.name !== discoveryToolName
      || Boolean(record.error)
      || !String(record.arguments?.query || '').trim()
      || !(
        record.terminalVerification?.status === 'verified'
        || record.envelope?.status === 'verified_success'
      )
    ) continue;
    try {
      const parsed = JSON.parse(String(record.result || ''));
      const capabilities = Array.isArray(parsed?.capabilities) ? parsed.capabilities : [];
      for (const capability of capabilities) {
        if (capability?.executableThisTurn !== true) continue;
        const name = String(capability?.toolName || '').trim();
        if (!name || name === discoveryToolName || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
        if (names.length >= MAX_DYNAMIC_DISCOVERY_TOOLS) return names;
      }
    } catch {
      // Only the canonical manifest's structured receipt can expand schemas.
    }
  }
  return names;
}

export const RUNTIME_ACTIVATION_CAPABILITIES = new Map([
  ['install_skill', 'skills.package.install'],
  ['skill_marketplace_install', 'skills.marketplace.install'],
  ['client_repair_skill', 'skills.runtime.repair'],
  ['external_control_configure_candidate', 'external-control.candidate.configure'],
  ['extension_registry_install', 'extension.registry.install'],
  ['extension_registry_rollback', 'extension.registry.rollback'],
]);

export function verifiedRuntimeActivatedToolNames(
  context: ToolContext | undefined,
  records: ToolExecutionRecord[],
  toolRegistry?: ToolRegistry,
): string[] {
  if (!toolRegistry) return [];
  const currentTaskId = String(context?.taskId || '').trim();
  const names = records
    .slice(-8)
    .flatMap(record => {
      const expectedCapabilityId = RUNTIME_ACTIVATION_CAPABILITIES.get(record.name);
      if (
        !expectedCapabilityId
        || record.capability?.capabilityId !== expectedCapabilityId
        || !currentTaskId
        || record.taskId !== currentTaskId
        || record.error
        || record.terminalVerification?.status !== 'verified'
      ) return [];
      try {
        const payload = JSON.parse(String(record.result || '{}'));
        const registeredRuntime = payload?.runtimeStatus === 'registered'
          || (payload?.registered === true && payload?.connected === true);
        if (
          payload?.ok !== true
          || payload?.usable !== true
          || !registeredRuntime
          || !Array.isArray(payload?.registeredToolNames)
        ) return [];

        if (record.name === 'extension_registry_install' || record.name === 'extension_registry_rollback') {
          // Signed extension activation may widen only the exact durable task
          // that produced the verified receipt. The registry owns the final
          // identity check; payload-declared names never grant authority.
          return getExactRegisteredExtensionToolNames({
            extensionId: String(payload.extensionId || ''),
            revisionId: String(payload.revisionId || ''),
            userId: String(context?.userId || 'anonymous'),
            manifestDigest: String(payload.manifestDigest || ''),
            registry: toolRegistry,
          });
        }

        return payload.registeredToolNames
          .map((name: unknown) => String(name || '').trim())
          .filter((name: string) => {
            if (!name) return false;
            const manifest = toolRegistry.getCapabilityManifestEntry(name, context?.toolPolicy, context);
            return manifest?.executable === true;
          });
      } catch {
        return [];
      }
    });
  return Array.from(new Set(names.filter(Boolean)));
}

export function refreshRuntimeActivatedToolAuthorization(
  context: ToolContext | undefined,
  records: ToolExecutionRecord[],
  toolRegistry: ToolRegistry,
): void {
  if (!context?.toolPolicy) return;
  const activated = verifiedRuntimeActivatedToolNames(context, records, toolRegistry);
  if (activated.length === 0) return;
  const forbidden = new Set(context.toolPolicy.forbiddenTools || []);
  if (forbidden.has('*')) return;
  const exactAllowed = activated.filter(name => !forbidden.has(name));
  if (exactAllowed.length === 0) return;
  context.toolPolicy = {
    ...context.toolPolicy,
    allowedTools: Array.from(new Set([
      ...(context.toolPolicy.allowedTools || []),
      ...exactAllowed,
    ])),
  };
}

/**
 * Resolve the current declaration projection. Discovery results may replace
 * low-priority initial schemas, but never increase the per-turn schema cap;
 * registry policy filtering remains authoritative after this step.
 */
export function resolveModelVisibleToolNames(
  context: ToolContext | undefined,
  records: ToolExecutionRecord[],
  toolRegistry?: ToolRegistry,
): string[] | undefined {
  const projection = context?.modelToolProjection;
  if (!projection) return undefined;
  const maxTools = Math.max(0, Math.min(32, Math.floor(projection.maxTools || 0)));
  if (maxTools === 0) return [];
  const dropped = new Set(
    (projection.droppedToolNames || []).map(name => String(name || '').trim()).filter(Boolean),
  );
  const initial = Array.from(new Set(
    (projection.toolNames || []).map(name => String(name || '').trim()).filter(Boolean),
  )).filter(name => !dropped.has(name)).slice(0, maxTools);
  const activatedRuntimeTools = verifiedRuntimeActivatedToolNames(context, records, toolRegistry)
    .filter(name => !dropped.has(name));
  if (!projection.allowDynamicDiscovery && activatedRuntimeTools.length === 0) return initial;

  const discoveryToolName = String(
    projection.discoveryToolName || 'client_capability_manifest',
  ).trim();
  const discovered = parseDiscoveredModelToolNames(records, discoveryToolName)
    .filter(name => !dropped.has(name));
  const remaining = initial.filter(name => (
    name !== discoveryToolName
    && !activatedRuntimeTools.includes(name)
    && !discovered.includes(name)
  ));
  const keepDiscovery = initial.includes(discoveryToolName) && maxTools > 0;
  const ordinaryLimit = Math.max(0, maxTools - (keepDiscovery ? 1 : 0));
  const visible = Array.from(new Set([
    ...activatedRuntimeTools,
    ...discovered,
    ...remaining,
  ])).slice(0, ordinaryLimit);
  if (keepDiscovery) visible.push(discoveryToolName);
  return visible;
}

export function parseVerifiedSameTaskReceipt(
  records: ToolExecutionRecord[],
  context: ToolContext | undefined,
  toolName: string,
  capabilityId: string,
): any | null {
  const taskId = String(context?.taskId || '').trim();
  if (!taskId) return null;
  for (const record of records.slice().reverse()) {
    if (
      record.name !== toolName
      || record.taskId !== taskId
      || record.error
      || record.terminalVerification?.status !== 'verified'
      || record.capability?.capabilityId !== capabilityId
    ) continue;
    try {
      return JSON.parse(String(record.result || '{}'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Model-selected Skill generation is the last reuse route, never the first.
 * The read-only host receipts must belong to this exact durable task so
 * copied chat text or an older task cannot manufacture permission to generate.
 */
export function hasSameTaskSkillGenerationDiscovery(
  records: ToolExecutionRecord[],
  context: ToolContext | undefined,
): boolean {
  const marketplace = parseVerifiedSameTaskReceipt(
    records,
    context,
    'skill_marketplace_search',
    'skills.marketplace.search',
  );
  const extensionPlan = parseVerifiedSameTaskReceipt(
    records,
    context,
    'self_extension_plan',
    'self-extension.plan',
  );
  const marketplaceSkills = Array.isArray(marketplace?.skills)
    ? marketplace.skills
    : Array.isArray(extensionPlan?.existingCoverage?.marketplaceSkills)
      ? extensionPlan.existingCoverage.marketplaceSkills
      : null;
  const noInstallableSkill = Array.isArray(marketplaceSkills)
    && marketplaceSkills.every((skill: any) => skill?.installable !== true || skill?.installed === true);
  const signedExtensions = Array.isArray(extensionPlan?.existingCoverage?.signedExtensions)
    ? extensionPlan.existingCoverage.signedExtensions
    : null;
  const noUsableSignedExtension = Array.isArray(signedExtensions)
    && signedExtensions.every((extension: any) => extension?.usable !== true);
  const externalCandidates = parseVerifiedSameTaskReceipt(
    records,
    context,
    'external_control_candidates',
    'external-control.candidate.list',
  );
  const research = parseVerifiedSameTaskReceipt(
    records,
    context,
    'capability_research',
    'capability.external.research',
  );
  return noInstallableSkill
    && noUsableSignedExtension
    && externalCandidates?.ok === true
    && externalCandidates?.status === 'listed'
    && Array.isArray(externalCandidates?.candidates)
    && research?.ok === true
    && research?.status === 'researched'
    && Array.isArray(research?.candidates);
}

export function taskExplicitlyNamesTool(task: string, toolName: string): boolean {
  const escaped = String(toolName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return false;
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, 'i')
    .test(String(task || ''));
}

/**
 * Identify schemas a local 4096-token attempt may not discard. The already
 * ordered declaration array remains authoritative: hard projections retain
 * every declaration, while a dynamic route retains its semantic winner,
 * explicitly requested/previously executed tools, and discovery.
 */
export function resolveRequiredToolNamesForModel(
  context: ToolContext | undefined,
  primaryTask: string,
  declarations: Array<{ function: { name: string } }>,
  records: ToolExecutionRecord[],
): string[] {
  const orderedNames = declarations
    .map(declaration => String(declaration.function.name || '').trim())
    .filter(Boolean);
  if (orderedNames.length === 0) return [];
  const declared = new Set(orderedNames);
  const required = new Set<string>();
  const projection = context?.modelToolProjection;

  // `toolNames` is the optional model choice set.  Never promote the entire
  // hard projection (often 20-32 verbose schemas) into an unshrinkable request
  // merely because this is a trusted continuation.  The pipeline records the
  // exact pinned/workflow/verification subset separately.
  for (const name of projection?.requiredToolNames || []) {
    if (declared.has(name)) required.add(name);
  }
  // The first declaration is the semantic/routed winner and is the minimum
  // viable action door when no richer server-owned requirement is available.
  required.add(orderedNames[0]);
  for (const name of orderedNames) {
    if (taskExplicitlyNamesTool(primaryTask, name)) required.add(name);
  }
  for (const record of records) {
    const name = String(record?.name || '').trim();
    if (declared.has(name)) required.add(name);
  }
  for (const name of buildActionEvidenceContract(primaryTask, undefined, context?.acceptedActionContract).verificationTools || []) {
    if (declared.has(name)) required.add(name);
  }
  // Opening a generated deliverable is a requested execution step, not an
  // optional schema that may be dropped when compacting for a local model.
  if (requiresArtifactOpen(primaryTask) && declared.has('desktop_open')
    && declarations.some(tool => /^(?:create|modify)_(?:docx|xlsx|pptx|pdf)$/.test(tool.function.name))) {
    required.add('desktop_open');
  }
  const artifact = requestedSingleArtifact(primaryTask);
  if (artifact && declared.has(artifact.reader)) required.add(artifact.reader);
  if (artifact?.producer === 'create_xlsx' && records.some(record =>
    record.name === 'create_xlsx' && record.terminalVerification?.status === 'verified')
    && declared.has('modify_xlsx')) required.add('modify_xlsx');
  if (executionBeforeWorkflowSave(primaryTask) && declared.has('code_execution')) required.add('code_execution');
  const discovery = String(
    projection?.discoveryToolName || 'client_capability_manifest',
  ).trim();
  if (declared.has(discovery)) required.add(discovery);
  if (declared.has('capability_gap_autofix')) required.add('capability_gap_autofix');
  return orderedNames.filter(name => required.has(name));
}
