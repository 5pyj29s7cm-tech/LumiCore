export { personalityRegistry } from './registry';
export { generateSystemPrompt, vectorToTone, vectorToVerbosity, vectorToneDescription, initVectorFromStyle } from './engine';
export { createDefaultEmotionalState, loadEmotionalState, saveEmotionalState, updateEmotionalState, formatEmotionalStateForPrompt, resolveVerbosityFromState, generateContextualGreeting, applyIntimacyToVector, vectorMemoryBias } from './state';
export type { EmotionalState, EmotionEvent } from './state';
export type { PersonalityConfig, PersonalityContext, PersonalityVector, ExpressionStyle, ToolPolicy, MemoryPolicy } from './types';
