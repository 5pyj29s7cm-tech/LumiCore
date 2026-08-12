import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getLocalAgent, getAllSessions, getTask, getTasksForAgent, getTasksForSession, buildTaskListResponse, getActiveSharedContexts, getSharedContext, removeSession, getSession, registerOutboundTask, updateTaskStatus, sendLAPSessionRequest } from './index';
import { getLAPPolicySnapshot } from './policy';
import { requireAuth, requireLocalRequest } from '../middleware/auth';
import { canInspectSession, canUseSession, claimSession, getSessionBinding, lapAccessScope, revokeSessionBinding } from './access';
import { createPairingTicket, listPairingTickets, revokePairingTicket } from './pairing';
import { addMemory } from '../memory/store';

export const lapRoutes = Router();

// Get local agent identity
lapRoutes.get('/lap/identity', requireAuth, (req, res) => {
  const identity = getLocalAgent();
  res.json({
    agentId: identity.agentId,
    name: identity.name,
    capabilities: identity.capabilities,
    publicProfile: identity.publicProfile,
    scope: lapAccessScope(req.user!),
  });
});

// Get LAP collaboration policy and memory firewall rules.
lapRoutes.get('/lap/policy', requireAuth, (req, res) => {
  res.json(getLAPPolicySnapshot(lapAccessScope(req.user!)));
});

lapRoutes.get('/lap/pairing-tickets', requireAuth, requireLocalRequest, (req, res) => {
  const tickets = listPairingTickets(lapAccessScope(req.user!));
  res.json({ tickets, count: tickets.length });
});

lapRoutes.post('/lap/pairing-tickets', requireAuth, requireLocalRequest, (req, res) => {
  const ticket = createPairingTicket(lapAccessScope(req.user!), req.body?.allowedScopes);
  res.status(201).json({
    ticketId: ticket.ticketId,
    pairingToken: ticket.token,
    allowedScopes: ticket.allowedScopes,
    expiresAt: ticket.expiresAt,
    websocketPath: '/lap',
  });
});

lapRoutes.delete('/lap/pairing-tickets/:token', requireAuth, requireLocalRequest, (req, res) => {
  const success = revokePairingTicket(req.params.token, lapAccessScope(req.user!));
  res.status(success ? 200 : 404).json({ success });
});

// List all active LAP sessions
lapRoutes.get('/lap/sessions', requireAuth, (req, res) => {
  const scope = lapAccessScope(req.user!);
  const localAgent = getLocalAgent();
  const sessions = getAllSessions().filter(session => canInspectSession(session, scope)).map(s => {
    const peer = s.peerA.agentId === localAgent.agentId ? s.peerB : s.peerA;
    return {
      sessionId: s.sessionId,
      peerA: { agentId: s.peerA.agentId, name: s.peerA.name, userId: s.peerA.userId },
      peerB: { agentId: s.peerB.agentId, name: s.peerB.name, userId: s.peerB.userId },
      peer: {
        agentId: peer.agentId,
        name: peer.name,
        userId: peer.userId,
        capabilities: peer.capabilities,
        publicProfile: peer.publicProfile,
      },
      trustLevel: s.trustLevel,
      scope: s.scope,
      requestedScope: s.requestedScope || [],
      establishedAt: s.establishedAt,
      lastHeartbeat: s.lastHeartbeat,
      authorizationStatus: s.authorizationStatus || 'pending',
      approved: canUseSession(s, scope),
      publicKeyFingerprint: getSessionBinding(s.sessionId)?.peerKeyFingerprint || '',
    };
  });
  res.json({ sessions, count: sessions.length });
});

// Get tasks for a specific agent
lapRoutes.get('/lap/tasks/:agentId', requireAuth, (req, res) => {
  const scope = lapAccessScope(req.user!);
  const allowedSessionIds = new Set(getAllSessions().filter(session => canUseSession(session, scope)).map(session => session.sessionId));
  const tasks = getTasksForAgent(req.params.agentId);
  res.json(buildTaskListResponse(tasks.filter((task: any) => allowedSessionIds.has(task.sessionId))));
});

// Return only tasks bound to one locally authorized peer session. Detailed
// results are labelled as peer-reported evidence, never as locally verified facts.
lapRoutes.get('/lap/sessions/:sessionId/tasks', requireAuth, (req, res) => {
  const scope = lapAccessScope(req.user!);
  const session = getSession(req.params.sessionId);
  if (!session || !canUseSession(session, scope)) return res.status(404).json({ error: 'LAP session not found in this workspace.' });
  res.json(buildTaskListResponse(getTasksForSession(session.sessionId), { includeResult: true }));
});

// Get shared contexts for a session
lapRoutes.get('/lap/contexts/:sessionId', requireAuth, (req, res) => {
  const session = getAllSessions().find(item => item.sessionId === req.params.sessionId);
  if (!session || !canUseSession(session, lapAccessScope(req.user!))) return res.status(404).json({ error: 'LAP session not found in this workspace.' });
  const contexts = getActiveSharedContexts(req.params.sessionId);
  res.json({ contexts, count: contexts.length });
});

// A remote handshake remains inert until the local owner approves the exact peer and workspace.
lapRoutes.post('/lap/sessions/:sessionId/claim', requireAuth, requireLocalRequest, (req, res) => {
  const result = claimSession({
    sessionId: req.params.sessionId,
    peerAgentId: String(req.body?.peerAgentId || '').trim(),
    scope: lapAccessScope(req.user!),
  });
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.json({
    success: true,
    sessionId: result.session.sessionId,
    peerAgentId: result.binding.peerAgentId,
    scope: { domain: result.binding.domain, orgId: result.binding.orgId },
    grantedScope: result.session.scope,
  });
});

