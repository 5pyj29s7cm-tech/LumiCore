import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  extensionManifestSigningPayload,
  type LumiExtensionManifest,
} from '../server/extensions/registry';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const manifestPath = argument('--manifest');
const privateKeyPath = argument('--private-key');
if (!manifestPath || !privateKeyPath) {
  fail('Usage: npm run extension:sign -- --manifest manifest.json --private-key publisher-private.pem [--out manifest.signed.json]');
}

const resolvedManifest = path.resolve(manifestPath);
const resolvedPrivateKey = path.resolve(privateKeyPath);
if (!fs.existsSync(resolvedManifest)) fail(`Manifest was not found: ${resolvedManifest}`);
if (!fs.existsSync(resolvedPrivateKey)) fail(`Private key was not found: ${resolvedPrivateKey}`);

let manifest: LumiExtensionManifest;
try {
  manifest = JSON.parse(fs.readFileSync(resolvedManifest, 'utf8')) as LumiExtensionManifest;
} catch (error: any) {
  fail(`Manifest is not valid JSON: ${String(error?.message || error)}`);
}

let privateKey: crypto.KeyObject;
try {
  privateKey = crypto.createPrivateKey(fs.readFileSync(resolvedPrivateKey));
} catch (error: any) {
  fail(`Private key could not be loaded: ${String(error?.message || error)}`);
}
if (privateKey.asymmetricKeyType !== 'ed25519') fail('Lumi extension manifests require an Ed25519 private key.');

const publicKey = crypto.createPublicKey(privateKey);
manifest.publisher = {
  ...manifest.publisher,
  publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
};
manifest.signature = { algorithm: 'ed25519', value: '' };
try {
  manifest.signature.value = crypto.sign(
    null,
    extensionManifestSigningPayload(manifest),
    privateKey,
  ).toString('base64');
} catch (error: any) {
  fail(`Manifest validation/signing failed: ${String(error?.message || error)}`);
}

const defaultOutput = path.join(
  path.dirname(resolvedManifest),
  `${path.basename(resolvedManifest, path.extname(resolvedManifest))}.signed.json`,
);
const outputPath = path.resolve(argument('--out') || defaultOutput);
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(`${outputPath}\n`);
