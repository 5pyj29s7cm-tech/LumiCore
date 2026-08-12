import type {
  LAPContextEntry,
  LAPContextFirewallDecision,
  LAPMemoryIngestionMode,
  LAPPrivacyClass,
  LAPSession,
} from './types';

const MAX_CONTEXT_PAYLOAD_LENGTH = 12_000;

export function inferLAPPrivacyClass(entry: Partial<LAPContextEntry>): LAPPrivacyClass {
  if (entry.privacyClass) return entry.privacyClass;
  if (entry.type === 'capability' || entry.type === 'knowledge') return 'public';
  if (entry.type === 'preference') return 'shared';
  return 'private';
}

export function evaluateLAPContextFirewall(
  entry: LAPContextEntry,
  session?: LAPSession,
  options: { localUserApproved?: boolean } = {},
): LAPContextFirewallDecision {
  if (!entry || typeof entry !== 'object') {
    return rejectLAPContext('Context entry is missing or malformed');
  }
  if (!entry.payload || typeof entry.payload !== 'string') {
    return rejectLAPContext('Context payload is required');
  }
  if (entry.payload.length > MAX_CONTEXT_PAYLOAD_LENGTH) {
    return rejectLAPContext(`Context payload exceeds ${MAX_CONTEXT_PAYLOAD_LENGTH} characters`);
  }
  if (typeof entry.confidence !== 'number' || entry.confidence < 0 || entry.confidence > 1) {
    return rejectLAPContext('Context confidence must be between 0 and 1');
  }
  if (!['memory', 'preference', 'capability', 'knowledge'].includes(entry.type)) {
    return rejectLAPContext(`Unsupported context type: ${(entry as any).type}`);
  }
  if (!['one-time', 'session', 'permanent'].includes(entry.scope)) {
    return rejectLAPContext(`Unsupported context scope: ${(entry as any).scope}`);
  }

  const privacyClass = inferLAPPrivacyClass(entry);
  // `entry.userApproved` is supplied by the remote peer and is provenance only;
  // it can never stand in for consent from this Lumi's authenticated owner.
  const locallyApproved = options.localUserApproved === true;
  if ((privacyClass === 'private' || privacyClass === 'secret') && !locallyApproved) {
    return rejectLAPContext(`User approval is required for ${privacyClass} LAP context`);
  }
  if (entry.scope === 'permanent' && !locallyApproved) {
    return rejectLAPContext('Permanent LAP context requires explicit user approval');
  }
  if (entry.scope === 'permanent' && session?.trustLevel !== 'direct') {
    return rejectLAPContext('Permanent LAP context requires a direct-trust session');
  }

  const memoryIngestion: LAPMemoryIngestionMode =
    entry.scope === 'permanent' && locallyApproved ? 'candidate_memory' : 'external_context';

  return {
    accepted: true,
    normalizedEntry: {
      ...entry,
      origin: entry.origin || 'external_lumi',
      privacyClass,
      userApproved: locallyApproved,
      tags: entry.tags || [],
    },
    memoryIngestion,
    mayAffectPersonality: false,
  };
}

function rejectLAPContext(reason: string): LAPContextFirewallDecision {
  return {
    accepted: false,
    reason,
    memoryIngestion: 'blocked',
    mayAffectPersonality: false,
  };
}
