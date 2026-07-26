import { spawnSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const args = npmCli ? [npmCli, 'audit', '--omit=dev', '--json'] : ['audit', '--omit=dev', '--json'];
const result = spawnSync(command, args, {
  cwd: process.cwd(),
  encoding: 'utf8',
  shell: !npmCli && process.platform === 'win32',
  maxBuffer: 16 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(result.stdout || '{}');
} catch {
  console.error(result.stderr || result.stdout || 'npm audit did not return JSON.');
  process.exit(2);
}

if (result.error) {
  console.error(result.error.message);
  process.exit(2);
}
if (report?.error || !report?.metadata?.vulnerabilities) {
  console.error(`[security:audit] npm audit did not return a vulnerability inventory: ${JSON.stringify(report?.error || null)}`);
  process.exit(2);
}

const counts = report?.metadata?.vulnerabilities ?? {};
const high = Number(counts.high ?? 0);
const critical = Number(counts.critical ?? 0);
const remaining = Object.entries(report?.vulnerabilities ?? {})
  .filter(([, finding]) => finding?.severity !== 'high' && finding?.severity !== 'critical')
  .map(([name, finding]) => `${name}:${finding.severity}`);

console.log(`[security:audit] production dependencies: critical=${critical}, high=${high}, moderate=${Number(counts.moderate ?? 0)}, low=${Number(counts.low ?? 0)}`);
if (remaining.length) console.log(`[security:audit] tracked non-blocking findings: ${remaining.join(', ')}`);

if (critical > 0 || high > 0) {
  console.error('[security:audit] blocked: production dependencies must have zero critical and zero high findings.');
  process.exit(1);
}
