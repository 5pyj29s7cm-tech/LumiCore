import { Router, Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import {
  activateInstalledSkill,
  getMCPConfig,
  mcpManager,
  normalizeSkillInstallName,
  requireSafeMCPServerName,
  unregisterServerTools,
} from "../mcp";
import {
  generateSkill,
  isGeneratedSkillDraftLocation,
  readGeneratedSkillDraft,
  validateGeneratedSkillDraftForInstall,
} from "../skills/generator";
import { getRecentWorkflows } from "../skills/worklog";
import { loadKeys } from "../config/keys";
import { requireAdmin, requireAuth, requireLocalRequest, resolveDomain } from "../middleware/auth";
import { isLoopbackAddress } from "../config/local_identity";
import { getExtensionRuntimeStates } from "../skills/runtime_state";
import { toolRegistry } from "../tools/registry";
import {
  DESKTOP_SESSION_HEADER,
  verifyDesktopSessionProof,
} from "../config/desktop_bootstrap";

const asyncHandler = (fn: (req: Request, res: Response, next?: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const GENERATED_DRAFT_APPROVAL_TTL_MS = 15 * 60_000;
type GeneratedDraftApproval = {
  uid: string;
  domain: string;
  orgId: string;
  directory: string;
  contentHash: string;
  desktopSessionDigest: string;
  expiresAt: number;
};
const generatedDraftApprovals = new Map<string, GeneratedDraftApproval>();

function desktopSessionDigest(req: Request): string {
  return crypto.createHash('sha256')
    .update(String(req.headers[DESKTOP_SESSION_HEADER] || ''))
    .digest('hex');
}

function requireNativeDesktopSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !verifyDesktopSessionProof(req.headers[DESKTOP_SESSION_HEADER], req.user.uid)) {
    res.status(403).json({ error: 'A valid native desktop session proof is required for host skill changes.' });
    return;
  }
  next();
}

function requirePersonalHostSkillScope(req: Request, res: Response, next: NextFunction): void {
  const scope = resolveDomain(req.user!);
  if (scope.domain !== 'personal' || Boolean(scope.orgId)) {
    res.status(403).json({ error: 'Host skill changes are available only in the personal administrator workspace.' });
    return;
  }
  next();
}

function issueGeneratedDraftApproval(req: Request, directory: string, contentHash: string) {
  const now = Date.now();
  for (const [nonce, approval] of generatedDraftApprovals) {
    if (approval.expiresAt <= now) generatedDraftApprovals.delete(nonce);
  }
  const approvalNonce = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + GENERATED_DRAFT_APPROVAL_TTL_MS;
  const scope = resolveDomain(req.user!);
  generatedDraftApprovals.set(approvalNonce, {
    uid: req.user!.uid,
    domain: scope.domain,
    orgId: scope.orgId || '',
    directory: path.resolve(directory),
    contentHash,
    desktopSessionDigest: desktopSessionDigest(req),
    expiresAt,
  });
  return { approvalNonce, approvalExpiresAt: new Date(expiresAt).toISOString() };
}

function consumeGeneratedDraftApproval(
  req: Request,
  directory: string,
  contentHash: string,
): { ok: true } | { ok: false; error: string } {
  const nonce = String(req.body?.approvalNonce || '').trim();
  if (!nonce) return { ok: false, error: 'A one-time generated draft approval nonce is required.' };
  const approval = generatedDraftApprovals.get(nonce);
  // A presented nonce is single-use even when the remaining binding is wrong.
  generatedDraftApprovals.delete(nonce);
  if (!approval || approval.expiresAt <= Date.now()) {
    return { ok: false, error: 'The generated draft approval expired or was already used. Review a fresh draft.' };
  }
  const scope = resolveDomain(req.user!);
  if (
    approval.uid !== req.user?.uid
    || approval.domain !== scope.domain
    || approval.orgId !== (scope.orgId || '')
    || approval.directory !== path.resolve(directory)
    || approval.contentHash !== contentHash
    || approval.desktopSessionDigest !== desktopSessionDigest(req)
  ) {
    return { ok: false, error: 'The generated draft approval is not bound to this user, workspace scope, native session, directory, and review hash.' };
  }
  return { ok: true };
}

function getStartupFailureNote(description: string | undefined): string | undefined {
  const match = String(description || '').match(/\(disabled after startup failure:\s*([^)]+)\)\s*$/i);
  return match?.[1]?.trim();
}

