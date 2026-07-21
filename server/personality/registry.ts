import fs from 'fs';
import path from 'path';
import { PersonalityConfig, PersonalityContext, PersonalityEvolutionAudit } from './types';
import { generateSystemPrompt, initVectorFromStyle, vectorToTone, vectorToVerbosity, constrainVectorPairs } from './engine';
import { Memory } from '../memory/types';
import { EmotionalState } from './state';
import { EvolutionStep, EvolutionConfig, DEFAULT_EVOLUTION_CONFIG } from './evolution';
import { readDB, writeDB } from '../../db_layer';

interface UserPersonalityState {
  schemaVersion: 1;
  personalityVersion: string;
  expressionStyle?: PersonalityConfig['expressionStyle'];
  personalityVector?: PersonalityConfig['personalityVector'];
  growthState?: PersonalityConfig['growthState'];
  lastEvolvedAt?: string | null;
  evolutionHistory?: any[];
  evolutionAudit?: PersonalityEvolutionAudit[];
  evolutionFrozenAt?: string | null;
}

const USER_PERSONALITY_STATE_PREFIX = 'personality_user_state:';

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

class PersonalityRegistry {
  private personalities: Map<string, PersonalityConfig> = new Map();
  private loaded = false;
  private broadcastFn: ((event: string, data: any) => void) | null = null;

  /** Set a broadcast callback for real-time evolution events */
  setBroadcast(fn: (event: string, data: any) => void): void {
    this.broadcastFn = fn;
  }

  /** Load the stable personality core. Owner-specific growth is loaded separately per user. */
  load(configPath?: string): void {
    if (this.loaded) return;

    const factoryPath = configPath || path.join(process.cwd(), 'server', 'personality', 'personalities.json');
    const altFactoryPath = path.join(process.cwd(), '..', 'server', 'personality', 'personalities.json');

    // Only the factory core is loaded globally. Personal and organization growth
    // states are overlaid from scoped database records at request time.
    let raw: string = '';
    let loadedFrom = '';
    for (const p of [factoryPath, altFactoryPath]) {
      try { raw = fs.readFileSync(p, 'utf-8'); loadedFrom = p; break; } catch {}
    }

    if (!loadedFrom) {
      console.warn('[Personality] Config not found, using built-in defaults');
      this.loadBuiltins();
      this.loaded = true;
      return;
    }

    try {
      const configs: PersonalityConfig[] = JSON.parse(raw);
      for (const config of configs) {
        this.personalities.set(config.id, config);
      }
      console.log(`[Personality] Loaded ${this.personalities.size} personalities`);
    } catch (err) {
      console.error('[Personality] Failed to parse config:', err);
      this.loadBuiltins();
    }

    this.loaded = true;
  }

  /** Minimal built-in fallback if the config file is missing */
  private loadBuiltins(): void {
    const lumi: PersonalityConfig = {
      id: 'lumi',
      name: 'Lumi',
      version: '2.2-builtin',
      coreMotivation: 'You are Lumi, a warm and helpful desktop AI companion. Answer questions directly and naturally first. Only use agent orchestration for genuinely complex multi-step tasks.',
      behavioralBoundaries: ['Do not pretend to be human', 'Do not share data between users', 'Do not execute destructive system commands without confirmation'],
      expressionStyle: {
        persona: 'a native desktop AI agent and master orchestrator',
        tone: 'inspiring',
        verbosity: 'balanced',
        languages: ['zh', 'en'],
        vocabularyHints: ['全息', '进化', '分布式'],
      },
      toolPolicy: {
        allowedTools: ['*'],
        requireConfirmation: ['code_execution'],
        forbiddenTools: [],
        securityOverrides: {
          desktop_run_command: 'safe',
          cad_prepare_autocad_operations: 'safe',
          'mcp_cad-drafting_autocad_new_document': 'safe',
          'mcp_cad-drafting_autocad_playback_file': 'safe',
        },
        maxIterations: 35,
      },
      memoryPolicy: { retrieveLimit: 5, minConfidence: 0.4, includeTypes: ['preference', 'fact', 'habit', 'knowledge'], autoExtract: true },
      ttsVoiceId: 'longxiaochun_v3',
      voiceInstructions: 'Speak warmly and proactively. Be the user\'s trusted desktop companion.',
      personalityVector: {
        cognitiveStyle: { analytical: 0.3, intuitive: 0.7, systematic: 0.3, creative: 0.6 },
        socialStyle: { warmth: 0.6, directness: 0.3, playfulness: 0.3, formality: 0.3 },
      },
      evolutionConfig: {
        plasticity: 0.3,
        minMemoriesForEvolution: 10,
        minConnectionForEvolution: 0.2,
        cooldownMs: 604800000,
        maxMutationsPerStep: 3,
      },
    };
    this.personalities.set('lumi', lumi);
    console.log('[Personality] Loaded built-in fallback personality');
  }

