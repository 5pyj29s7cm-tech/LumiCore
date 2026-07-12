import { Router } from "express";
import { deviceRegistry } from "../devices";
import { optionalAuth } from "../middleware/auth";
import { readDB, writeDB } from "../../db_layer";

function pairedKey(userId: string): string {
  return `paired_devices_${userId || 'local'}`;
}

function getPairedDeviceIds(userId: string): string[] {
  try {
    const row = (readDB().settings || []).find((s: any) => s.key === pairedKey(userId));
    const value = row?.value ? JSON.parse(row.value) : [];
    return Array.isArray(value) ? value.filter((id: any) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function savePairedDeviceIds(userId: string, ids: string[]): string[] {
  const db = readDB();
  if (!db.settings) db.settings = [];
  const unique = [...new Set(ids.filter(Boolean))];
  const key = pairedKey(userId);
  const idx = db.settings.findIndex((s: any) => s.key === key);
  const value = JSON.stringify(unique);
  if (idx >= 0) db.settings[idx].value = value;
  else db.settings.push({ key, value });
  writeDB(db);
  return unique;
}

export function mountDeviceRoutes(router: Router, _jwtSecret: string) {
  router.post("/devices/pair", optionalAuth, (req, res) => {
    const { deviceId } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    const userId = req.user?.uid || 'local';
    const pairedDeviceIds = savePairedDeviceIds(userId, [...getPairedDeviceIds(userId), String(deviceId)]);
    res.json({ success: true, paired: deviceId, pairedDeviceIds, timestamp: new Date().toISOString() });
  });

  router.delete("/devices/pair/:deviceId", optionalAuth, (req, res) => {
    const userId = req.user?.uid || 'local';
    const pairedDeviceIds = savePairedDeviceIds(
      userId,
      getPairedDeviceIds(userId).filter(id => id !== req.params.deviceId),
    );
    res.json({ success: true, unpaired: req.params.deviceId, pairedDeviceIds, timestamp: new Date().toISOString() });
  });

  router.get("/devices", optionalAuth, (req, res) => {
    const userId = req.user?.uid || 'local';
    const scope = req.user?.orgId
      ? { domain: 'work' as const, orgId: req.user.orgId }
      : { domain: 'personal' as const, orgId: '' };
    const userDevices = userId ? deviceRegistry.getUserDevices(userId, scope) : [];
    const mcpDevices = deviceRegistry.getMcpDevices();
    const pairedDeviceIds = getPairedDeviceIds(userId);
    const pairedSet = new Set(pairedDeviceIds);
    const devices = [...userDevices, ...mcpDevices].map(device => ({
      ...device,
      paired: pairedSet.has(device.id),
    }));
    const sensory = userId ? deviceRegistry.getSensoryContext(userId, scope) : { hasAudio: false, hasVideo: false, hasSpatial: false, hasHaptic: false, hasHolographic: false, activeDeviceTypes: [], deviceCount: mcpDevices.length };
    res.json({ devices, pairedDeviceIds, sensoryContext: sensory });
  });
}
