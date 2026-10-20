import './helpers';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as db from '../db_layer';
import * as taskRepository from '../server/conversation/history_repository';
import { getClientHealthReport, getBackendHealthReport } from '../server/client/self/health';
import { updateClientState } from '../server/client/self/state';
import { getSelfModelSnapshot } from '../server/client/self/snapshot';
import { formatCompactClientSelfPrompt } from '../server/client/self/prompt_compact';
import { getDurableTaskHealthSnapshot } from '../server/cognition/durable_task_diagnostics';
import { runtimeFaults } from '../server/runtime/fault_state';
import { scheduler } from '../server/scheduler';
import { mcpManager } from '../server/mcp/client';
import { runHealthAudit } from '../server/agents/health_audit';
import { saveProviderProbe } from '../server/llm/provider_health';

beforeAll(async () => { await db.initDatabase(); });
afterEach(() => vi.restoreAllMocks());

describe('unified runtime self-health', () => {
  it('reports fatal backend and persistence faults from their owners and redacts secrets', () => {
    vi.spyOn(runtimeFaults, 'snapshot').mockReturnValue({ degraded: true, acceptingWork: false, kind: 'unhandled_rejection', occurredAt: '2026-10-10T00:00:00.000Z' });
    vi.spyOn(db, 'getDatabasePersistenceStatus').mockReturnValue({ ...db.getDatabasePersistenceStatus(), degraded: true, lastError: 'write failed token=private-diagnostic-secret' });
    const report = getClientHealthReport('self-fault-owner', {}, {});
    expect(report.level).toBe('degraded');
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'backend.process', level: 'degraded' }), expect.objectContaining({ id: 'database.persistence', level: 'degraded' })]));
    expect(getBackendHealthReport().status).toBe('degraded');
    expect(runHealthAudit('self-fault-owner').overallStatus).toBe('unhealthy');
    expect(JSON.stringify(report)).not.toContain('private-diagnostic-secret');
  });

  it('uses failed model probes and leaves configured but untested models unknown', () => {
    saveProviderProbe({ provider: 'openai', model: 'self-health-probe', ok: false, testedAt: new Date().toISOString() });
    const report = getClientHealthReport('self-model-owner', {}, {
      reasoning: { provider: 'openai', model: 'self-health-probe', configured: true },
      vision: { provider: 'qwen', model: 'untested-self-health', configured: true },
      rerank: { provider: 'qwen', configured: true, enabled: false },
    });
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'model.reasoning', level: 'degraded', evidence: 'recent_probe_failed' }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'model.vision', level: 'unknown' }));
    expect(report.checks.find(check => check.id === 'model.rerank')).toBeUndefined();
  });

  it('distinguishes reconciliation and failed scheduling from an intentional pause', () => {
    vi.spyOn(scheduler, 'listTasks').mockReturnValue([
      { id: 'manual-pause', enabled: false, lastStatus: 'failed', requiresReconciliation: false, queued: false },
    ] as any);
    expect(getBackendHealthReport().scheduler.degraded).toBe(false);
    vi.mocked(scheduler.listTasks).mockReturnValue([
      { id: 'unknown-outcome', enabled: false, lastStatus: 'unknown', requiresReconciliation: true, queued: false },
      { id: 'timeout', enabled: true, lastStatus: 'timed_out', requiresReconciliation: false, queued: false },
    ] as any);
    expect(getBackendHealthReport().scheduler).toMatchObject({ degraded: true, pausedTasks: 1, failedTasks: 1 });
  });

  it('isolates chat and creation task diagnostics by owner and workspace', () => {
    const session = db.readDatabaseTables(['conversationActionTasks']);
    const rows = session.conversationActionTasks;
    const fixtures = [['self-task-owner', 'personal', '', 'own-video'], ['other-owner', 'personal', '', 'foreign-private'], ['self-task-owner', 'work', 'org-one', 'own-work'], ['self-task-owner', 'work', 'org-two', 'foreign-org']];
    session.conversationActionTasks = [...rows, ...fixtures.map(([userId, domain, orgId, id]) => ({
      id, userId, domain, orgId, status: 'blocked', blocker: 'Awaiting verified media result', conversationId: 'conversation-' + id,
      parentTaskId: '', rootUserMessageId: '', intentKind: 'media', operation: 'video', goal: '', target: '', activeRequestId: '', completionSource: '', context: '{}', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: '',
    }))];
    db.commitDatabaseTables(session);
    expect(getDurableTaskHealthSnapshot('self-task-owner').recent.map(item => item.taskId)).toEqual(['own-video']);
    expect(getDurableTaskHealthSnapshot('self-task-owner', { domain: 'work', orgId: 'org-one' }).recent.map(item => item.taskId)).toEqual(['own-work']);
    expect(getDurableTaskHealthSnapshot('self-task-owner', { domain: 'work' }).available).toBe(false);
  });

  it('does not turn an unavailable ledger into evidence that no tasks failed', () => {
    vi.spyOn(taskRepository, 'listScopedConversationTaskDiagnostics').mockImplementation(() => { throw Error('ledger temporarily unavailable'); });
    const tasks = getDurableTaskHealthSnapshot('self-unavailable-owner');
    expect(tasks.available).toBe(false);
    expect(tasks.diagnostics).toContain('conversation_tasks_unavailable');
    expect(getClientHealthReport('self-unavailable-owner', {}, {}).checks).toContainEqual(expect.objectContaining({ id: 'tasks.runtime', level: 'unknown' }));
  });

  it('reports voice faults and marks aged client observations unknown', () => {
    const observedAt = Date.now();
    updateClientState('self-voice-owner', { activeTab: 'command-center', voice: { state: 'error' }, meeting: { active: false }, knowledge: { totalFiles: 0 } });
    expect(getClientHealthReport('self-voice-owner', {}, {}).checks).toContainEqual(expect.objectContaining({ id: 'voice.observation', level: 'degraded' }));
    vi.spyOn(Date, 'now').mockReturnValue(observedAt + 31_000);
    const stale = getClientHealthReport('self-voice-owner', {}, {});
    expect(stale.checks).toContainEqual(expect.objectContaining({ id: 'voice.observation', level: 'unknown' }));
    expect(stale.findings).toContainEqual(expect.objectContaining({ id: 'client_state.stale' }));
  });
  it('does not describe an unobserved or stale knowledge inventory as empty or absorbed', () => {
    expect(getSelfModelSnapshot('self-unobserved-knowledge').knowledgeCoverage.verification).toBe('unknown');
    const missing = formatCompactClientSelfPrompt('self-unobserved-knowledge');
    expect(missing).toContain('counts and retrieval coverage are unknown');
    expect(missing).not.toContain('Knowledge: total=0');
    updateClientState('self-stale-knowledge', { activeTab: 'command-center', knowledge: { totalFiles: 2, indexedFiles: 2, verifiedFiles: 2 } });
    expect(getSelfModelSnapshot('self-stale-knowledge').knowledgeCoverage.verifiedAbsorption).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    const stale = getSelfModelSnapshot('self-stale-knowledge');
    expect(stale.knowledgeCoverage.verification).toBe('unknown');
    expect(stale.knowledgeCoverage.verifiedAbsorption).toBe(false);
  });

  it('does not label a verified on-demand skill as disconnected while its process sleeps', () => {
    vi.spyOn(mcpManager, 'getConfig').mockReturnValue({ ready: { enabled: true, command: 'node' } });
    vi.spyOn(mcpManager, 'getServerHealth').mockReturnValue({ ready: { status: 'idle', consecutiveCrashes: 0 } });
    vi.spyOn(mcpManager, 'getConnectedServers').mockReturnValue([]);
    vi.spyOn(mcpManager, 'listLocalSkills').mockReturnValue([]);
    expect(getClientHealthReport('self-idle-skill', {}, {}).checks).toContainEqual(expect.objectContaining({ id: 'skills.runtime', level: 'ok' }));
    vi.mocked(mcpManager.getServerHealth).mockReturnValue({ ready: { status: 'failed', consecutiveCrashes: 5, lastError: 'connection failed' } });
    expect(getClientHealthReport('self-idle-skill', {}, {}).checks).toContainEqual(expect.objectContaining({ id: 'skills.runtime', level: 'attention' }));
  });

});
