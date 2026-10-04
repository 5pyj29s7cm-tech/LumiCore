import { SerialExecutionQueue } from './serial_execution_queue';
export interface ConversationExecutionScope {
    userId: string;
    domain?: 'personal' | 'work';
    orgId?: string | null;
    conversationId: string;
}
export function conversationExecutionKey(scope: ConversationExecutionScope): string {
    if (!scope.userId || !scope.conversationId || scope.domain === 'work' && !scope.orgId)
        throw new Error('An exact authorized conversation scope is required');
    return JSON.stringify([scope.userId, scope.domain || 'personal', scope.domain === 'work' ? scope.orgId : '', scope.conversationId]);
}
const queue = new SerialExecutionQueue();
/** Transport source is provenance, never the mutex resource. Controls keep their exact existing request fences. */
export function reserveConversationExecution(scope: ConversationExecutionScope, requestId: string, signal?: AbortSignal) {
    const key = conversationExecutionKey(scope);
    if (!requestId || queue.getByRequestId(key, requestId))
        throw new Error('This conversation request already owns an execution admission');
    const lease = queue.reserve(key, requestId);
    const abort = () => lease.cancel();
    if (signal?.aborted)
        abort();
    else
        signal?.addEventListener('abort', abort, { once: true });
    return {
        async waitForTurn(): Promise<void> {
            if (!await lease.waitForTurn())
                throw signal?.reason || lease.signal.reason || new Error('Conversation execution admission cancelled');
        },
        release() { signal?.removeEventListener('abort', abort); lease.release(); },
    };
}
export type ConversationExecutionAdmission = ReturnType<typeof reserveConversationExecution>;
export interface ConversationResourceLifetime {
    admission?: ConversationExecutionAdmission;
    ownedByDurableRelease?: boolean;
}
