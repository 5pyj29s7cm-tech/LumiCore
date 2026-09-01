import { Router, type NextFunction, type Request, type Response } from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { activateInstalledSkill, mcpManager } from "../mcp";
import { getMarketplaceSkills, getSkillById, searchSkills, getCategories, recordInstall, publishSkill, rateSkill, getSkillRatings } from "../marketplace/registry";
import { translateSkills } from "../skills/translations";
import { makeLLMCall, type NormalizedMessage } from "../llm/providers";
import { getUserPreferredLLMConfig } from "../llm/user_preferences";
import {
  optionalAuth,
  requireAdmin,
  requireAuth,
  requireLocalRequest,
  resolveDomain,
  type AuthUser,
} from "../middleware/auth";
import { DESKTOP_SESSION_HEADER, verifyDesktopSessionProof } from "../config/desktop_bootstrap";
import { isLoopbackAddress } from "../config/local_identity";
import { toolRegistry } from "../tools/registry";
import { getExtensionRuntimeStates } from "../skills/runtime_state";
import { createBundledSkillIdentity } from "../marketplace/official_identity";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function requireNativeDesktopSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !verifyDesktopSessionProof(req.headers[DESKTOP_SESSION_HEADER], req.user.uid)) {
    res.status(403).json({ error: 'A valid native desktop session proof is required for Skill Hall runtime changes.' });
    return;
  }
  next();
}

function requirePersonalMarketplaceMutation(req: Request, res: Response, next: NextFunction): void {
  const scope = resolveDomain(req.user!);
  if (scope.domain !== 'personal' || Boolean(scope.orgId)) {
    res.status(403).json({ error: 'Skill Hall host changes are available only in the personal administrator workspace.' });
    return;
  }
  next();
}

function marketplaceScope(user?: AuthUser) {
  if (!user) return undefined;
  const dc = resolveDomain(user);
  return {
    ownerUid: user.uid,
    userId: user.uid,
    domain: dc.domain,
    orgId: dc.orgId,
  };
}

export function resolveMarketplaceSkillDirName(input: {
  skillId?: string;
  skillName?: string;
  installPath?: string;
}): string {
  const fromId = String(input.skillId || '').trim().replace(/^skill-/i, '');
  const fromPath = input.installPath
    ? String(input.installPath).split(/[\\/]+/).filter(Boolean).pop() || ''
    : '';
  const fromName = String(input.skillName || '').trim();
  const preferred = [fromId, fromPath, fromName]
    .map(value => value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''))
    .find(Boolean);
  if (!preferred) return 'skill';
  return preferred;
}

export function publicMarketplaceSkill(skill: Record<string, any>): Record<string, any> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    author: skill.author,
    downloads: skill.downloads,
    rating: skill.rating,
    category: skill.category,
    icon: skill.icon,
    installSource: skill.installSource,
    version: skill.version,
    toolCount: skill.toolCount,
    requiresApiKey: skill.requiresApiKey === true,
    apiKeyUrl: skill.apiKeyUrl,
    requiresSetup: skill.requiresSetup === true,
    setupNote: skill.setupNote,
    runtimeInstallable: skill.runtimeInstallable === true,
  };
}

function mayReadMarketplaceRuntime(req: Request): boolean {
  return req.user?.role === 'admin' && isLoopbackAddress(req.socket?.remoteAddress);
}

export function projectMarketplaceRuntime<T extends Record<string, any>>(
  skills: T[],
  includeOperationalDetails: boolean,
): Array<Record<string, any>> {
  if (!includeOperationalDetails) return skills.map(publicMarketplaceSkill);
  const runtimeByName = new Map(
    getExtensionRuntimeStates(toolRegistry.getCapabilityManifest())
      .map(state => [state.name, state]),
  );
  return skills.map(skill => {
    const skillName = resolveMarketplaceSkillDirName({
      skillId: skill.id,
      skillName: skill.name,
      installPath: skill.installPath,
    });
    const runtime = runtimeByName.get(skillName);
    const identityVerified = skill.installSource !== 'bundled'
      || skill.officialIdentityStatus === 'verified';
    const { installPath: _installPath, ...safeSkill } = skill;
    return {
      ...safeSkill,
      packagePresent: runtime?.packagePresent ?? false,
      configured: runtime?.configured ?? false,
      enabled: identityVerified ? (runtime?.enabled ?? false) : false,
      keyReady: runtime?.keyReady ?? !skill.requiresApiKey,
      registered: identityVerified ? (runtime?.registered ?? false) : false,
      usable: identityVerified ? (runtime?.usable ?? false) : false,
      registeredToolNames: identityVerified ? (runtime?.toolNames || []) : [],
      manifestCapabilityIds: identityVerified ? (runtime?.manifestCapabilityIds || []) : [],
      runtimeStatus: skill.officialIdentityStatus === 'conflict'
        ? 'identity_conflict'
        : (runtime?.status || 'not_configured'),
    };
  });
}

