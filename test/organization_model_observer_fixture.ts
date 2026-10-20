import { vi } from 'vitest';
import * as preparation from '../server/regions/packs/cn/messaging_turn/execution_preparation';
import type { MessagingRouteOptions } from '../server/regions/packs/cn/messaging_finalization';

const prepare = preparation.prepareMessagingExecution;
const observers = new WeakMap<MessagingRouteOptions, NonNullable<MessagingRouteOptions['onMessage']>>();
/** A local read-only provider observes the actual per-turn context; it never executes an org callback. */
export function observedMessagingOptions(options: MessagingRouteOptions): MessagingRouteOptions {
  const observe = options.onMessage;
  if (!observe) throw new Error('An observer fixture is required');
  const configured: MessagingRouteOptions = { ...options, onMessage: undefined, llmGetters: { getDeepSeek: () => null, getGemini: () => null } };
  observers.set(configured, observe);
  vi.spyOn(preparation, 'prepareMessagingExecution').mockImplementation(async input => {
    const result = await prepare(input);
    const observer = input.options && observers.get(input.options);
    if (observer && result.context) result.context.llm = {
      getDeepSeek: () => null, getGemini: () => null,
      getRelay: () => ({ chat: { completions: { create: async () => {
        const reply = await observer(input.msg);
        return { choices: [{ message: { content: reply?.text || 'Synthetic observed reply.' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      } } } }),
    };
    return result;
  });
  return configured;
}
