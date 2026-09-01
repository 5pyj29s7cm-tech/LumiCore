import './helpers';
import crypto from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDatabase,
  flushDBOrThrow,
  initDatabase,
  readDB,
  writeDB,
} from '../db_layer';
import {
  configureExtensionRuntimeForTests,
  extensionCredentialNamespace,
  extensionManifestSigningPayload,
  getExactRegisteredExtensionToolNames,
  hydrateActiveExtensions,
  isRegisteredOpenAICompatibleProvider,
  listExtensionRuntimeSnapshots,
  listExtensions,
  listRegisteredProviders,
  resetExtensionRegistryForTests,
  type LumiExtensionManifest,
} from '../server/extensions/registry';
import { makeLLMCall } from '../server/llm/providers';
import { runWithTools } from '../server/llm/adapter';
import { getUserPreferredLLM, upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { buildActionContract } from '../server/cognition/action_contract';
import { routeToolsForTurn } from '../server/cognition/tool_router';
import { registerExtensionRegistryTools } from '../server/tools/definitions/extension_registry_tools';
import { ToolRegistry, resetExternalCommitRuntimeCacheForTests } from '../server/tools/registry';

const USER_ID = 'extension-registry-user';
const ORIGIN = 'https://extension-provider.test';

function trustedLocalAdminContext(extra: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    authenticated: true,
    authRole: 'admin',
    localExecution: true,
    executionBoundary: 'trusted_local' as const,
    domain: 'personal',
    ...extra,
  };
}

interface FakeRuntimeState {
  calls: Array<{ url: string; method: string; body: Record<string, any>; authorization: string }>;
  externalVerified: boolean;
  reconcileVerified: boolean;
  modelResponses?: Array<{ content?: string; toolCalls?: Array<{ name: string; arguments: Record<string, any> }> }>;
}

let registry: ToolRegistry;
let runtimeState: FakeRuntimeState;

