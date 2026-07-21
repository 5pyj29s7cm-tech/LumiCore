import dns from 'node:dns/promises';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import type { ToolRegistry } from '../registry';
import { CN_TOOL_DISCOVERY_HINTS } from '../../regions/packs/cn/tool_discovery_hints';

type NetworkProfile = 'basic' | 'deep';

const PROFILE_TARGETS: Record<NetworkProfile, string[]> = {
  basic: ['https://www.baidu.com', 'https://www.bing.com'],
  deep: ['https://www.baidu.com', 'https://www.bing.com', 'https://example.com'],
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function resolveHost(hostname: string) {
  const startedAt = performance.now();
  try {
    const addresses = await withTimeout(dns.lookup(hostname, { all: true }), 5_000, 'DNS lookup');
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - startedAt),
      addresses: Array.from(new Set(addresses.map(address => address.address))).slice(0, 4),
    };
  } catch (error: any) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      addresses: [],
      error: String(error?.message || error || 'DNS lookup failed').slice(0, 240),
    };
  }
}

async function sampleHttp(url: string, timeoutMs: number) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'LumiOS-Network-Diagnostic/1.0' },
    });
    try { await response.body?.cancel(); } catch {}
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Math.round(performance.now() - startedAt),
      finalUrl: response.url,
      ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      finalUrl: url,
      error: String(error?.name === 'AbortError' ? 'HTTP request timed out' : error?.message || error || 'HTTP request failed').slice(0, 240),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sampleHttpRepeatedly(url: string, attempts: number) {
  const samples: Array<Awaited<ReturnType<typeof sampleHttp>>> = [];
  for (let index = 0; index < attempts; index += 1) {
    samples.push(await sampleHttp(url, 8_000));
    if (index < attempts - 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 150));
    }
  }
  return samples;
}

async function checkLocalServicePort(port: number) {
  const startedAt = performance.now();
  return new Promise<Record<string, unknown>>(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (result: Record<string, unknown>) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ port, latencyMs: Math.round(performance.now() - startedAt), ...result });
    };
    socket.setTimeout(2_000);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, error: 'connection timed out' }));
    socket.once('error', error => finish({ ok: false, error: String(error.message || error).slice(0, 160) }));
  });
}

export async function runNetworkStabilityCheck(args: Record<string, any> = {}): Promise<Record<string, unknown>> {
  const profile: NetworkProfile = args.profile === 'deep' ? 'deep' : 'basic';
  const samplesPerTarget = profile === 'deep' ? 3 : 2;
  const targets = PROFILE_TARGETS[profile];
  const startedAt = new Date().toISOString();

  const targetResults = await Promise.all(targets.map(async url => {
    const hostname = new URL(url).hostname;
    const [dnsResult, samples] = await Promise.all([
      resolveHost(hostname),
      sampleHttpRepeatedly(url, samplesPerTarget),
    ]);
    const successfulSamples = samples.filter(sample => sample.ok);
    const latencies = successfulSamples.map(sample => sample.latencyMs);
    return {
      url,
      hostname,
      dns: dnsResult,
      http: {
        attempts: samples.length,
        successes: successfulSamples.length,
        failures: samples.length - successfulSamples.length,
        successRate: samples.length ? successfulSamples.length / samples.length : 0,
        latencyMs: latencies.length ? {
          min: Math.min(...latencies),
          average: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
          max: Math.max(...latencies),
        } : null,
        samples,
      },
    };
  }));

  const localServices = args.includeLocalService === true
    ? [await checkLocalServicePort(3000)]
    : [];
  const dnsPassed = targetResults.every(target => target.dns.ok);
  const httpPassed = targetResults.every(target => target.http.successes === target.http.attempts);
  const localPassed = localServices.every(service => service.ok === true);

  return {
    ok: dnsPassed && httpPassed && localPassed,
    status: dnsPassed && httpPassed && localPassed ? 'completed' : 'completed_with_findings',
    profile,
    measurement: 'dns_and_http_samples',
    startedAt,
    finishedAt: new Date().toISOString(),
    samplesPerTarget,
    targets: targetResults,
    localServices,
    limitations: [
      'This measures DNS resolution and HTTP request success/latency, not ICMP ping or packet loss.',
      'A successful sample proves only the sampled endpoint and time window, not long-term network stability.',
      'Local service checks cover only the explicitly reported fixed Lumi service port.',
    ],
  };
}

export function registerNetworkDiagnosticTools(registry: ToolRegistry): void {
  registry.register({
    name: 'network_stability_check',
    description: 'Run a bounded, read-only Lumi network stability diagnostic using repeated DNS and HTTP samples against fixed public endpoints. Deep mode uses three endpoints and three samples each. It can also test the fixed local Lumi service port 3000. This is not ICMP ping and must not be reported as packet-loss evidence.',
    routingHints: [...CN_TOOL_DISCOVERY_HINTS.networkStability],
    parameters: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          enum: ['basic', 'deep'],
          description: 'basic uses two endpoints/two samples; deep uses three endpoints/three samples.',
        },
        includeLocalService: {
          type: 'boolean',
          description: 'Also test the fixed local Lumi backend port 3000.',
        },
      },
      required: [],
    },
    handler: async args => JSON.stringify(await runNetworkStabilityCheck(args), null, 2),
    permission: 'user',
    securityLevel: 'safe',
    evidence: {
      capability: 'network.stability',
      operation: 'test',
      assurance: 'measured',
      limitations: [
        'DNS and HTTP samples only; no ICMP ping or packet-loss measurement.',
        'Represents only the sampled endpoints and time window.',
      ],
    },
  });
}
