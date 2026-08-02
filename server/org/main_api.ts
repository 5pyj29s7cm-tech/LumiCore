/**
 * Company-side organization branch API.
 *
 * A user token is accepted only for registration. Registration returns an
 * immutable organization- and branch-scoped token. Every later request must
 * use that token so a branch cannot silently change organization or identity.
 */
import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, requireOrganizationBranchAuth } from '../middleware/auth';
import * as EDB from './db';
import * as KB from './kb';
import * as Templates from './templates';
import { getJwtSecret } from '../config/local_identity';
import {
  BranchSyncValidationError,
  getBranchSyncReceipt,
  persistBranchRegistration,
  persistBranchSyncBatch,
} from './branch_sync';
import {
  authorizeOrganizationDevice,
  authorizeOrganizationResource,
  OrganizationResourceAuthorizationError,
  type OrganizationDevicePermission,
} from './resource_acl';

const branchHeartbeats = new Map<string, string>(); // orgId:branchId -> last heartbeat ISO

function validBranchId(value: unknown): string {
  const branchId = String(value || '').trim();
  return /^[A-Za-z0-9._:@/-]{8,240}$/.test(branchId) ? branchId : '';
}

function branchHeartbeatKey(req: Request): string {
  return `${req.user!.orgId}:${req.user!.branchId}`;
}

function requireBranchSession(req: Request, res: Response, next: NextFunction): void {
  if (
    req.user?.tokenType !== 'organization_branch'
    || !req.user.orgId
    || !validBranchId(req.user.branchId)
  ) {
    res.status(403).json({ error: 'A valid organization branch session is required.' });
    return;
  }
  next();
}

function requireBranchDevicePermission(permission: OrganizationDevicePermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      authorizeOrganizationDevice({
        orgId: req.user!.orgId!,
        branchId: req.user!.branchId!,
        userId: req.user!.uid,
        permission,
      });
      next();
    } catch (error: any) {
      res.status(error instanceof OrganizationResourceAuthorizationError ? error.statusCode : 500)
        .json({ error: error?.message || 'Organization device authorization failed' });
    }
  };
}

