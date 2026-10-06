import { cloneDatabaseValue } from "../../db/snapshot_changes";
import { readDatabaseTables } from "../../../db_layer";
import type { ToolRegistry } from "../../tools/registry";
import { externalCapabilityProposalDigest, normalizeExternalCapabilityProposal } from "../schema";
import { sameExternalCapabilityCredentialRevision } from "../credential_binding";
import type { ExternalCapabilityPackageRow, ExternalCapabilityReceiptRow, ExternalCapabilityProjection, ExternalCapabilityAvailability, ExternalCapabilityStage } from './contracts';
import { arrays } from './store';
import { resolveReviewedRowRuntime } from './proposal_resolution';

export function actionAutomaticReady(
  row: ExternalCapabilityPackageRow,
  actionId: string,
  registry: ToolRegistry,
): boolean {
  try {
    const projected = projectRow(row, registry, arrays().receipts);
    return projected.stage === 'automatic'
      && projected.availability === 'ready'
      && projected.actions.some(action => action.id === actionId && action.availability === 'ready');
  } catch {
    return false;
  }
}

function receiptVerificationStatus(
  receipt: ExternalCapabilityReceiptRow | undefined,
): 'never' | 'verified' | 'unverified' | 'failed' {
  if (!receipt) return 'never';
  const status = receipt.terminalVerification?.status;
  return status === 'verified' || status === 'unverified' || status === 'failed' ? status : 'never';
}

