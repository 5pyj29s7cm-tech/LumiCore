import type { Router, Request, Response } from 'express';
import { requireAuth, resolveDomain } from '../middleware/auth';
import { FinanceWorksheetError, readFinanceWorksheet, saveFinanceWorksheet } from '../industry/finance_local_worksheet';

export function mountFinanceLocalWorksheetRoutes(router: Router) {
  const scope = (req: Request) => {
    const current = { userId: req.user!.uid, ...resolveDomain(req.user!) };
    if (Object.entries(current).some(([key, value]) => req.query[key] !== value)) {
      throw new FinanceWorksheetError('Worksheet account or workspace changed. Reload the active workspace.', 409);
    }
    return current;
  };
  const failure = (res: Response, error: unknown) => {
    if (!(error instanceof FinanceWorksheetError)) throw error;
    return res.status(error.statusCode).json({ error: error.message });
  };
  router.get('/business/finance-worksheets/:entryId/:workspaceId', requireAuth, (req, res, next) => {
    try { const current = scope(req); res.json({ scope: current, record: readFinanceWorksheet(current, req.params.entryId, req.params.workspaceId) }); }
    catch (error) { try { failure(res, error); } catch (unexpected) { next(unexpected); } }
  });
  router.put('/business/finance-worksheets/:entryId/:workspaceId', requireAuth, (req, res, next) => {
    if (req.user?.orgRole === 'viewer') { res.status(403).json({ error: 'Read-only organization role.' }); return; }
    let current: ReturnType<typeof scope>;
    try { current = scope(req); } catch (error) { try { failure(res, error); } catch (unexpected) { next(unexpected); } return; }
    void saveFinanceWorksheet(current, req.params.entryId, req.params.workspaceId, req.body?.rows, req.body?.expectedVersion)
      .then(record => res.json({ persisted: true, scope: current, record }))
      .catch(error => { try { failure(res, error); } catch (unexpected) { next(unexpected); } });
  });
}
