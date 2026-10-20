import { getClientHealthReport } from '../client/self/health';

export interface HealthReport {
  timestamp: string;
  overallStatus: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  checks: Array<{ name: string; status: 'ok' | 'warn' | 'error' | 'unknown'; detail: string }>;
  recommendations: string[];
  evolutionInsight?: string;
}

export function runHealthAudit(userId: string, scope: { domain?: 'personal' | 'work' | string; orgId?: string } = {}): HealthReport {
  const report = getClientHealthReport(userId, scope);
  return {
    timestamp: report.observedAt,
    overallStatus: report.level === 'ok' ? 'healthy' : report.level === 'degraded' ? 'unhealthy' : report.level === 'attention' ? 'degraded' : 'unknown',
    checks: report.checks.map(check => ({
      name: check.id,
      status: check.level === 'ok' ? 'ok' : check.level === 'degraded' ? 'error' : check.level === 'attention' ? 'warn' : 'unknown',
      detail: check.message + (check.evidence ? ` (${check.evidence})` : ''),
    })),
    recommendations: Array.from(new Set(report.findings.flatMap(finding => finding.safeActions || []))),
  };
}
