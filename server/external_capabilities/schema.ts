import crypto from 'node:crypto';

export const EXTERNAL_CAPABILITY_SCHEMA_VERSION = 1 as const;

export type ExternalCapabilityRuntimeKind =
  | 'builtin'
  | 'skill'
  | 'mcp'
  | 'signed_extension';

export type ExternalCapabilityExecutionMode =
  | 'manual'
  | 'assisted'
  | 'automatic_candidate';

export interface ExternalCapabilityRuntimeRef {
  id: string;
  kind: ExternalCapabilityRuntimeKind;
  provider?: string;
  manifestDigest?: string;
}

export interface ExternalCapabilityDocumentRef {
  kind: 'manual' | 'workflow' | 'api' | 'openapi' | 'mcp' | 'security';
  label: string;
  ref: string;
  sha256: string;
}

export interface ExternalCapabilityActionProposal {
  id: string;
  label: string;
  description: string;
  icon?: string;
  executionMode: ExternalCapabilityExecutionMode;
  runtimeRef: string;
  tool: {
    name: string;
    capabilityId: string;
    fixedArguments: Record<string, unknown>;
    userArgumentNames: string[];
  };
}

export interface ExternalCapabilityPackageProposal {
  schemaVersion: typeof EXTERNAL_CAPABILITY_SCHEMA_VERSION;
  id: string;
  version: string;
  name: string;
  description: string;
  presentation: {
    icon: string;
    placements: Array<'desktop' | 'skill_center' | 'command_center'>;
    launchActionId?: string;
  };
  guidance: {
    whenToUse: string[];
    whenNotToUse: string[];
    triggerHints: string[];
    steps: string[];
    completionRules: string[];
  };
  documents: ExternalCapabilityDocumentRef[];
  runtimeRefs: ExternalCapabilityRuntimeRef[];
  /** References only. Credential values are never valid package content. */
  credentialRefs: string[];
  actions: ExternalCapabilityActionProposal[];
  acceptance: {
    requiredActionIds: string[];
    minimumVerifiedRuns: number;
  };
}

const ID_RE = /^[a-z][a-z0-9._-]{2,95}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{1,127}$/;
const ICON_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const CREDENTIAL_REF_RE = /^[A-Za-z][A-Za-z0-9_.:-]{2,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SECRET_KEY_RE = /(?:password|passphrase|passkey|secret|token|api.?key|access.?key|authorization|cookie|private.?key|client.?secret|credential|(?:^|[_-])auth(?:entication)?(?:$|[_-])|(?:^|[_-])key(?:$|[_-])|session(?:id|key|token)?)/i;
const SECRET_VALUE_RE = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bbearer\s+[a-z0-9._~+/=-]{8,}|\bsk-[a-z0-9_-]{12,}\b|\bgh[pousr]_[a-z0-9]{20,}\b|\bgithub_pat_[a-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[a-z0-9-]{10,}\b|\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b|(?:api.?key|access.?token|client.?secret|credential|authorization)\s*[:=]\s*[^\s,;]{8,})/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object.`);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported field(s): ${unexpected.join(', ')}.`);
}

function boundedString(value: unknown, label: string, max: number, min = 1): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length < min || normalized.length > max) {
    throw new Error(`${label} must contain ${min}-${max} characters.`);
  }
  return normalized;
}

function boundedStringList(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must contain at most ${maxItems} items.`);
  }
  return Array.from(new Set(value.map((item, index) => boundedString(item, `${label}[${index}]`, maxLength))));
}

function scanForEmbeddedSecrets(value: unknown, path = 'proposal', depth = 0): void {
  if (depth > 8) throw new Error('External capability package nesting is too deep.');
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value)) throw new Error(`${path} contains credential material; store only a credential reference.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForEmbeddedSecrets(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const credentialReferenceField = key === 'credentialRefs';
    if (!credentialReferenceField && SECRET_KEY_RE.test(key)) {
      throw new Error(`${path}.${key} is credential material; capability packages may contain credentialRefs only.`);
    }
    scanForEmbeddedSecrets(item, `${path}.${key}`, depth + 1);
  }
}

