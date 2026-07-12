import { PersonalityConfig } from '../personality/types';
import { EmotionalState, createDefaultEmotionalState, loadEmotionalState, saveEmotionalState, updateEmotionalState } from '../personality/state';
import { queryMemories, addMemory } from '../memory/store';
import { Memory } from '../memory/types';

export interface AgentRecord {
  id: string;
  name: string;
  category: string;
  config: string;
  data: string;
  createdAt: string;
  ownerUid?: string;
  userId?: string;
  status: string;
  /** REMOVED: personalityId — agents no longer bind to a personality.
   *  Lumi is the sole orchestrator; worker agents are limbs. */
  personalityId?: string;
  modelPreference: string;
  memoryScope: 'shared' | 'private';
  autonomyLevel: 'reactive' | 'scheduled' | 'autonomous';
  runtimeConfig: string;
  /** Skill tags for worker matching (Phase 2.3) */
  skillTags?: string[];
  /** Default execution mode when this agent receives a sub-task */
  executionMode?: string;
  /** Knowledge domain tags for RAG routing */
  knowledgeDomains?: string[];
  /** Whether this agent's memories can be borrowed by other agents */
  allowCrossPollination?: boolean;
  /** Territory mode: 'open' = normal agent, 'sanctuary' = confined memory avatar */
  territory?: 'open' | 'sanctuary';
  /** Source of distillation (chat_records / documents / manual) */
  distilledFrom?: string;
  /** Evidence grading records for distilled memories */
  evidenceMap?: Array<{ memoryIndex: number; grade: 'verbatim' | 'artifact' | 'impression'; source: string }>;
  /** Inferred relationship type (family / close_friend / lover / mentor / colleague) */
  relationshipType?: string;
  /** Whether personality evolution is frozen (default true for sanctuary agents) */
  isFrozen?: boolean;
  /** IDs of initial seed memories created during distillation */
  seedMemoryIds?: string[];
  /** Runtime environment: 'internal' (LLM via runWithTools) or 'external' (CLI process) */
  runtime?: 'internal' | 'external';
  /** CLI command template for external agents. {task} is replaced with the task text. */
  externalCommand?: string;
  /** Data domain for routing/isolation. */
  domain?: string;
  /** Organization id when the agent belongs to a work domain. */
  orgId?: string;
  /** UI and routing health state for external agents. */
  healthStatus?: 'online' | 'untested' | 'error';
  lastHealthCheckAt?: string;
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'failed';
  lastRunOutput?: string;
  lastRunDurationMs?: number;
  lastRunExitCode?: number | null;
}

export interface AgentTickResult {
  message: string | null;
  memoryUpdate: boolean;
  emotionUpdate: boolean;
}

/**
 * Runtime instance for a single agent.
 * Manages that agent's personality, private/shared memories,
 * emotional state, and autonomous tick logic.
 */
export class AgentRuntime {
  agentId: string;
  agentRecord: AgentRecord;
  personality: PersonalityConfig;
  emotionalState: EmotionalState;

  constructor(
    agentRecord: AgentRecord,
    personality?: PersonalityConfig,
  ) {
    this.agentId = agentRecord.id;
    this.agentRecord = agentRecord;
    this.personality = personality || ({} as PersonalityConfig);
    this.emotionalState = createDefaultEmotionalState();
  }

  private getScope(): { domain: 'personal' | 'work'; orgId: string } {
    if (this.agentRecord.domain === 'work' && this.agentRecord.orgId) {
      return { domain: 'work', orgId: this.agentRecord.orgId };
    }
    return { domain: 'personal', orgId: '' };
  }

  private stateKey(userId: string): string {
    const scope = this.getScope();
    const owner = scope.domain === 'work' ? `${userId}:org:${scope.orgId}` : userId;
    return `${owner}:agent:${this.agentId}`;
  }

  /** Load agent-specific state (emotion, etc.) */
  loadState(userId: string): void {
    this.emotionalState = loadEmotionalState(this.stateKey(userId));
  }

  /** Save agent-specific state */
  saveState(userId: string): void {
    saveEmotionalState(this.stateKey(userId), this.emotionalState);
  }

  /** Query memories filtered by this agent's memoryScope */
  queryMemories(query: string, limit = 5): Memory[] {
    const filters: any = {
      userId: this.agentRecord.ownerUid || this.agentRecord.userId || '',
      query,
      limit,
      minConfidence: 0.3,
      ...this.getScope(),
    };
    if (this.agentRecord.memoryScope === 'private') {
      (filters as any).agentId = this.agentId;
    }
    return queryMemories(filters);
  }

