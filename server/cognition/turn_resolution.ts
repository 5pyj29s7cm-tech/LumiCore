import { randomUUID } from 'node:crypto';
import { normalizeActionIntent, type NormalizedActionIntent } from './normalized_action_intent';
import { withoutLocationLiterals } from './location_literals';
import { resolveActiveTaskMessageRelation, type ActiveTaskMessageResolution, type ActiveTaskRelationOptions } from './task_concurrency';
import type { ConversationActionContinuationState } from './action_continuation';
export interface TurnResolution {
    readonly id: string;
    readonly requestId: string;
    readonly userText: string;
    readonly instructionText: string;
    readonly userIntent: Readonly<NormalizedActionIntent>;
    readonly queryTarget: 'runtime_work' | 'conversation_receipts';
    readonly taskRelation: Readonly<ActiveTaskMessageResolution>;
}
/** Accept semantic meaning once; later stages may validate authority and version, never infer new user permission from prompt prose. */
export function resolveUserTurn(input: {
    requestId?: string;
    userText: string;
    state?: ConversationActionContinuationState | null;
    taskRelation?: ActiveTaskMessageResolution;
    options?: ActiveTaskRelationOptions;
}): TurnResolution {
    const requestId = input.requestId || randomUUID();
    const userIntent = normalizeActionIntent(input.userText);
    const relation = input.taskRelation || resolveActiveTaskMessageRelation(input.userText, userIntent.target === 'runtime_work' && userIntent.operation === 'status' ? null : input.state, { ...input.options, normalizedIntent: userIntent });
    return Object.freeze({
        id: 'resolution:' + requestId, requestId, userText: input.userText,
        instructionText: withoutLocationLiterals(input.userText, true),
        userIntent: Object.freeze(userIntent),
        queryTarget: userIntent.target === 'runtime_work' ? 'runtime_work' : 'conversation_receipts',
        taskRelation: Object.freeze({ ...relation }),
    });
}
