import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

const vulnerabilities = report?.vulnerabilities ?? {};
const exceptionPath = path.resolve('security/production-audit-exceptions.json');
const lockPath = path.resolve('package-lock.json');
const exceptions = JSON.parse(readFileSync(exceptionPath, 'utf8')).exceptions ?? [];
const packageLock = JSON.parse(readFileSync(lockPath, 'utf8'));
const waivedPackages = new Set();

for (const exception of exceptions) {
  const finding = vulnerabilities[exception.package];
  if (!finding) continue;

  const expiry = Date.parse(`${exception.expiresOn}T23:59:59.999Z`);
  const sourceIds = finding.via
    .filter(item => item && typeof item === 'object')
    .map(item => Number(item.source))
    .sort((a, b) => a - b);
  const expectedSources = [...exception.advisorySources].map(Number).sort((a, b) => a - b);
  const sourcesMatch = JSON.stringify(sourceIds) === JSON.stringify(expectedSources);
  const effectsMatch = JSON.stringify([...(finding.effects ?? [])].sort())
    === JSON.stringify([...exception.dependentPackages].sort());
  const versionsMatch = Object.entries(exception.packageVersions).every(([name, version]) => (
    packageLock.packages?.[`node_modules/${name}`]?.version === version
  ));
  const dependencyEdgeMatches = exception.dependentPackages.every(name => (
    packageLock.packages?.[`node_modules/${name}`]?.dependencies?.[exception.package]
      === exception.dependencyRange
  ));
  const runtimeReferencesAbsent = exception.runtimeEntrypoints.every(entry => {
    const source = readFileSync(path.resolve(entry), 'utf8');
    return !exception.forbiddenRuntimeReferences.some(reference => source.includes(reference));
  });
  const dependentFindingsMatch = exception.dependentPackages.every(name => {
    const dependent = vulnerabilities[name];
    return dependent
      && dependent.severity === finding.severity
      && dependent.via.length === 1
      && dependent.via[0] === exception.package;
  });
  const valid = Number.isFinite(expiry)
    && Date.now() <= expiry
    && finding.severity === exception.severity
    && sourcesMatch
    && effectsMatch
    && versionsMatch
    && dependencyEdgeMatches
    && runtimeReferencesAbsent
    && dependentFindingsMatch;

  if (!valid) {
    console.error(`[security:audit] exception rejected for ${exception.package}; dependency, advisory, runtime reachability, or expiry changed.`);
    continue;
  }

  waivedPackages.add(exception.package);
  exception.dependentPackages.forEach(name => waivedPackages.add(name));
  console.log(`[security:audit] compensated exception: ${exception.package} (${expectedSources.join(', ')}) expires ${exception.expiresOn}; runtime dependency is unreachable.`);
}

const activeFindings = Object.entries(vulnerabilities)
  .filter(([name]) => !waivedPackages.has(name));
const severityCount = severity => activeFindings
  .filter(([, finding]) => finding?.severity === severity).length;
const critical = severityCount('critical');
const high = severityCount('high');
const moderate = severityCount('moderate');
const low = severityCount('low');
const remaining = activeFindings
  .filter(([, finding]) => finding?.severity !== 'high' && finding?.severity !== 'critical')
  .map(([name, finding]) => `${name}:${finding.severity}`);

console.log(`[security:audit] production dependencies after validated exceptions: critical=${critical}, high=${high}, moderate=${moderate}, low=${low}`);
if (remaining.length) console.log(`[security:audit] tracked non-blocking findings: ${remaining.join(', ')}`);

if (critical > 0 || high > 0) {
  console.error('[security:audit] blocked: production dependencies must have zero critical and zero high findings.');
  process.exit(1);
}
