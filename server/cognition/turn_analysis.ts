import { buildActionContract, type LumiActionContract } from './action_contract';
import { normalizeActionIntent, type NormalizedActionIntent } from './normalized_action_intent';
import { classifySkillAuthoringIntent } from '../skills/authoring_intent';
import type { TurnResolution } from './turn_resolution';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** One planning invocation owns these pure facts. No process cache or permission state. */
export class TurnAnalysis {
  private readonly intents = new Map<string, NormalizedActionIntent>();
  private readonly contracts = new Map<string, LumiActionContract>();
  private readonly authoringIntents = new Map<string, ReturnType<typeof classifySkillAuthoringIntent>>();

  constructor(accepted?: Pick<TurnResolution, 'userText' | 'userIntent'>) {
    if (accepted) this.intents.set(accepted.userText, freeze({ ...accepted.userIntent }));
  }

  intent(text: string): NormalizedActionIntent {
    if (!this.intents.has(text)) this.intents.set(text, freeze(normalizeActionIntent(text)));
    return this.intents.get(text)!;
  }

  contract(text: string, acceptedContract?: LumiActionContract): LumiActionContract {
    if (!this.contracts.has(text)) this.contracts.set(text, freeze(acceptedContract ?? buildActionContract(text, this.intent(text), this)));
    return this.contracts.get(text)!;
  }

  authoring(text: string): ReturnType<typeof classifySkillAuthoringIntent> {
    if (!this.authoringIntents.has(text)) this.authoringIntents.set(text, classifySkillAuthoringIntent(text));
    return this.authoringIntents.get(text)!;
  }
}
