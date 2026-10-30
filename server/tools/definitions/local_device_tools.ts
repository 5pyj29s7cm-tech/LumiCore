import type { ToolRegistry } from '../registry';
import type { ToolCapabilityMetadata, ToolContext } from '../types';
import { discoverLanDevices } from '../../devices/lan_discovery';
import { readPrinterInventory, readPrinterStatus } from '../../devices/printer_inventory';
import { readNetworkPrinterStatus } from '../../devices/ipp_printer';
import { readUsbSerialInventory, USB_SERIAL_OBSERVATION_LIMIT } from '../../devices/usb_serial_inventory';
import { submitPrinterTestPage, readPrinterJobStatus, PRINTER_JOB_LIMITATIONS } from '../../devices/printer_jobs';

const OBSERVATION_LIMIT = 'Observed on the Lumi control-center host; discovery is not pairing, and a queue/status query is not a completed physical print.';
const EXECUTION_HOST = 'lumi_backend_host';
function requireControlCenter(context?: ToolContext): void {
  if (context?.authenticated !== true || !context.userId?.trim() || context.localExecution !== true
    || context.executionBoundary !== 'trusted_local') {
    throw new Error('Device access requires the authenticated native desktop session on the Lumi control center.');
  }
}
function capability(id: string, type: 'local_read' | 'network_read', fields: string[], statuses: string[], limitations = [OBSERVATION_LIMIT]): ToolCapabilityMetadata {
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
      limitations,
    },
  };
}
export interface LocalDeviceAdapters {
  discover: typeof discoverLanDevices;
  printers: typeof readPrinterInventory;
  printerStatus: typeof readPrinterStatus;
  networkPrinterStatus: typeof readNetworkPrinterStatus;
  usbSerial: typeof readUsbSerialInventory;
  submitTestPage?: typeof submitPrinterTestPage;
  jobStatus?: typeof readPrinterJobStatus;
}