function jsonResponse(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body, 'utf8')),
    },
  });
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, any>> {
  const raw = typeof init?.body === 'string'
    ? init.body
    : input instanceof Request
      ? await input.clone().text()
      : '';
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function fakeFetch(state: FakeRuntimeState): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = await requestBody(input, init);
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    state.calls.push({
      url,
      method: String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      body,
      authorization: headers.get('authorization') || '',
    });
    const path = new URL(url).pathname;
    if (path.endsWith('/models')) return jsonResponse({ data: [{ id: 'signed-model' }] });
    if (path.endsWith('/chat/completions')) {
      const scripted = state.modelResponses?.shift();
      return jsonResponse({
        id: 'signed-provider-completion',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: scripted?.content ?? `signed:${body.model}`,
            ...(scripted?.toolCalls?.length ? {
              tool_calls: scripted.toolCalls.map((call, index) => ({
                id: `signed-call-${index}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            } : {}),
          },
          finish_reason: scripted?.toolCalls?.length ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      });
    }
    if (path.endsWith('/health')) return jsonResponse({ ok: true });
    if (path.endsWith('/reconcile')) {
      return jsonResponse(state.reconcileVerified
        ? { ok: true, verified: true, verificationStatus: 'verified', status: 'completed' }
        : { ok: true, verified: false, verificationStatus: 'unknown', status: 'unknown' });
    }
    if (path.endsWith('/commit')) {
      return jsonResponse(state.externalVerified
        ? { ok: true, verified: true, verificationStatus: 'verified', status: 'completed', providerReceiptId: 'provider-1' }
        : { ok: true, verified: false, verificationStatus: 'unknown', status: 'unknown' });
    }
    if (path.endsWith('/observe')) {
      return jsonResponse({ ok: true, verified: true, verificationStatus: 'verified', status: 'completed', value: body.arguments?.query || '' });
    }
    return jsonResponse({ error: 'not found' }, 404);
  }) as typeof fetch;
}

function keyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

function signedManifest(input: {
  id?: string;
  version?: string;
  keys?: ReturnType<typeof keyPair>;
  origin?: string;
  localNetwork?: boolean;
  includeProvider?: boolean;
  includeObserveTool?: boolean;
  includeCommitTool?: boolean;
} = {}): LumiExtensionManifest {
  const id = input.id || 'ext_signed_provider';
  const origin = input.origin || ORIGIN;
  const keys = input.keys || keyPair();
  const tools: NonNullable<LumiExtensionManifest['tools']> = [];
  if (input.includeObserveTool !== false) {
    tools.push({
      name: `${id}_observe`,
      description: 'Read a value from the signed test service.',
      endpointPath: '/observe',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      permission: 'user',
      securityLevel: 'safe',
      routingHints: ['signed extension observation'],
      capability: {
        id: `${id}.observe`,
        family: 'signed_test',
        lane: 'general',
        operation: 'observe',
        risk: 'low',
        sideEffects: [{ type: 'none', scope: 'read only', reversible: true }],
        verification: {
          strategy: 'provider_ack',
          required: true,
          requiredFields: ['verified', 'verificationStatus'],
          successSignals: ['provider acknowledgement'],
          limitations: [],
        },
      },
    });
  }
  if (input.includeCommitTool) {
    tools.push({
      name: `${id}_commit`,
      description: 'Perform one confirmed external state change through the signed test service.',
      endpointPath: '/commit',
      reconcilePath: '/reconcile',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      permission: 'user',
      securityLevel: 'confirm',
      routingHints: ['signed extension external commit'],
      capability: {
        id: `${id}.commit`,
        family: 'signed_test',
        lane: 'general',
        operation: 'mutate',
        risk: 'high',
        sideEffects: [{ type: 'external_state_change', scope: 'signed test service', reversible: false }],
        verification: {
          strategy: 'provider_ack',
          required: true,
          requiredFields: ['verified', 'verificationStatus', 'providerReceiptId'],
          successSignals: ['provider acknowledgement'],
          limitations: [],
        },
      },
    });
  }
  const manifest: LumiExtensionManifest = {
    schemaVersion: 1,
    extensionApiVersion: 1,
    id,
    version: input.version || '1.0.0',
    name: 'Signed Provider Test',
    publisher: {
      id: 'lumi.test.publisher',
      publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    },
    signature: { algorithm: 'ed25519', value: '' },
    permissions: {
      networkOrigins: [origin],
      credentialRefs: [],
      localNetwork: input.localNetwork === true,
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 64 * 1024,
      timeoutMs: 5_000,
      maxConcurrency: 2,
    },
    auth: { type: 'none' },
    health: { path: '/health' },
    ...(input.includeProvider === false ? {} : {
      provider: {
        id,
        protocol: 'openai-compatible' as const,
        baseUrl: `${origin}/v1`,
        modelsPath: '/models',
        auth: { type: 'none' as const },
        defaultModel: 'signed-model',
        models: [{
          id: 'signed-model',
          capabilities: { text: true, vision: false, tools: true, json: true, streaming: true },
        }],
        local: origin.startsWith('http://127.') || origin.startsWith('http://localhost'),
      },
    }),
    tools,
  };
  manifest.signature.value = crypto.sign(null, extensionManifestSigningPayload(manifest), keys.privateKey).toString('base64');
  return manifest;
}

function configureRuntime(overrides: { persist?: () => Promise<void>; fetch?: typeof fetch; dnsAddress?: string } = {}): void {
  configureExtensionRuntimeForTests({
    fetch: overrides.fetch || fakeFetch(runtimeState),
    dnsLookup: async () => {
      const address = overrides.dnsAddress || '93.184.216.34';
      return [{ address, family: address.includes(':') ? 6 : 4 }];
    },
    ...(overrides.persist ? { persist: overrides.persist } : {}),
  });
}

async function install(manifest: LumiExtensionManifest, targetRegistry = registry): Promise<Record<string, any>> {
  return JSON.parse(await targetRegistry.execute('extension_registry_install', {
    manifest,
    trustPublisher: true,
  }, trustedLocalAdminContext({
    userConfirmed: true,
    taskId: `install-${manifest.id}-${manifest.version}`,
    requestId: `install-${manifest.version}`,
  })));
}

beforeAll(async () => {
  await initDatabase();
});

beforeEach(() => {
  resetExtensionRegistryForTests({ clearPersisted: true });
  resetExternalCommitRuntimeCacheForTests();
  registry = new ToolRegistry();
  registerExtensionRegistryTools(registry);
  runtimeState = { calls: [], externalVerified: true, reconcileVerified: false };
  configureRuntime();
});

afterEach(() => {
  vi.useRealTimers();
  configureExtensionRuntimeForTests(null);
  resetExtensionRegistryForTests();
});

describe('signed extension and Provider registry', () => {
  it('requires confirmation and rejects unsigned, tampered, credential-bearing, or unknown manifest fields', async () => {
    const manifest = signedManifest();
    await expect(registry.execute('extension_registry_install', { manifest, trustPublisher: true }, {
      userId: USER_ID,
      authenticated: true,
      authRole: 'user',
      localExecution: true,
      executionBoundary: 'trusted_local',
      userConfirmed: true,
    })).rejects.toThrow(/administrator/i);
    await expect(registry.execute('extension_registry_install', { manifest, trustPublisher: true }, {
      ...trustedLocalAdminContext(),
      localExecution: false,
      executionBoundary: 'remote_restricted',
      userConfirmed: true,
    })).rejects.toThrow(/remote|administrator/i);
    expect(runtimeState.calls).toHaveLength(0);

    await expect(registry.execute('extension_registry_install', { manifest, trustPublisher: true }, trustedLocalAdminContext()))
      .rejects.toThrow(/confirmation/i);

    const unsigned = structuredClone(manifest);
    unsigned.signature.value = '';
    await expect(install(unsigned)).rejects.toThrow(/signature verification failed/i);

    const tampered = structuredClone(manifest);
    tampered.name = 'Tampered after signing';
    await expect(install(tampered)).rejects.toThrow(/signature verification failed/i);

    const secret = structuredClone(manifest) as any;
    secret.apiKey = 'must-not-enter-the-registry';
    await expect(install(secret)).rejects.toThrow(/credential material/i);

    const unknown = structuredClone(manifest) as any;
    unknown.executeScript = 'arbitrary-code.js';
    await expect(install(unknown)).rejects.toThrow(/Unsupported extension manifest field/i);

    const globalCredential = structuredClone(manifest);
    globalCredential.permissions.credentialRefs = ['OPENAI_API_KEY'];
    globalCredential.auth = { type: 'bearer', credentialRef: 'OPENAI_API_KEY' };
    globalCredential.provider!.auth = { type: 'bearer', credentialRef: 'OPENAI_API_KEY' };
    await expect(install(globalCredential)).rejects.toThrow(/dedicated.*credential namespace/i);
    expect(readDB().extensionRevisions).toHaveLength(0);
  });

  it('fails closed on unsafe origins and DNS targets before issuing a request', async () => {
    const keys = keyPair();
    expect(() => signedManifest({ keys, origin: 'http://extension-provider.test' })).toThrow(/must use HTTPS/i);

    configureRuntime({ dnsAddress: '169.254.169.254' });
    const privateTarget = await install(signedManifest({ keys, version: '1.0.1' }));
    expect(privateTarget).toMatchObject({ ok: false, status: 'compatibility_failed' });
    expect(privateTarget.receipt.error).toMatch(/private|link-local/i);
    expect(runtimeState.calls).toHaveLength(0);

    configureRuntime({ dnsAddress: '::ffff:127.0.0.1' });
    const mappedLoopback = await install(signedManifest({ keys, version: '1.0.2' }));
    expect(mappedLoopback).toMatchObject({ ok: false, status: 'compatibility_failed' });
    expect(mappedLoopback.receipt.error).toMatch(/private|link-local/i);
    expect(runtimeState.calls).toHaveLength(0);
  });

  it('applies the total timeout while DNS resolution is still pending', async () => {
    vi.useFakeTimers();
    configureExtensionRuntimeForTests({
      fetch: fakeFetch(runtimeState),
      dnsLookup: async () => new Promise<never>(() => undefined),
    });
    const manifest = signedManifest({ includeProvider: false });
    manifest.permissions.timeoutMs = 1_000;
    const keys = keyPair();
    manifest.publisher.publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    manifest.signature.value = crypto.sign(null, extensionManifestSigningPayload(manifest), keys.privateKey).toString('base64');

    const pending = install(manifest);
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await pending;

    expect(result).toMatchObject({ ok: false, status: 'compatibility_failed' });
    expect(result.receipt.error).toMatch(/total timeout|resolution.*aborted/i);
    expect(runtimeState.calls).toHaveLength(0);
  });

  it('cancels a chunked extension response as soon as its signed byte budget is exceeded', async () => {
    let cancelled = false;
    const oversizedFetch = (async (input: RequestInfo | URL) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (pathname.endsWith('/models')) return jsonResponse({ data: [{ id: 'signed-model' }] });
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(700));
        },
        cancel() {
          cancelled = true;
        },
      }), { status: 200 });
    }) as typeof fetch;
    configureRuntime({ fetch: oversizedFetch });
    const manifest = signedManifest({ includeProvider: false });
    manifest.permissions.maxResponseBytes = 1_024;
    const keys = keyPair();
    manifest.publisher.publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    manifest.signature.value = crypto.sign(null, extensionManifestSigningPayload(manifest), keys.privateKey).toString('base64');

    const result = await install(manifest);

    expect(result).toMatchObject({ ok: false, status: 'compatibility_failed' });
    expect(result.receipt.error).toMatch(/response-byte budget/i);
    expect(cancelled).toBe(true);
  });

  it('stores publisher trust independently for each local user', async () => {
    const keys = keyPair();
    const first = signedManifest({ id: 'ext_user_one', keys, includeProvider: false });
    const second = signedManifest({ id: 'ext_user_two', keys, includeProvider: false });
    await install(first);
    const secondUser = 'extension-registry-user-two';

    const activated = JSON.parse(await registry.execute('extension_registry_install', {
      manifest: second,
      trustPublisher: true,
    }, trustedLocalAdminContext({
      userId: secondUser,
      userConfirmed: true,
      taskId: 'install-second-user',
      requestId: 'install-second-user-request',
    })));

    expect(activated).toMatchObject({ ok: true, status: 'activated' });
    const trustedBy = readDB().extensionPublishers
      .filter((publisher: any) => publisher.publisherId === first.publisher.id)
      .flatMap((publisher: any) => Array.isArray(publisher.trustedBy) ? publisher.trustedBy : [publisher.trustedBy])
      .sort();
    expect(trustedBy).toEqual([USER_ID, secondUser].sort());
  });

  it('activates a compatible provider/tool revision with provenance and exact routing', async () => {
    const manifest = signedManifest();
    const result = await install(manifest);
    expect(result).toMatchObject({
      ok: true,
      status: 'activated',
      verificationStatus: 'verified',
      runtimeStatus: 'registered',
      registered: true,
      usable: true,
      registeredToolNames: [`${manifest.id}_observe`],
    });
    expect(result.receipt.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.signerFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(isRegisteredOpenAICompatibleProvider(manifest.id, USER_ID)).toBe(true);

    const toolName = `${manifest.id}_observe`;
    const entry = registry.getCapabilityManifestEntry(toolName);
    expect(entry).toMatchObject({
      provider: manifest.id,
      source: 'adapter',
      operation: 'observe',
      requiresConfirmation: true,
      risk: 'high',
      sideEffects: expect.arrayContaining([
        expect.objectContaining({ type: 'external_communication' }),
      ]),
      provenance: { kind: 'adapter', provider: manifest.id, trust: 'user-reviewed' },
    });
    await expect(registry.execute(toolName, { query: 'hello' }, {
      userId: USER_ID,
      taskId: 'observe-unconfirmed',
      requestId: 'observe-unconfirmed-request',
    })).rejects.toThrow(/confirmation/i);
    expect(runtimeState.calls.filter(call => call.url.endsWith('/observe'))).toHaveLength(0);
    const observed = JSON.parse(await registry.execute(toolName, { query: 'hello' }, {
      userId: USER_ID,
      taskId: 'observe-1',
      requestId: 'observe-request-1',
      idempotencyKey: 'observe-idempotency-1',
      userConfirmed: true,
    }));
    expect(observed).toMatchObject({
      ok: true,
      verified: false,
      verificationStatus: 'unverified',
      providerClaimedVerified: true,
      extensionId: manifest.id,
      extensionVersion: '1.0.0',
      endpointOrigin: ORIGIN,
      value: 'hello',
    });

    const contract = buildActionContract('安装一个签名的 OpenAI-compatible Provider 扩展');
    expect(contract).toMatchObject({ kind: 'extension_registry', preferredTools: ['extension_registry_install'] });
    const route = routeToolsForTurn(
      '安装一个签名的 OpenAI-compatible Provider 扩展',
      registry.getToolDeclarations(),
      { capabilityManifest: registry.getCapabilityManifest() },
    );
    expect(route.hardAllowlist).toBe(true);
    expect(route.toolNames).toEqual(expect.arrayContaining(['extension_registry_install', 'extension_registry_list', 'extension_registry_receipts']));
    expect(route.toolNames).not.toEqual(expect.arrayContaining(['install_skill', 'generate_skill']));
  });

  it('reports current registry truth for list and already-active instead of trusting declared names', async () => {
    const manifest = signedManifest({ includeProvider: false });
    const activated = await install(manifest);
    const toolName = `${manifest.id}_observe`;
    const listed = JSON.parse(listExtensions({ userId: USER_ID }, registry));
    expect(listed.extensions.find((item: any) => item.id === activated.revisionId)).toMatchObject({
      runtimeStatus: 'registered',
      registered: true,
      usable: true,
      registeredToolNames: [toolName],
    });
    expect(JSON.parse(listExtensions({ userId: USER_ID })).extensions
      .find((item: any) => item.id === activated.revisionId)).toMatchObject({
      runtimeStatus: 'registered',
      usable: true,
      registeredToolNames: [toolName],
    });
    expect(listExtensionRuntimeSnapshots({ userId: USER_ID })).toContainEqual(expect.objectContaining({
      extensionId: manifest.id,
      revisionId: activated.revisionId,
      runtimeStatus: 'registered',
      usable: true,
      registeredToolNames: [toolName],
    }));

    const alreadyActive = await install(manifest);
    expect(alreadyActive).toMatchObject({
      ok: true,
      status: 'already_active',
      runtimeStatus: 'registered',
      registeredToolNames: [toolName],
    });

    registry.unregister(toolName);
    const stale = await install(manifest);
    expect(stale).toMatchObject({
      ok: false,
      status: 'runtime_unavailable',
      runtimeStatus: 'registration_missing',
      registered: false,
      usable: false,
      registeredToolNames: [],
    });
  });

  it('rejects an active provider whose persisted signed identity changed after activation', async () => {
    const manifest = signedManifest();
    const activated = await install(manifest);
    const db = readDB();
    const revision = db.extensionRevisions.find((item: any) => item.id === activated.revisionId);
    revision.manifest.provider.baseUrl = 'https://attacker.invalid/v1';
    revision.manifest.permissions.networkOrigins = ['https://attacker.invalid'];
    writeDB(db);

    await expect(registry.execute(`${manifest.id}_observe`, { query: 'tampered' }, {
      userId: USER_ID,
      userConfirmed: true,
      taskId: 'tampered-active-task',
      requestId: 'tampered-active-request',
    })).rejects.toThrow(/identity|signature|signed revision/i);
    expect(runtimeState.calls.filter(call => call.url.includes('attacker.invalid'))).toHaveLength(0);
    expect(isRegisteredOpenAICompatibleProvider(manifest.id, USER_ID)).toBe(false);
    expect(listRegisteredProviders(USER_ID)).toEqual([]);
    expect(registry.get(`${manifest.id}_observe`)).toBeUndefined();
    expect(listExtensionRuntimeSnapshots({ userId: USER_ID })).toContainEqual(expect.objectContaining({
      extensionId: manifest.id,
      usable: false,
      registered: false,
    }));
  });

  it('uses a newly activated signed tool in the same exact task and confirms its external commit separately', async () => {
    const publisherKeys = keyPair();
    const modelProvider = signedManifest({ id: 'ext_signed_model_host', keys: publisherKeys, includeObserveTool: false });
    await install(modelProvider);
    const target = signedManifest({
      id: 'ext_signed_same_task',
      keys: publisherKeys,
      includeProvider: false,
      includeObserveTool: false,
      includeCommitTool: true,
    });
    const targetTool = `${target.id}_commit`;
    runtimeState.modelResponses = [
      {
        content: 'Activate the exact signed extension.',
        toolCalls: [{
          name: 'extension_registry_install',
          arguments: { manifest: target, trustPublisher: true },
        }],
      },
      {
        content: 'Use the newly activated tool for the same task.',
        toolCalls: [{ name: targetTool, arguments: { value: 'same-task-value' } }],
      },
      { content: 'The signed extension completed the same task.' },
    ];
    const confirmation = vi.fn(async (_name: string, _args: Record<string, any>) => true);
    const taskId = 'signed-extension-same-task';
    const result = await runWithTools(
      [{ role: 'user', content: 'Install this signed extension and then use it to commit same-task-value.' }],
      registry,
      { provider: modelProvider.id, model: 'signed-model', userId: USER_ID },
      undefined,
      4,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ...trustedLocalAdminContext(),
        taskId,
        requestConfirmation: confirmation,
        toolPolicy: {
          allowedTools: ['extension_registry_install', 'extension_registry_list', 'extension_registry_receipts'],
          forbiddenTools: [],
          requireConfirmation: ['extension_registry_install'],
          maxIterations: 4,
        },
        modelToolProjection: {
          toolNames: ['extension_registry_install', 'extension_registry_list', 'extension_registry_receipts'],
          requiredToolNames: ['extension_registry_install'],
          maxTools: 3,
          allowDynamicDiscovery: false,
        },
      },
    );

    expect(confirmation.mock.calls.map(call => call[0])).toEqual([
      'extension_registry_install',
      targetTool,
    ]);
    expect(result.toolCalls.map(record => record.name)).toEqual([
      'extension_registry_install',
      targetTool,
    ]);
    expect(result.toolCalls.every(record => record.taskId === taskId)).toBe(true);
    expect(runtimeState.calls.filter(call => call.url.endsWith('/commit'))).toHaveLength(1);
  });

  it('does not convert forged declared names or a wrong revision identity into runtime authority', async () => {
    const manifest = signedManifest({ includeProvider: false });
    const activated = await install(manifest);
    registry.register({
      name: `${manifest.id}_forged`,
      description: 'A forged lookalike that is not in the signed revision.',
      parameters: { type: 'object', properties: {} },
      permission: 'user',
      securityLevel: 'safe',
      capability: {
        id: `${manifest.id}.forged`,
        family: 'signed_test',
        lane: 'general',
        source: 'adapter',
        provider: manifest.id,
        operation: 'observe',
        risk: 'low',
        sideEffects: [{ type: 'none', scope: 'forged declaration', reversible: true }],
        verification: {
          strategy: 'terminal_receipt', required: true, requiredFields: ['status'],
          successSignals: ['forged'], limitations: [],
        },
        provenance: { kind: 'adapter', provider: manifest.id, trust: 'user-reviewed' },
        prerequisites: [
          `active signed revision ${activated.revisionId}`,
          `manifest digest ${activated.manifestDigest}`,
        ],
      },
      handler: async () => JSON.stringify({ ok: true, status: 'forged' }),
    });

    expect(getExactRegisteredExtensionToolNames({
      extensionId: manifest.id,
      revisionId: activated.revisionId,
      userId: USER_ID,
      manifestDigest: activated.manifestDigest,
      registry,
    })).toEqual([`${manifest.id}_observe`]);
    expect(getExactRegisteredExtensionToolNames({
      extensionId: manifest.id,
      revisionId: 'forged-revision',
      userId: USER_ID,
      manifestDigest: activated.manifestDigest,
      registry,
    })).toEqual([]);
  });

  it('runs an installed Provider through real inference and records the exact selected model', async () => {
    const manifest = signedManifest();
    await install(manifest);
    const preference = upsertUserPreferredLLM(USER_ID, {
      provider: manifest.id,
      model: 'signed-model',
      selectionMode: 'pinned',
    });
    expect(preference).toMatchObject({ provider: manifest.id, model: 'signed-model' });

    const result = await makeLLMCall(
      [{ role: 'user', content: 'Use the signed provider.' }],
      [],
      { provider: manifest.id, model: 'signed-model', userId: USER_ID, selectionMode: 'pinned' },
      () => null,
      () => null,
    );
    expect(result.text).toBe('signed:signed-model');
    expect(result.routing).toMatchObject({
      requestedProvider: manifest.id,
      selectedProvider: manifest.id,
      selectedModel: 'signed-model',
      selectionMode: 'pinned',
    });
    expect(runtimeState.calls.some(call => call.url.endsWith('/v1/chat/completions'))).toBe(true);
  });

  it('uses credential references without persisting or returning the credential value', async () => {
    const credentialName = `${extensionCredentialNamespace('ext_signed_provider')}TEST_TOKEN`;
    process.env[credentialName] = 'extension-secret-value';
    try {
      const manifest = signedManifest();
      const keys = keyPair();
      manifest.publisher.publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      manifest.permissions.credentialRefs = [credentialName];
      manifest.auth = { type: 'bearer', credentialRef: credentialName };
      manifest.provider!.auth = { type: 'bearer', credentialRef: credentialName };
      manifest.signature.value = crypto.sign(null, extensionManifestSigningPayload(manifest), keys.privateKey).toString('base64');
      await install(manifest);
      const credentialCalls = runtimeState.calls.filter(call => call.url.endsWith('/models') || call.url.endsWith('/health'));
      expect(credentialCalls.length).toBeGreaterThan(0);
      expect(credentialCalls.every(call => call.authorization === 'Bearer extension-secret-value')).toBe(true);
      expect(JSON.stringify(readDB().extensionRevisions)).not.toContain('extension-secret-value');
      expect(listExtensions({ userId: USER_ID })).not.toContain('extension-secret-value');
    } finally {
      delete process.env[credentialName];
    }
  });

  it('allows only a signed loopback Provider in strict privacy mode', async () => {
    const priorPrivacy = process.env.LUMI_PRIVACY;
    process.env.LUMI_PRIVACY = 'strict';
    try {
      const remote = signedManifest();
      await install(remote);
      await expect(makeLLMCall(
        [{ role: 'user', content: 'strict remote' }], [],
        { provider: remote.id, model: 'signed-model', userId: USER_ID, selectionMode: 'pinned' },
        () => null, () => null,
      )).rejects.toThrow(/strict mode|not declared.*local/i);
      expect(runtimeState.calls.filter(call => call.url.endsWith('/chat/completions'))).toHaveLength(0);

      resetExtensionRegistryForTests({ clearPersisted: true });
      registry = new ToolRegistry();
      registerExtensionRegistryTools(registry);
      configureRuntime();
      const local = signedManifest({
        id: 'ext_signed_local',
        origin: 'http://127.0.0.1:19090',
        localNetwork: true,
      });
      await install(local);
      const result = await makeLLMCall(
        [{ role: 'user', content: 'strict local' }], [],
        { provider: local.id, model: 'signed-model', userId: USER_ID, selectionMode: 'pinned' },
        () => null, () => null,
      );
      expect(result.text).toBe('signed:signed-model');
    } finally {
      if (priorPrivacy === undefined) delete process.env.LUMI_PRIVACY;
      else process.env.LUMI_PRIVACY = priorPrivacy;
    }
  });

  it('enforces confirmation and durable zero-resend behavior for an unverified external commit', async () => {
    runtimeState.externalVerified = false;
    const manifest = signedManifest({ includeCommitTool: true });
    await install(manifest);
    const toolName = `${manifest.id}_commit`;
    const context = {
      userId: USER_ID,
      taskId: 'external-commit-task',
      requestId: 'external-commit-request',
      idempotencyKey: 'extension-external-commit-key',
    };
    await expect(registry.execute(toolName, { value: 'one' }, context)).rejects.toThrow(/confirmation/i);
    const first = JSON.parse(await registry.execute(toolName, { value: 'one' }, { ...context, userConfirmed: true }));
    expect(first).toMatchObject({ verified: false, verificationStatus: 'unverified', status: 'unknown' });
    await expect(registry.execute(toolName, { value: 'one' }, { ...context, userConfirmed: true }))
      .rejects.toThrow(/unknown prior outcome|automatic resend was stopped/i);
    expect(runtimeState.calls.filter(call => call.url.endsWith('/commit'))).toHaveLength(1);
  });

  it('updates and rolls back signed revisions without losing the prior tool definition', async () => {
    const keys = keyPair();
    const v1 = signedManifest({ keys, version: '1.0.0' });
    const v2 = signedManifest({ keys, version: '2.0.0' });
    await install(v1);
    await install(v2);
    expect(registry.get(`${v2.id}_observe`)?.description).toContain('@2.0.0');

    const rollback = JSON.parse(await registry.execute('extension_registry_rollback', {
      extensionId: v1.id,
      version: '1.0.0',
    }, trustedLocalAdminContext({ userConfirmed: true, taskId: 'rollback-v1' })));
    expect(rollback).toMatchObject({
      ok: true,
      status: 'rollback_activated',
      runtimeStatus: 'registered',
      registered: true,
      usable: true,
      registeredToolNames: [`${v1.id}_observe`],
    });
    expect(registry.get(`${v1.id}_observe`)?.description).toContain('@1.0.0');
    const listed = JSON.parse(listExtensions({ userId: USER_ID }));
    expect(listed.extensions.find((item: any) => item.version === '1.0.0').status).toBe('active');
    expect(listed.extensions.find((item: any) => item.version === '2.0.0').status).toBe('inactive');
  });

  it('does not rollback to a persisted revision re-signed by another key', async () => {
    const keys = keyPair();
    const v1 = signedManifest({ keys, version: '1.0.0' });
    const v2 = signedManifest({ keys, version: '2.0.0' });
    await install(v1);
    await install(v2);

    const attacker = keyPair();
    const db = readDB();
    const target = db.extensionRevisions.find((item: any) => item.extensionId === v1.id && item.version === '1.0.0');
    target.manifest.publisher.publicKey = attacker.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    target.manifest.signature.value = crypto.sign(
      null,
      extensionManifestSigningPayload(target.manifest),
      attacker.privateKey,
    ).toString('base64');
    writeDB(db);

    await expect(registry.execute('extension_registry_rollback', {
      extensionId: v1.id,
      version: '1.0.0',
    }, trustedLocalAdminContext({ userConfirmed: true, taskId: 'rollback-tampered' })))
      .rejects.toThrow(/identity|publisher|fingerprint|signed revision/i);
    expect(registry.get(`${v2.id}_observe`)?.description).toContain('@2.0.0');
  });

  it('restores the previous active revision when activation persistence fails', async () => {
    const keys = keyPair();
    const v1 = signedManifest({ keys, version: '1.0.0' });
    const v2 = signedManifest({ keys, version: '2.0.0' });
    await install(v1);
    configureRuntime({ persist: async () => { throw new Error('injected persistence failure'); } });
    const failed = await install(v2);
    expect(failed).toMatchObject({ ok: false, status: 'rolled_back', rollback: 'previous_revision_restored' });
    expect(registry.get(`${v1.id}_observe`)?.description).toContain('@1.0.0');
    expect(JSON.parse(listExtensions({ userId: USER_ID })).extensions.find((item: any) => item.version === '1.0.0').status).toBe('active');
  });

  it('restores an active extension when disable persistence fails', async () => {
    const manifest = signedManifest();
    await install(manifest);
    configureRuntime({ persist: async () => { throw new Error('disable persistence failure'); } });
    const result = JSON.parse(await registry.execute('extension_registry_disable', {
      extensionId: manifest.id,
    }, trustedLocalAdminContext({ userConfirmed: true, taskId: 'disable-failure' })));
    expect(result).toMatchObject({ ok: false, status: 'disable_failed_previous_restored' });
    expect(registry.get(`${manifest.id}_observe`)).toBeDefined();
    expect(isRegisteredOpenAICompatibleProvider(manifest.id, USER_ID)).toBe(true);
  });

  it('preserves a disabled custom Provider selection and fails explicitly instead of silently substituting it', async () => {
    const manifest = signedManifest();
    await install(manifest);
    upsertUserPreferredLLM(USER_ID, { provider: manifest.id, model: 'signed-model', selectionMode: 'pinned' });
    await registry.execute('extension_registry_disable', { extensionId: manifest.id }, trustedLocalAdminContext({
      userConfirmed: true,
      taskId: 'disable-provider',
    }));
    expect(getUserPreferredLLM(USER_ID)).toMatchObject({ provider: manifest.id, model: 'signed-model' });
    await expect(makeLLMCall(
      [{ role: 'user', content: 'Do not silently switch.' }],
      [],
      { provider: manifest.id, model: 'signed-model', userId: USER_ID, selectionMode: 'pinned' },
      () => null,
      () => null,
    )).rejects.toThrow(/not active|Unsupported provider/i);
  });

  it('hydrates active signed extensions after a real database close and restart', async () => {
    const manifest = signedManifest();
    await install(manifest);
    await flushDBOrThrow();
    resetExtensionRegistryForTests();
    await closeDatabase();
    await initDatabase();
    runtimeState = { calls: [], externalVerified: true, reconcileVerified: false };
    configureRuntime();
    const restartedRegistry = new ToolRegistry();
    registerExtensionRegistryTools(restartedRegistry);
    const hydrated = await hydrateActiveExtensions(restartedRegistry);
    expect(hydrated).toEqual({ activated: 1, failed: 0, errors: [] });
    expect(restartedRegistry.get(`${manifest.id}_observe`)).toBeDefined();
    expect(isRegisteredOpenAICompatibleProvider(manifest.id, USER_ID)).toBe(true);
  });

  it('enforces provider response-byte and concurrency budgets for streamed SDK responses', async () => {
    const manifest = signedManifest();
    manifest.permissions.maxResponseBytes = 1_024;
    manifest.permissions.maxConcurrency = 1;
    const keys = keyPair();
    manifest.publisher.publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    manifest.signature.value = crypto.sign(null, extensionManifestSigningPayload(manifest), keys.privateKey).toString('base64');
    await install(manifest);

    let releaseResponse!: () => void;
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
    configureRuntime({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'signed-model' }] });
        if (url.endsWith('/health')) return jsonResponse({ ok: true });
        if (url.endsWith('/chat/completions')) {
          await responseGate;
          return jsonResponse({
            choices: [{ message: { role: 'assistant', content: 'x'.repeat(2_000) } }],
          });
        }
        return jsonResponse({ ok: true });
      }) as typeof fetch,
    });
    const first = makeLLMCall(
      [{ role: 'user', content: 'first' }], [],
      { provider: manifest.id, model: 'signed-model', userId: USER_ID, selectionMode: 'pinned' },
      () => null, () => null,
    );
    await new Promise(resolve => setTimeout(resolve, 25));
    await expect(makeLLMCall(
      [{ role: 'user', content: 'second' }], [],
      { provider: manifest.id, model: 'signed-model', userId: USER_ID, selectionMode: 'pinned' },
      () => null, () => null,
    )).rejects.toThrow(/concurrency budget/i);
    releaseResponse();
    await expect(first).rejects.toThrow(/response.*budget/i);
  });
});
