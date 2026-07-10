import fs from 'fs';
import path from 'path';
import { PersonalityConfig, PersonalityContext, PersonalityEvolutionAudit } from './types';
import { generateSystemPrompt, initVectorFromStyle, vectorToTone, vectorToVerbosity, constrainVectorPairs } from './engine';
import { Memory } from '../memory/types';
import { EmotionalState } from './state';
import { EvolutionStep, EvolutionConfig, DEFAULT_EVOLUTION_CONFIG } from './evolution';

class PersonalityRegistry {
  private personalities: Map<string, PersonalityConfig> = new Map();
  private loaded = false;
  private broadcastFn: ((event: string, data: any) => void) | null = null;

  /** Set a broadcast callback for real-time evolution events */
  setBroadcast(fn: (event: string, data: any) => void): void {
    this.broadcastFn = fn;
  }

  /** Load personalities: user's evolved state (data/) takes priority over factory default */
  load(configPath?: string): void {
    if (this.loaded) return;

    const factoryPath = configPath || path.join(process.cwd(), 'server', 'personality', 'personalities.json');
    const altFactoryPath = path.join(process.cwd(), '..', 'server', 'personality', 'personalities.json');
    const userStatePath = path.join(process.cwd(), 'data', 'personalities.json');
    const altUserStatePath = path.join(process.cwd(), '..', 'data', 'personalities.json');

    // 1. Prefer user's evolved state (data/ — gitignored, survives updates)
    let raw: string = '';
    let loadedFrom = '';
    for (const p of [userStatePath, altUserStatePath]) {
      try { raw = fs.readFileSync(p, 'utf-8'); loadedFrom = p; break; } catch {}
    }

    // 2. Fall back to factory default (server/ — git-tracked, clean for all users)
    if (!loadedFrom) {
      for (const p of [factoryPath, altFactoryPath]) {
        try { raw = fs.readFileSync(p, 'utf-8'); loadedFrom = p; break; } catch {}
      }
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
          cad_generate_autocad_draw_script: 'safe',
          cad_run_autocad_draw_script: 'safe',
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

  list(): PersonalityConfig[] {
    if (!this.loaded) this.load();
    return Array.from(this.personalities.values());
  }

  /**
   * Apply an evolution step to a personality, persisting the changes.
   * Returns the updated config.
   */
  applyEvolution(personalityId: string, step: EvolutionStep, options?: { force?: boolean }): PersonalityConfig | null {
    const config = this.get(personalityId);
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

    // Persist to disk
    this.save();

    // Broadcast real-time evolution event
    if (this.broadcastFn) {
      this.broadcastFn('personality:evolved', {
        personalityId,
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
  getEvolutionConfig(personalityId: string): EvolutionConfig {
    const config = this.get(personalityId);
    if (!config) return DEFAULT_EVOLUTION_CONFIG;
    const stored = (config as any).evolutionConfig as Partial<EvolutionConfig> | undefined;
    return { ...DEFAULT_EVOLUTION_CONFIG, ...stored };
  }

  /** Get evolution history for a personality */
  getEvolutionHistory(personalityId: string): EvolutionStep[] {
    const config = this.get(personalityId);
    if (!config) return [];
    return (config as any).evolutionHistory || [];
  }

  getEvolutionAudit(personalityId: string): PersonalityEvolutionAudit[] {
    const config = this.get(personalityId);
    if (!config) return [];
    return ((config as any).evolutionAudit || []) as PersonalityEvolutionAudit[];
  }

  isEvolutionFrozen(personalityId: string): boolean {
    const config = this.get(personalityId);
    return Boolean(config?.evolutionFrozenAt);
  }

  setEvolutionFrozen(personalityId: string, frozen: boolean): PersonalityConfig | null {
    const config = this.get(personalityId);
    if (!config) return null;
    config.evolutionFrozenAt = frozen ? new Date().toISOString() : null;
    this.save();
    this.broadcastFn?.('personality:evolution_freeze_changed', {
      personalityId,
      frozen,
      frozenAt: config.evolutionFrozenAt,
    });
    return config;
  }

  revertEvolution(personalityId: string, auditId: string): PersonalityConfig | null {
    const config = this.get(personalityId);
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
    this.save();
    this.broadcastFn?.('personality:evolution_reverted', {
      personalityId,
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
  ): Promise<boolean> {
    const config = this.get(personalityId);
    if (!config) return false;

    const extConfig = config as any;

    // Remove contradicted interest from motivation text
    if (changes.removeFromMotivation) {
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
    if (changes.newMotivation) {
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

    // Persist immediately
    this.save();
    this.broadcastFn?.('personality:corrected', {
      personalityId,
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
    },
  ): { config: PersonalityConfig; systemPrompt: string } {
    const config = this.get(personalityId) || this.getDefault();
    const prompt = generateSystemPrompt(config, ctx, options);
    return { config, systemPrompt: prompt };
  }
}

export const personalityRegistry = new PersonalityRegistry();