export function registerLocalDeviceTools(registry: ToolRegistry, adapters: LocalDeviceAdapters = {
  discover: discoverLanDevices, printers: readPrinterInventory,
  printerStatus: readPrinterStatus, networkPrinterStatus: readNetworkPrinterStatus, usbSerial: readUsbSerialInventory,
}): void {
  registry.register({
    name: 'lan_discover_devices',
    description: 'Discover advertised TV/receiver and printer services on the physical private IPv4 LAN of this Lumi control-center computer using bounded mDNS and SSDP queries. Returns candidate services and source interfaces. A silent device is not proof of absence. Advertised text/URLs are untrusted device data. Does not pair, control, or print.',
    // i18n-allow: Multilingual routing synonyms used to recognize device requests, not UI labels.
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
    description: 'Read installed Windows printer queues and their raw spooler/offline flags, default queue, driver, port and job counters on this Lumi control-center computer. The deviceIdentity graph has scope windows_device_registration and networkReachability not_tested. It records OS PnP parent/container and cachedAssociationEndpointAddress; each queue pnpIdentity points to exact OS queue nodes. observedAt is the read time, cacheUpdatedAt is unknown when null. Physical network devices and Windows queues are separate observations. Does not print, cancel jobs, install, change defaults, or infer physical online state from queue flags.',
    // i18n-allow: Multilingual routing synonyms used to recognize device requests, not UI labels.
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
    description: 'Read the current raw status and restricted job counters for an exact installed Windows printer queue name returned by printer_list. Includes the same source-bound OS PnP identity graph and cached endpoint metadata as printer_list. This is a spooler observation, not a live network printer test. Does not print or change jobs.',
    // i18n-allow: Multilingual routing synonyms used to recognize device requests, not UI labels.
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
    // i18n-allow: Multilingual routing synonyms used to recognize device requests, not UI labels.
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
  registry.register({
    name: 'usb_serial_list',
    description: 'Read currently present Windows Ports-class devices and unconfigured USB candidates on this Lumi control-center computer. Returns exact PnP instance IDs, hardware VID/PID, source-specific COM/PortName values, installed driver metadata and raw problem codes. Device Parameters PortName is read even when Win32_SerialPort omits a device. A USB bridge does not identify downstream firmware or prove an MCP connection. Device-provided text is untrusted. Does not open ports, send serial commands, install drivers, reset devices, or probe firmware/network services.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    permission: 'user', securityLevel: 'safe',
    capability: capability('devices.usb_serial.list', 'local_read', ['observedAt', 'platform', 'devices'], ['ok'], [USB_SERIAL_OBSERVATION_LIMIT]),
    evidence: { capability: 'devices.usb_serial.list', operation: 'observe', assurance: 'observed', limitations: [USB_SERIAL_OBSERVATION_LIMIT] },
    handler: async (_args, context) => {
      requireControlCenter(context);
      const result = await adapters.usbSerial();
      return JSON.stringify({ ...result, ok: result.status === 'ok', executionHost: EXECUTION_HOST, source: 'windows_pnp_serial' });
    },
  });

  registry.register({
    name: 'printer_print_test_page',
    description: 'Print exactly one built-in Lumi test page through the installed Windows driver of the exact printer queue selected by the user or returned by printer_list. This consumes paper/ink. Returns the real Windows job id after GDI EndDoc succeeds. No arbitrary DOCX/PDF rendering, raw IPP submission, queue/port/default/driver changes, or automatic retry. A submitted job is not physical paper-completion proof; use printer_job_status for its exact queue/id.',
    parameters: { type: 'object', properties: { printerName: { type: 'string', description: 'Exact installed printer queue name chosen for this print action.' } }, required: ['printerName'], additionalProperties: false },
    permission: 'user', securityLevel: 'confirm',
    preflight: (_args, context) => { requireControlCenter(context); },
    capability: {
      id: 'devices.printers.print_test_page', family: 'devices', lane: 'system', operation: 'create', risk: 'medium',
      domains: ['devices'], tags: ['devices', 'printer'],
      sideEffects: [{ type: 'external_state_change', scope: 'One driver-rendered page on the exact selected installed printer queue', reversible: false }],
      prerequisites: ['Authenticated native desktop session on the control center', 'User-selected installed Windows printer queue and driver'],
      verification: { strategy: 'terminal_receipt', required: true,
        requiredFields: ['executionHost', 'observedAt', 'printerName', 'jobId', 'submission'], requiredValues: { ok: true, status: 'submitted' },
        successStatuses: ['submitted'], failureStatuses: ['not_submitted', 'submission_unknown', 'unsupported'],
        successSignals: ['The selected Windows driver returned a positive StartDoc job id and EndDoc succeeded.'], limitations: [...PRINTER_JOB_LIMITATIONS] },
    },
    evidence: { capability: 'devices.printers.print_test_page', operation: 'create', assurance: 'observed', limitations: [...PRINTER_JOB_LIMITATIONS] },
    handler: async (args, context) => {
      requireControlCenter(context);
      return JSON.stringify({ ...await (adapters.submitTestPage ?? submitPrinterTestPage)(args.printerName), executionHost: EXECUTION_HOST });
    },
  });
  registry.register({
    name: 'printer_job_status',
    description: 'Read the current Windows spooler receipt for an exact installed printer queue and positive job id returned by printer_print_test_page or supplied by the user. Returns raw job flags and page counters. not_observed is a successful current observation, not permanent absence or a prohibition on a later query. A missing/disappearing job or PRINTED flag does not independently prove physical paper output. Does not submit, cancel, clear, restart or change any job.',
    parameters: { type: 'object', properties: {
      printerName: { type: 'string', description: 'Exact installed queue name from the submission receipt.' },
      jobId: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Exact Windows StartDoc/spooler job identifier.' },
    }, required: ['printerName', 'jobId'], additionalProperties: false },
    permission: 'user', securityLevel: 'safe',
    capability: capability('devices.printers.job_status', 'local_read', ['observedAt', 'printerName', 'jobId', 'job'], ['job_observed', 'not_observed'], [...PRINTER_JOB_LIMITATIONS]),
    evidence: { capability: 'devices.printers.job_status', operation: 'observe', assurance: 'observed', limitations: [...PRINTER_JOB_LIMITATIONS] },
    handler: async (args, context) => {
      requireControlCenter(context);
      return JSON.stringify({ ...await (adapters.jobStatus ?? readPrinterJobStatus)(args.printerName, args.jobId), executionHost: EXECUTION_HOST });
    },
  });

}