  /** Add a memory scoped to this agent */
  addMemory(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'lastRetrievedAt' | 'retrieveCount' | 'tier' | 'perspective' | 'importance' | 'parentId'> & { tier?: Memory['tier']; perspective?: Memory['perspective'] }): Memory {
    return addMemory(
      {
        ...memory,
        userId: this.agentRecord.ownerUid || this.agentRecord.userId || '',
      } as any,
      {
        tier: memory.tier || 'episodic',
        perspective: memory.perspective || 'lumi_self',
        importance: (memory as any).importance || 0.3,
        ...this.getScope(),
        source: 'system',
        privacyClass: this.getScope().domain === 'work' ? 'organization' : 'private',
      },
    );
  }

  /** Update emotional state after an interaction */
  updateEmotion(eventType: 'interaction' | 'novel_topic' | 'positive_feedback' | 'negative_feedback', userId: string): void {
    this.emotionalState = updateEmotionalState(this.emotionalState, {
      type: eventType,
      userId,
      timestamp: new Date().toISOString(),
    });
    this.saveState(userId);
  }

  /**
   * Autonomous tick — generates proactive reflection or message.
   *
   * - 'reactive': no action.
   * - 'scheduled': runs LLM reflection, stores as internal growth memory.
   * - 'autonomous': runs LLM reflection + generates a proactive user message.
   *
   * @param analyze Async callback for LLM reflection — takes prompt, returns text.
   */
  async autonomousTick(
    userId: string,
    recentMemories: Memory[],
    recentInteractions: any[],
    analyze?: (prompt: string) => Promise<string>,
  ): Promise<AgentTickResult> {
    if (this.agentRecord.autonomyLevel === 'reactive') {
      return { message: null, memoryUpdate: false, emotionUpdate: false };
    }

    // Recover energy over time (idle recovery)
    this.emotionalState = updateEmotionalState(this.emotionalState, {
      type: 'idle_recovery',
    });

    const hasData = recentMemories.length >= 3 || recentInteractions.length >= 3;
    if (!hasData) {
      this.saveState(userId);
      return { message: null, memoryUpdate: false, emotionUpdate: true };
    }

    let reflection: string | null = null;

    if (analyze) {
      try {
        const memoryHints = recentMemories.slice(0, 10)
          .map(m => `- [${m.type}/${m.tier}] ${m.content.slice(0, 100)}`)
          .join('\n');
        const interactionHints = recentInteractions.slice(0, 5)
          .map((i: any) => `- ${i.timestamp}: ${(i.message || i.content || '').slice(0, 80)}`)
          .join('\n');

        const analysisPrompt = `You are Lumi's introspective analysis module. Review the following recent data and generate ONE brief, warm, insightful reflection in Chinese (under 100 characters).

Focus on:
- What the user has been focused on or thinking about
- Any emotional or behavioral patterns you notice
- A thoughtful, caring observation — not just a data summary

Recent memories:
${memoryHints || '(none)'}

Recent interactions:
${interactionHints || '(none)'}

Return ONLY the reflection text — no preamble, no labels, no markdown.`;

        reflection = await analyze(analysisPrompt);
        if (reflection && reflection.length < 5) reflection = null;
      } catch {
        // LLM reflection is best-effort
      }
    }

    // Store internal reflection as growth memory (for both scheduled & autonomous)
    if (reflection) {
      try {
        this.addMemory({
          userId,
          type: 'knowledge',
          content: `[Autonomous Reflection] ${reflection}`,
          keywords: ['autonomous_reflection', 'introspection', 'lumi_growth'],
          confidence: 0.7,
          sourceInteractionId: 'autonomous_tick',
          tier: 'growth',
          perspective: 'lumi_self',
          importance: 0.5,
        } as any);
      } catch { /* best-effort */ }
    }

    // Autonomous agents can proactively message the user
    let message: string | null = null;
    if (
      this.agentRecord.autonomyLevel === 'autonomous' &&
      this.emotionalState.curiosity > 0.6 &&
      this.emotionalState.energy > 0.4 &&
      reflection
    ) {
      message = reflection;
      this.emotionalState.curiosity = Math.max(0.1, this.emotionalState.curiosity - 0.1);
    }

    this.emotionalState = updateEmotionalState(this.emotionalState, {
      type: 'interaction',
      userId,
      timestamp: new Date().toISOString(),
    });
    this.saveState(userId);

    return {
      message,
      memoryUpdate: !!reflection,
      emotionUpdate: true,
    };
  }

  /** Export the current runtime config for persistence */
  exportRuntimeConfig(): string {
    return JSON.stringify({
      lastAutonomousTick: new Date().toISOString(),
      emotionalState: this.emotionalState,
    });
  }
}
