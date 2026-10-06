import { cloneDatabaseValue } from "../../db/snapshot_changes";
import OpenAI from "openai";
import { EXTENSION_ID_RE, digest } from './manifest_validation';
import { runtimeRevision, assertRevisionOwner, assertCurrentExecutableRevision, invalidateRevisionRuntime } from './runtime_revision';
import type { OpenAICompatibleProviderManifest, ExtensionProviderModel, ExtensionRevision } from './contracts';
import { acquireConcurrency } from './concurrency';
import { assertResolvedDestinationAllowed, extensionNetworkFetch, providerClients } from './runtime_state';
import { credentialValue } from './network_request';
import { arrays } from './persistence';
import { verifyPersistedRevision } from './revision_verification';

export function isExtensionProviderId(value: unknown): value is string {
  return typeof value === 'string' && EXTENSION_ID_RE.test(value);
}

export function isRegisteredOpenAICompatibleProvider(providerId: unknown, userId?: string): boolean {
  if (!isExtensionProviderId(providerId)) return false;
  const revision = runtimeRevision(providerId);
  return Boolean(revision?.manifest.provider && (!userId || revision.userId === userId));
}

export function getRegisteredProviderDefaultModel(providerId: string, userId?: string): string {
  const revision = runtimeRevision(providerId);
  if (!revision?.manifest.provider || (userId && revision.userId !== userId)) return '';
  return revision.manifest.provider.defaultModel;
}

export function getRegisteredProviderManifest(providerId: string, userId?: string): OpenAICompatibleProviderManifest | null {
  const revision = runtimeRevision(providerId);
  if (!revision?.manifest.provider || (userId && revision.userId !== userId)) return null;
  return cloneDatabaseValue(revision.manifest.provider);
}

export function isRegisteredProviderLocal(providerId: string, userId?: string): boolean {
  return getRegisteredProviderManifest(providerId, userId)?.local === true;
}

export function assertRegisteredProviderModel(
  providerId: string,
  modelId: string,
  options: { userId?: string; needsVision?: boolean; needsTools?: boolean; needsJson?: boolean; needsStreaming?: boolean } = {},
): ExtensionProviderModel {
  const revision = runtimeRevision(providerId);
  if (!revision?.manifest.provider) throw new Error(`Extension provider ${providerId} is not active.`);
  assertRevisionOwner(revision, options.userId);
  const model = revision.manifest.provider.models.find(item => item.id === modelId);
  if (!model) throw new Error(`Model ${modelId} is not declared by signed provider ${providerId}.`);
  if (options.needsVision && model.capabilities.vision !== true) throw new Error(`Model ${modelId} does not declare vision capability.`);
  if (options.needsTools && model.capabilities.tools !== true) throw new Error(`Model ${modelId} does not declare tool-calling capability.`);
  if (options.needsJson && model.capabilities.json !== true) throw new Error(`Model ${modelId} does not declare JSON response capability.`);
  if (options.needsStreaming && model.capabilities.streaming !== true) throw new Error(`Model ${modelId} does not declare streaming capability.`);
  return cloneDatabaseValue(model);
}