export function mountBranchRoutes(router: Router) {
  router.post('/branch/register', requireAuth, async (req: Request, res: Response) => {
    const orgId = String(req.body?.orgId || '').trim();
    const branchId = validBranchId(req.body?.branchId);
    if (!orgId || !branchId) {
      res.status(400).json({ error: 'orgId and a stable branchId are required' });
      return;
    }

    const membership = EDB.getMember(orgId, req.user!.uid);
    if (!membership || membership.status !== 'active') {
      res.status(403).json({ error: 'Not a member of this organization' });
      return;
    }

    try {
      await persistBranchRegistration({ orgId, branchId, userId: req.user!.uid });
    } catch (error: any) {
      const status = error instanceof BranchSyncValidationError || error instanceof OrganizationResourceAuthorizationError
        ? error.statusCode
        : 500;
      res.status(status).json({ error: error?.message || 'Branch registration could not be persisted' });
      return;
    }

    const branchToken = jwt.sign(
      {
        uid: req.user!.uid,
        username: req.user!.username,
        role: req.user!.role || 'user',
        orgId,
        orgRole: membership.role,
        tokenType: 'organization_branch',
        branchId,
      },
      getJwtSecret(),
      { expiresIn: '7d' },
    );
    branchHeartbeats.set(`${orgId}:${branchId}`, new Date().toISOString());

    res.json({
      success: true,
      org: {
        id: orgId,
        name: EDB.getOrgById(orgId)?.name,
      },
      membership: {
        role: membership.role,
        departmentId: membership.departmentId,
      },
      branchId,
      branchToken,
      serverTime: new Date().toISOString(),
    });
  });

  router.post('/branch/ingest', requireOrganizationBranchAuth, requireBranchSession, requireBranchDevicePermission('sync_write'), async (req: Request, res: Response) => {
    try {
      const receipt = await persistBranchSyncBatch({
        payload: req.body || {},
        authenticatedUserId: req.user!.uid,
        authenticatedOrgId: req.user!.orgId!,
        authenticatedBranchId: req.user!.branchId!,
      });
      branchHeartbeats.set(branchHeartbeatKey(req), new Date().toISOString());
      res.json({ success: true, synced: receipt.accepted, receipt });
    } catch (error: any) {
      const status = error instanceof BranchSyncValidationError || error instanceof OrganizationResourceAuthorizationError
        ? error.statusCode
        : 500;
      res.status(status).json({
        success: false,
        error: error?.message || 'Branch sync persistence failed',
      });
    }
  });

  router.get('/branch/ingest/receipts/:batchId', requireOrganizationBranchAuth, requireBranchSession, requireBranchDevicePermission('sync_write'), (req: Request, res: Response) => {
    try {
      const receipt = getBranchSyncReceipt({
        orgId: req.user!.orgId!,
        branchId: req.user!.branchId!,
        batchId: String(req.params.batchId || ''),
      });
      if (!receipt) {
        res.status(404).json({ found: false });
        return;
      }
      res.json({ found: true, receipt });
    } catch (error: any) {
      const status = error instanceof BranchSyncValidationError ? error.statusCode : 500;
      res.status(status).json({ error: error?.message || 'Unable to read branch sync receipt' });
    }
  });

  router.get('/branch/kb-cache', requireOrganizationBranchAuth, requireBranchSession, requireBranchDevicePermission('kb_read'), (req: Request, res: Response) => {
    const articles = EDB.listKbArticles(req.user!.orgId!, { status: 'published' })
      .filter(article => authorizeOrganizationResource({
        orgId: req.user!.orgId!,
        actorUserId: req.user!.uid,
        branchId: req.user!.branchId,
        resourceType: 'knowledge_article',
        resourceId: article.id,
        permission: 'read',
        ownerUserId: article.authorId,
      }).allowed);
    res.json({
      articles: articles.map(article => ({
        id: article.id,
        title: article.title,
        content: article.content,
        category: article.category,
        tags: article.tags,
      })),
      updatedAt: new Date().toISOString(),
    });
  });

  router.get('/branch/status', requireOrganizationBranchAuth, requireBranchSession, requireBranchDevicePermission('status_read'), (req: Request, res: Response) => {
    branchHeartbeats.set(branchHeartbeatKey(req), new Date().toISOString());
    const orgPrefix = `${req.user!.orgId}:`;
    res.json({
      status: 'ok',
      serverTime: new Date().toISOString(),
      branchId: req.user!.branchId,
      orgId: req.user!.orgId,
      connectedBranches: [...branchHeartbeats.keys()].filter(key => key.startsWith(orgPrefix)).length,
    });
  });

  router.get('/branch/templates', requireOrganizationBranchAuth, requireBranchSession, requireBranchDevicePermission('template_read'), (req: Request, res: Response) => {
    res.json(Templates.listTemplates(req.user!.orgId!, { status: 'published' }));
  });

  router.post('/branch/kb/search', requireOrganizationBranchAuth, requireBranchSession, requireBranchDevicePermission('kb_read'), (req: Request, res: Response) => {
    const query = String(req.body?.query || '').trim();
    const limit = Math.max(1, Math.min(Number(req.body?.limit) || 5, 50));
    if (!query) {
      res.status(400).json({ error: 'query is required' });
      return;
    }
    KB.searchKnowledgeBase(req.user!.orgId!, query, { limit: 50, userId: req.user!.uid })
      .then(results => {
        const articles = new Map(EDB.listKbArticles(req.user!.orgId!).map(article => [article.id, article]));
        res.json(results.filter(result => {
          const article = articles.get(result.articleId);
          return Boolean(article && authorizeOrganizationResource({
            orgId: req.user!.orgId!,
            actorUserId: req.user!.uid,
            branchId: req.user!.branchId,
            resourceType: 'knowledge_article',
            resourceId: article.id,
            permission: 'read',
            ownerUserId: article.authorId,
          }).allowed);
        }).slice(0, limit));
      })
      .catch(error => res.status(500).json({ error: error.message }));
  });
}

export function getConnectedBranchCount(): number {
  return branchHeartbeats.size;
}

export function getBranchHeartbeats(): ReadonlyMap<string, string> {
  return branchHeartbeats;
}

export function removeBranchHeartbeat(identity: string): void {
  branchHeartbeats.delete(identity);
}
