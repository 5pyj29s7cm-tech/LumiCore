/**
 * Org REST API routes.
 *
 * Mounted under /api/org for the organization work domain in every deployment.
 * All routes use the unified auth middleware (no inline JWT copy-paste).
 */

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, requireOrgRole, requireOrgMember, optionalAuth } from '../middleware/auth';
import * as Org from './org';
import * as EDB from './db';
import * as KB from './kb';
import * as LegalCases from './legal_cases';
import * as Templates from './templates';
import * as Audit from './audit';
import * as WorkRouting from './work_routing';
import * as ResourceACL from './resource_acl';
import { Server as SocketIOServer } from 'socket.io';
import { getJwtSecret } from '../config/local_identity';

function respondResourceAuthorizationError(res: Response, error: unknown): void {
  const status = error instanceof ResourceACL.OrganizationResourceAuthorizationError
    ? error.statusCode
    : 500;
  res.status(status).json({ error: error instanceof Error ? error.message : 'Organization resource authorization failed' });
}

function canReadOrganizationResource(input: {
  orgId: string;
  userId: string;
  resourceType: ResourceACL.OrganizationResourceType;
  resourceId: string;
  ownerUserId?: string;
}): boolean {
  return ResourceACL.authorizeOrganizationResource({
    orgId: input.orgId,
    actorUserId: input.userId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    permission: 'read',
    ownerUserId: input.ownerUserId,
  }).allowed;
}

