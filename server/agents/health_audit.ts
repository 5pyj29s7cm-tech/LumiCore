/**
 * System Health Self-Audit
 * Periodically checks system health and provides actionable insights.
 */
import { toolRegistry } from '../tools/registry';
import { personalityRegistry } from '../personality/registry';
import { loadKeys } from '../config/keys';
import { readDB } from '../../db_layer';
import { getMarketplaceSkills } from '../marketplace/registry';
import { getDurableTaskHealthSnapshot } from '../cognition/durable_task_diagnostics';

export interface HealthReport {
  timestamp: string;
  overallStatus: 'healthy' | 'degraded' | 'unhealthy';
  checks: HealthCheck[];
  recommendations: string[];
  evolutionInsight?: string;
}

interface HealthCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

export function runHealthAudit(
  userId: string,
  scope: { domain?: 'personal' | 'work' | string; orgId?: string } = {},
): HealthReport {
  const checks: HealthCheck[] = [];
  const recommendations: string[] = [];
  const domain = scope.domain === 'work' ? 'work' : 'personal';
  const orgId = domain === 'work' ? String(scope.orgId || '') : '';

  // 1. API keys check
  const keys = loadKeys();
  const configuredKeys = Object.values(keys).filter(v => v && v.trim().length > 0).length;
  checks.push({
    name: 'API Keys',
    status: configuredKeys >= 2 ? 'ok' : configuredKeys >= 1 ? 'warn' : 'error',
    detail: `${configuredKeys}/11 API keys configured`,
  });
  if (configuredKeys < 2) {
    recommendations.push('配置大模型 API key 即可启用更多功能（设置 → API 矩阵）');
  }

  // 2. Tool registry health
  const totalTools = toolRegistry.list().length;
  checks.push({
    name: 'Tool Registry',
    status: totalTools >= 50 ? 'ok' : 'warn',
    detail: `${totalTools} tools registered`,
  });

  // 3. Memory check
  try {
    const db = readDB();
    const memCount = ((db as any).memories || []).filter((memory: any) =>
      memory.userId === userId &&
      (memory.domain || 'personal') === domain &&
      (memory.orgId || '') === orgId
    ).length;
    checks.push({
      name: 'Memory System',
      status: memCount > 0 ? 'ok' : 'warn',
      detail: `${memCount} memories stored`,
    });
    if (memCount === 0) {
      recommendations.push('Lumi 还没开始构建你的记忆画像 — 多聊几天就会越来越懂你');
    }
  } catch {
    checks.push({ name: 'Memory System', status: 'error', detail: 'Database read failed' });
  }

  // 4. Skills installed
  const marketplace = getMarketplaceSkills(undefined, {
    ownerUid: userId,
    domain,
    orgId,
  });
  const installed = marketplace.filter(s => s.installed);
  const uninstalled = marketplace.filter(s => !s.installed && s.runtime !== 'external');
  checks.push({
    name: 'Skills',
    status: installed.length >= 3 ? 'ok' : installed.length >= 1 ? 'warn' : 'warn',
    detail: `${installed.length} installed, ${uninstalled.length} available in marketplace`,
  });
  if (uninstalled.length > 0 && installed.length < 3) {
    const top = uninstalled.filter(s => s.installSource === 'bundled').slice(0, 3);
    if (top.length > 0) {
      recommendations.push(`${top.length} 个技能待安装：${top.map(s => s.name).join('、')}`);
    }
  }

  // 5. Personality evolution
  try {
    const personality = personalityRegistry.getForUser('lumi', userId, orgId || undefined);
    if (personality) {
      const history = personalityRegistry.getEvolutionHistory('lumi', userId, orgId || undefined);
      const evoCount = history?.length || 0;
      const lastEvo = history?.[history.length - 1]?.timestamp;
      checks.push({
        name: 'Personality Evolution',
        status: evoCount > 0 ? 'ok' : 'warn',
        detail: evoCount > 0
          ? `${evoCount} evolution steps, last: ${lastEvo?.slice(0, 10) || 'unknown'}`
          : 'No evolution yet — personality is still at factory settings',
      });
      if (evoCount === 0) {
        recommendations.push('Lumi 的人格还没开始演化 — 多互动就会自动调整风格');
      }
    }
  } catch {
    checks.push({ name: 'Personality Evolution', status: 'warn', detail: 'Unknown' });
  }

  // 6. Agent ecosystem
  try {
    const db = readDB();
    const agentCount = ((db as any).agents || []).filter((agent: any) => {
      if (domain === 'work') {
        return (agent.domain || 'work') === 'work' && (agent.orgId || '') === orgId;
      }
      return (agent.ownerUid || agent.userId) === userId && agent.domain !== 'work' && !agent.orgId;
    }).length;
    checks.push({
      name: 'Agent Team',
      status: agentCount > 0 ? 'ok' : 'warn',
      detail: `${agentCount} team agents`,
    });
  } catch {
    checks.push({ name: 'Agent Team', status: 'warn', detail: 'Unknown' });
  }

  // 7. Durable task recovery and blockers
  const durableTasks = getDurableTaskHealthSnapshot(userId, { domain, orgId });
  checks.push({
    name: 'Durable Task Runtime',
    status: durableTasks.blocked > 0 ? 'error' : durableTasks.failed > 0 ? 'warn' : 'ok',
    detail: `${durableTasks.active} active, ${durableTasks.retryScheduled} retry scheduled, ${durableTasks.blocked} blocked, ${durableTasks.failed} failed`,
  });
  if (durableTasks.blocked > 0) {
    recommendations.push('Inspect the durable task diagnosis before resuming; unknown external outcomes and unverified side effects must not be replayed automatically.');
  }

  // Overall assessment
  const errors = checks.filter(c => c.status === 'error').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  const overallStatus = errors > 0 ? 'unhealthy' : warns > 3 ? 'degraded' : 'healthy';

  // Evolution insight
  let evolutionInsight: string | undefined;
  if (overallStatus === 'healthy' && installed.length >= 3) {
    evolutionInsight = 'Lumi 系统健康，核心能力就绪。自然语言办公、自动工作流、人格演化均在运行中。';
  } else if (warns > 0) {
    evolutionInsight = `系统有 ${warns} 项待优化。继续使用 Lumi，它会自动学习和适应你的习惯。`;
  }

  return {
    timestamp: new Date().toISOString(),
    overallStatus,
    checks,
    recommendations,
    evolutionInsight,
  };
}
