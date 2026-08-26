import type { Router } from 'express';
import { requireAuth, resolveDomain } from '../middleware/auth';
import {
  createCommandCenterPlan,
  deleteCommandCenterPlan,
  listCommandCenterPlans,
  runCommandCenterPlan,
  updateCommandCenterPlan,
} from '../command_center/plans';

export function mountCommandCenterPlanRoutes(router: Router): void {
  router.get('/command-center/plans', requireAuth, (req, res) => {
    const scope = resolveDomain(req.user!);
    res.json({ plans: listCommandCenterPlans({ userId: req.user!.uid, ...scope }) });
  });

  router.post('/command-center/plans', requireAuth, (req, res) => {
    try {
      const scope = resolveDomain(req.user!);
      const plan = createCommandCenterPlan({ userId: req.user!.uid, ...scope }, req.body || {});
      res.status(201).json({ plan });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/command-center/plans/:id', requireAuth, (req, res) => {
    try {
      const scope = resolveDomain(req.user!);
      const plan = updateCommandCenterPlan({
        id: req.params.id,
        userId: req.user!.uid,
        ...scope,
        patch: req.body || {},
      });
      if (!plan) return res.status(404).json({ error: 'Plan not found.' });
      res.json({ plan });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/command-center/plans/:id/run', requireAuth, (req, res) => {
    const scope = resolveDomain(req.user!);
    const result = runCommandCenterPlan({ id: req.params.id, userId: req.user!.uid, ...scope, manual: true });
    if (!result) return res.status(404).json({ error: 'Plan not found.' });
    res.status(result.reused ? 200 : 202).json(result);
  });

  router.delete('/command-center/plans/:id', requireAuth, (req, res) => {
    const scope = resolveDomain(req.user!);
    const deleted = deleteCommandCenterPlan({ id: req.params.id, userId: req.user!.uid, ...scope });
    if (!deleted) return res.status(404).json({ error: 'Plan not found.' });
    res.json({ deleted: true });
  });
}
