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
  }
  for (const failure of failedFiles.slice(0, diagnosticLimit - Math.min(failedTests.length, diagnosticLimit))) {
    console.error(`\n[test-file-failure] ${failure.fileName}`);
    if (failure.message) console.error(stripAnsi(failure.message));
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
