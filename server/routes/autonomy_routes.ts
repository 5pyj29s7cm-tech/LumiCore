import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { getGateConfig, saveGateConfig } from '../autonomy/safety_gate';
import {
  cancelTask,
  getTaskHistory,
  getTaskQueue,
  requestPauseAutonomousTask,
  resumeAutonomousTask,
} from '../autonomy/task_queue';
import {
  listBackgroundTasks,
  requestCancelBackgroundTask,
  requestPauseBackgroundTask,
  resumeBackgroundTask,
} from '../agents/background_tasks';

export function autonomyRoutes(): Router {
  const router = Router();

  // Safety gate config
  router.get('/gate_config', requireAuth, (req, res) => {
    res.json(getGateConfig(req.user!.uid));
  });

  router.put('/gate_config', requireAuth, (req, res) => {
    const updated = saveGateConfig(req.body || {}, req.user!.uid);
    res.json(updated);
  });

  // Task queue
  router.get('/queue', requireAuth, (req, res) => {
    res.json({ queue: getTaskQueue(req.user!.uid) });
  });

  router.get('/history', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    res.json({ tasks: getTaskHistory(limit, offset, req.user!.uid) });
  });

  router.post('/tasks/:id/cancel', requireAuth, (req, res) => {
    const ok = cancelTask(req.params.id, req.user!.uid);
    if (!ok) return res.status(404).json({ error: 'Task not found or not cancellable' });
    res.json({ id: req.params.id, cancelled: true });
  });

  router.post('/tasks/:id/pause', requireAuth, (req, res) => {
    const task = requestPauseAutonomousTask(req.params.id, req.user!.uid);
    if (!task) return res.status(404).json({ error: 'Task not found or not pausable' });
    res.json({ task });
  });

  router.post('/tasks/:id/resume', requireAuth, (req, res) => {
    const task = resumeAutonomousTask(req.params.id, req.user!.uid);
    if (!task) return res.status(404).json({ error: 'Task not found or not resumable' });
    res.json({ task });
  });

  router.get('/background-tasks', requireAuth, (req, res) => {
    res.json({ tasks: listBackgroundTasks(req.user!.uid) });
  });

  router.post('/background-tasks/:id/cancel', requireAuth, (req, res) => {
    const task = requestCancelBackgroundTask(req.params.id, req.user!.uid);
    if (!task) return res.status(404).json({ error: 'Background task not found' });
    res.json({ task });
  });

  router.post('/background-tasks/:id/pause', requireAuth, (req, res) => {
    const task = requestPauseBackgroundTask(req.params.id, req.user!.uid);
    if (!task) return res.status(404).json({ error: 'Background task not found or not pausable' });
    res.json({ task });
  });

  router.post('/background-tasks/:id/resume', requireAuth, (req, res) => {
    const task = resumeBackgroundTask(req.params.id, req.user!.uid);
    if (!task) return res.status(404).json({ error: 'Background task not found or not resumable' });
    res.json({ task });
  });

  return router;
}
