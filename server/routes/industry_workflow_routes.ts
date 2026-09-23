import { Router } from 'express';
import { BUSINESS_LINES, type BusinessLine } from '../industry/business_catalog';
import path from 'node:path';
import { businessLegacySummary, importBusinessLegacyArchive, readBusinessLegacyArchive, resolveBusinessLegacyArtifact } from '../industry/legacy_archive';
import { readDocumentPreview } from '../files/document_preview';
import { flushDBOrThrow } from '../../db_layer';
import { recordEcommerceWorkbenchArchive } from '../industry/ecommerce_workbench_archive';
import { bindIndustryWorkspaceContext, listIndustryWorkspaceContexts, getActiveIndustryWorkspaceContext, selectIndustryWorkspaceContext } from '../industry/workspace_context';
import { optionalAuth, requireAuth, resolveDomain } from '../middleware/auth';
import { DESKTOP_SESSION_HEADER, verifyDesktopSessionProof } from '../config/desktop_bootstrap';
import { isLoopbackAddress } from '../config/local_identity';
import { toolRegistry, type ToolRegistry } from '../tools/registry';
import {
  getIndustryWorkflowTask,
  listCurrentIndustryWorkflowContracts,
  listIndustryWorkflowTasks,
  recordIndustryWorkflowExecution,
  startIndustryWorkflow,
} from '../industry/workflow_service';
import {
  executeFinanceDeliveryWorkflow,
  FinanceDeliveryError,
} from '../industry/finance_delivery';

function scope(req: any) {
  const userId = req.user?.uid || 'anonymous';
  const resolved = req.user ? resolveDomain(req.user) : { domain: 'personal' as const, orgId: '' };
  return { userId, domain: resolved.domain, orgId: resolved.orgId };
}