// A sandbox probe delegates one bounded task without sharing local memory/files.
// The remote response is evidence only; it never executes as local code or writes memory.
lapRoutes.post('/lap/sessions/:sessionId/sandbox-probe', requireAuth, requireLocalRequest, async (req, res) => {
  const scope = lapAccessScope(req.user!);
  const session = getSession(req.params.sessionId);
  if (!session || !canUseSession(session, scope)) return res.status(404).json({ error: 'LAP session not found in this workspace.' });
  if (!session.scope.includes('delegate_task')) return res.status(409).json({ error: 'This LAP session does not permit task delegation.' });

  const prompt = String(req.body?.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'Sandbox probe prompt is required.' });
  const task = {
    taskId: `lap_probe_${randomUUID()}`,
    type: 'sandbox_capability_probe',
    priority: 'normal' as const,
    deadline: new Date(Date.now() + 30_000).toISOString(),
    payload: {
      prompt,
      sandbox: true,
      allowTools: false,
      allowMemory: false,
      allowLocalFiles: false,
      maxOutputChars: 4_000,
    },
    callback: 'lap.task.result',
  };
  registerOutboundTask(task, session, getLocalAgent().agentId);
  try {
    const response = await sendLAPSessionRequest(session.sessionId, 'lap.task.delegate', { task }, 20_000);
    if (response.error || response.accepted === false) {
      updateTaskStatus(session.sessionId, task.taskId, response.outcome === 'unknown' ? 'unknown' : 'rejected', undefined, response.error || response.reason);
      return res.status(502).json({ error: response.error || response.reason || 'The peer rejected the sandbox probe.', taskId: task.taskId });
    }
    if (getTask(task.taskId)?.status === 'pending') updateTaskStatus(session.sessionId, task.taskId, 'accepted');
    res.status(202).json({
      accepted: true,
      taskId: task.taskId,
      status: 'pending',
      sandbox: { tools: false, memory: false, localFiles: false },
      peerAcknowledgement: { accepted: response.accepted === true, estimatedCompletion: response.estimatedCompletion || '' },
    });
  } catch (error: any) {
    updateTaskStatus(session.sessionId, task.taskId, 'unknown', undefined, String(error?.message || 'LAP sandbox probe result is unknown.'));
    res.status(504).json({
      error: String(error?.message || 'LAP sandbox probe did not return a verified acknowledgement.'),
      taskId: task.taskId,
      outcome: 'unknown',
      replayBlocked: true,
    });
  }
});

// Selective absorption is an explicit local write. One context entry is copied
// with immutable LAP provenance; remote peer approval flags are never trusted.
lapRoutes.post('/lap/sessions/:sessionId/contexts/:contextId/absorb', requireAuth, requireLocalRequest, (req, res) => {
  const scope = lapAccessScope(req.user!);
  const session = getSession(req.params.sessionId);
  if (!session || !canUseSession(session, scope)) return res.status(404).json({ error: 'LAP session not found in this workspace.' });
  const context = getSharedContext(session.sessionId, req.params.contextId);
  if (!context) return res.status(404).json({ error: 'LAP context entry was not found or has expired.' });
  if (context.entry.type !== 'knowledge' && context.entry.type !== 'capability') {
    return res.status(409).json({ error: 'Only knowledge or capability context can be selectively absorbed.' });
  }

  const peer = session.peerA.agentId === getLocalAgent().agentId ? session.peerB : session.peerA;
  try {
    const memory = addMemory({
      userId: req.user!.uid,
      type: 'knowledge',
      content: context.entry.payload,
      keywords: Array.from(new Set([
        'lap',
        'external_lumi',
        peer.agentId,
        ...(context.entry.tags || []),
      ])).slice(0, 20),
      confidence: Math.min(0.9, Math.max(0.1, Number(context.entry.confidence) || 0.5)),
      sourceInteractionId: `lap:${session.sessionId}:${context.id}`,
    }, {
      tier: 'episodic',
      perspective: 'shared_memory',
      importance: 0.35,
      domain: scope.domain,
      orgId: scope.orgId,
      source: 'lap',
      privacyClass: scope.domain === 'work' ? 'organization' : 'shared',
      retention: 'long_term',
      userApproved: true,
      deduplicate: true,
    });
    res.status(201).json({
      success: true,
      memoryId: memory.id,
      source: {
        kind: 'lap',
        sessionId: session.sessionId,
        contextId: context.id,
        peerAgentId: peer.agentId,
      },
      scope: { domain: scope.domain, orgId: scope.orgId },
      personalityMutation: false,
    });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message || 'LAP context absorption was blocked by the memory firewall.') });
  }
});

// Revoke a session
lapRoutes.delete('/lap/sessions/:sessionId', requireAuth, requireLocalRequest, (req, res) => {
  const session = getAllSessions().find(item => item.sessionId === req.params.sessionId);
  const scope = lapAccessScope(req.user!);
  if (!session || !canInspectSession(session, scope)) return res.status(404).json({ error: 'LAP session not found in this workspace.' });
  revokeSessionBinding(req.params.sessionId, scope);
  const ok = removeSession(req.params.sessionId);
  res.json({ success: ok, sessionId: req.params.sessionId });
});