export function projectRow(
  row: ExternalCapabilityPackageRow,
  registry: ToolRegistry,
  receipts: ExternalCapabilityReceiptRow[],
): ExternalCapabilityProjection {
  const proposal = normalizeExternalCapabilityProposal(row.proposal);
  if (externalCapabilityProposalDigest(proposal) !== String(row.packageDigest || '').trim().toLowerCase()) {
    throw new Error('The persisted external capability package does not match its reviewed digest.');
  }
  const runtime = resolveReviewedRowRuntime(row, registry);
  const currentByAction = new Map(runtime.actions.map(action => [action.actionId, action]));
  const executionReceipts = receipts
    .map((receipt, index) => ({ receipt, index }))
    .filter(({ receipt }) => (
      receipt.kind === 'execution'
      && receipt.packageRowId === row.id
      && sameExternalCapabilityCredentialRevision(
        receipt.credentialBindingRevision,
        row.credentialBindingRevision,
      )
    ))
    .sort((left, right) => (
      right.receipt.createdAt.localeCompare(left.receipt.createdAt)
      || right.index - left.index
    ))
    .map(({ receipt }) => receipt);
  const latestByAction = new Map<string, ExternalCapabilityReceiptRow>();
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","externalCapabilityPackages","externalCapabilityReceipts"]);
  const taskOwner = new Map((db.conversationActionTasks || []).map((task: any) => [String(task.id || ''), String(task.userId || '')]));
  const conversationReceipts = (db.conversationActionReceipts || []).flatMap((receipt: any, index: number) => {
    if (
      taskOwner.get(String(receipt.taskId || '')) !== row.ownerUserId
      || String(receipt.createdAt || '').localeCompare(row.activatedAt || '') < 0
    ) return [];
    let envelope: Record<string, any> = {};
    try {
      const parsed = typeof receipt.envelope === 'string' ? JSON.parse(receipt.envelope || '{}') : receipt.envelope;
      if (parsed && typeof parsed === 'object') envelope = parsed;
    } catch {}
    const status = String(envelope.status || receipt.outcome || 'unknown_outcome');
    const hostVerified = status === 'verified_success'
      && String(receipt.outcome || '') === 'verified_success'
      && envelope.verification?.status === 'verified'
      && envelope.verification?.basis === 'terminal_verification';
    return [{
      id: String(receipt.id || ''),
      toolName: String(receipt.toolName || ''),
      createdAt: String(receipt.createdAt || ''),
      status,
      hostVerified,
      verificationStatus: String(envelope.verification?.status || 'never'),
      index,
    }];
  });
  const verifiedRunCounts = new Map<string, number>();
  const latestConversationVerification = new Map<string, string>();
  const latestOutcomeRevokesAutomatic = new Map<string, boolean>();
  const latestActionVerificationStatus = new Map<string, 'never' | 'verified' | 'unverified' | 'failed'>();
  for (const action of Array.isArray(row.resolvedActions) ? row.resolvedActions : []) {
    const externalRelevant = executionReceipts.filter(receipt => (
      receipt.actionId === action.actionId
      && receipt.runtimeIdentityDigest === action.runtimeIdentityDigest
      && receipt.createdAt.localeCompare(row.activatedAt || '') >= 0
    ));
    const conversationRelevant = conversationReceipts.filter(receipt => receipt.toolName === action.proxyToolName);
    const externalRuns = externalRelevant.filter(receipt => (
      receipt.hostVerified
      && receipt.status === 'verified_success'
      && receipt.terminalVerification?.status === 'verified'
    ));
    const conversationRuns = conversationRelevant.filter(receipt => receipt.hostVerified);
    verifiedRunCounts.set(action.actionId, externalRuns.length + conversationRuns.length);
    const latest = [...externalRuns.map(receipt => receipt.createdAt), ...conversationRuns.map(receipt => receipt.createdAt)]
      .sort((left, right) => right.localeCompare(left))[0];
    if (latest) latestConversationVerification.set(action.actionId, latest);
    const latestExternalReceipt = externalRelevant[0];
    const latestConversationReceipt = [...conversationRelevant]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.index - left.index)[0];
    const events = [
      ...(latestExternalReceipt ? [{
        createdAt: latestExternalReceipt.createdAt,
        status: latestExternalReceipt.status,
        verificationStatus: latestExternalReceipt.terminalVerification?.status || 'never',
        verified: latestExternalReceipt.hostVerified
          && latestExternalReceipt.status === 'verified_success'
          && latestExternalReceipt.terminalVerification?.status === 'verified',
      }] : []),
      ...(latestConversationReceipt ? [{
        createdAt: latestConversationReceipt.createdAt,
        status: latestConversationReceipt.status,
        verificationStatus: latestConversationReceipt.verificationStatus,
        verified: latestConversationReceipt.hostVerified,
      }] : []),
    ];
    const latestCreatedAt = events.map(event => event.createdAt)
      .sort((left, right) => right.localeCompare(left))[0];
    const latestEvents = latestCreatedAt
      ? events.filter(event => event.createdAt === latestCreatedAt)
      : [];
    // Equal timestamps are intentionally conservative: any terminal failure or
    // unknown at the newest instant revokes automation until a later verified run.
    const latestRevokes = latestEvents.some(event => !event.verified);
    latestOutcomeRevokesAutomatic.set(action.actionId, latestRevokes);
    if (latestEvents.length > 0 && latestRevokes) {
      const explicitlyFailed = latestEvents.some(event => (
        event.verificationStatus === 'failed'
        || /(?:failed|denied|blocked|cancelled|timeout|target_mismatch)/i.test(event.status)
      ));
      latestActionVerificationStatus.set(action.actionId, explicitlyFailed ? 'failed' : 'unverified');
    } else if (latestEvents.some(event => event.verified)) {
      latestActionVerificationStatus.set(action.actionId, 'verified');
    }
  }
  for (const receipt of executionReceipts) {
    if (!latestByAction.has(receipt.actionId)) latestByAction.set(receipt.actionId, receipt);
  }
  const acceptanceSatisfied = proposal.acceptance.requiredActionIds.every(actionId => (
    (verifiedRunCounts.get(actionId) || 0) >= proposal.acceptance.minimumVerifiedRuns
  ));
  const acceptanceCurrentlyHealthy = acceptanceSatisfied
    && proposal.acceptance.requiredActionIds.every(actionId => !latestOutcomeRevokesAutomatic.get(actionId));
  const automaticCandidates = proposal.actions.filter(action => action.executionMode === 'automatic_candidate');
  const automaticReady = acceptanceCurrentlyHealthy
    && automaticCandidates.length > 0
    && automaticCandidates.every(action => proposal.acceptance.requiredActionIds.includes(action.id))
    && automaticCandidates.every(action => !latestOutcomeRevokesAutomatic.get(action.id))
    && automaticCandidates.every(action => {
      const manifest = currentByAction.get(action.id);
      return manifest?.executable === true && manifest.requiresConfirmation === false;
    });
  const proxiesReady = runtime.availability === 'ready'
    && runtime.actions.length === proposal.actions.length
    && runtime.actions.every(action => Boolean(registry.get(action.proxyToolName)));
  const availability: ExternalCapabilityAvailability = proxiesReady ? 'ready' : 'unavailable';
  const unavailableReason = runtime.reason || (!proxiesReady ? 'The reviewed package proxy is not hydrated in the current runtime.' : '');
  const stage: ExternalCapabilityStage = availability !== 'ready'
    ? 'configured'
    : automaticReady
      ? 'automatic'
      : acceptanceCurrentlyHealthy
        ? 'verified'
        : 'connected';
  return {
    id: row.capabilityId,
    version: row.version,
    name: proposal.name,
    description: proposal.description,
    stage,
    availability,
    ...(unavailableReason ? { unavailableReason } : {}),
    presentation: cloneDatabaseValue(proposal.presentation),
    runtimeRefs: cloneDatabaseValue(proposal.runtimeRefs),
    guidance: cloneDatabaseValue(proposal.guidance),
    actions: proposal.actions.map(action => {
      const resolved = currentByAction.get(action.id);
      const latest = latestByAction.get(action.id);
      const verifiedAt = latestConversationVerification.get(action.id);
      const verifiedRuns = verifiedRunCounts.get(action.id) || 0;
      return {
        id: action.id,
        label: action.label,
        description: action.description,
        ...(action.icon ? { icon: action.icon } : {}),
        capabilityId: action.tool.capabilityId,
        toolName: resolved?.proxyToolName || row.resolvedActions.find(item => item.actionId === action.id)?.proxyToolName || '',
        underlyingToolName: action.tool.name,
        executionMode: action.executionMode,
        requiresConfirmation: resolved?.requiresConfirmation ?? true,
        availability: resolved?.executable && Boolean(registry.get(resolved.proxyToolName)) ? 'ready' : 'unavailable',
        verification: {
          status: latestActionVerificationStatus.get(action.id)
            || (verifiedRuns > 0 ? 'verified' : receiptVerificationStatus(latest)),
          ...(verifiedAt ? { lastVerifiedAt: verifiedAt } : {}),
          verifiedRuns,
        },
      };
    }),
    activatedAt: row.activatedAt,
    updatedAt: row.updatedAt,
  };
}