function normalizeJsonValue(value: unknown, label: string, depth = 0): unknown {
  if (depth > 6) throw new Error(`${label} nesting is too deep.`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 4_000) throw new Error(`${label} contains a string longer than 4000 characters.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error(`${label} contains too many items.`);
    return value.map((item, index) => normalizeJsonValue(item, `${label}[${index}]`, depth + 1));
  }
  assertObject(value, label);
  if (Object.keys(value).length > 64) throw new Error(`${label} contains too many fields.`);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    boundedString(key, `${label} field name`, 128),
    normalizeJsonValue(item, `${label}.${key}`, depth + 1),
  ]));
}

function normalizeDocument(value: unknown, index: number): ExternalCapabilityDocumentRef {
  const label = `proposal.documents[${index}]`;
  assertObject(value, label);
  assertOnlyKeys(value, ['kind', 'label', 'ref', 'sha256'], label);
  const kind = boundedString(value.kind, `${label}.kind`, 16) as ExternalCapabilityDocumentRef['kind'];
  if (!['manual', 'workflow', 'api', 'openapi', 'mcp', 'security'].includes(kind)) {
    throw new Error(`${label}.kind is unsupported.`);
  }
  const ref = boundedString(value.ref, `${label}.ref`, 1_024);
  const safeHttpsRef = (() => {
    try {
      const url = new URL(ref);
      return url.protocol === 'https:'
        && !url.username
        && !url.password
        && !url.search
        && !url.hash;
    } catch {
      return false;
    }
  })();
  const controlledRelativeRef = /^(?:data-root|knowledge):[A-Za-z0-9][A-Za-z0-9_./-]{0,511}$/.test(ref)
    && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(ref.slice(ref.indexOf(':') + 1))
    && !/[\\]/.test(ref);
  const digestRef = /^sha256:[a-f0-9]{64}$/.test(ref);
  if (!safeHttpsRef && !controlledRelativeRef && !digestRef) {
    throw new Error(`${label}.ref must be a query-free HTTPS URL, controlled data-root/knowledge reference, or SHA-256 reference.`);
  }
  const sha256 = boundedString(value.sha256, `${label}.sha256`, 64).toLowerCase();
  if (!SHA256_RE.test(sha256)) throw new Error(`${label}.sha256 must be a SHA-256 digest.`);
  return {
    kind,
    label: boundedString(value.label || kind, `${label}.label`, 96),
    ref,
    sha256,
  };
}

function normalizeAction(value: unknown, index: number): ExternalCapabilityActionProposal {
  const label = `proposal.actions[${index}]`;
  assertObject(value, label);
  assertOnlyKeys(value, ['id', 'label', 'description', 'icon', 'executionMode', 'runtimeRef', 'tool'], label);
  assertObject(value.tool, `${label}.tool`);
  assertOnlyKeys(value.tool, ['name', 'capabilityId', 'fixedArguments', 'userArgumentNames'], `${label}.tool`);
  const id = boundedString(value.id, `${label}.id`, 64).toLowerCase();
  if (!ID_RE.test(id)) throw new Error(`${label}.id is invalid.`);
  const name = boundedString(value.tool.name, `${label}.tool.name`, 128);
  const capabilityId = boundedString(value.tool.capabilityId, `${label}.tool.capabilityId`, 160);
  if (!TOOL_NAME_RE.test(name)) throw new Error(`${label}.tool.name is invalid.`);
  const executionMode = boundedString(
    value.executionMode || 'assisted',
    `${label}.executionMode`,
    32,
  ) as ExternalCapabilityExecutionMode;
  if (!['manual', 'assisted', 'automatic_candidate'].includes(executionMode)) {
    throw new Error(`${label}.executionMode is unsupported.`);
  }
  const fixedArguments = value.tool.fixedArguments === undefined
    ? {}
    : normalizeJsonValue(value.tool.fixedArguments, `${label}.tool.fixedArguments`);
  assertObject(fixedArguments, `${label}.tool.fixedArguments`);
  const userArgumentNames = boundedStringList(
    value.tool.userArgumentNames,
    `${label}.tool.userArgumentNames`,
    32,
    128,
  );
  for (const argumentName of userArgumentNames) {
    if (!TOOL_NAME_RE.test(argumentName)) throw new Error(`${label}.tool.userArgumentNames contains an invalid name.`);
    if (Object.prototype.hasOwnProperty.call(fixedArguments, argumentName)) {
      throw new Error(`${label}.tool.${argumentName} cannot be both fixed and user supplied.`);
    }
  }
  const icon = value.icon === undefined ? undefined : boundedString(value.icon, `${label}.icon`, 64);
  if (icon && !ICON_RE.test(icon)) throw new Error(`${label}.icon must be a built-in icon identifier.`);
  const runtimeRef = boundedString(value.runtimeRef, `${label}.runtimeRef`, 96).toLowerCase();
  if (!ID_RE.test(runtimeRef)) throw new Error(`${label}.runtimeRef is invalid.`);
  return {
    id,
    label: boundedString(value.label, `${label}.label`, 96),
    description: boundedString(value.description, `${label}.description`, 500),
    ...(icon ? { icon } : {}),
    executionMode,
    runtimeRef,
    tool: { name, capabilityId, fixedArguments, userArgumentNames },
  };
}

function normalizeRuntimeRef(value: unknown, index: number): ExternalCapabilityRuntimeRef {
  const label = `proposal.runtimeRefs[${index}]`;
  assertObject(value, label);
  assertOnlyKeys(value, ['id', 'kind', 'provider', 'manifestDigest'], label);
  const id = boundedString(value.id, `${label}.id`, 96).toLowerCase();
  if (!ID_RE.test(id)) throw new Error(`${label}.id is invalid.`);
  const kind = boundedString(value.kind, `${label}.kind`, 32) as ExternalCapabilityRuntimeKind;
  if (!['builtin', 'skill', 'mcp', 'signed_extension'].includes(kind)) {
    throw new Error(`${label}.kind is unsupported.`);
  }
  const provider = value.provider === undefined
    ? undefined
    : boundedString(value.provider, `${label}.provider`, 128);
  if (kind !== 'builtin' && !provider) throw new Error(`${label}.provider is required for non-builtin runtimes.`);
  const manifestDigest = value.manifestDigest === undefined
    ? undefined
    : boundedString(value.manifestDigest, `${label}.manifestDigest`, 64).toLowerCase();
  if (manifestDigest && !SHA256_RE.test(manifestDigest)) {
    throw new Error(`${label}.manifestDigest must be a SHA-256 digest.`);
  }
  if (kind === 'signed_extension' && !manifestDigest) {
    throw new Error(`Signed-extension ${label} must pin manifestDigest.`);
  }
  return { id, kind, ...(provider ? { provider } : {}), ...(manifestDigest ? { manifestDigest } : {}) };
}

export function normalizeExternalCapabilityProposal(input: unknown): ExternalCapabilityPackageProposal {
  const serialized = JSON.stringify(input);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 128 * 1024) {
    throw new Error('External capability package exceeds the 128 KiB limit.');
  }
  scanForEmbeddedSecrets(input);
  assertObject(input, 'proposal');
  assertOnlyKeys(input, [
    'schemaVersion',
    'id',
    'version',
    'name',
    'description',
    'presentation',
    'guidance',
    'documents',
    'runtimeRefs',
    'credentialRefs',
    'actions',
    'acceptance',
  ], 'proposal');
  if (input.schemaVersion !== EXTERNAL_CAPABILITY_SCHEMA_VERSION) {
    throw new Error(`proposal.schemaVersion must be ${EXTERNAL_CAPABILITY_SCHEMA_VERSION}.`);
  }
  const id = boundedString(input.id, 'proposal.id', 96).toLowerCase();
  if (!ID_RE.test(id)) throw new Error('proposal.id is invalid.');
  const version = boundedString(input.version, 'proposal.version', 64);
  if (!VERSION_RE.test(version)) throw new Error('proposal.version must be semantic version text.');

  assertObject(input.presentation, 'proposal.presentation');
  assertOnlyKeys(input.presentation, ['icon', 'placements', 'launchActionId'], 'proposal.presentation');
  const icon = boundedString(input.presentation.icon, 'proposal.presentation.icon', 64);
  if (!ICON_RE.test(icon)) throw new Error('proposal.presentation.icon must be a built-in icon identifier.');
  const placements = boundedStringList(input.presentation.placements, 'proposal.presentation.placements', 3, 32) as ExternalCapabilityPackageProposal['presentation']['placements'];
  if (!placements.length || placements.some(item => !['desktop', 'skill_center', 'command_center'].includes(item))) {
    throw new Error('proposal.presentation.placements contains an unsupported placement.');
  }
  const launchActionId = input.presentation.launchActionId === undefined
    ? undefined
    : boundedString(input.presentation.launchActionId, 'proposal.presentation.launchActionId', 64).toLowerCase();
  if (launchActionId && !ID_RE.test(launchActionId)) {
    throw new Error('proposal.presentation.launchActionId is invalid.');
  }
  if (placements.includes('desktop') && !launchActionId) {
    throw new Error('Desktop capability packages must declare proposal.presentation.launchActionId.');
  }

  assertObject(input.guidance, 'proposal.guidance');
  assertOnlyKeys(input.guidance, ['whenToUse', 'whenNotToUse', 'triggerHints', 'steps', 'completionRules'], 'proposal.guidance');

  if (!Array.isArray(input.runtimeRefs) || input.runtimeRefs.length < 1 || input.runtimeRefs.length > 16) {
    throw new Error('proposal.runtimeRefs must contain 1-16 runtime references.');
  }
  const runtimeRefs = input.runtimeRefs.map(normalizeRuntimeRef);
  if (new Set(runtimeRefs.map(runtime => runtime.id)).size !== runtimeRefs.length) {
    throw new Error('proposal.runtimeRefs ids must be unique.');
  }

  if (!Array.isArray(input.documents) || input.documents.length > 24) {
    throw new Error('proposal.documents must contain at most 24 document references.');
  }
  const documents = input.documents.map(normalizeDocument);
  if (!documents.some(document => document.kind === 'manual' || document.kind === 'workflow')) {
    throw new Error('External capability packages require at least one manual or workflow document reference.');
  }
  const credentialRefs = boundedStringList(input.credentialRefs, 'proposal.credentialRefs', 24, 128);
  for (const ref of credentialRefs) {
    if (!CREDENTIAL_REF_RE.test(ref) || SECRET_VALUE_RE.test(ref)) {
      throw new Error('proposal.credentialRefs must contain reference identifiers, never credential values.');
    }
  }
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 32) {
    throw new Error('proposal.actions must contain 1-32 actions.');
  }
  const actions = input.actions.map(normalizeAction);
  if (new Set(actions.map(action => action.id)).size !== actions.length) {
    throw new Error('proposal.actions ids must be unique.');
  }
  const runtimeRefIds = new Set(runtimeRefs.map(runtime => runtime.id));
  const missingRuntime = actions.find(action => !runtimeRefIds.has(action.runtimeRef));
  if (missingRuntime) throw new Error(`proposal.actions '${missingRuntime.id}' references an unknown runtimeRef.`);
  if (launchActionId && !actions.some(action => action.id === launchActionId)) {
    throw new Error('proposal.presentation.launchActionId must reference a declared action.');
  }
  const acceptanceInput = input.acceptance === undefined ? {} : input.acceptance;
  assertObject(acceptanceInput, 'proposal.acceptance');
  assertOnlyKeys(acceptanceInput, ['requiredActionIds', 'minimumVerifiedRuns'], 'proposal.acceptance');
  const requiredActionIds = acceptanceInput.requiredActionIds === undefined
    ? actions.map(action => action.id)
    : boundedStringList(acceptanceInput.requiredActionIds, 'proposal.acceptance.requiredActionIds', 32, 64)
      .map(item => item.toLowerCase());
  if (!requiredActionIds.length || requiredActionIds.some(actionId => !actions.some(action => action.id === actionId))) {
    throw new Error('proposal.acceptance.requiredActionIds must reference declared actions.');
  }
  const minimumVerifiedRuns = acceptanceInput.minimumVerifiedRuns === undefined
    ? 1
    : Number(acceptanceInput.minimumVerifiedRuns);
  if (!Number.isInteger(minimumVerifiedRuns) || minimumVerifiedRuns < 1 || minimumVerifiedRuns > 20) {
    throw new Error('proposal.acceptance.minimumVerifiedRuns must be an integer from 1 to 20.');
  }
  if (actions.some(action => action.executionMode === 'automatic_candidate')) {
    const documentKinds = new Set(documents.map(document => document.kind));
    if (
      !(['manual', 'workflow'] as const).some(kind => documentKinds.has(kind))
      || !documentKinds.has('security')
      || !(['api', 'openapi', 'mcp'] as const).some(kind => documentKinds.has(kind))
    ) {
      throw new Error('Automatic-candidate packages require manual/workflow, security, and API/OpenAPI/MCP document references.');
    }
  }

  return {
    schemaVersion: EXTERNAL_CAPABILITY_SCHEMA_VERSION,
    id,
    version,
    name: boundedString(input.name, 'proposal.name', 96),
    description: boundedString(input.description, 'proposal.description', 800),
    presentation: {
      icon,
      placements: Array.from(new Set(placements)),
      ...(launchActionId ? { launchActionId } : {}),
    },
    guidance: (() => {
      const whenToUse = boundedStringList(input.guidance.whenToUse, 'proposal.guidance.whenToUse', 12, 240);
      const triggerHints = boundedStringList(input.guidance.triggerHints, 'proposal.guidance.triggerHints', 24, 120);
      const steps = boundedStringList(input.guidance.steps, 'proposal.guidance.steps', 24, 240);
      const completionRules = boundedStringList(input.guidance.completionRules, 'proposal.guidance.completionRules', 12, 240);
      if (!whenToUse.length || !triggerHints.length || !steps.length || !completionRules.length) {
        throw new Error('proposal.guidance.whenToUse, triggerHints, steps, and completionRules must each contain at least one item.');
      }
      return {
      whenToUse,
      whenNotToUse: boundedStringList(input.guidance.whenNotToUse, 'proposal.guidance.whenNotToUse', 12, 240),
      triggerHints,
      steps,
      completionRules,
      };
    })(),
    documents,
    runtimeRefs,
    credentialRefs,
    actions,
    acceptance: { requiredActionIds, minimumVerifiedRuns },
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => [key, stableValue((value as Record<string, unknown>)[key])]));
}

export function externalCapabilityProposalDigest(proposal: ExternalCapabilityPackageProposal): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(proposal))).digest('hex');
}

export function assertExternalCapabilityArguments(input: unknown): Record<string, unknown> {
  const value = input === undefined ? {} : input;
  scanForEmbeddedSecrets(value, 'arguments');
  const normalized = normalizeJsonValue(value, 'arguments');
  assertObject(normalized, 'arguments');
  return normalized;
}
