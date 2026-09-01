import type { NextFunction, Request, Response, Router } from 'express';
import type { Server } from 'socket.io';
import {
  DESKTOP_SESSION_HEADER,
  verifyDesktopSessionProof,
} from '../config/desktop_bootstrap';
import {
  activateExternalCapabilityProposal,
  deactivateExternalCapability,
  executeExternalCapabilityAction,
  listActiveExternalCapabilities,
  reviewExternalCapabilityProposal,
} from '../external_capabilities/registry';
import { requireAdmin, requireAuth, requireLocalRequest, resolveDomain } from '../middleware/auth';
import { createDesktopRelay } from '../socket/desktop_relay';
import { toolRegistry } from '../tools/registry';

const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise.resolve(fn(req, res, next)).catch(next);

function desktopSessionProof(req: Request): string {
  return String(req.headers[DESKTOP_SESSION_HEADER] || '').trim();
}

export function requireNativeDesktopSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !verifyDesktopSessionProof(desktopSessionProof(req), req.user.uid)) {
    res.status(403).json({ error: 'A valid native desktop session proof is required for external capability changes and execution.' });
    return;
  }
  next();
}

export function requirePersonalExternalCapabilityScope(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const scope = resolveDomain(req.user);
  if (scope.domain !== 'personal' || scope.orgId) {
    res.status(403).json({ error: 'External capability packages are available only in the personal workspace.' });
    return;
  }
  next();
}

function safeCorrelationValue(value: unknown, fallback: string, max = 180): string {
  const normalized = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{8,256}$/.test(normalized)
    ? normalized.slice(0, max)
    : fallback;
}

function requestError(res: Response, error: unknown): void {
  const err = error as Error & { statusCode?: number };
  const message = String(err?.message || 'External capability request failed.').slice(0, 1_000);
  const status = Number(err?.statusCode) || (
    /not active|not found/i.test(message) ? 404
      : /confirmation boundary|conflict|changed after review|review.*again/i.test(message) ? 409
        : /required|invalid|unsupported|must|contains|exceeds|unavailable|does not/i.test(message) ? 400
          : 500
  );
  res.status(status).json({ error: message });
}

export function mountExternalCapabilityRoutes(router: Router, io: Server): void {
  router.get(
    '/external-capabilities',
    requireAuth,
    requirePersonalExternalCapabilityScope,
    requireLocalRequest,
    requireNativeDesktopSession,
    (req, res) => {
    try {
      res.json({ capabilities: listActiveExternalCapabilities(req.user!.uid, toolRegistry) });
    } catch (error) {
      requestError(res, error);
    }
    },
  );

  router.post(
    '/external-capabilities/review',
    requireAuth,
    requireAdmin,
    requirePersonalExternalCapabilityScope,
    requireLocalRequest,
    requireNativeDesktopSession,
    asyncHandler(async (req, res) => {
      try {
        const result = await reviewExternalCapabilityProposal({
          ownerUserId: req.user!.uid,
          proposal: req.body?.proposal ?? req.body?.package,
          desktopSessionProof: desktopSessionProof(req),
          registry: toolRegistry,
        });
        res.json(result);
      } catch (error) {
        requestError(res, error);
      }
    }),
  );

  router.post(
    '/external-capabilities/activate',
    requireAuth,
    requireAdmin,
    requirePersonalExternalCapabilityScope,
    requireLocalRequest,
    requireNativeDesktopSession,
    asyncHandler(async (req, res) => {
      try {
        const result = await activateExternalCapabilityProposal({
          ownerUserId: req.user!.uid,
          proposal: req.body?.proposal ?? req.body?.package,
          id: req.body?.id,
          version: req.body?.version,
          packageDigest: req.body?.packageDigest,
          reviewNonce: req.body?.reviewNonce ?? req.body?.approvalNonce,
          desktopSessionProof: desktopSessionProof(req),
          registry: toolRegistry,
        });
        res.json(result);
      } catch (error) {
        requestError(res, error);
      }
    }),
  );

  router.post(
    '/external-capabilities/:id/deactivate',
    requireAuth,
    requireAdmin,
    requirePersonalExternalCapabilityScope,
    requireLocalRequest,
    requireNativeDesktopSession,
    asyncHandler(async (req, res) => {
      try {
        const result = await deactivateExternalCapability({
          ownerUserId: req.user!.uid,
          capabilityId: String(req.params.id || '').trim().toLowerCase(),
          registry: toolRegistry,
        });
        res.json(result);
      } catch (error) {
        requestError(res, error);
      }
    }),
  );

  router.post(
    '/external-capabilities/:id/actions/:actionId/execute',
    requireAuth,
    requirePersonalExternalCapabilityScope,
    requireLocalRequest,
    requireNativeDesktopSession,
    asyncHandler(async (req, res) => {
      const requestId = safeCorrelationValue(
        req.body?.requestId || req.headers['x-request-id'],
        '',
      );
      const idempotencyKey = safeCorrelationValue(
        req.body?.idempotencyKey || req.headers['x-idempotency-key'],
        '',
        256,
      );
      if (!requestId || !idempotencyKey) {
        res.status(400).json({
          error: 'Stable requestId and idempotencyKey values are required for external capability execution.',
        });
        return;
      }
      const desktopRelay = createDesktopRelay({
        io,
        userId: req.user!.uid,
        domain: 'personal',
        orgId: '',
        source: 'external-capability-icon',
        requestId,
      });
      try {
        const result = await executeExternalCapabilityAction({
          ownerUserId: req.user!.uid,
          capabilityId: String(req.params.id || '').trim().toLowerCase(),
          actionId: String(req.params.actionId || '').trim().toLowerCase(),
          arguments: req.body?.arguments,
          requestId,
          idempotencyKey,
          registry: toolRegistry,
          context: {
            userId: req.user!.uid,
            authenticated: true,
            authRole: req.user!.role,
            localExecution: true,
            executionBoundary: 'trusted_local',
            domain: 'personal',
            orgId: '',
            desktopRelay,
          },
        });
        res.json(result);
      } catch (error) {
        requestError(res, error);
      } finally {
        desktopRelay.releaseControlLease('external capability request finished');
      }
    }),
  );
}
