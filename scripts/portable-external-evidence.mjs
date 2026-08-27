#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PortableExternalEvidenceCollector,
  PortableExternalEvidenceError,
  assertPortableEvidenceRuntime,
  computePortableCollectorBundleSha256,
  normalizePortableEvidenceManifest,
  readPortableEvidenceJsonFile,
  readPortableEvidenceKeyFile,
  validatePortableEvidenceDocument,
} from './lib/portable-external-evidence.mjs';
import { probePortablePassiveStore } from './lib/portable-passive-store-probe.mjs';

export function portableExternalCollectorBundleSha256() {
  return computePortableCollectorBundleSha256([
    {
      name: 'scripts/lib/portable-external-evidence.mjs',
      path: fileURLToPath(new URL('./lib/portable-external-evidence.mjs', import.meta.url)),
    },
    {
      name: 'scripts/lib/portable-passive-store-probe.mjs',
      path: fileURLToPath(new URL('./lib/portable-passive-store-probe.mjs', import.meta.url)),
    },
    {
      name: 'scripts/portable-external-evidence.mjs',
      path: fileURLToPath(import.meta.url),
    },
  ]);
}

const COMMAND_FLAGS = Object.freeze({
  'probe-store': new Set(['manifest', 'data-root', 'hmac-key-file', 'captured-at', 'pretty']),
  'capture-provider': new Set([
    'manifest', 'hmac-key-file', 'payload-file', 'provider-request-nonce',
    'scenario-id', 'phase-id', 'request-id', 'phase-nonce', 'captured-at', 'pretty',
  ]),
  verify: new Set(['manifest', 'hmac-key-file', 'evidence', 'pretty']),
});

const REQUIRED_FLAGS = Object.freeze({
  'probe-store': ['manifest', 'data-root', 'hmac-key-file'],
  'capture-provider': [
    'manifest', 'hmac-key-file', 'payload-file', 'scenario-id', 'phase-id',
    'request-id', 'phase-nonce', 'provider-request-nonce',
  ],
  verify: ['manifest', 'hmac-key-file', 'evidence'],
});

export function portableExternalEvidenceCliUsage() {
  return [
    'Portable external evidence prototype (never opens the formal LumiOS/LumiCore data root).',
    '',
    'Commands:',
    '  probe-store --manifest <json> --data-root <isolated-root> --hmac-key-file <file>',
    '  capture-provider --manifest <json> --payload-file <provider-body.json>',
    '    --scenario-id <id> --phase-id <id> --request-id <id> --phase-nonce <nonce>',
    '    --provider-request-nonce <nonce> --hmac-key-file <file>',
    '  verify --manifest <json> --evidence <signed-json> --hmac-key-file <file>',
    '',
    'All evidence is written to stdout. No command accepts a latest/newest selector.',
  ].join('\n');
}

function cliFail(code) {
  throw new PortableExternalEvidenceError(code);
}

export function parsePortableExternalEvidenceCliArgs(argv) {
  const values = Array.isArray(argv) ? [...argv] : [];
  if (values.length === 0 || values[0] === '--help' || values[0] === '-h') {
    return { command: 'help', options: {} };
  }
  const command = String(values.shift() || '');
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) cliFail('portable_evidence_cli_command_invalid');
  const options = {};
  while (values.length > 0) {
    const token = String(values.shift() || '');
    if (!token.startsWith('--')) cliFail('portable_evidence_cli_flag_invalid');
    const name = token.slice(2);
    if (!allowed.has(name) || Object.prototype.hasOwnProperty.call(options, name)) {
      cliFail('portable_evidence_cli_flag_invalid');
    }
    if (name === 'pretty') {
      options[name] = true;
      continue;
    }
    if (values.length === 0 || String(values[0]).startsWith('--')) {
      cliFail('portable_evidence_cli_flag_value_required');
    }
    options[name] = String(values.shift());
  }
  for (const name of REQUIRED_FLAGS[command]) {
    if (!String(options[name] || '').trim()) cliFail(`portable_evidence_cli_${name.replaceAll('-', '_')}_required`);
  }
  return { command, options };
}

function readProviderPayload(filename) {
  const absolute = path.resolve(String(filename || ''));
  let metadata;
  try { metadata = fs.lstatSync(absolute); } catch (error) {
    throw new PortableExternalEvidenceError('portable_evidence_provider_payload_file_missing', undefined, error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 16 * 1024 * 1024) {
    cliFail('portable_evidence_provider_payload_file_invalid');
  }
  return fs.readFileSync(absolute);
}

function serializeOutput(value, pretty) {
  return `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
}

export async function runPortableExternalEvidenceCli(argv, io = {}) {
  const parsed = parsePortableExternalEvidenceCliArgs(argv);
  const write = typeof io.write === 'function' ? io.write : value => process.stdout.write(value);
  if (parsed.command === 'help') {
    write(`${portableExternalEvidenceCliUsage()}\n`);
    return 0;
  }
  const manifestInput = readPortableEvidenceJsonFile(parsed.options.manifest);
  const manifest = assertPortableEvidenceRuntime(
    normalizePortableEvidenceManifest(manifestInput),
    portableExternalCollectorBundleSha256(),
  );
  const hmacKey = readPortableEvidenceKeyFile(parsed.options['hmac-key-file']);
  const pretty = parsed.options.pretty === true;

  if (parsed.command === 'probe-store') {
    const result = await probePortablePassiveStore({
      manifest,
      dataRoot: parsed.options['data-root'],
      hmacKey,
      capturedAt: parsed.options['captured-at'],
    });
    write(serializeOutput(result, pretty));
    return 0;
  }

  if (parsed.command === 'capture-provider') {
    const collector = new PortableExternalEvidenceCollector({
      manifest,
      hmacKey,
      now: parsed.options['captured-at']
        ? () => new Date(parsed.options['captured-at'])
        : undefined,
    });
    const record = collector.captureProviderRequest({
      scenarioId: parsed.options['scenario-id'],
      phaseId: parsed.options['phase-id'],
      requestId: parsed.options['request-id'],
      phaseNonce: parsed.options['phase-nonce'],
    }, readProviderPayload(parsed.options['payload-file']), {
      providerRequestNonce: parsed.options['provider-request-nonce'],
    });
    write(serializeOutput(record, pretty));
    return 0;
  }

  const evidence = readPortableEvidenceJsonFile(parsed.options.evidence, 32 * 1024 * 1024);
  const validation = validatePortableEvidenceDocument(evidence, hmacKey, manifest);
  write(serializeOutput(validation, pretty));
  return validation.ok ? 0 : 2;
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  runPortableExternalEvidenceCli(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }).catch(error => {
    const code = error instanceof PortableExternalEvidenceError
      ? error.code
      : 'portable_evidence_cli_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
