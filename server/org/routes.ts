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
import { Server as SocketIOServer } from 'socket.io';
import { getJwtSecret } from '../config/local_identity';

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

  // ── Knowledge Base ───────────────────────────────────────────────────

  router.get('/org/kb/stats', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    res.json(KB.getStats(req.user!.orgId!));
  });

  router.get('/org/kb/articles', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const articles = KB.listArticles(req.user!.orgId!, {
      category: req.query.category as string | undefined,
      status: req.query.status as string | undefined,
    });
    res.json(articles.map(article => ({
      ...article,
      ingestionManifest: KB.getArticleIngestionManifest(req.user!.orgId!, article.id),
    })));
  });

  router.get('/org/kb/articles/:articleId', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const article = KB.getArticle(req.user!.orgId!, req.params.articleId);
    if (!article) {
      res.status(404).json({ error: 'Article not found' });
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
    const article = KB.createArticle(req.user!.orgId!, req.user!.uid, { title, content, category, tags, status });
    res.status(201).json({
      ...article,
      ingestionManifest: KB.getArticleIngestionManifest(req.user!.orgId!, article.id),
    });
  });

  router.put('/org/kb/articles/:articleId', requireAuth, requireOrgRole('owner', 'admin', 'member'), (req: Request, res: Response) => {
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
    KB.indexArticle(req.user!.orgId!, req.params.articleId).then(count => {
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
    KB.searchKnowledgeBase(req.user!.orgId!, query, { limit: limit || 5, category, status, userId: req.user!.uid }).then(results => {
      res.json(results);
    }).catch(err => {
      res.status(500).json({ error: err.message });
    });
  });

  // ── Agent Templates ───────────────────────────────────────────────────

  router.get('/org/legal/cases', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const query = String(req.query.query || '');
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
    res.json({ cases: LegalCases.listCases(req.user!.orgId!, query, limit) });
  });

  router.get('/org/legal/cases/:caseId', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const caseFile = LegalCases.getCase(req.user!.orgId!, req.params.caseId);
    if (!caseFile) {
      res.status(404).json({ error: 'Legal case not found' });
      return;
    }
    res.json(caseFile);
  });

  router.post('/org/legal/cases', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const caseFile = LegalCases.createCase(req.user!.orgId!, req.user!.uid, req.body || {});
    res.status(201).json(caseFile);
  });

  router.put('/org/legal/cases/:caseId', requireAuth, requireOrgMember, (req: Request, res: Response) => {
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

  router.post('/org/legal/cases/:caseId/materials', requireAuth, requireOrgMember, (req: Request, res: Response) => {
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
