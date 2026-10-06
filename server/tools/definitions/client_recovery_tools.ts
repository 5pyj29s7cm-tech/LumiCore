import type { ToolRegistry } from '../registry';
import { executeToolCallOrThrow } from '../execution_engine';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { getClientHealthReport } from '../../client/self_model';
import { mcpManager, registerConnectedSkillTools, requireSafeMCPServerName, unregisterServerTools } from '../../mcp';
import { safeRuntimeError, sanitizeDiagnosticValue } from '../../client/diagnostic_sanitizer';
import { getDurableTaskHealthSnapshot } from '../../cognition/durable_task_diagnostics';
import { getAdapterResilienceSnapshot } from '../adapter_resilience';
import { RECOVERY_SURFACE_ACTIONS, getSkillRuntimeFindings, getAutonomyDiagnosticPolicy, getAutonomyWorkflowDiagnostics } from './client_self_shared';

export function registerClientRecoveryTools(registry: ToolRegistry): void {
  registry.register({
    name: 'client_health_check',
    description: 'Run Lumi local self-governance health check: client body state, background/runtime health, runtime errors, files/voice issues, autonomy boundary, and skill runtime findings.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (_args, context) => {
      const userId = context?.userId || 'anonymous';
      const scope = { domain: context?.domain, orgId: context?.orgId };
      const isWork = context?.domain === 'work' && Boolean(context?.orgId);
      return JSON.stringify(sanitizeDiagnosticValue({
        report: getClientHealthReport(userId, scope),
        durableTasks: getDurableTaskHealthSnapshot(userId, scope),
        adapterResilience: getAdapterResilienceSnapshot(),
        skillRuntimeFindings: getSkillRuntimeFindings(),
        autonomyGate: isWork ? null : getAutonomyDiagnosticPolicy(userId),
        autonomyWorkflows: isWork ? [] : getAutonomyWorkflowDiagnostics(userId),
        scope: isWork ? { domain: 'work', orgId: context?.orgId } : { domain: 'personal' },
      }), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'client_self_repair',
    description: [
      'Perform safe Lumi client self-repair actions that do not write user files or operate external apps.',
      'Use refresh_client_state to force a state relay refresh.',
      'Use open_recovery_surface to open the relevant registered Lumi surface (skills, computer adaptation, settings, plans, knowledge, or organization).',
      'For skill package repair use client_repair_skill, which requires confirmation.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['refresh_client_state', 'open_recovery_surface'],
          description: 'Safe self-repair action.',
        },
        surface: {
          type: 'string',
          description: 'Recovery surface for open_recovery_surface: skills, logs/runtime, settings, kernel/computer, plans/autonomy, knowledge/files, organization, or voice.',
        },
      },
      required: ['action'],
    },
    handler: async (args, context) => {
      if (!context?.desktopRelay || !context.toolRegistry) {
        throw new Error('Client self-repair requires the Lumi desktop client relay.');
      }
      let actionArgs: Record<string, unknown>;
      if (args.action === 'refresh_client_state') {
        actionArgs = { action: 'refresh_client_state' };
      } else if (args.action === 'open_recovery_surface') {
        const surface = String(args.surface || 'settings').toLowerCase();
        const recovery = RECOVERY_SURFACE_ACTIONS[surface];
        if (!recovery) throw new Error(`Unknown recovery surface: ${surface}`);
        actionArgs = recovery;
      } else {
        throw new Error(`Unsupported client_self_repair action: ${args.action}`);
      }
      const clientAction = JSON.parse(await executeToolCallOrThrow({ registry: context.toolRegistry, name: 'client_action', arguments: actionArgs, context }));
      return JSON.stringify(sanitizeDiagnosticValue({
        ok: true,
        status: 'verified',
        requestedRepair: args.action,
        delegatedCapability: 'client.surface.action',
        clientAction,
      }), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      ...capabilityContract({
        id: 'client.recovery.surface',
        family: 'client-recovery',
        lane: 'client',
        operation: 'mutate',
        risk: 'low',
        sideEffects: [{ type: 'desktop_control', scope: 'Lumi client recovery surface state', reversible: true }],
        verification: {
          strategy: 'state_diff',
          required: true,
          requiredFields: ['ok', 'status', 'requestedRepair', 'delegatedCapability', 'clientAction.verification.status'],
          requiredValues: { ok: true, status: 'verified', delegatedCapability: 'client.surface.action' },
          successStatuses: ['verified'],
          failureStatuses: ['failed', 'unverified'],
          successSignals: ['authoritative client_action receipt contains verified refreshed state'],
          limitations: ['Opening a recovery surface does not prove the underlying issue was repaired.'],
        },
      }),
      deprecated: true,
      replacedBy: 'client.surface.action',
    },
    evidence: capabilityEvidence({
      id: 'client.recovery.surface',
      operation: 'mutate',
      subjectArgument: 'action',
      limitations: ['The compatibility wrapper delegates to client.surface.action and must not be selected for new plans.'],
    }),
  });

  registry.register({
    name: 'client_repair_skill',
    description: 'Restart an already approved Lumi skill/MCP server by name. When explicitly requested, repair may also rebind an unchanged, signed built-in skill to the current trusted LumiCore host runtime. Repair never follows mutable npmPackage/repoUrl metadata and never installs ordinary local dependencies.',
    parameters: {
      type: 'object',
      properties: {
        skillName: {
          type: 'string',
          description: 'Installed skill or MCP server name to repair.',
        },
      },
      required: ['skillName'],
    },
    handler: async (args, context) => {
      if (
        context?.authenticated !== true
        || context.authRole !== 'admin'
        || context.localExecution !== true
        || context.executionBoundary !== 'trusted_local'
        || context.domain === 'work'
        || Boolean(context.orgId)
      ) {
        throw new Error('Skill repair requires the authenticated local desktop administrator in the personal workspace.');
      }
      const skillName = requireSafeMCPServerName(String(args.skillName || ''));
      const priorConfig = mcpManager.getConfig();
      const priorServerConfig = Object.prototype.hasOwnProperty.call(priorConfig, skillName)
        ? structuredClone(priorConfig[skillName])
        : undefined;
      try {
        const result = await mcpManager.repairSkill(skillName);
        if (!result.success) {
          throw new Error(safeRuntimeError(result.reason) || `Skill "${skillName}" repair failed.`);
        }
        if (!result.action || !Array.isArray(result.tools) || result.tools.length < 1) {
          throw new Error(`Skill "${skillName}" repair returned without exact connected tool declarations.`);
        }
        const activation = await registerConnectedSkillTools(skillName, result.tools, {
          registry,
          serverConfig: mcpManager.getConfig()[skillName],
        });
        if (mcpManager.getConfig()[skillName]?.installationState === 'pending') {
          // A bundled restore remains crash-safe/pending until its exact live
          // declarations are present in the current capability manifest.
          mcpManager.commitSkillActivation(skillName);
        }
        return JSON.stringify(sanitizeDiagnosticValue({
          ok: true,
          status: 'repaired',
          skillName,
          action: result.action,
          directory: result.directory,
          runtimeStatus: activation.runtimeStatus,
          usable: activation.usable,
          toolCount: activation.toolCount,
          registeredToolNames: activation.registeredToolNames,
          manifestCapabilityIds: activation.manifestCapabilityIds,
        }), null, 2);
      } catch (error) {
        const rollbackErrors: string[] = [];
        try {
          unregisterServerTools(skillName, registry);
        } catch (rollbackError: any) {
          rollbackErrors.push(`registry: ${rollbackError?.message || rollbackError}`);
        }
        try {
          await mcpManager.disconnectServer(skillName);
        } catch (rollbackError: any) {
          rollbackErrors.push(`disconnect: ${rollbackError?.message || rollbackError}`);
        }
        try {
          const currentConfig = mcpManager.getConfig();
          if (priorServerConfig) currentConfig[skillName] = priorServerConfig;
          else delete currentConfig[skillName];
          mcpManager.saveConfig(currentConfig);
        } catch (rollbackError: any) {
          rollbackErrors.push(`configuration: ${rollbackError?.message || rollbackError}`);
        }
        if (rollbackErrors.length > 0) {
          throw new Error(
            `${String((error as any)?.message || error)} Repair rollback incomplete (${rollbackErrors.join(' | ')}).`,
            { cause: error },
          );
        }
        throw error;
      }
    },
    permission: 'admin',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'skills.runtime.repair',
      family: 'skill-lifecycle',
      lane: 'system',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'installation', scope: 'exact signed Lumi-bundled package runtime rebind', reversible: true },
        { type: 'local_state_change', scope: 'MCP skill runtime configuration', reversible: true },
        { type: 'process_execution', scope: 'local MCP skill process restart', reversible: true },
      ],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'skillName', 'action', 'runtimeStatus', 'usable', 'toolCount', 'registeredToolNames', 'manifestCapabilityIds'],
        requiredValues: { ok: true, status: 'repaired', runtimeStatus: 'registered', usable: true },
        successStatuses: ['repaired'],
        failureStatuses: ['failed', 'not_found', 'unverified'],
        successSignals: ['restarted MCP process returned tools and those exact tools are executable in the current capability manifest'],
        limitations: ['Registration proves the tool is usable by LumiCore; a real task receipt is still required to prove its domain outcome.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'skills.runtime.repair',
      operation: 'mutate',
      subjectArgument: 'skillName',
      limitations: ['A separate real task is required to validate functional behavior after repair.'],
    }),
  });
}