  /** Force-reload personalities from disk */
  reload(configPath?: string): void {
    this.personalities.clear();
    this.loaded = false;
    this.load(configPath);
  }

  get(id: string): PersonalityConfig | undefined {
    if (!this.loaded) this.load();
    return this.personalities.get(id);
  }

  getDefault(): PersonalityConfig {
    if (!this.loaded) this.load();
    return this.personalities.get('lumi')!;
  }

  private userStateKey(personalityId: string, userId: string, orgId?: string): string {
    const owner = orgId ? `org:${orgId}:member:${userId}` : `personal:${userId}`;
    return `${USER_PERSONALITY_STATE_PREFIX}${personalityId}:${owner}`;
  }

  private loadUserState(personalityId: string, userId: string, orgId?: string): UserPersonalityState | null {
    if (!userId) return null;
    try {
      const db = readDB();
      const row = (db.settings || []).find((item: any) => item.key === this.userStateKey(personalityId, userId, orgId));
      if (!row?.value) return null;
      const parsed = JSON.parse(row.value);
      return parsed?.schemaVersion === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  private saveUserState(personalityId: string, userId: string, config: PersonalityConfig, orgId?: string): void {
    if (!userId) return;
    const state: UserPersonalityState = {
      schemaVersion: 1,
      personalityVersion: config.version,
      expressionStyle: cloneConfig(config.expressionStyle),
      personalityVector: config.personalityVector ? cloneConfig(config.personalityVector) : undefined,
      growthState: config.growthState ? cloneConfig(config.growthState) : undefined,
      lastEvolvedAt: config.lastEvolvedAt,
      evolutionHistory: cloneConfig(config.evolutionHistory || []),
      evolutionAudit: cloneConfig(config.evolutionAudit || []),
      evolutionFrozenAt: config.evolutionFrozenAt,
    };
    const db = readDB();
    if (!db.settings) db.settings = [];
    const key = this.userStateKey(personalityId, userId, orgId);
    const row = db.settings.find((item: any) => item.key === key);
    const value = JSON.stringify(state);
    if (row) row.value = value;
    else db.settings.push({ key, value });
    writeDB(db);
  }

  getForUser(personalityId: string, userId?: string, orgId?: string): PersonalityConfig | undefined {
    const base = this.get(personalityId);
    if (!base || !userId) return base;
    const config = cloneConfig(base);
    delete config.growthState;
    delete config.lastEvolvedAt;
    delete config.evolutionHistory;
    delete config.evolutionAudit;
    delete config.evolutionFrozenAt;

    const applyState = (state: UserPersonalityState | null, includeGrowth: boolean) => {
      if (!state) return;
      config.version = state.personalityVersion || config.version;
      if (state.expressionStyle) config.expressionStyle = cloneConfig(state.expressionStyle);
      if (state.personalityVector) config.personalityVector = cloneConfig(state.personalityVector);
      if (!includeGrowth) return;
      if (state.growthState) config.growthState = cloneConfig(state.growthState);
      config.lastEvolvedAt = state.lastEvolvedAt;
      config.evolutionHistory = cloneConfig(state.evolutionHistory || []);
      config.evolutionAudit = cloneConfig(state.evolutionAudit || []);
      config.evolutionFrozenAt = state.evolutionFrozenAt;
    };

    const personalState = this.loadUserState(personalityId, userId);
    if (!orgId) {
      applyState(personalState, true);
      return config;
    }

    // Work keeps the member's recognizable Lumi style, then adds only that
    // member's organization-specific adaptation. Private growth details never
    // become organization context, and another member cannot change this key.
    applyState(personalState, false);
    applyState(this.loadUserState(personalityId, userId, orgId), true);
    return config;
  }

  list(): PersonalityConfig[] {
    if (!this.loaded) this.load();
    return Array.from(this.personalities.values());
  }

  /**
   * Apply an evolution step to a personality, persisting the changes.
   * Returns the updated config.
   */
  applyEvolution(personalityId: string, step: EvolutionStep, options?: { force?: boolean; userId?: string; orgId?: string }): PersonalityConfig | null {
    const config = this.getForUser(personalityId, options?.userId, options?.orgId);
    if (!config) return null;
    if (config.evolutionFrozenAt && !options?.force) return null;
    const audit = this.buildEvolutionAudit(step);

    // Apply each mutation
    for (const m of step.mutations) {
      this.applyMutation(config, m);
    }

    // Apply Jungian pair constraints — keep the vector psychologically coherent
    if (config.personalityVector) {
      config.personalityVector = constrainVectorPairs(config.personalityVector);
      // Re-sync discrete fields after constraint
      config.expressionStyle.tone = vectorToTone(config.personalityVector);
      config.expressionStyle.verbosity = vectorToVerbosity(config.personalityVector);
    }

    // Update version
    config.version = step.version;

    // Store evolution metadata
    const extConfig = config as any;
    extConfig.lastEvolvedAt = step.timestamp;
    if (!extConfig.evolutionHistory) extConfig.evolutionHistory = [];
    if (!extConfig.evolutionAudit) extConfig.evolutionAudit = [];
    extConfig.evolutionAudit.push(audit);
    extConfig.evolutionHistory.push({
      auditId: audit.id,
      version: step.version,
      timestamp: step.timestamp,
      trigger: step.trigger,
      depth: step.depth || 'full',
      ownerProfile: step.ownerProfile,
      mutations: step.mutations,
      narrative: step.narrative,
    });

    if (options?.userId) this.saveUserState(personalityId, options.userId, config, options.orgId);
    else this.save();

    // Broadcast real-time evolution event
    if (this.broadcastFn) {
      this.broadcastFn('personality:evolved', {
        personalityId,
        userId: options?.userId,
        orgId: options?.orgId,
        version: step.version,
        narrative: step.narrative,
        mutations: step.mutations,
        timestamp: step.timestamp,
      });
    }

    console.log(`[Personality] ${config.name} evolved to ${step.version}: ${step.mutations.length} mutation(s)`);
    return config;
  }

  /** Apply a single mutation by dot-path */
  private applyMutation(config: PersonalityConfig, mutation: EvolutionStep['mutations'][0]): void {
    const parts = mutation.field.split('.');

    // Auto-initialize personalityVector when mutations target it
    if (parts[0] === 'personalityVector' && !config.personalityVector) {
      config.personalityVector = initVectorFromStyle(config.expressionStyle);
    }
    if (parts[0] === 'growthState' && parts.length > 1 && !config.growthState) {
      config.growthState = {
        version: 0,
        lastUpdatedAt: new Date().toISOString(),
        ownerInterests: [],
        ownerExpressions: [],
        communicationPatterns: [],
        adaptationNotes: [],
      };
    }

    let target: any = config;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target[parts[i]];
      if (!target) return;
    }
    target[parts[parts.length - 1]] = mutation.to;

    // After vector mutation, sync discrete fields derived from the vector
    if (parts[0] === 'personalityVector' && config.personalityVector) {
      config.expressionStyle.tone = vectorToTone(config.personalityVector);
      config.expressionStyle.verbosity = vectorToVerbosity(config.personalityVector);
    }
  }

  private buildEvolutionAudit(step: EvolutionStep): PersonalityEvolutionAudit {
    const mutationFields = step.mutations.map(m => m.field);
    const coreFields = mutationFields.filter(field =>
      field === 'coreMotivation' ||
      field.startsWith('behavioralBoundaries') ||
      field.startsWith('toolPolicy') ||
      field.startsWith('memoryPolicy'),
    );
    const growthFields = mutationFields.filter(field =>
      field === 'growthState' ||
      field.startsWith('growthState.') ||
      field.startsWith('expressionStyle') ||
      field.startsWith('personalityVector'),
    );
    const affectedLayer =
      coreFields.length > 0 && growthFields.length > 0 ? 'mixed' :
      coreFields.length > 0 ? 'core' :
      'growth';

    return {
      id: `evo_${crypto.randomUUID()}`,
      status: 'active',
      createdAt: step.timestamp,
      trigger: step.trigger,
      depth: step.depth || 'full',
      affectedLayer,
      reversible: step.mutations.every(m => m.from !== undefined),
      summary: step.narrative,
      mutationFields,
      reasons: step.mutations.map(m => m.reason),
      sourceMemoryCount: step.ownerProfile?.memoryCount,
    };
  }

  /** Get the evolution config for a personality (with defaults) */
  getEvolutionConfig(personalityId: string, userId?: string, orgId?: string): EvolutionConfig {
    const config = this.getForUser(personalityId, userId, orgId);
    if (!config) return DEFAULT_EVOLUTION_CONFIG;
    const stored = (config as any).evolutionConfig as Partial<EvolutionConfig> | undefined;
    return { ...DEFAULT_EVOLUTION_CONFIG, ...stored };
  }

  /** Get evolution history for a personality */
  getEvolutionHistory(personalityId: string, userId?: string, orgId?: string): EvolutionStep[] {
    const config = this.getForUser(personalityId, userId, orgId);
    if (!config) return [];
    return (config as any).evolutionHistory || [];
  }

  getEvolutionAudit(personalityId: string, userId?: string, orgId?: string): PersonalityEvolutionAudit[] {
    const config = this.getForUser(personalityId, userId, orgId);
    if (!config) return [];
    return ((config as any).evolutionAudit || []) as PersonalityEvolutionAudit[];
  }

  isEvolutionFrozen(personalityId: string, userId?: string, orgId?: string): boolean {
    const config = this.getForUser(personalityId, userId, orgId);
    return Boolean(config?.evolutionFrozenAt);
  }

  setEvolutionFrozen(personalityId: string, frozen: boolean, userId?: string, orgId?: string): PersonalityConfig | null {
    const config = this.getForUser(personalityId, userId, orgId);
    if (!config) return null;
    config.evolutionFrozenAt = frozen ? new Date().toISOString() : null;
    if (userId) this.saveUserState(personalityId, userId, config, orgId);
    else this.save();
    this.broadcastFn?.('personality:evolution_freeze_changed', {
      personalityId,
      userId,
      orgId,
      frozen,
      frozenAt: config.evolutionFrozenAt,
    });
    return config;
  }

  revertEvolution(personalityId: string, auditId: string, userId?: string, orgId?: string): PersonalityConfig | null {
    const config = this.getForUser(personalityId, userId, orgId);
    if (!config) return null;
    const extConfig = config as any;
    const audit = ((extConfig.evolutionAudit || []) as PersonalityEvolutionAudit[])
      .find(entry => entry.id === auditId);
    if (!audit || audit.status === 'reverted' || !audit.reversible) return null;
    const history = (extConfig.evolutionHistory || []).find((entry: any) => entry.auditId === auditId);
    if (!history?.mutations?.length) return null;

    for (const mutation of [...history.mutations].reverse()) {
      this.applyMutation(config, {
        field: mutation.field,
        from: mutation.to,
        to: mutation.from,
        reason: `Revert ${auditId}: ${mutation.reason}`,
      });
    }

    audit.status = 'reverted';
    audit.revertedAt = new Date().toISOString();
    history.revertedAt = audit.revertedAt;
    history.reverted = true;
    const [major, minor] = (config.version || '2.3').split('.').map(Number);
    config.version = `${major || 2}.${(minor || 0) + 1}`;
    if (userId) this.saveUserState(personalityId, userId, config, orgId);
    else this.save();
    this.broadcastFn?.('personality:evolution_reverted', {
      personalityId,
      userId,
      orgId,
      auditId,
      version: config.version,
    });
    return config;
  }

  /** Persist the current registry state to the user's state file (data/ — gitignored) */
  save(configPath?: string): void {
    // Always write to data/ so evolution survives git pulls
    const userStatePath = path.join(process.cwd(), 'data', 'personalities.json');
    const altUserStatePath = path.join(process.cwd(), '..', 'data', 'personalities.json');

    // Ensure data directory exists
    for (const p of [userStatePath, altUserStatePath]) {
      try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
    }

    const configs = Array.from(this.personalities.values());
    const json = JSON.stringify(configs, null, 2);

    for (const p of [userStatePath, altUserStatePath]) {
      try {
        fs.writeFileSync(p, json, 'utf-8');
        return;
      } catch {}
    }
    console.error('[Personality] Failed to save config');
  }

  /**
   * Apply a real-time identity correction from user feedback.
   * Removes contradicted interests/claims from coreMotivation and interestClusters,
   * then persists to disk immediately — no 7-day cooldown wait.
   */
  async correctIdentity(
    personalityId: string,
    changes: {
      removeInterest?: string;
      removeFromMotivation?: string;
      newMotivation?: string;
    },
    userId?: string,
    orgId?: string,
  ): Promise<boolean> {
    const config = this.getForUser(personalityId, userId, orgId);
    if (!config) return false;

    const extConfig = config as any;

    if (userId && !config.growthState) {
      config.growthState = {
        version: 0,
        lastUpdatedAt: new Date().toISOString(),
        ownerInterests: [],
        ownerExpressions: [],
        communicationPatterns: [],
        adaptationNotes: [],
      };
    }

    // Remove contradicted interest from motivation text
    if (!userId && changes.removeFromMotivation) {
      const target = changes.removeFromMotivation.trim();
      config.coreMotivation = config.coreMotivation
        .replace(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '')
        .replace(/\s{2,}/g, ' ')
        .replace(/,\s*,/g, ',')
        .trim();
      // Edge case: trailing period after removal
      config.coreMotivation = config.coreMotivation.replace(/\s\.$/, '.');
    }

    // Replace entire motivation if provided
    if (!userId && changes.newMotivation) {
      config.coreMotivation = changes.newMotivation;
    }

    // Remove from interest clusters
    if (changes.removeInterest) {
      const ownerProfile = extConfig.ownerProfile || extConfig.evolutionHistory?.find((e: any) => e.ownerProfile)?.ownerProfile;
      if (ownerProfile?.interestClusters) {
        ownerProfile.interestClusters = ownerProfile.interestClusters.filter(
          (ic: string) => !ic.includes(changes.removeInterest!) && !changes.removeInterest!.includes(ic),
        );
      }
      if (config.growthState) {
        const removeMatch = (value: string) =>
          !value.includes(changes.removeInterest!) && !changes.removeInterest!.includes(value);
        config.growthState.ownerInterests = (config.growthState.ownerInterests || []).filter(removeMatch);
        config.growthState.ownerExpressions = (config.growthState.ownerExpressions || []).filter(removeMatch);
        config.growthState.communicationPatterns = (config.growthState.communicationPatterns || []).filter(removeMatch);
        config.growthState.adaptationNotes = [
          ...(config.growthState.adaptationNotes || []),
          `Removed contradicted owner signal: ${changes.removeInterest}`,
        ].slice(-20);
        config.growthState.lastUpdatedAt = new Date().toISOString();
      }
      // Also clean up any old evolution history references
      if (extConfig.evolutionHistory) {
        for (const entry of extConfig.evolutionHistory) {
          if (entry.ownerProfile?.interestClusters) {
            entry.ownerProfile.interestClusters = entry.ownerProfile.interestClusters.filter(
              (ic: string) => !ic.includes(changes.removeInterest!) && !changes.removeInterest!.includes(ic),
            );
          }
        }
      }
    }

    // Bump version to reflect correction
    const [major, minor] = (config.version || '2.3').split('.').map(Number);
    config.version = `${major}.${(minor || 0) + 1}`;

    if (userId) this.saveUserState(personalityId, userId, config, orgId);
    else this.save();
    this.broadcastFn?.('personality:corrected', {
      personalityId,
      userId,
      orgId,
      changes,
      newVersion: config.version,
    });
    console.log(`[Personality] ${config.name} identity corrected to ${config.version}`);
    return true;
  }

  /**
   * Build the full system prompt for a personality in a given context,
   * optionally enriched with skill overrides and memories.
   */
  buildSystemPrompt(
    personalityId: string,
    ctx: PersonalityContext,
    options?: {
      memories?: Memory[];
      ragKnowledge?: string[];
      emotionalState?: EmotionalState;
      userId?: string;
      userText?: string;
      domain?: 'personal' | 'work';
      orgId?: string;
    },
  ): { config: PersonalityConfig; systemPrompt: string } {
    const scopedOrgId = options?.domain === 'work' ? options.orgId : undefined;
    const config = this.getForUser(personalityId, options?.userId, scopedOrgId) || this.getDefault();
    const prompt = generateSystemPrompt(config, ctx, options);
    return { config, systemPrompt: prompt };
  }
}

export const personalityRegistry = new PersonalityRegistry();
