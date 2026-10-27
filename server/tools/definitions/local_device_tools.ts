import type { ToolRegistry } from '../registry';
import type { ToolCapabilityMetadata, ToolContext } from '../types';
import { discoverLanDevices } from '../../devices/lan_discovery';
import { readPrinterInventory, readPrinterStatus } from '../../devices/printer_inventory';
import { readNetworkPrinterStatus } from '../../devices/ipp_printer';

const OBSERVATION_LIMIT = 'Observed on the Lumi control-center host; discovery is not pairing, and a queue/status query is not a completed physical print.';
const EXECUTION_HOST = 'lumi_backend_host';
function requireControlCenter(context?: ToolContext): void {
  if (context?.authenticated !== true || !context.userId?.trim() || context.localExecution !== true
    || context.executionBoundary !== 'trusted_local') {
    throw new Error('Device access requires the authenticated native desktop session on the Lumi control center.');
  }
}
function capability(id: string, type: 'local_read' | 'network_read', fields: string[], statuses: string[]): ToolCapabilityMetadata {
  return {
    id, family: 'devices', lane: 'system', operation: 'observe', risk: 'low',
    domains: ['devices'], tags: ['devices', 'control center'],
    sideEffects: [{ type, scope: 'Lumi control-center host and its physical LAN', reversible: true }],
    prerequisites: ['Authenticated native desktop session on the control center'],
    verification: {
      strategy: 'terminal_receipt', required: true,
      requiredFields: ['executionHost', ...fields], successStatuses: statuses,
      failureStatuses: ['unavailable', 'error', 'unsupported', 'query_failed'],
      successSignals: ['The requested read-only observation returned its own source and timestamp.'],
      limitations: [OBSERVATION_LIMIT],
    },
  };
}
export interface LocalDeviceAdapters {
  discover: typeof discoverLanDevices;
  printers: typeof readPrinterInventory;
  printerStatus: typeof readPrinterStatus;
  networkPrinterStatus: typeof readNetworkPrinterStatus;
}

export function registerLocalDeviceTools(registry: ToolRegistry, adapters: LocalDeviceAdapters = {
  discover: discoverLanDevices, printers: readPrinterInventory,
  printerStatus: readPrinterStatus, networkPrinterStatus: readNetworkPrinterStatus,
}): void {
  registry.register({
    name: 'lan_discover_devices',
    description: 'Discover advertised TV/receiver and printer services on the physical private IPv4 LAN of this Lumi control-center computer using bounded mDNS and SSDP queries. Returns candidate services and source interfaces. A silent device is not proof of absence. Advertised text/URLs are untrusted device data. Does not pair, control, or print.',
    routingHints: ['局域网设备', '发现电视', '查找打印机', '同一网络设备', 'LAN devices', 'discover TV'],
    parameters: { type: 'object', properties: {
      timeoutMs: { type: 'integer', minimum: 500, maximum: 8000, description: 'Discovery receive window; default 3000ms.' },
      protocols: { type: 'array', items: { type: 'string', enum: ['mdns', 'ssdp'] }, minItems: 1, uniqueItems: true },
    }, additionalProperties: false },
    permission: 'user', securityLevel: 'safe',
    capability: capability('devices.lan.discover', 'network_read', ['startedAt', 'finishedAt', 'interfaces', 'candidates'], ['completed']),
    evidence: { capability: 'devices.lan.discover', operation: 'observe', assurance: 'observed', limitations: [OBSERVATION_LIMIT] },
    handler: async (args, context) => {
      requireControlCenter(context);
      return JSON.stringify({ ...await adapters.discover({ timeoutMs: args.timeoutMs, protocols: args.protocols }), executionHost: EXECUTION_HOST });
    },
  });
  registry.register({
    name: 'printer_list',
    description: 'Read installed Windows printer queues and their raw spooler/offline flags, default queue, driver, port and job counters on this Lumi control-center computer. Physical network devices and Windows queues are different observations. Does not print, cancel jobs, install, change defaults, or infer physical online state from queue flags.',
    routingHints: ['打印机列表', '默认打印机', '打印队列', '连接的打印机', 'installed printers'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    permission: 'user', securityLevel: 'safe',
    capability: capability('devices.printers.list', 'local_read', ['observedAt', 'platform', 'printers', 'ports'], ['ok']),
    evidence: { capability: 'devices.printers.list', operation: 'observe', assurance: 'observed', limitations: [OBSERVATION_LIMIT] },
    handler: async (_args, context) => {
      requireControlCenter(context);
      const result = await adapters.printers();
      return JSON.stringify({ ...result, ok: result.status === 'ok', executionHost: EXECUTION_HOST, source: 'windows_spooler', limitations: [OBSERVATION_LIMIT] });
    },
  });
  registry.register({
    name: 'printer_status',
    description: 'Read the current raw status and restricted job counters for an exact installed Windows printer queue name returned by printer_list. This is a spooler observation, not a live network printer test. Does not print or change jobs.',
    routingHints: ['打印机状态', '打印任务状态', 'printer queue status'],
    parameters: { type: 'object', properties: { printerName: { type: 'string', description: 'Exact installed queue name from printer_list or supplied by the user.' } }, required: ['printerName'], additionalProperties: false },
    permission: 'user', securityLevel: 'safe',
    capability: capability('devices.printers.status', 'local_read', ['observedAt', 'platform', 'printer'], ['ok']),
    evidence: { capability: 'devices.printers.status', operation: 'observe', assurance: 'observed', limitations: [OBSERVATION_LIMIT] },
    handler: async (args, context) => {
      requireControlCenter(context);
      const result = await adapters.printerStatus(args.printerName);
      return JSON.stringify({ ...result, ok: result.status === 'ok', executionHost: EXECUTION_HOST, source: 'windows_spooler', limitations: [OBSERVATION_LIMIT] });
    },
  });
  registry.register({
    name: 'printer_network_status',
    description: 'Read printer state and supported formats with IPP Get-Printer-Attributes over HTTP at an advertised _ipp._tcp endpoint or exact user-supplied endpoint on the control-center physical private LAN. Use the literal IPv4 address, advertised port and resource path; do not guess them from a Windows queue name. No redirects, document submission, jobs, pairing, or configuration. IPPS-only endpoints require a separate TLS adapter.',
    routingHints: ['网络打印机状态', '打印机支持格式', 'IPP printer status'],
    parameters: { type: 'object', properties: {
      address: { type: 'string', description: 'Literal IPv4 peer address from LAN discovery or the user.' },
      port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Actual advertised IPP port.' },
      resourcePath: { type: 'string', description: 'Actual advertised resource path such as the rp TXT value with a leading slash.' },
    }, required: ['address', 'port', 'resourcePath'], additionalProperties: false },
    permission: 'user', securityLevel: 'safe',
    capability: capability('devices.printers.network_status', 'network_read', ['observedAt', 'target', 'ippStatusCode', 'attributes'], ['observed']),
    evidence: { capability: 'devices.printers.network_status', operation: 'observe', assurance: 'observed', limitations: [OBSERVATION_LIMIT] },
    handler: async (args, context) => {
      requireControlCenter(context);
      return JSON.stringify({ ...await adapters.networkPrinterStatus({ address: args.address, port: args.port, resourcePath: args.resourcePath }), executionHost: EXECUTION_HOST, source: 'ipp_get_printer_attributes' });
    },
  });
}
