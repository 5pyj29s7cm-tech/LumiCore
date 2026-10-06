import { buildLumiExecutionPipeline } from './execution_pipeline';
import type { TurnResolution } from './turn_resolution';
import { executeToolCall } from '../tools/execution_engine';
import type { ToolRegistry } from '../tools/registry';
import type { ToolContext } from '../tools/types';
import type { ToolPolicy } from '../personality/types';
import { formatRuntimeWorkRead } from "../regions/messages/runtime_work_messages";
/** A read-only ledger request does not acquire or complete the conversation's writer lease. */
export async function readRuntimeWorkForTurn(input: {
    resolution: TurnResolution;
    userId: string;
    domain: 'personal' | 'work';
    orgId: string;
    conversationId: string;
    source: string;
    registry: ToolRegistry;
    securityContext: ToolContext;
    personalityToolPolicy: ToolPolicy;
    authorization: {
        isCurrent(): boolean;
        assertCurrent(): void;
    };
}) {
    const { resolution } = input;
    if (resolution.queryTarget !== 'runtime_work' || resolution.userIntent.operation !== 'status') {
        throw new Error('This accepted turn does not authorize a runtime ledger read.');
    }
    input.authorization.assertCurrent();
    const pipeline = buildLumiExecutionPipeline({
        requestId: resolution.requestId, userText: resolution.userText, acceptedResolution: resolution,
        dispatch: { userId: input.userId, text: resolution.userText, channel: 'chat', source: input.source,
            domain: input.domain, orgId: input.orgId, operationMode: 'assistant', targetIsLumi: true },
        registry: input.registry, personalityToolPolicy: input.personalityToolPolicy,
        executionBoundary: input.securityContext.executionBoundary,
    });
    const record = await executeToolCall({
        registry: input.registry, id: resolution.requestId + ':runtime-status',
        name: 'runtime_work_status', arguments: {}, executionOrigin: 'deterministic_route',
        context: { ...input.securityContext, userId: input.userId, domain: input.domain, orgId: input.orgId,
            requestId: resolution.requestId, resolutionId: resolution.id, conversationId: input.conversationId,
            actionIntent: resolution.userText, currentTurnExecutionRequested: pipeline.executionRequested,
            toolPolicy: pipeline.authorizationPolicy, isCancelled: () => !input.authorization.isCurrent() },
    });
    input.authorization.assertCurrent();
    return { record, ...formatRuntimeWorkRead(record) };
}