async function activateMarketplaceSkill(skillName: string) {
  const config = mcpManager.getConfig()[skillName];
  if (config?.enabled !== true && config?.installationState !== 'pending') {
    return {
      skillName,
      runtimeStatus: 'configuration_required' as const,
      usable: false as const,
      toolCount: 0,
      registeredToolNames: [] as string[],
      manifestCapabilityIds: [] as string[],
      requiresApiKey: config?.requiresApiKey === true,
      apiKeyEnv: config?.apiKeyEnv,
    };
  }
  return activateInstalledSkill(skillName, { rollbackInstallOnFailure: true });
}

function marketplaceInstallMessage(displayName: string, activation: { usable: boolean }): string {
  return activation.usable
    ? `Skill "${displayName}" installed, registered, and ready to use.`
    : `Skill "${displayName}" is installed but still needs its required configuration before Lumi can use it.`;
}

function recordMarketplaceInstallBestEffort(skillId: string): void {
  try {
    recordInstall(skillId);
  } catch (error: any) {
    console.warn(`[SkillHall] Runtime activation succeeded, but install analytics could not be recorded for ${skillId}:`, error?.message || error);
  }
}

export function mountMarketplaceRoutes(
  router: Router,
  jwtSecret: string,
  io: { emit: (event: string, data: any) => void },
  llmGetters?: {
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
) {
  // Discoverable marketplace skills (dynamic from registry)
  router.get("/marketplace/skills", optionalAuth, (req, res) => {
    try {
      const q = req.query.q as string | undefined;
      const lang = req.query.lang as string | undefined;
      const scope = marketplaceScope(req.user);
      const skills = q ? searchSkills(q, lang, scope) : getMarketplaceSkills(lang, scope);
      res.json(projectMarketplaceRuntime(skills, mayReadMarketplaceRuntime(req)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Single skill detail
  router.get("/marketplace/skills/:id", optionalAuth, (req, res) => {
    try {
      const lang = req.query.lang as string | undefined;
      const skill = getSkillById(req.params.id, lang, marketplaceScope(req.user));
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      const ratings = getSkillRatings(req.params.id);
      res.json({ ...projectMarketplaceRuntime([skill], mayReadMarketplaceRuntime(req))[0], ratings });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Marketplace categories
  router.get("/marketplace/categories", optionalAuth, (req, res) => {
    try {
      const lang = req.query.lang as string | undefined;
      const scope = marketplaceScope(req.user);
      const categories = getCategories(lang, scope);
      const withCounts = categories.map(cat => {
        const skills = getMarketplaceSkills(lang, scope).filter(s => s.category === cat);
        return { name: cat, count: skills.length };
      });
      res.json(withCounts);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Discoverable community personalities
  router.get("/marketplace/personalities", (_req, res) => {
    const communityPersonalities = [
      {
        id: "sherlock",
        name: "Sherlock",
        author: "Lumi Community",
        version: "1.0.0",
        description: "A hyper-analytical detective personality. Notices patterns others miss and asks probing questions.",
        downloadCount: 3842,
        gistUrl: "",
        tags: ["analytical", "investigation", "logic"],
      },
      {
        id: "sage",
        name: "Sage",
        author: "Lumi Labs",
        version: "2.1.0",
        description: "A wise mentor personality. Draws from philosophy, history, and literature to provide thoughtful guidance.",
        downloadCount: 5190,
        gistUrl: "",
        tags: ["wisdom", "philosophy", "mentoring"],
      },
      {
        id: "hacker",
        name: "H4CK3R",
        author: "Lumi Community",
        version: "1.3.0",
        description: "Cybersecurity specialist. Thinks in exploits and defenses. Great for CTF challenges and security audits.",
        downloadCount: 7234,
        gistUrl: "",
        tags: ["security", "hacking", "technical"],
      },
      {
        id: "poet",
        name: "Poet",
        author: "Lumi Community",
        version: "1.0.0",
        description: "Creative writing companion. Crafts beautiful prose, poetry, and storytelling with lyrical flair.",
        downloadCount: 2156,
        gistUrl: "",
        tags: ["creative", "writing", "artistic"],
      },
      {
        id: "architect",
        name: "Architect",
        author: "Lumi Labs",
        version: "1.5.0",
        description: "Software architecture specialist. Designs systems, evaluates trade-offs, and writes clean abstractions.",
        downloadCount: 4678,
        gistUrl: "",
        tags: ["architecture", "design", "systems"],
      },
    ];
    res.json(communityPersonalities);
  });

  // Acquire/install a skill from the marketplace
  router.post("/marketplace/skills/acquire", requireAuth, requireAdmin, requirePersonalMarketplaceMutation, requireLocalRequest, requireNativeDesktopSession, async (req, res) => {
    try {
      const { skillId, skillName, installSource } = req.body;
      if (!skillId || !skillName) return res.status(400).json({ error: "skillId and skillName required" });
      const scope = marketplaceScope(req.user);

      // Bundled skills: install the registry-owned package, then complete the
      // same connect -> register -> manifest verification transaction used by
      // Lumi's tool-facing skill lifecycle. A copied directory alone is not a
      // usable skill.
      if (installSource === 'bundled') {
        const bundledSkill = getSkillById(skillId, undefined, scope);
        if (
          !bundledSkill
          || bundledSkill.installSource !== 'bundled'
          || !bundledSkill.installPath
          || !fs.existsSync(bundledSkill.installPath)
        ) {
          return res.status(404).json({ error: 'The requested bundled skill package is unavailable.' });
        }
        if (bundledSkill.runtimeInstallable === false) {
          return res.status(409).json({
            success: false,
            usable: false,
            reviewRequired: true,
            error: 'This bundled entry depends on an external process whose executable identity is not pinned. Configure it through the reviewed external MCP flow instead.',
          });
        }
        if (bundledSkill.officialIdentityStatus === 'conflict') {
          return res.status(409).json({
            success: false,
            usable: false,
            identityConflict: true,
            error: bundledSkill.conflictReason
              || 'The official Skill Hall id is occupied by a package or configuration with different provenance. Remove it explicitly before installing the official package.',
          });
        }

        const skillDirName = resolveMarketplaceSkillDirName({
          skillId,
          skillName,
          installPath: bundledSkill.installPath,
        });
        io.emit('skill:installing', { skillId, name: skillName, stage: 'copying' });
        try {
          await mcpManager.installSkillValidated(skillDirName, bundledSkill.installPath, {
            managedSkill: createBundledSkillIdentity(skillId, bundledSkill.installPath),
          });
          io.emit('skill:installing', { skillId, name: skillName, stage: 'connecting' });
          const activation = await activateMarketplaceSkill(skillDirName);
          recordMarketplaceInstallBestEffort(skillId);
          io.emit('skill:installed', { skillId, name: skillName, source: 'bundled' });
          return res.json({
            success: true,
            name: skillName,
            message: marketplaceInstallMessage(skillName, activation),
            ...activation,
          });
        } catch (err: any) {
          return res.status(500).json({ error: `Install failed: ${err.message}` });
        }
      }

      // Community skills: copy from bundled dir too (they are implemented there now)
      if (installSource === 'community') {
        return res.status(409).json({
          success: false,
          usable: false,
          reviewRequired: true,
          error: `Community skill "${skillName}" is discoverable but cannot execute until an immutable package review and approval transaction is available. Nothing was installed or activated.`,
        });
      }

      // npm package install — e.g. "lumi-skill-nanobanana" from npm registry
      if (installSource === 'npm' && req.body.npmPackage) {
        return res.status(409).json({
          success: false,
          usable: false,
          reviewRequired: true,
          error: 'Direct npm execution is disabled. Use a curated MCP candidate or an immutable reviewed package proposal; no package was installed.',
        });
      }

      // GitHub repo install — clone + npm install + register
      if (installSource === 'github' && req.body.repoUrl) {
        return res.status(409).json({
          success: false,
          usable: false,
          reviewRequired: true,
          error: 'Direct GitHub execution is disabled. Use a curated MCP candidate or an immutable reviewed package proposal; no repository was installed.',
        });
      }

      res.status(400).json({ error: 'Invalid installSource' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Publish a community skill
  router.post("/marketplace/publish", requireAuth, requireAdmin, requirePersonalMarketplaceMutation, requireLocalRequest, requireNativeDesktopSession, (req, res) => {
    try {
      const { name, description, author, category, icon, version, toolCount } = req.body;
      if (!name || !description) return res.status(400).json({ error: 'name and description required' });
      const skill = publishSkill({ name, description, author: author || 'Community', category: category || 'Other', icon: icon || 'Zap', version, toolCount });
      res.json({
        success: true,
        skill,
        executable: false,
        note: 'Community publication stores discovery metadata only. Executable packages require an immutable reviewed proposal.',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Rate a skill
  router.post("/marketplace/skills/:id/rate", requireAuth, (req, res) => {
    try {
      const { rating, review } = req.body;
      const userId = (req as any).user?.uid || 'anonymous';
      const result = rateSkill(req.params.id, userId, Number(rating), review);
      res.json({ success: true, rating: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get skill ratings
  router.get("/marketplace/skills/:id/reviews", (req, res) => {
    try {
      const ratings = getSkillRatings(req.params.id);
      res.json({ ratings });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Trigger batch translation of skill metadata
  router.post("/marketplace/translate", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
    try {
      const lang = (req.query.lang as string) || (req.body?.lang) || 'zh';
      if (lang === 'en') return res.json({ ok: true, message: 'English is source language' });

      const skills = getMarketplaceSkills().map(s => ({
        id: s.id,
        displayName: s.name,
        description: s.description,
        setupNote: s.setupNote,
      }));

      const translated = await translateSkills(skills, lang, async (prompt: string) => {
        if (!llmGetters) throw new Error("LLM service is not available for marketplace translation");
        const userId = (req as any).user?.uid || 'anonymous';
        const messages: NormalizedMessage[] = [
          { role: "system", content: "You are a translator. Output ONLY valid JSON." },
          { role: "user", content: prompt },
        ];
        const response = await makeLLMCall(
          messages,
          [],
          getUserPreferredLLMConfig(userId, { maxTokens: 4096 }),
          llmGetters.getDeepSeek,
          llmGetters.getGemini,
          llmGetters.getOpenAI,
          llmGetters.getAnthropic,
          llmGetters.getQwen,
          llmGetters.getOllama,
          llmGetters.getLmStudio,
          llmGetters.getArk,
          llmGetters.getXiaomi,
          llmGetters.getKimi,
          llmGetters.getGlm,
          llmGetters.getRelay,
        );
        return response.text || "";
      });

      res.json({ ok: true, translated: translated.size, lang });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Discover skills from npm registry
  router.get("/marketplace/discover/npm", async (req, res) => {
    try {
      const q = req.query.q || 'lumi-skill';
      const searchNpm = async (text: string) => {
        const params = new URLSearchParams({ text, size: '20' });
        const resp = await fetch(`https://registry.npmjs.org/-/v1/search?${params}`, {
          headers: { 'Accept': 'application/json' },
        });
        if (!resp.ok) throw new Error(`npm registry returned ${resp.status}`);
        return resp.json() as Promise<any>;
      };

      const primary = await searchNpm(`${String(q)} keywords:lumi-skill`);
      let objects = primary.objects || [];
      if (objects.length === 0 && String(q).trim() !== 'lumi-skill') {
        const fallback = await searchNpm(String(q));
        objects = fallback.objects || [];
      }

      const results = objects.map((obj: any) => ({
        id: `npm-${obj.package?.name}`,
        name: obj.package?.name,
        description: obj.package?.description || '',
        version: obj.package?.version,
        author: obj.package?.publisher?.username || obj.package?.author?.name || '',
        npmUrl: obj.package?.links?.npm,
        repository: obj.package?.links?.repository,
        installSource: 'npm' as const,
        npmPackage: obj.package?.name,
        source: 'npm',
      }));
      res.json({ source: 'npm', count: results.length, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Discover skills from GitHub topics
  router.get("/marketplace/discover/github", async (req, res) => {
    try {
      const topic = req.query.topic || 'lumi-skill';
      const url = `https://api.github.com/search/repositories?q=topic:${encodeURIComponent(String(topic))}&sort=stars&per_page=20`;
      const resp = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'LumiCore/3.0',
        },
      });
      if (!resp.ok) throw new Error(`GitHub API returned ${resp.status}`);
      const data: any = await resp.json();
      const results = (data.items || []).map((repo: any) => ({
        id: `gh-${repo.full_name}`,
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description || '',
        stars: repo.stargazers_count,
        url: repo.html_url,
        cloneUrl: repo.clone_url,
        language: repo.language,
        updatedAt: repo.updated_at,
        installSource: 'github' as const,
        repoUrl: repo.clone_url,
        source: 'github',
      }));
      res.json({ source: 'github', count: results.length, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
