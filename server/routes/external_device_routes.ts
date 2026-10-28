import type { NextFunction, Request, Response, Router } from 'express';
import { DESKTOP_SESSION_HEADER, resolveDesktopSession } from '../config/desktop_bootstrap';
import { requireAuth, requireLocalRequest } from '../middleware/auth';
import { observeExternalDevices, type ExternalObservationAdapters } from '../devices/external_observation';
import { readNetworkPrinterStatus, type IppPrinterTarget } from '../devices/ipp_printer';

export interface ExternalDeviceRouteAdapters extends ExternalObservationAdapters {
  printerStatus: typeof readNetworkPrinterStatus;
}

function requireDesktopObservationSession(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  if (!resolveDesktopSession(req.headers[DESKTOP_SESSION_HEADER], req.user!.uid)) {
    res.status(403).json({ error: 'A valid local desktop session proof is required' });
    return;
  }
  next();
}

function printerTarget(value: unknown): IppPrinterTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 3 || !keys.every(key => ['address', 'port', 'resourcePath'].includes(key))
    || typeof body.address !== 'string' || !body.address
    || !Number.isInteger(body.port) || Number(body.port) < 1 || Number(body.port) > 65535
    || typeof body.resourcePath !== 'string' || !body.resourcePath) return null;
  return { address: body.address, port: body.port as number, resourcePath: body.resourcePath };
}

export function mountExternalDeviceRoutes(router: Router, adapters: Partial<ExternalDeviceRouteAdapters> = {}): void {
  const admission = [requireAuth, requireLocalRequest, requireDesktopObservationSession];
  router.get('/devices/external', ...admission, async (_req, res, next) => {
    try {
      res.json(await observeExternalDevices(adapters));
    } catch (error) { next(error); }
  });
  router.post('/devices/external/printer-status', ...admission, async (req, res, next) => {
    const target = printerTarget(req.body);
    if (!target) {
      res.status(400).json({ error: 'Supply exactly address, integer port (1–65535), and resourcePath' });
      return;
    }
    try {
      // Failure receipts are observations too; keep their body available to the caller.
      res.json(await (adapters.printerStatus ?? readNetworkPrinterStatus)(target));
    } catch (error) { next(error); }
  });
}