function stripStartupFailureNote(description: string | undefined, fallback: string): string {
  return String(description || fallback).replace(/\s*\(disabled after startup failure:[^)]+\)\s*$/i, '').trim();
}

export function mountSkillRoutes(
  router: Router,
  jwtSecret: string,
  llmGetters: {
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
  },
  io: { emit: (event: string, data: any) => void },
) {
  const activateOrRollback = async (name: string) => {
    const config = mcpManager.getConfig()[name];
    if (config?.enabled !== true && config?.installationState !== 'pending') {
      return {
        skillName: name,
        runtimeStatus: 'configuration_required' as const,
        usable: false as const,
        toolCount: 0,
        registeredToolNames: [] as string[],
        manifestCapabilityIds: [] as string[],
        requiresApiKey: config?.requiresApiKey === true,
        apiKeyEnv: config?.apiKeyEnv,
      };
    }
    return activateInstalledSkill(name, { rollbackInstallOnFailure: true });
  };

  // List all installed skills (local + external MCP servers)
  router.get("/skills", requireAuth, (req, res) => {
    try {
      const includeOperationalDetails = req.user?.role === 'admin' && isLoopbackAddress(req.socket?.remoteAddress);
      const localSkills = mcpManager.listLocalSkills();
      const mcpConfig = getMCPConfig();
      const health = mcpManager.getServerHealth();
      const allSkills = getExtensionRuntimeStates(toolRegistry.getCapabilityManifest()).map((runtime) => {
        const name = runtime.name;
        const config = mcpConfig[name];
        const local = localSkills.find(s => s.name === name);
        const serverHealth = health[name];
        const startupError = serverHealth?.lastError || getStartupFailureNote(config?.description);
        const summary = {
          name,
          description: stripStartupFailureNote(config?.description || local?.description, name),
          enabled: runtime.enabled,
          source: config?.source || local?.source || 'local',
          autoGenerated: config?.autoGenerated || local?.autoGenerated || false,
          toolCount: runtime.toolNames.length || config?.toolCount || (local?.toolCount || 0),
          connected: runtime.connected,
          registered: runtime.registered,
          usable: runtime.usable,
          runtimeStatus: runtime.status,
          registeredToolNames: runtime.toolNames,
          broken: runtime.broken,
          healthStatus: runtime.healthStatus,
          requiresApiKey: config?.requiresApiKey || false,
        };
        if (!includeOperationalDetails) return summary;
        return {
          ...summary,
          generatedFrom: config?.generatedFrom,
          installedAt: local?.installedAt || '',
          startupError,
          consecutiveCrashes: serverHealth?.consecutiveCrashes || 0,
          lastCrashTime: serverHealth?.lastCrashTime,
          lastSuccessfulConnect: serverHealth?.lastSuccessfulConnect,
          apiKeyEnv: config?.apiKeyEnv,
          apiKeyUrl: config?.apiKeyUrl,
        };
      });
      res.json({ skills: allSkills });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Generate a skill from description or workflows
  router.post("/skills/generate", requireAuth, requireAdmin, requirePersonalHostSkillScope, requireLocalRequest, requireNativeDesktopSession, asyncHandler(async (req, res) => {
    try {
      const { description, provider, model } = req.body;
      const dc = resolveDomain(req.user!);

      let workflows;
      if (req.body.workflowIds) {
        const allWorkflows = getRecentWorkflows(req.user!.uid, dc.domain, dc.orgId);
        workflows = allWorkflows.filter(w => (req.body.workflowIds as string[]).includes(w.id));
      } else if (req.body.useRecent) {
        workflows = getRecentWorkflows(req.user!.uid, dc.domain, dc.orgId).slice(-5);
      }

      const result = await generateSkill(
        {
          description,
          workflows,
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          userId: req.user!.uid,
        },
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
        llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi,
        llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
      );

      if (result.success) {
        if (!result.directory || !result.review?.contentHash) {
          return res.status(500).json({ error: 'Generated draft review identity is incomplete.' });
        }
        const approval = issueGeneratedDraftApproval(req, result.directory, result.review.contentHash);
        res.json({
          ...result,
          ...approval,
          activated: false,
          note: 'Draft created in the isolated Lumi data directory. Review and explicitly install it before use.',
        });
      } else {
        res.status(400).json(result);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));

  // Install a skill from git/npm/local
  router.post("/skills/install", requireAuth, requireAdmin, requirePersonalHostSkillScope, requireLocalRequest, requireNativeDesktopSession, async (req, res) => {
    try {
      const { source, url, package: pkgName, path: localPath, name } = req.body;

      if ((source === 'git' || source === 'github' || source === 'npm') && (url || pkgName)) {
        return res.status(409).json({
          success: false,
          usable: false,
          reviewRequired: true,
          error: 'Direct third-party package execution is disabled. Use a curated external MCP candidate or an immutable reviewed package proposal.',
        });
      } else if (source === 'local' && localPath) {
        const generatedDraftLocation = isGeneratedSkillDraftLocation(localPath);
        if (!generatedDraftLocation) {
          return res.status(409).json({
            success: false,
            usable: false,
            reviewRequired: true,
            error: 'Arbitrary local skill execution is disabled. Only a Lumi-generated draft bound to its exact review hash can use this installation route.',
          });
        }
        const generatedDraft = readGeneratedSkillDraft(localPath);
        if (generatedDraftLocation && !generatedDraft) {
          return res.status(400).json({
            error: 'Generated skill draft metadata is missing or invalid. Regenerate and review the draft instead of installing it as an ordinary local skill.',
          });
        }
        if (generatedDraftLocation && req.body.approved !== true) {
          return res.status(409).json({
            error: 'Generated skill draft installation requires approved=true after reviewing permissions, risk, side effects, and non-executing validation results.',
            draft: generatedDraft,
          });
        }
        const approvedContentHash = String(req.body.approvedContentHash || '').trim();
        if (generatedDraftLocation && approvedContentHash !== generatedDraft!.review.contentHash) {
          return res.status(409).json({
            error: 'The approval does not match the current generated skill review hash. Review the draft again before installing it.',
          });
        }
        const approval = consumeGeneratedDraftApproval(req, localPath, approvedContentHash);
        if (!approval.ok) {
          const approvalError = 'error' in approval
            ? approval.error
            : 'The generated draft approval could not be verified.';
          return res.status(409).json({ error: approvalError });
        }
        const validation = generatedDraftLocation
          ? await validateGeneratedSkillDraftForInstall(localPath)
          : null;
        if (validation && !validation.valid) {
          return res.status(400).json({
            error: 'Generated skill draft validation failed.',
            details: validation.errors,
          });
        }
        if (validation && (
          !validation.validatedDirectory
          || validation.review?.contentHash !== approvedContentHash
        )) {
          return res.status(409).json({
            error: 'Generated skill validation did not return the exact approved immutable snapshot.',
          });
        }
        const requestedName = String(name || '').trim();
        if (validation && requestedName && normalizeSkillInstallName(requestedName) !== validation.skillName) {
          return res.status(409).json({
            error: `The approval is bound to generated skill "${validation.skillName}" and cannot install it as "${requestedName}".`,
          });
        }
        const skillName = normalizeSkillInstallName(validation?.skillName || requestedName || path.basename(localPath));
        const validatedSnapshot = validation?.validatedDirectory || '';
        let destDir = '';
        try {
          destDir = await mcpManager.installSkillValidated(
            skillName,
            validatedSnapshot || localPath,
            validation?.review
              ? {
                  approvedGeneratedDraft: {
                    approvedAt: new Date().toISOString(),
                    review: validation.review as unknown as Record<string, unknown>,
                  },
                }
              : undefined,
          );
        } finally {
          if (validatedSnapshot) {
            try { fs.rmSync(validatedSnapshot, { recursive: true, force: true }); } catch {}
          }
        }
        const activation = await activateOrRollback(skillName);
        try { fs.rmSync(localPath, { recursive: true, force: true }); } catch {}
        res.json({ success: true, name: skillName, directory: destDir, ...activation });
      } else {
        res.status(400).json({ error: 'Invalid source. Install an official Skill Hall entry, configure a curated MCP candidate, or provide a reviewed Lumi-generated draft.' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Repair is a pure restart, except for an exact package bundled with this build.
  router.post("/skills/:name/repair", requireAuth, requireAdmin, requirePersonalHostSkillScope, requireLocalRequest, requireNativeDesktopSession, async (req, res) => {
    try {
      const result = await mcpManager.repairSkill(req.params.name);
      if (!result.success) return res.status(400).json(result);
      const activation = await activateInstalledSkill(req.params.name);
      io.emit('skill:updated', { name: req.params.name });
      res.json({ ...result, ...activation });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Explicitly clean incomplete local skills
  router.delete("/skills/broken", requireAuth, requireAdmin, requirePersonalHostSkillScope, requireLocalRequest, requireNativeDesktopSession, async (_req, res) => {
    try {
      const removed = mcpManager.cleanupBrokenSkills();
      for (const name of removed) {
        unregisterServerTools(name);
        try { await mcpManager.disconnectServer(name); } catch {}
        io.emit('skill:uninstalled', { name });
      }
      res.json({ success: true, removed });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Uninstall a skill
  router.delete("/skills/:name", requireAuth, requireAdmin, requirePersonalHostSkillScope, requireLocalRequest, requireNativeDesktopSession, async (req, res) => {
    try {
      try { await mcpManager.disconnectServer(req.params.name); } catch {}
      unregisterServerTools(req.params.name);
      mcpManager.uninstallSkill(req.params.name);
      io.emit('skill:uninstalled', { name: req.params.name });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Enable a skill
  router.post("/skills/:name/enable", requireAuth, requireAdmin, requirePersonalHostSkillScope, requireLocalRequest, requireNativeDesktopSession, async (req, res) => {
    try {
      const skillName = requireSafeMCPServerName(req.params.name);
      const config = getMCPConfig();
      if (!Object.prototype.hasOwnProperty.call(config, skillName)) return res.status(404).json({ error: 'Skill not found' });
      const skillConfig = config[skillName];
      if (skillConfig.source === 'local') {
        mcpManager.assertLocalSkillRuntimeIdentity(skillName, skillConfig);
      }
      if (skillConfig.requiresApiKey && skillConfig.apiKeyEnv) {
        const stored = loadKeys()[skillConfig.apiKeyEnv]?.trim();
        const fromEnv = process.env[skillConfig.apiKeyEnv]?.trim();
        if (!stored && !fromEnv) {
          return res.status(400).json({
            error: `Configure ${skillConfig.apiKeyEnv} before enabling this skill.`,
            requiresApiKey: true,
            apiKeyEnv: skillConfig.apiKeyEnv,
            apiKeyUrl: skillConfig.apiKeyUrl,
          });
        }
      }
      if (skillConfig.installationState === 'active') {
        skillConfig.enabled = true;
      } else {
        skillConfig.enabled = false;
        skillConfig.installationState = 'pending';
      }
      mcpManager.saveConfig(config);
      const activation = await activateInstalledSkill(skillName);
      res.json({ success: true, ...activation });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Disable a skill
  router.post("/skills/:name/disable", requireAuth, requireAdmin, requirePersonalHostSkillScope, requireLocalRequest, requireNativeDesktopSession, async (req, res) => {
    try {
      const skillName = requireSafeMCPServerName(req.params.name);
      const config = getMCPConfig();
      if (!Object.prototype.hasOwnProperty.call(config, skillName)) return res.status(404).json({ error: 'Skill not found' });
      config[skillName].enabled = false;
      mcpManager.saveConfig(config);
      await mcpManager.disconnectServer(skillName);
      const unregistered = unregisterServerTools(skillName);
      res.json({ success: true, unregistered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Workflow inspection (for debugging / manual generation)
  router.get("/skills/workflows", requireAuth, (req, res) => {
    const dc = resolveDomain(req.user!);
    const workflows = getRecentWorkflows(req.user!.uid, dc.domain, dc.orgId);
    res.json({ workflows: workflows.slice(-20), total: workflows.length });
  });
}
