import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const reportPath = path.resolve(process.argv[2] || 'vitest-results.json');
const minimum = Number(process.env.LUMI_MIN_TESTS || 1562);
if (!existsSync(reportPath)) {
  console.error(`[test-inventory] missing Vitest JSON report: ${reportPath}`);
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
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
