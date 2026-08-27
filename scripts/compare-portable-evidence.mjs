#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PortableExternalEvidenceError,
  readPortableEvidenceJsonFile,
  readPortableEvidenceKeyFile,
} from './lib/portable-external-evidence.mjs';
import { comparePortableEvidencePairs } from './lib/portable-evidence-comparison.mjs';

const ALLOWED_FLAGS = new Set([
  'baseline-manifest', 'baseline-bundle', 'baseline-build', 'baseline-key',
  'candidate-manifest', 'candidate-bundle', 'candidate-build', 'candidate-key',
  'formal-native', 'compared-at', 'pretty',
]);

const REQUIRED_FLAGS = Object.freeze([
  'baseline-manifest', 'baseline-bundle', 'baseline-build', 'baseline-key',
  'candidate-manifest', 'candidate-bundle', 'candidate-build', 'candidate-key',
]);

export function portableEvidenceComparisonUsage() {
  return [
    'Compare signed baseline/candidate portable evidence without reading product state.',
    '',
    'Required:',
    '  --baseline-manifest <signed.json> --baseline-bundle <signed.json>',
    '  --baseline-build <signed.json> --baseline-key <file>',
    '  --candidate-manifest <signed.json> --candidate-bundle <signed.json>',
    '  --candidate-build <signed.json> --candidate-key <file>',
    '',
    'Optional:',
    '  --formal-native <signed.json> --compared-at <ISO> --pretty',
    '',
    'Missing formal-native evidence is reported as not_run and can never release.',
  ].join('\n');
}

function fail(code) {
  throw new PortableExternalEvidenceError(code);
}

export function parsePortableEvidenceComparisonArgs(argv) {
  const values = Array.isArray(argv) ? [...argv] : [];
  if (values.length === 0 || values[0] === '--help' || values[0] === '-h') {
    return { help: true, options: {} };
  }
  const options = {};
  while (values.length > 0) {
    const token = String(values.shift() || '');
    if (!token.startsWith('--')) fail('portable_comparison_cli_flag_invalid');
    const name = token.slice(2);
    if (!ALLOWED_FLAGS.has(name) || Object.prototype.hasOwnProperty.call(options, name)) {
      fail('portable_comparison_cli_flag_invalid');
    }
    if (name === 'pretty') {
      options[name] = true;
      continue;
    }
    if (values.length === 0 || String(values[0]).startsWith('--')) {
      fail('portable_comparison_cli_flag_value_required');
    }
    options[name] = String(values.shift());
  }
  for (const name of REQUIRED_FLAGS) {
    if (!String(options[name] || '').trim()) {
      fail(`portable_comparison_cli_${name.replaceAll('-', '_')}_required`);
    }
  }
  return { help: false, options };
}

export async function runPortableEvidenceComparisonCli(argv, io = {}) {
  const parsed = parsePortableEvidenceComparisonArgs(argv);
  const write = typeof io.write === 'function' ? io.write : text => process.stdout.write(text);
  if (parsed.help) {
    write(`${portableEvidenceComparisonUsage()}\n`);
    return 0;
  }
  const options = parsed.options;
  const baselineKey = readPortableEvidenceKeyFile(options['baseline-key']);
  const candidateKey = readPortableEvidenceKeyFile(options['candidate-key']);
  const comparison = comparePortableEvidencePairs({
    baseline: {
      hmacKey: baselineKey,
      manifest: readPortableEvidenceJsonFile(options['baseline-manifest'], 8 * 1024 * 1024),
      bundle: readPortableEvidenceJsonFile(options['baseline-bundle'], 32 * 1024 * 1024),
      buildIdentity: readPortableEvidenceJsonFile(options['baseline-build'], 2 * 1024 * 1024),
    },
    candidate: {
      hmacKey: candidateKey,
      manifest: readPortableEvidenceJsonFile(options['candidate-manifest'], 8 * 1024 * 1024),
      bundle: readPortableEvidenceJsonFile(options['candidate-bundle'], 32 * 1024 * 1024),
      buildIdentity: readPortableEvidenceJsonFile(options['candidate-build'], 2 * 1024 * 1024),
      formalNativeEvidence: options['formal-native']
        ? readPortableEvidenceJsonFile(options['formal-native'], 8 * 1024 * 1024)
        : undefined,
    },
  }, { comparedAt: options['compared-at'] });
  write(`${JSON.stringify(comparison, null, options.pretty ? 2 : 0)}\n`);
  return comparison.releaseEligible ? 0 : 2;
}

function isMainModule() {
  return Boolean(process.argv[1])
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMainModule()) {
  runPortableEvidenceComparisonCli(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }).catch(error => {
    const code = error instanceof PortableExternalEvidenceError
      ? error.code
      : 'portable_comparison_cli_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
