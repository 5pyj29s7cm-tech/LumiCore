import { SerialExecutionQueue } from './serial_execution_queue';
import type { RequestAuthorization } from '../conversation/lifecycle';
export interface ConversationExecutionScope {
    userId: string;
    domain?: 'personal' | 'work';
    orgId?: string | null;
    conversationId: string;
    /** Provenance for exact controls; deliberately excluded from the mutex key. */
    source?: string;
}
export function conversationExecutionKey(scope: ConversationExecutionScope): string {
    if (!scope.userId || !scope.conversationId || scope.domain === 'work' && !scope.orgId)
        throw new Error('An exact authorized conversation scope is required');
    return JSON.stringify([scope.userId, scope.domain || 'personal', scope.domain === 'work' ? scope.orgId : '', scope.conversationId]);
}
const queue = new SerialExecutionQueue();
/** Transport source is provenance, never the mutex resource. Controls keep their exact existing request fences. */
export function reserveConversationExecution(scope: ConversationExecutionScope, requestId: string, signal?: AbortSignal, guard?: { authorization: RequestAuthorization; abort(reason: unknown): void }) {
    guard?.authorization.assertCurrent();
    const key = conversationExecutionKey(scope);
    if (!requestId || queue.getByRequestId(key, requestId, scope.source))
        throw new Error('This conversation request already owns an execution admission');
    const lease = queue.reserve(key, requestId, scope.source);
    const abort = () => lease.cancel();
    if (signal?.aborted)
        abort();
    else
        signal?.addEventListener('abort', abort, { once: true });
    const revoke = () => guard?.abort(lease.signal.reason);
    if (guard) lease.controller.signal.addEventListener('abort', revoke, { once: true });
    if (lease.signal.aborted) revoke();
    const stopAuthorization = guard?.authorization.watch(lease.controller);
    return {
        get controller() { return lease.controller; },
        get state() { return lease.state; },
        get waitingForRequestId() { return lease.predecessor?.requestId; },
        async waitForTurn(): Promise<void> {
            if (!await lease.waitForTurn())
                throw signal?.reason || lease.signal.reason || new Error('Conversation execution admission cancelled');
            guard?.authorization.assertCurrent();
        },
        release() { stopAuthorization?.(); lease.controller.signal.removeEventListener('abort', revoke); signal?.removeEventListener('abort', abort); lease.release(); },
    };
}
/** Control lookup stays source-scoped while all admissions share one conversation FIFO. */
export function getConversationExecution(scope: ConversationExecutionScope & { source: string }, requestId: string) {
    const lease = queue.getByRequestId(conversationExecutionKey(scope), requestId, scope.source);
    return lease;
}
export function getCurrentConversationExecution(scope: ConversationExecutionScope & { source: string }, position: 'current' | 'tail' = 'current') {
    const key = conversationExecutionKey(scope);
    return position === 'tail' ? queue.getTail(key, scope.source) : queue.getCurrent(key, scope.source);
}
export function cancelConversationExecution(scope: ConversationExecutionScope & { source: string }, requestId?: string): Promise<unknown> {
    const key = conversationExecutionKey(scope);
    return requestId
        ? getConversationExecution(scope, requestId) ? queue.cancelRequest(key, requestId, scope.source) : Promise.resolve(false)
        : queue.cancelAll(key, scope.source);
}
export type ConversationExecutionAdmission = ReturnType<typeof reserveConversationExecution>;
export interface ConversationResourceLifetime {
    admission?: ConversationExecutionAdmission;
    ownedByDurableRelease?: boolean;
}
