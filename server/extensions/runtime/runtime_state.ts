import dns from "node:dns/promises";
import type OpenAI from "openai";
import { Agent as UndiciAgent } from "undici";
import { flushDBOrThrow, readDatabaseTables, commitDatabaseTables } from "../../../db_layer";
import type { ToolRegistry } from "../../tools/registry";
import type { ExtensionRevision, ExtensionRuntimeOverrides, LumiExtensionManifest } from './contracts';
import { isLoopbackHost, isPrivateAddress } from './network_policy';

export const activeRuntime = new Map<string, ExtensionRevision>();

export const registeredTools = new Map<string, {
  extensionId: string;
  revisionId: string;
  userId: string;
  registry: ToolRegistry;
}>();

export const providerClients = new Map<string, { revisionId: string; signature: string; client: OpenAI }>();

export const executionCounts = new Map<string, number>();

let runtimeOverrides: ExtensionRuntimeOverrides | null = null;

let activationLock: Promise<void> = Promise.resolve();

export async function assertResolvedDestinationAllowed(url: URL, manifest: LumiExtensionManifest): Promise<void> {
  if (!manifest.permissions.networkOrigins.includes(url.origin)) throw new Error(`Network sandbox denied origin ${url.origin}.`);
  if (isLoopbackHost(url.hostname)) {
    if (manifest.permissions.localNetwork !== true) throw new Error('Network sandbox denied loopback access.');
    return;
  }
  await resolveAllowedExtensionAddresses(url.hostname, manifest);
}

async function resolveAllowedExtensionAddresses(
  hostname: string,
  manifest: LumiExtensionManifest,
): Promise<Array<{ address: string; family: number }>> {
  const lookup = runtimeOverrides?.dnsLookup || (async (target: string) => dns.lookup(target, { all: true }));
  const addresses = await lookup(hostname);
  if (!addresses.length) throw new Error('Extension destination did not resolve.');
  if (addresses.some(item => isPrivateAddress(item.address)) && manifest.permissions.localNetwork !== true) {
    throw new Error('Network sandbox denied a destination resolving to a private or link-local address.');
  }
  return addresses.map(item => ({ address: item.address, family: Number(item.family) }));
}

function createExtensionNetworkDispatcher(manifest: LumiExtensionManifest): UndiciAgent {
  return new UndiciAgent({
    connect: {
      lookup: ((hostname: string, options: any, callback: (...args: any[]) => void) => {
        resolveAllowedExtensionAddresses(hostname, manifest)
          .then(addresses => {
            const requestedFamily = typeof options === 'number' ? options : Number(options?.family || 0);
            const matching = requestedFamily
              ? addresses.filter(item => item.family === requestedFamily)
              : addresses;
            if (!matching.length) {
              callback(new Error(`Extension destination has no allowed IPv${requestedFamily || ''} address.`));
              return;
            }
            if (options?.all === true) callback(null, matching);
            else callback(null, matching[0].address, matching[0].family);
          })
          .catch(error => callback(error));
      }) as any,
    },
  });
}

export async function extensionNetworkFetch(
  manifest: LumiExtensionManifest,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<{ response: Response; close: () => Promise<void> }> {
  if (runtimeOverrides?.fetch) {
    return { response: await runtimeOverrides.fetch(input, init), close: async () => undefined };
  }
  const dispatcher = createExtensionNetworkDispatcher(manifest);
  try {
    const response = await fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: UndiciAgent });
    return {
      response,
      close: async () => { await dispatcher.close(); },
    };
  } catch (error) {
    await dispatcher.close().catch(() => undefined);
    throw error;
  }
}

export async function persistStrict(): Promise<void> {
  if (runtimeOverrides?.persist) return runtimeOverrides.persist();
  return flushDBOrThrow();
}

export async function withActivationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = activationLock;
  let release!: () => void;
  activationLock = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await operation(); } finally { release(); }
}

export function configureExtensionRuntimeForTests(overrides: ExtensionRuntimeOverrides | null): void {
  runtimeOverrides = overrides;
  providerClients.clear();
}

export function resetExtensionRegistryForTests(options: { clearPersisted?: boolean } = {}): void {
  for (const [name, owner] of [...registeredTools.entries()]) {
    owner.registry.unregister(name);
    registeredTools.delete(name);
  }
  activeRuntime.clear();
  providerClients.clear();
  executionCounts.clear();
  activationLock = Promise.resolve();
  runtimeOverrides = null;
  if (options.clearPersisted) {
    const db = readDatabaseTables(["extensionActivationReceipts","extensionPublishers","extensionRevisions"]);
    db.extensionPublishers = [];
    db.extensionRevisions = [];
    db.extensionActivationReceipts = [];
    commitDatabaseTables(db);
  }
}
