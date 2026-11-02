import type { Router, Request, Response } from 'express';
import { requireAuth, requireOrgRole, requireOrgMember } from '../middleware/auth';
import * as InteriorProjects from './projects';
import * as InteriorProjectAssets from './project_assets';
import { getInteriorProjectWorkflow } from './project_workflow';
import * as EDB from '../org/db';
import { durableInteriorProjectRouter } from './durable_routes';

function respondInteriorProjectError(res: Response, error: unknown): boolean {
  if (
    error instanceof InteriorProjects.InteriorProjectValidationError
    || error instanceof InteriorProjectAssets.InteriorProjectAssetValidationError
  ) {
    res.status(error.statusCode).json({ error: error.message });
    return true;
  }
  return false;
}

function requirePersonalInteriorContext(req: Request, res: Response): string | null {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  if (req.user.orgId) {
    res.status(409).json({ error: 'Personal design projects require the personal Lumi workspace.' });
    return null;
  }
  return InteriorProjects.personalInteriorProjectScope(req.user.uid);
}

export function mountInteriorProjectRoutes(baseRouter: Router): void {
  const router = durableInteriorProjectRouter(baseRouter);
  router.get('/personal/interior/projects', requireAuth, (req: Request, res: Response) => {
    const scopeId = requirePersonalInteriorContext(req, res);
    if (!scopeId) return;
    res.json({
      projects: InteriorProjects.listInteriorProjects(scopeId, {
        includeArchived: req.query.includeArchived === 'true',
      }),
    });
  });

  router.get('/personal/interior/projects/active', requireAuth, (req: Request, res: Response) => {
    const scopeId = requirePersonalInteriorContext(req, res);
    if (!scopeId) return;
    res.json({ project: InteriorProjects.getActiveInteriorProject(scopeId, req.user!.uid) });
  });

  router.put('/personal/interior/projects/active', requireAuth, (req: Request, res: Response) => {
    const scopeId = requirePersonalInteriorContext(req, res);
    if (!scopeId) return;
    try {
      const projectId = req.body?.projectId == null ? null : String(req.body.projectId);
      res.json({ project: InteriorProjects.setActiveInteriorProject(scopeId, req.user!.uid, projectId) });
    } catch (error) {
      if (!respondInteriorProjectError(res, error)) throw error;
    }
  });

  router.get('/personal/interior/projects/:projectId', requireAuth, (req: Request, res: Response) => {
    const scopeId = requirePersonalInteriorContext(req, res);
    if (!scopeId) return;
    const project = InteriorProjects.getInteriorProject(scopeId, req.params.projectId);
    if (!project) {
      res.status(404).json({ error: 'Interior project not found' });
      return;
    }
    res.json(project);
  });

  router.post('/personal/interior/projects', requireAuth, (req: Request, res: Response) => {
    const scopeId = requirePersonalInteriorContext(req, res);
    if (!scopeId) return;
    try {
      const project = InteriorProjects.createInteriorProject(scopeId, req.user!.uid, req.body || {});
      InteriorProjects.setActiveInteriorProject(scopeId, req.user!.uid, project.id);
      res.status(201).json(project);
    } catch (error) {
      if (!respondInteriorProjectError(res, error)) throw error;
    }
  });

  router.get('/personal/interior/projects/:projectId/workflow', requireAuth, (req: Request, res: Response) => {
    const scopeId = requirePersonalInteriorContext(req, res);
    if (!scopeId) return;
    const workflow = getInteriorProjectWorkflow(scopeId, req.params.projectId);
    if (!workflow || !InteriorProjects.getInteriorProject(scopeId, req.params.projectId)) {
      res.status(404).json({ error: 'Interior project not found' });
      return;
    }
    res.json({ workflow });
  });

  router.put('/personal/interior/projects/:projectId', requireAuth, (req: Request, res: Response) => {
    const scopeId = requirePersonalInteriorContext(req, res);
    if (!scopeId) return;
    try {
      const project = InteriorProjects.updateInteriorProject(scopeId, req.params.projectId, req.body || {});
      if (!project) {
        res.status(404).json({ error: 'Interior project not found' });
        return;
      }
      res.json(project);
    } catch (error) {
      if (!respondInteriorProjectError(res, error)) throw error;
    }
  });

  router.get('/personal/interior/projects/:projectId/assets', requireAuth, (req: Request, res: Response) => {
    const scopeId = requirePersonalInteriorContext(req, res);
    if (!scopeId) return;
    if (!InteriorProjects.getInteriorProject(scopeId, req.params.projectId)) {
      res.status(404).json({ error: 'Interior project not found' });
      return;
    }
    res.json({ assets: InteriorProjectAssets.listInteriorProjectAssets(scopeId, req.params.projectId) });
  });

  router.put('/personal/interior/projects/:projectId/assets/:assetId', requireAuth, (req: Request, res: Response) => {
    const scopeId = requirePersonalInteriorContext(req, res);
    if (!scopeId) return;
    try {
      const asset = InteriorProjectAssets.updateInteriorProjectAsset(
        scopeId,
        req.params.projectId,
        req.params.assetId,
        req.body || {},
      );
      if (!asset) {
        res.status(404).json({ error: 'Interior project asset not found' });
        return;
      }
      res.json(asset);
    } catch (error) {
      if (!respondInteriorProjectError(res, error)) throw error;
    }
  });

  router.delete('/personal/interior/projects/:projectId/assets/:assetId', requireAuth, (req: Request, res: Response) => {
    const scopeId = requirePersonalInteriorContext(req, res);
    if (!scopeId) return;
    const asset = InteriorProjectAssets.removeInteriorProjectAsset(
      scopeId,
      req.params.projectId,
      req.params.assetId,
    );
    if (!asset) {
      res.status(404).json({ error: 'Interior project asset not found' });
      return;
    }
    res.json({ success: true, asset, fileRetained: true });
  });

  router.get('/org/interior/projects', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const projects = InteriorProjects.listInteriorProjects(req.user!.orgId!, {
      includeArchived: req.query.includeArchived === 'true',
    });
    res.json({ projects });
  });

  router.get('/org/interior/projects/active', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    res.json({
      project: InteriorProjects.getActiveInteriorProject(req.user!.orgId!, req.user!.uid),
    });
  });

  router.put('/org/interior/projects/active', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    try {
      const projectId = req.body?.projectId == null ? null : String(req.body.projectId);
      res.json({
        project: InteriorProjects.setActiveInteriorProject(req.user!.orgId!, req.user!.uid, projectId),
      });
    } catch (error) {
      if (!respondInteriorProjectError(res, error)) throw error;
    }
  });

  router.get('/org/interior/projects/:projectId', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const project = InteriorProjects.getInteriorProject(req.user!.orgId!, req.params.projectId);
    if (!project) {
      res.status(404).json({ error: 'Interior project not found' });
      return;
    }
    res.json(project);
  });

  router.post('/org/interior/projects', requireAuth, requireOrgRole('owner', 'admin', 'member'), (req: Request, res: Response) => {
    try {
      const project = InteriorProjects.createInteriorProject(req.user!.orgId!, req.user!.uid, req.body || {});
      InteriorProjects.setActiveInteriorProject(req.user!.orgId!, req.user!.uid, project.id);
      EDB.logAudit({
        orgId: req.user!.orgId!,
        userId: req.user!.uid,
        action: 'interior_project.created',
        resourceType: 'interior_project',
        resourceId: project.id,
        details: { name: project.name, projectType: project.projectType },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
      res.status(201).json(project);
    } catch (error) {
      if (!respondInteriorProjectError(res, error)) throw error;
    }
  });

  router.get('/org/interior/projects/:projectId/workflow', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const project = InteriorProjects.getInteriorProject(req.user!.orgId!, req.params.projectId);
    if (!project) {
      res.status(404).json({ error: 'Interior project not found' });
      return;
    }
    res.json({ workflow: getInteriorProjectWorkflow(project.orgId, project.id) });
  });

  router.put('/org/interior/projects/:projectId', requireAuth, requireOrgRole('owner', 'admin', 'member'), (req: Request, res: Response) => {
    try {
      const project = InteriorProjects.updateInteriorProject(
        req.user!.orgId!,
        req.params.projectId,
        req.body || {},
      );
      if (!project) {
        res.status(404).json({ error: 'Interior project not found' });
        return;
      }
      EDB.logAudit({
        orgId: req.user!.orgId!,
        userId: req.user!.uid,
        action: project.status === 'archived' ? 'interior_project.archived' : 'interior_project.updated',
        resourceType: 'interior_project',
        resourceId: project.id,
        details: { name: project.name, projectType: project.projectType, status: project.status },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
      res.json(project);
    } catch (error) {
      if (!respondInteriorProjectError(res, error)) throw error;
    }
  });

  router.get('/org/interior/projects/:projectId/assets', requireAuth, requireOrgMember, (req: Request, res: Response) => {
    const project = InteriorProjects.getInteriorProject(req.user!.orgId!, req.params.projectId);
    if (!project) {
      res.status(404).json({ error: 'Interior project not found' });
      return;
    }
    res.json({ assets: InteriorProjectAssets.listInteriorProjectAssets(req.user!.orgId!, project.id) });
  });

  router.put('/org/interior/projects/:projectId/assets/:assetId', requireAuth, requireOrgRole('owner', 'admin', 'member'), (req: Request, res: Response) => {
    try {
      const asset = InteriorProjectAssets.updateInteriorProjectAsset(
        req.user!.orgId!,
        req.params.projectId,
        req.params.assetId,
        req.body || {},
      );
      if (!asset) {
        res.status(404).json({ error: 'Interior project asset not found' });
        return;
      }
      EDB.logAudit({
        orgId: req.user!.orgId!,
        userId: req.user!.uid,
        action: 'interior_project.asset_updated',
        resourceType: 'interior_project_asset',
        resourceId: asset.id,
        details: { projectId: asset.projectId, fileId: asset.fileId, category: asset.category },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
      res.json(asset);
    } catch (error) {
      if (!respondInteriorProjectError(res, error)) throw error;
    }
  });

  router.delete('/org/interior/projects/:projectId/assets/:assetId', requireAuth, requireOrgRole('owner', 'admin', 'member'), (req: Request, res: Response) => {
    const asset = InteriorProjectAssets.removeInteriorProjectAsset(
      req.user!.orgId!,
      req.params.projectId,
      req.params.assetId,
    );
    if (!asset) {
      res.status(404).json({ error: 'Interior project asset not found' });
      return;
    }
    EDB.logAudit({
      orgId: req.user!.orgId!,
      userId: req.user!.uid,
      action: 'interior_project.asset_removed',
      resourceType: 'interior_project_asset',
      resourceId: asset.id,
      details: { projectId: asset.projectId, fileId: asset.fileId, fileRetained: true },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json({ success: true, asset, fileRetained: true });
  });

}
