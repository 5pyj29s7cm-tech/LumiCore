import type { CapabilityManifestEntry, ToolExecutionRecord } from "../../tools/types";
import type { ExternalCapabilityActionProposal, ExternalCapabilityPackageProposal } from "../schema";

export type ExternalCapabilityStage = 'configured' | 'connected' | 'verified' | 'automatic';

export type ExternalCapabilityAvailability = 'ready' | 'unavailable';

export interface ResolvedActionSnapshot {
  actionId: string;
  runtimeRef: string;
  toolName: string;
  proxyToolName: string;
  capabilityId: string;
  source: CapabilityManifestEntry['source'];
  provider: string;
  executable: boolean;
  requiresConfirmation: boolean;
  permission: CapabilityManifestEntry['permission'];
  risk: CapabilityManifestEntry['risk'];
  sideEffects: CapabilityManifestEntry['sideEffects'];
  runtimeIdentityDigest: string;
}

export interface ExternalCapabilityPackageRow {
  id: string;
  ownerUserId: string;
  capabilityId: string;
  version: string;
  status: 'reviewed' | 'active' | 'inactive';
  packageDigest: string;
  /** Installation-keyed internal revision; never project through routes/manifests. */
  credentialBindingRevision: string;
  proposal: ExternalCapabilityPackageProposal;
  resolvedActions: ResolvedActionSnapshot[];
  availability: ExternalCapabilityAvailability;
  unavailableReason: string;
  createdAt: string;
  reviewedAt: string;
  activatedAt: string;
  updatedAt: string;
  lastHydratedAt: string;
}

export interface ExternalCapabilityReceiptRow {
  id: string;
  packageRowId: string;
  ownerUserId: string;
  capabilityId: string;
  actionId: string;
  kind: 'review' | 'activation' | 'execution';
  status: string;
  hostVerified: boolean;
  toolName: string;
  runtimeIdentityDigest?: string;
  credentialBindingRevision?: string;
  terminalVerification?: ToolExecutionRecord['terminalVerification'];
  envelope?: ToolExecutionRecord['envelope'];
  errorDigest?: string;
  requestId?: string;
  idempotencyKey?: string;
  inputDigest?: string;
  persistenceState?: 'persisted' | 'pending';
  canonicalOutcome?: {
    recordId: string;
    status: string;
    hostVerified: boolean;
    toolName: string;
    underlyingToolName: string;
    terminalVerification?: ToolExecutionRecord['terminalVerification'];
  };
  persistenceErrorDigest?: string;
  createdAt: string;
}

export interface ReviewApproval {
  ownerUserId: string;
  packageRowId: string;
  capabilityId: string;
  version: string;
  packageDigest: string;
  credentialBindingRevision: string;
  desktopSessionDigest: string;
  expiresAt: number;
}

export interface ExternalCapabilityProjection {
  id: string;
  version: string;
  name: string;
  description: string;
  stage: ExternalCapabilityStage;
  availability: ExternalCapabilityAvailability;
  unavailableReason?: string;
  presentation: ExternalCapabilityPackageProposal['presentation'];
  runtimeRefs: ExternalCapabilityPackageProposal['runtimeRefs'];
  guidance: ExternalCapabilityPackageProposal['guidance'];
  actions: Array<{
    id: string;
    label: string;
    description: string;
    icon?: string;
    capabilityId: string;
    toolName: string;
    underlyingToolName: string;
    executionMode: ExternalCapabilityActionProposal['executionMode'];
    requiresConfirmation: boolean;
    availability: ExternalCapabilityAvailability;
    verification: {
      status: 'never' | 'verified' | 'unverified' | 'failed';
      lastVerifiedAt?: string;
      verifiedRuns: number;
    };
  }>;
  activatedAt: string;
  updatedAt: string;
}
