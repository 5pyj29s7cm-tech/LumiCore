import type { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, resolveDomain } from '../middleware/auth';
import { LocalBoardError, readLocalOperationsBoard, saveLocalOperationsBoard } from '../industry/scoped_local_board';

/** Local user records only: these routes never execute a business workflow or platform action. */
export function mountLocalOperationsBoardRoutes(router: Router) {
  const scope = (req: Request) => {
    const current = { userId: req.user!.uid, ...resolveDomain(req.user!) };
    if (Object.entries(current).some(([key, value]) => req.query[key] !== value)) throw new LocalBoardError('Board account or organization changed. Reload the active workspace.', 409);
    return current;
  };
  const fail = (res: Response, next: NextFunction, error: unknown) => {
    if (error instanceof LocalBoardError) res.status(error.statusCode).json({ error: error.message });
    else next(error);
  };
  router.get('/business/local-boards/:boardId/:workspaceId', requireAuth, (req, res, next) => {
    try {
      const current = scope(req);
      res.json({ scope: current, record: readLocalOperationsBoard(current, req.params.boardId, req.params.workspaceId) });
    } catch (error) { fail(res, next, error); }
  });
  router.put('/business/local-boards/:boardId/:workspaceId', requireAuth, (req, res, next) => {
    if (req.user?.orgRole === 'viewer') { res.status(403).json({ error: 'Read-only organization role.' }); return; }
    let current: ReturnType<typeof scope>;
    try { current = scope(req); } catch (error) { fail(res, next, error); return; }
    void saveLocalOperationsBoard(current, req.params.boardId, req.params.workspaceId, req.body?.rows, req.body?.expectedVersion)
      .then(record => res.json({ persisted: true, scope: current, record }))
      .catch(error => fail(res, next, error));
  });
}
