import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FormalStage9ProducerEvidenceError,
  assembleFormalStage9UnadjudicatedBundle,
  createFormalStage9FileBackedProducerEvidence,
  formalStage9ProducerEvidenceExitCode,
} from './lib/formal-stage9-producer-evidence.mjs';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;

function fail(code, details = {}) {
  throw new FormalStage9ProducerEvidenceError(code, details);
}

function text(value) {
  return String(value ?? '').trim();
}

function assertNoLinkedComponents(value, code) {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  try {
    for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) fail(code);
    }
  } catch (error) {
    if (error instanceof FormalStage9ProducerEvidenceError) throw error;
    fail(code, { cause: error?.message });
  }
}

function directoryIdentity(directory, code) {
  try {
    const metadata = fs.lstatSync(directory);
    const real = fs.realpathSync.native(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code);
    return { real, dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    if (error instanceof FormalStage9ProducerEvidenceError) throw error;
    fail(code, { cause: error?.message });
  }
}

function assertSameDirectoryIdentity(directory, expected, code) {
  const actual = directoryIdentity(directory, code);
  const sameReal = process.platform === 'win32'
    ? actual.real.toLowerCase() === expected.real.toLowerCase()
    : actual.real === expected.real;
  if (!sameReal
    || (expected.dev && actual.dev !== expected.dev)
    || (expected.ino && actual.ino !== expected.ino)) fail(code);
}

function fsyncDirectory(directory, code) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'win32') fail(code, { cause: error?.message });
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function readStableJson(filePath, code) {
  const requested = text(filePath);
  if (!requested || !path.isAbsolute(requested)) fail(code);
  const absolute = path.resolve(requested);
  assertNoLinkedComponents(absolute, code);
  let descriptor;
  try {
    const metadata = fs.lstatSync(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
      fail(code);
    }
    descriptor = fs.openSync(fs.realpathSync.native(absolute), fs.constants.O_RDONLY);
    const before = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      fail(`${code}_changed_during_read`);
    }
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof FormalStage9ProducerEvidenceError) throw error;
    fail(code, { cause: error?.message });
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function parseArgs(argv) {
  const command = text(argv[0]);
  if (!['produce', 'assemble'].includes(command)) fail('formal_stage9_package_command_invalid');
  const allowed = command === 'produce'
    ? new Set(['--producer', '--binding', '--payload', '--scenario-sources', '--evidence-root', '--recorded-at', '--output'])
    : new Set(['--binding', '--packages', '--evidence-root', '--created-at', '--completed-at', '--output']);
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = text(argv[index]);
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || Object.hasOwn(options, flag.slice(2))) {
      fail('formal_stage9_package_arguments_invalid');
    }
    options[flag.slice(2)] = value;
  }
  const required = command === 'produce'
    ? ['producer', 'binding', 'payload', 'scenario-sources', 'evidence-root', 'output']
    : ['binding', 'packages', 'evidence-root', 'output'];
  if (required.some(key => !text(options[key]))) fail('formal_stage9_package_arguments_incomplete');
  for (const key of required.filter(key => key !== 'producer')) {
    if (!path.isAbsolute(text(options[key]))) fail(`formal_stage9_${key}_absolute_required`);
    options[key] = path.resolve(options[key]);
  }
  return { command, options };
}

function writeJsonExclusive(outputPath, value) {
  if (!path.isAbsolute(text(outputPath))) fail('formal_stage9_output_absolute_required');
  const destination = path.resolve(outputPath);
  const parent = path.dirname(destination);
  assertNoLinkedComponents(parent, 'formal_stage9_output_parent_invalid');
  const parentMetadata = fs.lstatSync(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    fail('formal_stage9_output_parent_invalid');
  }
  const parentIdentity = directoryIdentity(parent, 'formal_stage9_output_parent_invalid');
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(16).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o400);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, destination);
    assertSameDirectoryIdentity(
      parent,
      parentIdentity,
      'formal_stage9_output_parent_changed',
    );
    try { fs.chmodSync(destination, 0o400); } catch {}
    fsyncDirectory(parent, 'formal_stage9_output_parent_fsync_failed');
  } catch (error) {
    if (error?.code === 'EEXIST') fail('formal_stage9_output_exists');
    if (error instanceof FormalStage9ProducerEvidenceError) throw error;
    fail('formal_stage9_output_write_failed', { cause: error?.message });
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

function usage() {
  return [
    'Formal Stage 9 producer package bridge (fail closed; never adjudicates).',
    '',
    'produce:',
    '  node scripts/formal-stage9-producer-package.mjs produce --producer <main|restart|failover|wps|variants> \\',
    '    --binding <absolute-json> --payload <absolute-json> --scenario-sources <absolute-json> \\',
    '    --evidence-root <absolute-directory> --output <new-absolute-json> [--recorded-at <iso>]',
    '',
    'assemble:',
    '  node scripts/formal-stage9-producer-package.mjs assemble --binding <absolute-json> \\',
    '    --packages <absolute-json-array-or-object> --evidence-root <absolute-directory> \\',
    '    --output <new-absolute-json> [--created-at <iso>] [--completed-at <iso>]',
    '',
    'Success means packageComplete/not_adjudicated and exits 2. This command has',
    'no signing option and can never produce a formal acceptance or exit 0.',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  let result;
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(`${usage()}\n`);
      process.exitCode = 1;
      return;
    }
    const { command, options } = parseArgs(argv);
    const binding = readStableJson(options.binding, 'formal_stage9_binding_file_invalid');
    if (command === 'produce') {
      result = await createFormalStage9FileBackedProducerEvidence({
        producer: options.producer,
        binding: binding.binding || binding,
        payload: readStableJson(options.payload, 'formal_stage9_payload_file_invalid'),
        scenarioEvidence: readStableJson(
          options['scenario-sources'],
          'formal_stage9_scenario_sources_file_invalid',
        ),
        evidenceRoot: options['evidence-root'],
        recordedAt: options['recorded-at'],
      });
    } else {
      const packageInput = readStableJson(options.packages, 'formal_stage9_packages_file_invalid');
      result = assembleFormalStage9UnadjudicatedBundle({
        binding: binding.binding || binding,
        producerPackages: Array.isArray(packageInput)
          ? packageInput
          : packageInput.producerPackages || packageInput.packages || packageInput,
        evidenceRoot: options['evidence-root'],
        createdAt: options['created-at'],
        completedAt: options['completed-at'],
      });
    }
    writeJsonExclusive(options.output, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    result = {
      ok: false,
      packageComplete: false,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      fullAcceptance: false,
      error: error?.code || 'formal_stage9_package_unexpected_failure',
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  process.exitCode = formalStage9ProducerEvidenceExitCode(result);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
