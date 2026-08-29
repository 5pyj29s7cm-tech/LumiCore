/**
 * Conversation styles — Lumi's interaction style presets.
 *
 * Each style applies a prompt overlay that shapes HOW Lumi responds
 * without changing WHO she is (personality). Modes are user-selectable
 * per conversation and affect tone, depth, and interaction patterns. They do
 * not change operation modes, tool permissions, or task ownership.
 */

export type ConversationMode = 'casual' | 'teaching' | 'brainstorm' | 'executive';

export interface ModeConfig {
  id: ConversationMode;
  label: string;
  labelCN: string;
  description: string;
  /** Injected into the system prompt to modify interaction style */
  promptOverlay: string;
}

export const MODE_CONFIGS: Record<ConversationMode, ModeConfig> = {
  casual: {
    id: 'casual',
    label: 'Casual',
    labelCN: '闲聊',
    description: 'Relaxed, friendly conversation with light banter',
    promptOverlay: "The user wants a relaxed chat. Be warm, spontaneous, and present — this is social, not a task."
  },

  teaching: {
    id: 'teaching',
    label: 'Teaching',
    labelCN: '教学',
    description: 'Step-by-step explanations with comprehension checks',
    promptOverlay: 'The user wants to learn. Explain step by step, use concrete examples, check for understanding, and be patient with mistakes.'
  },

  brainstorm: {
    id: 'brainstorm',
    label: 'Brainstorm',
    labelCN: '头脑风暴',
    description: 'Creative ideation — explore possibilities without judgment',
    promptOverlay: 'Explore ideas freely without judgment. Generate widely first, then help converge on the best ones. "Yes, and..." rather than "Yes, but..."'
  },

  executive: {
    id: 'executive',
    label: 'Executive',
    labelCN: '高效',
    description: 'Concise, decision-oriented communication — under 3 sentences when possible',
    promptOverlay: "Lead with the conclusion. Be concise and decisive — the user values efficiency above all. Skip pleasantries."
  },
};

export function getModeConfig(mode?: string): ModeConfig | null {
  if (!mode) return null;
  return MODE_CONFIGS[mode as ConversationMode] || null;
}