function providerClientFetch(revision: ExtensionRevision): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    assertCurrentExecutableRevision(revision);
    const release = acquireConcurrency(revision);
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url || String(input));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), revision.manifest.permissions.timeoutMs!);
    let finished = false;
    let closeNetwork = async () => undefined;
    const finish = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      release();
      await closeNetwork().catch(() => undefined);
    };
    const callerSignal = init?.signal || request?.signal;
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    try {
      await assertResolvedDestinationAllowed(url, revision.manifest);
      const body = init?.body;
      let bodyBytes = 0;
      if (typeof body === 'string') bodyBytes = Buffer.byteLength(body, 'utf8');
      else if (body instanceof URLSearchParams) bodyBytes = Buffer.byteLength(body.toString(), 'utf8');
      else if (body instanceof ArrayBuffer) bodyBytes = body.byteLength;
      else if (ArrayBuffer.isView(body)) bodyBytes = body.byteLength;
      else if (request?.body && !['GET', 'HEAD'].includes(request.method.toUpperCase())) {
        const declaredLength = Number(request.headers.get('content-length') || 0);
        if (!declaredLength) throw new Error('Provider streaming request bodies are not allowed by the extension sandbox.');
        bodyBytes = declaredLength;
      }
      if (bodyBytes > revision.manifest.permissions.maxRequestBytes!) {
        throw new Error('Provider request exceeds its signed request-byte budget.');
      }
      const secured = await extensionNetworkFetch(
        revision.manifest,
        input,
        { ...init, signal, redirect: 'error' },
      );
      closeNetwork = secured.close;
      const response = secured.response;
      const length = Number(response.headers.get('content-length') || 0);
      if (length > revision.manifest.permissions.maxResponseBytes!) throw new Error('Provider response exceeds its signed response-byte budget.');
      if (!response.body) {
        await finish();
        return response;
      }
      const reader = response.body.getReader();
      let responseBytes = 0;
      const bodyStream = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              await finish();
              streamController.close();
              return;
            }
            responseBytes += chunk.value.byteLength;
            if (responseBytes > revision.manifest.permissions.maxResponseBytes!) {
              controller.abort();
              await reader.cancel('response byte budget exceeded');
              await finish();
              streamController.error(new Error('Provider response exceeded its signed response-byte budget.'));
              return;
            }
            streamController.enqueue(chunk.value);
          } catch (error) {
            await finish();
            streamController.error(error);
          }
        },
        async cancel(reason) {
          try { await reader.cancel(reason); } finally { await finish(); }
        },
      });
      return new Response(bodyStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      await finish();
      throw error;
    }
  }) as typeof fetch;
}

export function getRegisteredOpenAIClient(providerId: string, userId?: string): OpenAI | null {
  const revision = runtimeRevision(providerId);
  if (!revision?.manifest.provider) return null;
  assertRevisionOwner(revision, userId);
  const provider = revision.manifest.provider;
  const credential = provider.auth.type === 'bearer' ? credentialValue(provider.auth.credentialRef!) : 'no-auth';
  if (provider.auth.type === 'bearer' && !credential) throw new Error(`Required credentialRef ${provider.auth.credentialRef} is not configured.`);
  const signature = digest([revision.id, provider.baseUrl, provider.auth.credentialRef || '', credential || '']);
  const cached = providerClients.get(providerId);
  if (cached?.signature === signature) return cached.client;
  const client = new OpenAI({
    apiKey: credential || 'no-auth',
    baseURL: provider.baseUrl,
    timeout: revision.manifest.permissions.timeoutMs,
    maxRetries: 0,
    fetch: providerClientFetch(revision),
  });
  providerClients.set(providerId, { revisionId: revision.id, signature, client });
  return client;
}

export function listRegisteredProviders(userId?: string): Array<Record<string, unknown>> {
  try {
    const store = arrays();
    return store.revisions
      .filter(item => item.status === 'active' && item.manifest.provider && (!userId || item.userId === userId))
      .filter(item => {
        try {
          verifyPersistedRevision(item, store);
          return true;
        } catch {
          invalidateRevisionRuntime(item);
          return false;
        }
      })
      .map(item => ({
        id: item.extensionId,
        version: item.version,
        userId: item.userId,
        local: item.manifest.provider!.local === true,
        defaultModel: item.manifest.provider!.defaultModel,
        models: item.manifest.provider!.models.map(model => ({ ...model })),
        configured: item.manifest.provider!.auth.type === 'none' || Boolean(credentialValue(item.manifest.provider!.auth.credentialRef!)),
        manifestDigest: item.manifestDigest,
        signerFingerprint: item.signerFingerprint,
        compatibility: item.compatibility,
      }));
  } catch {
    return [];
  }
}
