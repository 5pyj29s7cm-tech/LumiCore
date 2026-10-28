import { Router } from "express";
import { mountExternalDeviceRoutes } from './external_device_routes';
import {
  deviceRegistry,
  projectPublicDevice,
  projectRestrictedNativeDeviceEvidence,
} from "../devices";
import type { DeviceScope } from "../devices";
import { DESKTOP_SESSION_HEADER, resolveDesktopSession } from "../config/desktop_bootstrap";
import { requireAdmin, requireAuth, requireLocalRequest } from "../middleware/auth";

export function mountDeviceRoutes(router: Router, _jwtSecret: string) {
  mountExternalDeviceRoutes(router);
  const requestScope = (req: any): DeviceScope => req.user?.orgId
    ? { domain: 'work', orgId: req.user.orgId }
    : { domain: 'personal', orgId: '' };

  // Formal acceptance needs an exact registry-bound Tauri identity, but that
  // process metadata must never ride the ordinary device API.  This separate
  // surface requires all four boundaries: authenticated user, system admin,
  // loopback transport, and a live desktop capability bound to the same uid.
  router.get(
    "/devices/native-client-evidence",
    requireAuth,
    requireAdmin,
    requireLocalRequest,
    (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const session = resolveDesktopSession(
        req.headers[DESKTOP_SESSION_HEADER],
        req.user!.uid,
      );
      if (!session) {
        return res.status(403).json({ error: 'A valid local desktop session proof is required' });
      }
      const scope = requestScope(req);
      const devices = deviceRegistry.getUserDevices(req.user!.uid, scope)
        .map(projectRestrictedNativeDeviceEvidence)
        .filter((device): device is NonNullable<typeof device> => device !== null);
      return res.json({ devices });
    },
  );

  router.get("/devices", requireAuth, (req, res) => {
    const userId = req.user!.uid;
    const scope = requestScope(req);
    // MCP devices are returned only when their registered owner and domain
    // match this exact request scope; the global MCP list is never merged in.
    const userDevices = deviceRegistry.getUserDevices(userId, scope);
    const devices = userDevices.map(projectPublicDevice);
    const sensory = deviceRegistry.getSensoryContext(userId, scope);
    res.json({ devices, sensoryContext: sensory });
  });
}
