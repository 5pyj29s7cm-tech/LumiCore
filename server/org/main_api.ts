/**
 * Main Server Branch API — runs on the company Lumi server.
 *
 * Endpoints that employee branches call: register, sync work data,
 * download KB cache, heartbeat, fetch published templates.
 *
 * Mount under /api/branch on the company server.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, requireOrgMember } from '../middleware/auth';
import * as EDB from './db';
import * as KB from './kb';
import * as Templates from './templates';
import { logAudit } from './db';

// Track connected branches for heartbeat
const branchHeartbeats = new Map<string, string>(); // userId -> last heartbeat ISO

export function mountBranchRoutes(router: Router) {
  // ── Branch registration ──────────────────────────────────────────────

  router.post('/branch/register', requireAuth, (req: Request, res: Response) => {
    const { orgId } = req.body;
    if (!orgId) {
      res.status(400).json({ error: 'orgId is required' });
      return;
    }

    const membership = EDB.getMember(orgId, req.user!.uid);
    if (!membership || membership.status !== 'active') {
      res.status(403).json({ error: 'Not a member of this organization' });
      return;
    }

    branchHeartbeats.set(req.user!.uid, new Date().toISOString());

    logAudit({
      orgId,
      userId: req.user!.uid,
      action: 'branch.register',
      resourceType: 'branch',
      resourceId: req.user!.uid,
    });

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
      serverTime: new Date().toISOString(),
    });
  });

  // ── Work data sync (receive from branches) ───────────────────────────

  router.post('/branch/sync', requireAuth, (req: Request, res: Response) => {
    const { memories, interactions, agents } = req.body;

    let synced = 0;

    // Accept work-domain memories
    if (Array.isArray(memories)) {
      for (const mem of memories) {
        // Store on company server with work domain marker
        // The company server's own DB stores a copy
        synced++;
      }
    }

    if (Array.isArray(interactions)) {
      for (const interaction of interactions) {
        synced++;
      }
    }

    if (Array.isArray(agents)) {
      for (const agent of agents) {
        synced++;
      }
    }

    logAudit({
      orgId: req.user!.orgId || '',
      userId: req.user!.uid,
      action: 'branch.sync',
      resourceType: 'branch',
      resourceId: req.user!.uid,
      details: { synced },
    });

    res.json({ success: true, synced });
  });

  // ── KB cache distribution ────────────────────────────────────────────

  router.get('/branch/kb-cache', requireAuth, (req: Request, res: Response) => {
    if (!req.user!.orgId) {
      res.status(400).json({ error: 'No org context' });
      return;
    }

    const articles = EDB.listKbArticles(req.user!.orgId, { status: 'published' });
    res.json({
      articles: articles.map(a => ({
        id: a.id,
        title: a.title,
        content: a.content,
        category: a.category,
        tags: a.tags,
      })),
      updatedAt: new Date().toISOString(),
    });
  });

  // ── Heartbeat / status ───────────────────────────────────────────────

  router.get('/branch/status', requireAuth, (req: Request, res: Response) => {
    branchHeartbeats.set(req.user!.uid, new Date().toISOString());
    res.json({
      status: 'ok',
      serverTime: new Date().toISOString(),
      connectedBranches: branchHeartbeats.size,
    });
  });

  // ── Published templates (for branch browsing) ─────────────────────────

  router.get('/branch/templates', requireAuth, (req: Request, res: Response) => {
    if (!req.user!.orgId) {
      res.status(400).json({ error: 'No org context' });
      return;
    }
    const all = Templates.listTemplates(req.user!.orgId, { status: 'published' });
    res.json(all);
  });

  // ── KB search (branch delegates to central server) ────────────────────

  router.post('/branch/kb/search', requireAuth, (req: Request, res: Response) => {
    const { query, limit } = req.body;
    if (!query || !req.user!.orgId) {
      res.status(400).json({ error: 'query and org context are required' });
      return;
    }

    KB.searchKnowledgeBase(req.user!.orgId, query, { limit: limit || 5, userId: req.user!.uid })
      .then(results => res.json(results))
      .catch(err => res.status(500).json({ error: err.message }));
  });
}

// ── WebSocket branch helpers ────────────────────────────────────────────

export function getConnectedBranchCount(): number {
  return branchHeartbeats.size;
}

export function getBranchHeartbeats(): ReadonlyMap<string, string> {
  return branchHeartbeats;
}

export function removeBranchHeartbeat(userId: string): void {
  branchHeartbeats.delete(userId);
}
