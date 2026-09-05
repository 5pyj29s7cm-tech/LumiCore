import type { Request, Router } from 'express';
import { requireAuth, requireAdmin, requireLocalRequest } from '../middleware/auth';
import { getConfiguredPrivacyMode, getPrivacyMode, isPrivacyModeLocked, savePrivacyMode } from '../config/privacy';

function canManage(req: Request): boolean {
  const address = String(req.socket.remoteAddress || '').toLowerCase();
  const local = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
  // A loopback reverse proxy must not turn a remote request into a local admin.
  const forwarded = ['forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']
    .some(header => req.headers[header] !== undefined);
  return local && !forwarded && req.user?.role === 'admin' && !req.user.orgId;
}

function state(req: Request) {
  const mode = getPrivacyMode();
  const locked = isPrivacyModeLocked();
  const configuredMode = locked ? 'strict' : getConfiguredPrivacyMode();
  return { mode, configuredMode, locked, canManage: canManage(req), restartRequired: mode !== configuredMode };
}

export function mountPrivacyRoutes(router: Router): void {
  router.get('/privacy', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(state(req)); }
    catch { res.status(500).json({ error: 'Privacy settings could not be read.' }); }
  });
  router.put('/privacy', requireAuth, requireAdmin, requireLocalRequest, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!canManage(req)) {
      res.status(403).json({ error: 'Only a local personal administrator can change privacy mode.' });
      return;
    }
    if (isPrivacyModeLocked()) {
      res.status(409).json({ error: 'Privacy mode is enforced by the environment.' });
      return;
    }
    if (!req.body || !['strict', 'standard'].includes(req.body.mode)
      || Object.keys(req.body).some(key => key !== 'mode')) {
      res.status(400).json({ error: 'Expected a strict or standard privacy mode.' });
      return;
    }
    try { savePrivacyMode(req.body.mode); res.json(state(req)); }
    catch { res.status(500).json({ error: 'Privacy settings were not saved.' }); }
  });
}
