import { Router } from "express";
import {
  deviceRegistry,
  projectPublicDevice,
  projectRestrictedNativeDeviceEvidence,
} from "../devices";
import type { DeviceScope } from "../devices";
import { DESKTOP_SESSION_HEADER, resolveDesktopSession } from "../config/desktop_bootstrap";
import { requireAdmin, requireAuth, requireLocalRequest } from "../middleware/auth";
import { readDB, writeDB } from "../../db_layer";

function pairedKey(userId: string, scope: DeviceScope): string {
  const scopeKey = scope.domain === 'work' ? `work_${scope.orgId}` : 'personal';
  return `paired_devices_${userId}_${scopeKey}`;
}

function getPairedDeviceIds(userId: string, scope: DeviceScope): string[] {
  try {
    const row = (readDB().settings || []).find((s: any) => s.key === pairedKey(userId, scope));
    const value = row?.value ? JSON.parse(row.value) : [];
    return Array.isArray(value) ? value.filter((id: any) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function savePairedDeviceIds(userId: string, scope: DeviceScope, ids: string[]): string[] {
  const db = readDB();
  if (!db.settings) db.settings = [];
  const unique = [...new Set(ids.filter(Boolean))];
  const key = pairedKey(userId, scope);
  const idx = db.settings.findIndex((s: any) => s.key === key);
  const value = JSON.stringify(unique);
  if (idx >= 0) db.settings[idx].value = value;
  else db.settings.push({ key, value });
  writeDB(db);
  return unique;
}

export function mountDeviceRoutes(router: Router, _jwtSecret: string) {
  const requestScope = (req: any): DeviceScope => req.user?.orgId
    ? { domain: 'work', orgId: req.user.orgId }
    : { domain: 'personal', orgId: '' };

  router.post("/devices/pair", requireAuth, (req, res) => {
    const { deviceId } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    const normalizedDeviceId = String(deviceId).trim();
    if (!normalizedDeviceId || normalizedDeviceId.length > 512) {
      return res.status(400).json({ error: 'deviceId must be 512 characters or fewer' });
    }
    const userId = req.user!.uid;
    const scope = requestScope(req);
    const visible = deviceRegistry.getUserDevices(userId, scope);
    if (!visible.some(device => device.id === normalizedDeviceId)) {
      return res.status(404).json({ error: 'Device not found in the active user and domain scope' });
    }
    const pairedDeviceIds = savePairedDeviceIds(
      userId,
      scope,
      [...getPairedDeviceIds(userId, scope), normalizedDeviceId],
    );
    res.json({ success: true, paired: normalizedDeviceId, pairedDeviceIds, timestamp: new Date().toISOString() });
  });

  router.delete("/devices/pair/:deviceId", requireAuth, (req, res) => {
    const userId = req.user!.uid;
    const scope = requestScope(req);
    const current = getPairedDeviceIds(userId, scope);
    if (!current.includes(req.params.deviceId)) {
      return res.status(404).json({ error: 'Paired device not found in the active user and domain scope' });
    }
    const pairedDeviceIds = savePairedDeviceIds(
      userId,
      scope,
      current.filter(id => id !== req.params.deviceId),
    );
    res.json({ success: true, unpaired: req.params.deviceId, pairedDeviceIds, timestamp: new Date().toISOString() });
  });

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
    const pairedDeviceIds = getPairedDeviceIds(userId, scope);
    const pairedSet = new Set(pairedDeviceIds);
    const devices = userDevices.map(device => ({
      ...projectPublicDevice(device),
      paired: pairedSet.has(device.id),
    }));
    const sensory = deviceRegistry.getSensoryContext(userId, scope);
    res.json({ devices, pairedDeviceIds, sensoryContext: sensory });
  });
}
