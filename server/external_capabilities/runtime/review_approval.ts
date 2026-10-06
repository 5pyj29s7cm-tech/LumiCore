import crypto from "node:crypto";
import { externalCapabilityProposalDigest, normalizeExternalCapabilityProposal, type ExternalCapabilityPackageProposal } from "../schema";
import { sameExternalCapabilityCredentialRevision } from "../credential_binding";
import type { ReviewApproval, ResolvedActionSnapshot, ExternalCapabilityPackageRow } from './contracts';
import type { arrays } from './store';

const REVIEW_APPROVAL_TTL_MS = 15 * 60_000;

export const reviewApprovals = new Map<string, ReviewApproval>();

export function reviewPermissions(actions: ResolvedActionSnapshot[]) {
  return actions.map(action => ({
    actionId: action.actionId,
    proxyToolName: action.proxyToolName,
    underlyingToolName: action.toolName,
    permission: action.permission,
    risk: action.risk,
    requiresConfirmation: action.requiresConfirmation,
    sideEffects: action.sideEffects,
  }));
}

function desktopSessionDigest(proof: string): string {
  return crypto.createHash('sha256').update(proof).digest('hex');
}

export function issueReviewApproval(input: {
  ownerUserId: string;
  row: ExternalCapabilityPackageRow;
  desktopSessionProof: string;
}) {
  const now = Date.now();
  for (const [nonce, approval] of reviewApprovals) {
    if (approval.expiresAt <= now) reviewApprovals.delete(nonce);
  }
  const reviewNonce = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + REVIEW_APPROVAL_TTL_MS;
  reviewApprovals.set(reviewNonce, {
    ownerUserId: input.ownerUserId,
    packageRowId: input.row.id,
    capabilityId: input.row.capabilityId,
    version: input.row.version,
    packageDigest: input.row.packageDigest,
    credentialBindingRevision: input.row.credentialBindingRevision,
    desktopSessionDigest: desktopSessionDigest(input.desktopSessionProof),
    expiresAt,
  });
  return { reviewNonce, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumeReviewApproval(input: {
  ownerUserId: string;
  reviewNonce: string;
  row: ExternalCapabilityPackageRow;
  desktopSessionProof: string;
}): void {
  const nonce = String(input.reviewNonce || '').trim();
  if (!nonce) throw new Error('A one-time external capability review nonce is required.');
  const approval = reviewApprovals.get(nonce);
  reviewApprovals.delete(nonce);
  if (!approval || approval.expiresAt <= Date.now()) {
    throw new Error('The external capability review expired or was already used. Review the package again.');
  }
  if (
    approval.ownerUserId !== input.ownerUserId
    || approval.packageRowId !== input.row.id
    || approval.capabilityId !== input.row.capabilityId
    || approval.version !== input.row.version
    || approval.packageDigest !== input.row.packageDigest
    || !sameExternalCapabilityCredentialRevision(
      approval.credentialBindingRevision,
      input.row.credentialBindingRevision,
    )
    || approval.desktopSessionDigest !== desktopSessionDigest(input.desktopSessionProof)
  ) {
    throw new Error('The external capability review is not bound to this user, package, or native desktop session.');
  }
}

export function reviewedRow(input: {
  ownerUserId: string;
  reviewNonce: string;
  proposal?: unknown;
  id?: string;
  version?: string;
  packageDigest?: string;
}, store: ReturnType<typeof arrays>): ExternalCapabilityPackageRow {
  const approval = reviewApprovals.get(String(input.reviewNonce || '').trim());
  let proposal: ExternalCapabilityPackageProposal | undefined;
  let digest = String(input.packageDigest || '').trim().toLowerCase();
  if (input.proposal !== undefined) {
    proposal = normalizeExternalCapabilityProposal(input.proposal);
    digest = externalCapabilityProposalDigest(proposal);
  }
  const id = proposal?.id || String(input.id || '').trim().toLowerCase();
  const version = proposal?.version || String(input.version || '').trim();
  const row = store.packages.find(candidate => (
    candidate.id === approval?.packageRowId
    && approval.ownerUserId === input.ownerUserId
    && candidate.ownerUserId === input.ownerUserId
    && candidate.capabilityId === id
    && candidate.version === version
    && candidate.packageDigest === digest
    && (candidate.status === 'reviewed' || candidate.status === 'active')
  ));
  if (!row) throw new Error('No matching reviewed external capability package was found.');
  return row;
}