export function mountIndustryWorkflowRoutes(router: Router, registry: ToolRegistry = toolRegistry) {
  const asyncHandler = (handler: (req: any, res: any) => Promise<any> | any) => (
    req: any,
    res: any,
    next: any,
  ) => Promise.resolve(handler(req, res)).catch(next);

  router.get('/business/legacy', requireAuth, (req, res) => {
    if (scope(req).domain !== 'personal') return res.json({ items: [] });
    return res.json({ items: BUSINESS_LINES.flatMap(line => { const archive = readBusinessLegacyArchive(req.user!.uid, line); return archive ? [businessLegacySummary(archive)] : []; }) });
  });
  router.get('/files/business-archive/:line/:hash', requireAuth, asyncHandler(async (req, res) => {
    const line = req.params.line as BusinessLine;
    if (scope(req).domain !== 'personal' || !BUSINESS_LINES.includes(line) || !/^[a-f0-9]{64}$/.test(req.params.hash)) return res.status(404).json({ error: 'Artifact not found' });
    const item = resolveBusinessLegacyArtifact(req.user.uid, line, req.params.hash);
    if (!item) return res.status(404).json({ error: 'Artifact not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'");
    if (req.query.preview === '1') return res.json(await readDocumentPreview(item.path));
    return res.download(item.path, path.basename(item.originalPath));
  }));
  router.get('/business/legacy/:line', requireAuth, (req, res) => {
    const line = req.params.line as BusinessLine;
    if (scope(req).domain !== 'personal' || !BUSINESS_LINES.includes(line)) return res.status(404).json({ error: 'Archive not found' });
    const archive = readBusinessLegacyArchive(req.user!.uid, line);
    return archive ? res.json(archive) : res.status(404).json({ error: 'Archive not imported' });
  });
  router.post('/business/legacy/:line/import', requireAuth, asyncHandler(async (req, res) => {
    const current = scope(req); const line = req.params.line as BusinessLine;
    if (current.domain !== 'personal' || !BUSINESS_LINES.includes(line) || !isLoopbackAddress(req.socket?.remoteAddress) || !verifyDesktopSessionProof(req.headers[DESKTOP_SESSION_HEADER], current.userId)) return res.status(403).json({ error: 'Local personal desktop session required' });
    const archive = await importBusinessLegacyArchive(current.userId, line);
    return res.json({ ...businessLegacySummary(archive), persisted: true, activeTasksImported: 0, credentialsImported: 0 });
  }));
  router.get('/business/workspaces', requireAuth, (req, res) => {
    const current = scope(req);
    res.json({ items: listIndustryWorkspaceContexts(current), active: { ecommerce: getActiveIndustryWorkspaceContext({ ...current, productLine: 'ecommerce' }), finance: getActiveIndustryWorkspaceContext({ ...current, productLine: 'finance' }) } });
  });
  router.post('/business/workspaces', requireAuth, asyncHandler(async (req, res) => {
    if (req.user?.orgRole === 'viewer') return res.status(403).json({ error: 'Read-only organization role' });
    const current = scope(req);
    const item = req.body?.id ? selectIndustryWorkspaceContext(current, req.body.id) : bindIndustryWorkspaceContext(current, req.body || {});
    await flushDBOrThrow();
    res.json({ item });
  }));
  router.get('/industry/workflows/contracts', optionalAuth, (_req, res) => {
    res.json({ contracts: listCurrentIndustryWorkflowContracts() });
  });

  router.get('/industry/workflows', requireAuth, (req, res) => {
    res.json({ tasks: listIndustryWorkflowTasks(scope(req), Number(req.query?.limit) || 50) });
  });

  router.get('/industry/workflows/:taskId', requireAuth, (req, res) => {
    const task = getIndustryWorkflowTask(scope(req), String(req.params.taskId || ''));
    if (!task) return res.status(404).json({ error: 'Industry workflow task not found' });
    return res.json({ task });
  });

  router.post('/industry/workflows', requireAuth, asyncHandler(async (req, res) => {
    if (req.user?.orgRole === 'viewer') return res.status(403).json({ error: 'Read-only organization role' });
    const entryId = String(req.body?.entryId || '').trim();
    if (!entryId) return res.status(400).json({ error: 'entryId is required' });
    const result = startIndustryWorkflow({
      ...scope(req),
      entryId,
      sourceInput: String(req.body?.sourceInput || ''),
      source: String(req.body?.source || 'industry_client'),
      context: req.body?.context && typeof req.body.context === 'object' ? req.body.context : undefined,
      idempotencyKey: String(req.body?.idempotencyKey || ''),
      conversationId: String(req.body?.conversationId || ''),
    });
    await flushDBOrThrow();
    return res.status(201).json(result);
  }));

  router.post('/industry/workflows/:taskId/verify', requireAuth, asyncHandler(async (req, res) => {
    if (req.user?.orgRole === 'viewer') return res.status(403).json({ error: 'Read-only organization role' });
    const taskId = String(req.params.taskId || '');
    if (!getIndustryWorkflowTask(scope(req), taskId)) {
      return res.status(404).json({ error: 'Industry workflow task not found' });
    }
    const result = req.body?.workbenchInput ? recordEcommerceWorkbenchArchive({ ...scope(req), taskId, workbenchInput: req.body.workbenchInput }) : recordIndustryWorkflowExecution({
      ...scope(req),
      taskId,
      resultText: String(req.body?.resultText || ''),
      filePaths: Array.isArray(req.body?.filePaths) ? req.body.filePaths.map(String) : [],
      source: String(req.body?.source || 'industry_client'),
      // Browser callers cannot manufacture tool receipts. Real receipts are
      // accepted only through server-owned execution integration.
      toolRecords: [],
    });
    await flushDBOrThrow();
    return res.json(result);
  }));

  router.post('/industry/workflows/:taskId/finance-delivery', requireAuth, asyncHandler(async (req, res) => {
    const userId = String(req.user?.uid || '').trim();
    const desktopProof = req.headers[DESKTOP_SESSION_HEADER];
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !verifyDesktopSessionProof(desktopProof, userId)) {
      return res.status(403).json({
        ok: false,
        status: 'blocked',
        code: 'DESKTOP_SESSION_PROOF_REQUIRED',
        error: 'A valid local desktop session proof is required for deterministic Finance delivery.',
      });
    }
    try {
      const result = await executeFinanceDeliveryWorkflow({
        ...scope(req),
        taskId: String(req.params.taskId || ''),
        financeInput: req.body?.financeInput && typeof req.body.financeInput === 'object'
          ? req.body.financeInput
          : {},
        registry,
        authRole: req.user?.role,
        orgRole: req.user?.orgRole,
      });
      return res.json(result);
    } catch (error) {
      if (!(error instanceof FinanceDeliveryError)) throw error;
      return res.status(error.statusCode).json({
        ok: false,
        status: error.details.status || 'blocked',
        code: error.code,
        error: error.message,
        ...error.details,
      });
    }
  }));
}