export function mountOrgRoutes(router: Router, io?: SocketIOServer) {
  // ── Health / status ──────────────────────────────────────────────────

  router.get('/org/status', optionalAuth, (_req: Request, res: Response) => {
    const connected = !!_req.user?.orgId;
    res.json({
      enabled: true,
      connected,
      orgId: _req.user?.orgId || null,
      orgRole: _req.user?.orgRole || null,
    });
  });

  // ── Organization CRUD ────────────────────────────────────────────────

  router.post('/org/org', requireAuth, (req: Request, res: Response) => {
    const { name, slug } = req.body;
    if (!name || !slug) {
      res.status(400).json({ error: 'name and slug are required' });
      return;
    }
    const existing = Org.getOrganizationBySlug(slug);
    if (existing) {
      res.status(409).json({ error: 'Organization slug already taken' });
      return;
    }
    const org = Org.createOrganization(name, slug, req.user!.uid);
    // Re-sign JWT with orgId so the user's current session picks it up immediately
    const JWT_SECRET = getJwtSecret();
    const newToken = jwt.sign(
      { uid: req.user!.uid, username: req.user!.username, role: req.user!.role, orgId: org.id, orgRole: 'owner' },
      JWT_SECRET,
      { expiresIn: '24h' },
    );
    res.cookie('token', newToken, { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 });
    res.status(201).json({ ...org, token: newToken, orgRole: 'owner' });
  });

  router.get('/org/org/:orgId', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const org = Org.getOrganization(req.params.orgId);
    if (!org) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }
    res.json(org);
  });

  router.put('/org/org/:orgId', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const updates = { ...(req.body || {}) };
    if (updates.name !== undefined) {
      if (typeof updates.name !== 'string') {
        res.status(400).json({ error: 'Organization name must be a string' });
        return;
      }
      updates.name = updates.name.trim();
      if (!updates.name || updates.name.length > 120 || updates.name.includes('\uFFFD')) {
        res.status(400).json({ error: 'Organization name is empty, too long, or contains invalid characters' });
        return;
      }
    }
    const org = Org.updateOrganization(req.params.orgId, req.user!.uid, updates);
    if (!org) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }
    res.json(org);
  });

  router.delete('/org/org/:orgId', requireAuth, requireOrgRole('owner'), (req: Request, res: Response) => {
    const result = Org.deleteOrganization(req.params.orgId, req.user!.uid);
    if (!result) {
      res.status(403).json({ error: 'Only the owner can delete an organization' });
      return;
    }
    res.json({ success: true });
  });

  router.get('/org/org', requireAuth, (req: Request, res: Response) => {
    const orgs = Org.listUserOrganizations(req.user!.uid);
    res.json(orgs);
  });

  // ── Members ──────────────────────────────────────────────────────────

  router.get('/org/org/:orgId/members', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const members = Org.listOrgMembers(req.params.orgId);
    res.json(members);
  });

  router.post('/org/org/:orgId/members', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const { userId, role, departmentId } = req.body;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    const membership = Org.inviteMember(req.params.orgId, req.user!.uid, userId, role, departmentId);
    res.status(201).json(membership);
  });

  router.delete('/org/org/:orgId/members/:userId', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const result = Org.removeOrgMember(req.params.orgId, req.user!.uid, req.params.userId);
    if (!result) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    res.json({ success: true });
  });

  router.put('/org/org/:orgId/members/:userId/role', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const { role } = req.body;
    if (!role) {
      res.status(400).json({ error: 'role is required' });
      return;
    }
    const m = Org.changeMemberRole(req.params.orgId, req.user!.uid, req.params.userId, role);
    if (!m) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    res.json(m);
  });

  // ── Departments ──────────────────────────────────────────────────────

  router.get('/org/org/:orgId/departments', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const depts = Org.getOrgDepartments(req.params.orgId);
    res.json(depts);
  });

  router.post('/org/org/:orgId/departments', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const { name, parentId } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const dept = Org.createOrgDepartment(req.params.orgId, name, parentId);
    res.status(201).json(dept);
  });

  // ── Positions and durable business routing ───────────────────────────

  router.get('/org/org/:orgId/positions', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    res.json(WorkRouting.listOrganizationPositions(req.params.orgId, req.query.includeArchived === 'true'));
  });

  router.post('/org/org/:orgId/positions', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const position = WorkRouting.createOrganizationPosition({
      orgId: req.params.orgId,
      actorUserId: req.user!.uid,
      departmentId: req.body?.departmentId,
      name: req.body?.name,
      description: req.body?.description,
      skillTags: req.body?.skillTags,
      memberIds: req.body?.memberIds,
      agentIds: req.body?.agentIds,
      isManager: req.body?.isManager,
    });
    res.status(201).json(position);
  });

  router.put('/org/org/:orgId/positions/:positionId', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const position = WorkRouting.updateOrganizationPosition({
      ...req.body,
      orgId: req.params.orgId,
      actorUserId: req.user!.uid,
      positionId: req.params.positionId,
    });
    if (!position) {
      res.status(404).json({ error: 'Position not found' });
      return;
    }
    res.json(position);
  });

  router.get('/org/org/:orgId/work-routing/rules', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    res.json(WorkRouting.listOrganizationWorkRoutingRules(req.params.orgId, req.query.includeDisabled === 'true'));
  });

  router.post('/org/org/:orgId/work-routing/rules', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const rule = WorkRouting.createOrganizationWorkRoutingRule({
      ...req.body,
      orgId: req.params.orgId,
      actorUserId: req.user!.uid,
    });
    res.status(201).json(rule);
  });

  router.put('/org/org/:orgId/work-routing/rules/:ruleId', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const rule = WorkRouting.updateOrganizationWorkRoutingRule({
      orgId: req.params.orgId,
      actorUserId: req.user!.uid,
      ruleId: req.params.ruleId,
      updates: req.body || {},
    });
    if (!rule) {
      res.status(404).json({ error: 'Routing rule not found' });
      return;
    }
    res.json(rule);
  });

  router.get('/org/org/:orgId/work-items', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const membership = EDB.getMember(req.params.orgId, req.user!.uid)!;
    const requesterUserId = ['owner', 'admin'].includes(membership.role)
      ? String(req.query.requesterUserId || '') || undefined
      : req.user!.uid;
    res.json(WorkRouting.listOrganizationWorkItems(req.params.orgId, {
      status: req.query.status as WorkRouting.OrganizationWorkItemStatus | undefined,
      requesterUserId,
      taskId: String(req.query.taskId || '') || undefined,
      limit: Number(req.query.limit) || undefined,
    }));
  });

  router.get('/org/org/:orgId/work-items/:workItemId', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const item = WorkRouting.getOrganizationWorkItem(req.params.orgId, req.params.workItemId);
    if (!item) {
      res.status(404).json({ error: 'Work item not found' });
      return;
    }
    const membership = EDB.getMember(req.params.orgId, req.user!.uid)!;
    const canRead = ['owner', 'admin'].includes(membership.role)
      || item.requesterUserId === req.user!.uid
      || item.assignedMemberId === req.user!.uid
      || (item.collaboratorMemberIds || []).includes(req.user!.uid)
      || item.humanOwnerUserId === req.user!.uid;
    if (!canRead) {
      res.status(403).json({ error: 'This work item is not assigned to the current member' });
      return;
    }
    res.json(item);
  });

  router.get('/org/org/:orgId/work-approvals', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    res.json(WorkRouting.listOrganizationWorkApprovals(
      req.params.orgId,
      req.query.status as WorkRouting.OrganizationWorkApprovalStatus | undefined,
    ));
  });

  router.post('/org/org/:orgId/work-approvals/:approvalId/decision', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    if (!['approve', 'reject'].includes(String(req.body?.decision || ''))) {
      res.status(400).json({ error: 'decision must be approve or reject' });
      return;
    }
    const result = WorkRouting.decideOrganizationWorkApproval({
      orgId: req.params.orgId,
      approvalId: req.params.approvalId,
      actorUserId: req.user!.uid,
      decision: req.body.decision,
      reason: req.body.reason,
    });
    if (!result) {
      res.status(404).json({ error: 'Approval not found' });
      return;
    }
    res.json(result);
  });

  router.get('/org/org/:orgId/work-handoffs', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const membership = EDB.getMember(req.params.orgId, req.user!.uid)!;
    const all = WorkRouting.listOrganizationWorkHandoffs(
      req.params.orgId,
      String(req.query.workItemId || '') || undefined,
    );
    if (['owner', 'admin'].includes(membership.role)) {
      res.json(all);
      return;
    }
    res.json(all.filter(handoff => (
      handoff.actorUserId === req.user!.uid
      || handoff.from.memberId === req.user!.uid
      || handoff.to.memberId === req.user!.uid
    )));
  });

  router.post('/org/org/:orgId/work-items/:workItemId/handoffs', requireAuth, requireOrgRole('owner', 'admin', 'member'), (req: Request, res: Response) => {
    const handoff = WorkRouting.requestOrganizationWorkHandoff({
      orgId: req.params.orgId,
      workItemId: req.params.workItemId,
      actorUserId: req.user!.uid,
      type: req.body?.type,
      targetDepartmentId: req.body?.targetDepartmentId,
      targetPositionId: req.body?.targetPositionId,
      targetMemberId: req.body?.targetMemberId,
      targetAgentIds: req.body?.targetAgentIds,
      reason: req.body?.reason,
    });
    if (!handoff) {
      res.status(404).json({ error: 'Work item not found' });
      return;
    }
    res.status(201).json(handoff);
  });

  router.post('/org/org/:orgId/work-handoffs/:handoffId/decision', requireAuth, requireOrgRole('owner', 'admin', 'member'), (req: Request, res: Response) => {
    if (!['accept', 'decline'].includes(String(req.body?.decision || ''))) {
      res.status(400).json({ error: 'decision must be accept or decline' });
      return;
    }
    const result = WorkRouting.decideOrganizationWorkHandoff({
      orgId: req.params.orgId,
      handoffId: req.params.handoffId,
      actorUserId: req.user!.uid,
      decision: req.body.decision,
    });
    if (!result) {
      res.status(404).json({ error: 'Handoff not found' });
      return;
    }
    res.json(result);
  });

  // ── Knowledge Base ───────────────────────────────────────────────────

  router.get('/org/org/:orgId/resources/:resourceType/:resourceId/policy', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    res.json(ResourceACL.getOrganizationResourcePolicy(req.params.orgId, req.params.resourceType, req.params.resourceId));
  });

  router.put('/org/org/:orgId/resources/:resourceType/:resourceId/policy', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    try {
      res.json(ResourceACL.setOrganizationResourcePolicy({
        orgId: req.params.orgId,
        actorUserId: req.user!.uid,
        resourceType: req.params.resourceType,
        resourceId: req.params.resourceId,
        ownerUserId: req.body?.ownerUserId,
        classification: req.body?.classification,
        departmentId: req.body?.departmentId,
        grants: req.body?.grants,
      }));
    } catch (error) {
      respondResourceAuthorizationError(res, error);
    }
  });

  router.delete('/org/org/:orgId/resources/:resourceType/:resourceId/policy', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    try {
      const removed = ResourceACL.removeOrganizationResourcePolicy({
        orgId: req.params.orgId,
        actorUserId: req.user!.uid,
        resourceType: req.params.resourceType,
        resourceId: req.params.resourceId,
      });
      if (!removed) {
        res.status(404).json({ error: 'Resource policy not found' });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      respondResourceAuthorizationError(res, error);
    }
  });

  router.get('/org/org/:orgId/credential-references', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    res.json(ResourceACL.listOrganizationCredentialReferences(req.params.orgId, req.user!.uid));
  });

  router.post('/org/org/:orgId/credential-references', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    try {
      const reference = ResourceACL.createOrganizationCredentialReference({
        ...(req.body || {}),
        orgId: req.params.orgId,
        actorUserId: req.user!.uid,
        name: req.body?.name,
        provider: req.body?.provider,
        credentialRef: req.body?.credentialRef,
        purpose: req.body?.purpose,
        grants: req.body?.grants,
      });
      res.status(201).json(reference);
    } catch (error) {
      respondResourceAuthorizationError(res, error);
    }
  });

  router.delete('/org/org/:orgId/credential-references/:credentialId', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    try {
      const revoked = ResourceACL.revokeOrganizationCredentialReference({
        orgId: req.params.orgId,
        actorUserId: req.user!.uid,
        credentialId: req.params.credentialId,
      });
      if (!revoked) {
        res.status(404).json({ error: 'Credential reference not found' });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      respondResourceAuthorizationError(res, error);
    }
  });

  router.get('/org/org/:orgId/devices', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    try {
      res.json(ResourceACL.listOrganizationDevices(req.params.orgId, req.user!.uid));
    } catch (error) {
      respondResourceAuthorizationError(res, error);
    }
  });

  router.put('/org/org/:orgId/devices/:deviceId', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    try {
      const device = ResourceACL.updateOrganizationDevice({
        orgId: req.params.orgId,
        actorUserId: req.user!.uid,
        deviceId: req.params.deviceId,
        status: req.body?.status,
        permissions: req.body?.permissions,
        label: req.body?.label,
      });
      if (!device) {
        res.status(404).json({ error: 'Organization device not found' });
        return;
      }
      res.json(device);
    } catch (error) {
      respondResourceAuthorizationError(res, error);
    }
  });

  router.get('/org/kb/stats', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const visible = new Set(KB.listArticles(req.user!.orgId!, undefined, req.user!.uid)
      .filter(article => canReadOrganizationResource({
        orgId: req.user!.orgId!,
        userId: req.user!.uid,
        resourceType: 'knowledge_article',
        resourceId: article.id,
        ownerUserId: article.authorId,
      }))
      .map(article => article.id));
    res.json(KB.getStats(req.user!.orgId!, visible));
  });

  router.get('/org/kb/articles', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const articles = KB.listArticles(req.user!.orgId!, {
      category: req.query.category as string | undefined,
      status: req.query.status as string | undefined,
    }, req.user!.uid);
    res.json(articles.filter(article => canReadOrganizationResource({
      orgId: req.user!.orgId!,
      userId: req.user!.uid,
      resourceType: 'knowledge_article',
      resourceId: article.id,
      ownerUserId: article.authorId,
    })).map(article => ({
      ...article,
      ingestionManifest: KB.getArticleIngestionManifest(req.user!.orgId!, article.id),
    })));
  });

  router.get('/org/kb/articles/:articleId', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const article = KB.getArticle(req.user!.orgId!, req.params.articleId, req.user!.uid);
    if (!article) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }
    try {
      ResourceACL.assertOrganizationResourceAccess({
        orgId: req.user!.orgId!,
        actorUserId: req.user!.uid,
        resourceType: 'knowledge_article',
        resourceId: article.id,
        permission: 'read',
        ownerUserId: article.authorId,
      });
    } catch (error) {
      respondResourceAuthorizationError(res, error);
      return;
    }
    res.json({
      ...article,
      ingestionManifest: KB.getArticleIngestionManifest(req.user!.orgId!, article.id),
    });
  });

  router.post('/org/kb/articles', requireAuth, requireOrgRole('owner', 'admin', 'member'), (req: Request, res: Response) => {
    const { title, content, category, tags, status } = req.body;
    if (!title || !content) {
      res.status(400).json({ error: 'title and content are required' });
      return;
    }
    const article = KB.createArticle(
      req.user!.orgId!,
      req.user!.uid,
      { title, content, category, tags, status },
      { index: req.body?.index !== false },
    );
    if (req.body?.access) {
      try {
        ResourceACL.setOrganizationResourcePolicy({
          orgId: req.user!.orgId!,
          actorUserId: req.user!.uid,
          resourceType: 'knowledge_article',
          resourceId: article.id,
          ownerUserId: req.user!.uid,
          classification: req.body.access.classification,
          departmentId: req.body.access.departmentId,
          grants: req.body.access.grants,
        });
      } catch (error) {
        KB.deleteArticle(req.user!.orgId!, req.user!.uid, article.id);
        respondResourceAuthorizationError(res, error);
        return;
      }
    }
    res.status(201).json({
      ...article,
      ingestionManifest: KB.getArticleIngestionManifest(req.user!.orgId!, article.id),
    });
  });

  router.put('/org/kb/articles/:articleId', requireAuth, requireOrgRole('owner', 'admin', 'member'), (req: Request, res: Response) => {
    const current = KB.getArticle(req.user!.orgId!, req.params.articleId, req.user!.uid, 'write');
    if (!current) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }
    try {
      ResourceACL.assertOrganizationResourceAccess({
        orgId: req.user!.orgId!,
        actorUserId: req.user!.uid,
        resourceType: 'knowledge_article',
        resourceId: current.id,
        permission: 'write',
        ownerUserId: current.authorId,
      });
    } catch (error) {
      respondResourceAuthorizationError(res, error);
      return;
    }
    const article = KB.updateArticle(req.user!.orgId!, req.user!.uid, req.params.articleId, req.body);
    if (!article) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }
    res.json({
      ...article,
      ingestionManifest: KB.getArticleIngestionManifest(req.user!.orgId!, article.id),
    });
  });

  router.delete('/org/kb/articles/:articleId', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const result = KB.deleteArticle(req.user!.orgId!, req.user!.uid, req.params.articleId);
    if (!result) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }
    res.json({ success: true });
  });

  router.post('/org/kb/articles/:articleId/index', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    KB.indexArticle(req.user!.orgId!, req.params.articleId, req.user!.uid).then(count => {
      res.json({
        success: true,
        indexedChunks: count,
        ingestionManifest: KB.getArticleIngestionManifest(req.user!.orgId!, req.params.articleId),
      });
    }).catch(err => {
      res.status(500).json({ error: err.message });
    });
  });

  router.post('/org/kb/articles/:articleId/verify', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    if (!Array.isArray(req.body?.cases) || req.body.cases.length === 0) {
      res.status(400).json({ error: 'cases must contain at least one golden question with a reference answer and expected chunk indexes' });
      return;
    }
    KB.verifyArticleKnowledge(
      req.user!.orgId!,
      req.params.articleId,
      req.user!.uid,
      req.body.cases,
    ).then(ingestionManifest => {
      res.json({
        success: true,
        ingestionStatus: ingestionManifest.status,
        ingestionManifest,
      });
    }).catch(err => {
      res.status(/not found/i.test(String(err?.message || '')) ? 404 : 400).json({ error: err.message });
    });
  });

  router.post('/org/kb/search', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const { query, limit, category, status } = req.body;
    if (!query) {
      res.status(400).json({ error: 'query is required' });
      return;
    }
    const requestedLimit = Math.max(1, Math.min(Number(limit) || 5, 50));
    KB.searchKnowledgeBase(req.user!.orgId!, query, { limit: 50, category, status, userId: req.user!.uid }).then(results => {
      const articles = new Map(KB.listArticles(req.user!.orgId!, undefined, req.user!.uid).map(article => [article.id, article]));
      res.json(results.filter(result => {
        const article = articles.get(result.articleId);
        return Boolean(article && canReadOrganizationResource({
          orgId: req.user!.orgId!,
          userId: req.user!.uid,
          resourceType: 'knowledge_article',
          resourceId: article.id,
          ownerUserId: article.authorId,
        }));
      }).slice(0, requestedLimit));
    }).catch(err => {
      res.status(500).json({ error: err.message });
    });
  });

  // ── Agent Templates ───────────────────────────────────────────────────

  router.get('/org/legal/cases', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const query = String(req.query.query || '');
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
    res.json({ cases: LegalCases.listCases(req.user!.orgId!, query, 200, req.user!.uid)
      .filter(caseFile => canReadOrganizationResource({
        orgId: req.user!.orgId!,
        userId: req.user!.uid,
        resourceType: 'legal_case',
        resourceId: caseFile.id,
        ownerUserId: caseFile.createdBy,
      }))
      .slice(0, limit) });
  });

  router.get('/org/legal/cases/:caseId', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const caseFile = LegalCases.getCase(req.user!.orgId!, req.params.caseId, req.user!.uid);
    if (!caseFile) {
      res.status(404).json({ error: 'Legal case not found' });
      return;
    }
    try {
      ResourceACL.assertOrganizationResourceAccess({
        orgId: req.user!.orgId!,
        actorUserId: req.user!.uid,
        resourceType: 'legal_case',
        resourceId: caseFile.id,
        permission: 'read',
        ownerUserId: caseFile.createdBy,
      });
    } catch (error) {
      respondResourceAuthorizationError(res, error);
      return;
    }
    res.json(caseFile);
  });

  router.post('/org/legal/cases', requireAuth, requireOrgRole('owner', 'admin', 'member'), (req: Request, res: Response) => {
    const caseFile = LegalCases.createCase(req.user!.orgId!, req.user!.uid, req.body || {});
    if (req.body?.access) {
      try {
        ResourceACL.setOrganizationResourcePolicy({
          orgId: req.user!.orgId!,
          actorUserId: req.user!.uid,
          resourceType: 'legal_case',
          resourceId: caseFile.id,
          ownerUserId: req.user!.uid,
          classification: req.body.access.classification,
          departmentId: req.body.access.departmentId,
          grants: req.body.access.grants,
        });
      } catch (error) {
        LegalCases.deleteCase(req.user!.orgId!, req.user!.uid, caseFile.id);
        respondResourceAuthorizationError(res, error);
        return;
      }
    }
    res.status(201).json(caseFile);
  });

  router.put('/org/legal/cases/:caseId', requireAuth, requireOrgRole('owner', 'admin', 'member'), (req: Request, res: Response) => {
    const current = LegalCases.getCase(req.user!.orgId!, req.params.caseId, req.user!.uid, 'write');
    if (!current) {
      res.status(404).json({ error: 'Legal case not found' });
      return;
    }
    try {
      ResourceACL.assertOrganizationResourceAccess({
        orgId: req.user!.orgId!,
        actorUserId: req.user!.uid,
        resourceType: 'legal_case',
        resourceId: current.id,
        permission: 'write',
        ownerUserId: current.createdBy,
      });
    } catch (error) {
      respondResourceAuthorizationError(res, error);
      return;
    }
    const caseFile = LegalCases.updateCase(req.user!.orgId!, req.user!.uid, req.params.caseId, req.body || {});
    if (!caseFile) {
      res.status(404).json({ error: 'Legal case not found' });
      return;
    }
    res.json(caseFile);
  });

  router.delete('/org/legal/cases/:caseId', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const caseFile = LegalCases.deleteCase(req.user!.orgId!, req.user!.uid, req.params.caseId);
    if (!caseFile) {
      res.status(404).json({ error: 'Legal case not found' });
      return;
    }
    res.json({ success: true, caseId: caseFile.id });
  });

  router.post('/org/legal/cases/:caseId/materials', requireAuth, requireOrgRole('owner', 'admin', 'member'), (req: Request, res: Response) => {
    const current = LegalCases.getCase(req.user!.orgId!, req.params.caseId, req.user!.uid, 'write');
    if (!current) {
      res.status(404).json({ error: 'Legal case not found' });
      return;
    }
    try {
      ResourceACL.assertOrganizationResourceAccess({
        orgId: req.user!.orgId!,
        actorUserId: req.user!.uid,
        resourceType: 'legal_case',
        resourceId: current.id,
        permission: 'write',
        ownerUserId: current.createdBy,
      });
    } catch (error) {
      respondResourceAuthorizationError(res, error);
      return;
    }
    const material = LegalCases.addMaterial(req.user!.orgId!, req.user!.uid, req.params.caseId, {
      type: req.body?.type || 'note',
      title: req.body?.title || '案件材料',
      content: req.body?.content || '',
      fileName: req.body?.fileName,
      localPath: req.body?.localPath,
      source: req.body?.source || 'manual',
    });
    if (!material) {
      res.status(404).json({ error: 'Legal case not found' });
      return;
    }
    res.status(201).json(material);
  });

  router.get('/org/templates', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const templates = Templates.listTemplates(req.user!.orgId!, {
      status: req.query.status as EDB.TemplateStatus | undefined,
      category: req.query.category as string | undefined,
      authorId: req.query.authorId as string | undefined,
    });
    res.json(templates);
  });

  router.get('/org/templates/:templateId', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const t = Templates.getTemplate(req.user!.orgId!, req.params.templateId);
    if (!t) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }
    res.json(t);
  });

  router.post('/org/templates', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const { name, description, category, config, icon } = req.body;
    if (!name || !description || !category || !config) {
      res.status(400).json({ error: 'name, description, category, and config are required' });
      return;
    }
    const t = Templates.createTemplate(req.user!.orgId!, req.user!.uid, { name, description, category, config, icon });
    res.status(201).json(t);
  });

  router.post('/org/templates/:templateId/submit', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const t = Templates.submitForReview(req.user!.orgId!, req.user!.uid, req.params.templateId);
    if (!t) {
      res.status(400).json({ error: 'Cannot submit this template (check status and ownership)' });
      return;
    }
    if (io) {
      io.to(`org:${req.user!.orgId}`).emit('template:submitted', { templateId: req.params.templateId, authorId: req.user!.uid });
    }
    res.json(t);
  });

  router.post('/org/templates/:templateId/approve', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const t = Templates.approveTemplate(req.user!.orgId!, req.user!.uid, req.params.templateId, req.body.comment);
    if (!t) {
      res.status(400).json({ error: 'Cannot approve this template (must be pending_review)' });
      return;
    }
    if (io) {
      io.to(`org:${req.user!.orgId}`).emit('template:approved', { templateId: req.params.templateId, reviewerId: req.user!.uid });
    }
    res.json(t);
  });

  router.post('/org/templates/:templateId/reject', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const { comment } = req.body;
    if (!comment) {
      res.status(400).json({ error: 'Rejection reason (comment) is required' });
      return;
    }
    const t = Templates.rejectTemplate(req.user!.orgId!, req.user!.uid, req.params.templateId, comment);
    if (!t) {
      res.status(400).json({ error: 'Cannot reject this template (must be pending_review)' });
      return;
    }
    if (io) {
      io.to(`org:${req.user!.orgId}`).emit('template:rejected', { templateId: req.params.templateId, reviewerId: req.user!.uid });
    }
    res.json(t);
  });

  router.post('/org/templates/:templateId/publish', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const t = Templates.publishTemplate(req.user!.orgId!, req.user!.uid, req.params.templateId);
    if (!t) {
      res.status(400).json({ error: 'Cannot publish this template (must be approved)' });
      return;
    }
    if (io) {
      io.to(`org:${req.user!.orgId}`).emit('template:published', { templateId: req.params.templateId });
    }
    res.json(t);
  });

  router.post('/org/templates/:templateId/install', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const result = Templates.installTemplate(req.user!.orgId!, req.user!.uid, req.params.templateId);
    if (!result) {
      res.status(400).json({ error: 'Cannot install this template (must be published)' });
      return;
    }
    res.json(result);
  });

  // ── Invitations ──────────────────────────────────────────────────────

  router.post('/org/org/:orgId/invitations', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const inv = Org.createOrgInvitation(req.params.orgId, req.user!.uid, {
      role: req.body.role,
      departmentId: req.body.departmentId,
      maxUses: req.body.maxUses,
      expiresAt: req.body.expiresAt,
    });
    res.status(201).json(inv);
  });

  router.get('/org/invitations/:code', optionalAuth, (req: Request, res: Response) => {
    const result = Org.validateInvitation(req.params.code);
    if (!result.valid) {
      res.status(404).json({ error: result.reason });
      return;
    }
    // Return org info (but not full invitation details) for the join page
    res.json({
      valid: true,
      org: {
        id: result.org!.id,
        name: result.org!.name,
        slug: result.org!.slug,
      },
      role: result.invitation!.role,
    });
  });

  router.post('/org/invitations/:code/accept', requireAuth, (req: Request, res: Response) => {
    const result = Org.acceptInvitation(req.params.code, req.user!.uid);
    if (!result.success) {
      res.status(400).json({ error: result.reason });
      return;
    }
    // Emit member.joined event via WebSocket if available
    if (io) {
      io.to(`org:${result.orgId}`).emit('member:joined', {
        userId: req.user!.uid,
        username: req.user!.username,
        orgId: result.orgId,
      });
    }
    res.json({ success: true, orgId: result.orgId, membership: result.membership });
  });

  // ── Audit Log (admin only) ───────────────────────────────────────────

  router.get('/org/audit', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    // If filter params are present, use queryAuditLog
    const hasFilters = req.query.userId || req.query.action || req.query.resourceType || req.query.from || req.query.to;
    if (hasFilters) {
      const entries = Audit.queryAuditLog(req.user!.orgId!, {
        userId: req.query.userId as string,
        action: req.query.action as string,
        resourceType: req.query.resourceType as string,
        resourceId: req.query.resourceId as string,
        from: req.query.from as string,
        to: req.query.to as string,
      }, limit, offset);
      res.json(entries);
      return;
    }

    const entries = EDB.listAuditLog(req.user!.orgId!, limit, offset);
    res.json(entries);
  });

  router.get('/org/audit/stats', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const daysBack = parseInt(req.query.days as string) || 7;
    const stats = Audit.getAuditStats(req.user!.orgId!, daysBack);
    res.json(stats);
  });

  router.get('/org/audit/export', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const csv = Audit.exportAuditCSV(req.user!.orgId!, {
      userId: req.query.userId as string,
      action: req.query.action as string,
      resourceType: req.query.resourceType as string,
      from: req.query.from as string,
      to: req.query.to as string,
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${req.user!.orgId}-${Date.now()}.csv"`);
    res.send(csv);
  });

  // ── Connection ───────────────────────────────────────────────────────

  router.post('/org/org/:orgId/revoke/:userId', requireAuth, requireOrgRole('owner', 'admin'), (req: Request, res: Response) => {
    const m = Org.revokeMemberConnection(req.params.orgId, req.user!.uid, req.params.userId);
    if (!m) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    if (io) {
      io.to(`org:${req.params.orgId}`).emit('member:left', {
        userId: req.params.userId,
        orgId: req.params.orgId,
      });
    }
    res.json({ success: true });
  });
}
