import { describe, expect, it } from 'vitest';
import { computeMutations, generateReviewPrompt, OwnerProfile } from '../server/personality/evolution';
import { generateSystemPrompt } from '../server/personality/engine';
import { PersonalityConfig } from '../server/personality/types';

const baseConfig: PersonalityConfig = {
  id: 'lumi',
  name: 'Lumi',
  version: '2.3',
  coreMotivation: 'You are Lumi, a stable local-first desktop AI companion.',
  behavioralBoundaries: ['Do not share private user data.'],
  expressionStyle: {
    persona: 'a native desktop AI companion',
    tone: 'warm',
    verbosity: 'balanced',
    languages: ['zh', 'en'],
    vocabularyHints: [],
  },
  toolPolicy: {
    allowedTools: ['*'],
    requireConfirmation: [],
    forbiddenTools: [],
    maxIterations: 5,
  },
  memoryPolicy: {
    retrieveLimit: 5,
    minConfidence: 0.4,
    includeTypes: ['preference', 'fact', 'habit', 'knowledge'],
    autoExtract: true,
  },
  personalityVector: {
    cognitiveStyle: { analytical: 0.3, intuitive: 0.7, systematic: 0.3, creative: 0.6 },
    socialStyle: { warmth: 0.6, directness: 0.3, playfulness: 0.3, formality: 0.3 },
  },
};

const profile: OwnerProfile = {
  synthesizedAt: new Date().toISOString(),
  memoryCount: 20,
  dominantTone: 'warm',
  frequentExpressions: ['功能完整', '本地部署'],
  interestClusters: ['AI community', 'desktop client'],
  formalityLevel: 0.2,
  emotionalExpressiveness: 0.7,
  communicationPatterns: ['prefers direct product decisions'],
};

describe('personality core and growth split', () => {
  it('stores owner-specific learning in growthState instead of coreMotivation', () => {
    const mutations = computeMutations(baseConfig, profile, {
      plasticity: 0.3,
      minMemoriesForEvolution: 10,
      minConnectionForEvolution: 0.2,
      cooldownMs: 0,
      maxMutationsPerStep: 6,
    });

    expect(mutations.some(m => m.field === 'growthState')).toBe(true);
    expect(mutations.some(m => m.field === 'coreMotivation')).toBe(false);
    const growthMutation = mutations.find(m => m.field === 'growthState');
    expect(growthMutation?.to.ownerInterests).toContain('AI community');
    expect(growthMutation?.to.ownerExpressions).toContain('功能完整');
  });

  it('injects growth state without redefining core identity', () => {
    const prompt = generateSystemPrompt({
      ...baseConfig,
      growthState: {
        version: 1,
        lastUpdatedAt: new Date().toISOString(),
        ownerInterests: ['desktop client'],
        ownerExpressions: ['功能完整'],
        communicationPatterns: ['prefers direct product decisions'],
        adaptationNotes: [],
      },
    }, {
      mode: 'chat',
      sensory: { audio: false, visual: false, spatial: false, haptic: false, holographic: false, activeDeviceTypes: [], deviceCount: 0 },
    });

    expect(prompt).toContain('Personal Growth State');
    expect(prompt).toContain('Stable Lumi Identity Anchor');
    expect(prompt).toContain('same Lumi, not separate personas');
    expect(prompt).toContain('desktop client');
    expect(prompt).toContain('do not treat it as core identity');
  });

  it('generates clean weekly monthly and yearly review prompts', () => {
    for (const depth of ['weekly', 'monthly', 'yearly'] as const) {
      const prompt = generateReviewPrompt({
        depth,
        personalityName: 'Lumi',
        currentVersion: '2.3',
        evolutionSteps: [{
          version: '2.4',
          timestamp: new Date().toISOString(),
          trigger: 'scheduled',
          depth: depth === 'weekly' ? 'lightweight' : 'full',
          ownerProfile: profile,
          mutations: [],
          narrative: '更理解主人对桌面能力和法律工作流的要求。',
        }],
        newMemoryCount: 12,
        newInteractionCount: 8,
        topMemoryTopics: ['桌面能力', '法律工作流', '自主学习'],
        connectionScore: 0.83,
        totalFacts: 42,
        totalPreferences: 9,
        activeConversations: 3,
      });

      expect(prompt).toContain('你是 Lumi');
      expect(prompt).toContain('主人主要话题：桌面能力、法律工作流、自主学习');
      expect(prompt).toContain('连接亲密度：83%');
      expect(prompt).not.toContain('�');
      expect(prompt).not.toContain('{label}');
      expect(prompt).not.toContain('{ctx.');
    }
  });
});
