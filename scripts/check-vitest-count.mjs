import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const reportPath = path.resolve(process.argv[2] || 'vitest-results.json');
const minimum = Number(process.env.LUMI_MIN_TESTS || 1562);
if (!existsSync(reportPath)) {
  console.error(`[test-inventory] missing Vitest JSON report: ${reportPath}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`[test-inventory] invalid Vitest JSON report: ${reportPath}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const stripAnsi = (value) => String(value || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
const escapeWorkflowData = value => stripAnsi(value)
  .replace(/%/g, '%25')
  .replace(/\r/g, '%0D')
  .replace(/\n/g, '%0A');
const escapeWorkflowProperty = value => escapeWorkflowData(value)
  .replace(/:/g, '%3A')
  .replace(/,/g, '%2C');
const githubActions = process.env.GITHUB_ACTIONS === 'true';
const annotationPath = fileName => {
  const absolute = path.resolve(String(fileName || ''));
  const relative = path.relative(process.cwd(), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return '.github/workflows/ci.yml';
  }
  return relative.replace(/\\/g, '/');
};
const emitFailureAnnotation = ({ fileName, title, message }) => {
  if (!githubActions) return;
  const safeTitle = String(title || 'Vitest failure').slice(0, 240);
  const safeMessage = String(message || 'Vitest reported a failure without details.').slice(0, 8_000);
  console.error(
    `::error file=${escapeWorkflowProperty(annotationPath(fileName))},title=${escapeWorkflowProperty(safeTitle)}::${escapeWorkflowData(safeMessage)}`,
  );
};
const failedTests = [];
const failedFiles = [];
for (const file of report.testResults || []) {
  const fileName = String(file?.name || '<unknown test file>');
  const assertions = Array.isArray(file?.assertionResults) ? file.assertionResults : [];
  for (const assertion of assertions) {
    if (assertion?.status !== 'failed') continue;
    failedTests.push({
      fileName,
      name: String(assertion.fullName || assertion.title || '<unknown test>'),
      messages: Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [],
    });
  }
  if (file?.status === 'failed' && assertions.every(assertion => assertion?.status !== 'failed')) {
    failedFiles.push({ fileName, message: file.message });
  }
}

const failedCount = Number(report.numFailedTests || failedTests.length);
if (report.success === false || failedCount > 0 || failedFiles.length > 0) {
  console.error(`[test-inventory] Vitest failed: ${failedCount} failed test(s), ${failedFiles.length} failed file(s) without a failed assertion.`);
  const diagnosticLimit = 50;
  for (const failure of failedTests.slice(0, diagnosticLimit)) {
    console.error(`\n[test-failure] ${failure.name}`);
    console.error(`[test-file] ${failure.fileName}`);
    for (const message of failure.messages) console.error(stripAnsi(message));
    emitFailureAnnotation({
      fileName: failure.fileName,
      title: failure.name,
      message: failure.messages.map(stripAnsi).join('\n') || 'Vitest assertion failed.',
    });
  }
  for (const failure of failedFiles.slice(0, diagnosticLimit - Math.min(failedTests.length, diagnosticLimit))) {
    console.error(`\n[test-file-failure] ${failure.fileName}`);
    if (failure.message) console.error(stripAnsi(failure.message));
    emitFailureAnnotation({
      fileName: failure.fileName,
      title: 'Vitest file failure',
      message: stripAnsi(failure.message) || 'Vitest failed before reporting an assertion.',
    });
  }
  if (failedTests.length === 0 && failedFiles.length === 0) {
    emitFailureAnnotation({
      fileName: '.github/workflows/ci.yml',
      title: 'Vitest suite failure',
      message: `Vitest reported success=false with ${failedCount} failed test(s), but emitted no assertion diagnostics.`,
    });
  }
  const omitted = failedTests.length + failedFiles.length - diagnosticLimit;
  if (omitted > 0) console.error(`\n[test-inventory] ${omitted} additional failure(s) omitted.`);
  process.exitCode = 1;
}

const total = Number(report.numTotalTests ?? report.testResults?.reduce((sum, file) => sum + Number(file.assertionResults?.length || 0), 0));
if (!Number.isFinite(total)) {
  console.error('[test-inventory] Vitest report does not contain a test count.');
  process.exit(2);
}
console.log(`[test-inventory] ${total} tests collected; minimum is ${minimum}.`);
if (total < minimum) {
  console.error(`[test-inventory] blocked: test inventory dropped by ${minimum - total}.`);
  process.exit(1);
}
