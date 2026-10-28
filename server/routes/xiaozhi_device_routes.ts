import type { NextFunction, Request, Response, Router } from 'express';
import { requireAdmin, requireAuth, requireLocalRequest } from '../middleware/auth';
import { DESKTOP_SESSION_HEADER, resolveDesktopSession } from '../config/desktop_bootstrap';
import { getPhysicalLanInterfaces } from '../devices/lan_discovery';
import { xiaozhiDeviceService, type XiaozhiDeviceService } from '../devices/xiaozhi_service';

type Service = Pick<XiaozhiDeviceService, 'list' | 'createPairing' | 'getPairingConfiguration' | 'revoke'>;
function localSession(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', 'no-store');
  if (!resolveDesktopSession(req.headers[DESKTOP_SESSION_HEADER], req.user!.uid)) {
    res.status(403).json({ error: 'A valid local control-center session is required.' }); return;
  }
  next();
}
function report(error: unknown, res: Response) {
  const code = Number((error as { statusCode?: unknown })?.statusCode);
  res.status(Number.isInteger(code) && code >= 400 && code <= 599 ? code : 503)
    .json({ error: error instanceof Error ? error.message : 'The local device gateway is unavailable.' });
}
export function mountXiaozhiDeviceRoutes(router: Router, service: Service = xiaozhiDeviceService,
  interfaces: typeof getPhysicalLanInterfaces = getPhysicalLanInterfaces) {
  const admission = [requireAuth, requireAdmin, requireLocalRequest, localSession];
  router.get('/devices/xiaozhi', ...admission, async (req, res) => {
    try { res.json(await service.list(req.user!.uid)); } catch (error) { report(error, res); }
  });
  router.get('/devices/xiaozhi/interfaces', ...admission, async (_req, res) => {
    try { res.json({ interfaces: await interfaces() }); } catch (error) { report(error, res); }
  });
  router.post('/devices/xiaozhi/pairings', ...admission, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['deviceId', 'clientId', 'localAddress'].includes(key))
      || typeof body.deviceId !== 'string' || !body.deviceId.trim() || body.deviceId.length > 256
      || typeof body.localAddress !== 'string' || !body.localAddress
      || (body.clientId !== undefined && (typeof body.clientId !== 'string' || !body.clientId.trim() || body.clientId.length > 256))) {
      res.status(400).json({ error: 'Supply the device identity and an observed physical LAN address.' }); return;
    }
    try {
      const { mcpUrl: _privateBridge, ...configuration } = await service.createPairing(req.user!.uid, body);
      res.status(201).json(configuration);
    } catch (error) { report(error, res); }
  });
  router.get('/devices/xiaozhi/pairings/:id/configuration', ...admission, async (req, res) => {
    try {
      const { mcpUrl: _privateBridge, ...configuration } = await service.getPairingConfiguration(String(req.params.id), req.user!.uid);
      res.json(configuration);
    } catch (error) { report(error, res); }
  });
  router.delete('/devices/xiaozhi/pairings/:id', ...admission, async (req, res) => {
    try { await service.revoke(String(req.params.id), req.user!.uid); res.json({ ok: true }); }
    catch (error) { report(error, res); }
  });
}
