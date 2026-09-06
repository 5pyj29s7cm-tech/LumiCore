import type { Request, RequestHandler, Response } from 'express';
import { flushDBOrThrow } from '../../db_layer';
import { requireAuth, resolveDomain } from '../middleware/auth';
import { mutationScopeKey, runSerializedMutation } from '../persistence/durable_scope_mutation';

/** Recheck authentication after waiting for an earlier mutation in this scope. */
export function serializedScopeRoute(kind: string, handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const key = `${kind}:${mutationScopeKey({ userId: req.user!.uid, ...resolveDomain(req.user!) })}`;
    return runSerializedMutation(key, async () => {
      let admitted = false;
      requireAuth(req, res, () => { admitted = true; });
      if (!admitted) return;
      try { return await handler(req, res, next); }
      catch (error) { next(error); }
    });
  };
}

/** A final response and invalidation notification share the same save barrier. */
export async function sendDurableMutation(
  req: Request, res: Response, result: unknown, afterSaved?: () => void,
  options: { retryable?: boolean } = {},
): Promise<Response | void> {
  const response = structuredClone(result);
  try { await flushDBOrThrow(); }
  catch {
    return res.status(503).json({
      error: options.retryable === false
        ? 'The change is pending because saving failed. Refresh the current state before issuing another toggle.'
        : 'The change is pending because saving failed. Retry after storage becomes available.',
      code: 'PERSISTENCE_UNAVAILABLE', retryable: options.retryable !== false, persistence: 'pending',
    });
  }
  // A queued save is not permission to publish after membership/session expiry.
  let authorized = false;
  requireAuth(req, res, () => { authorized = true; });
  if (!authorized) return;
  afterSaved?.();
  return res.json(response);
}
