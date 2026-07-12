import { Router } from "express";
import { readDB, writeDB } from "../../db_layer";
import { requireAuth } from "../middleware/auth";
import { broadcastPreferenceChange } from "../memory";
import { broadcastToOrg } from '../org/ws_sync';
import { normalizeOperationMode, parseStoredOperationMode } from "../cognition/operation_modes";
import { autonomyLevelForOperationMode, saveGateConfig } from "../autonomy/safety_gate";

export function mountPreferencesRoutes(router: Router, _jwtSecret: string) {
  const petPreferenceKey = (user: NonNullable<Express.Request['user']>) => (
    user.orgId ? `pet_prefs_org_${user.orgId}` : `pet_prefs_${user.uid}`
  );

  router.get("/preferences/pet", requireAuth, (req, res) => {
    try {
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === petPreferenceKey(req.user!));
      if (setting) {
        res.json(JSON.parse(setting.value));
      } else {
        res.json({ pet: null, accessories: [] });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put("/preferences/pet", requireAuth, (req, res) => {
    try {
      const uid = req.user!.uid;
      if (req.user!.orgId && !['owner', 'admin'].includes(String(req.user!.orgRole || ''))) {
        return res.status(403).json({ error: 'Only an organization owner or administrator can change the organization Lumi appearance.' });
      }
      const { pet, accessories } = req.body || {};
      const db = readDB();
      if (!db.settings) db.settings = [];
      const key = petPreferenceKey(req.user!);
      const value = JSON.stringify({ pet: pet || null, accessories: accessories || [] });
      const existing = db.settings.findIndex((s: any) => s.key === key);
      if (existing >= 0) {
        db.settings[existing].value = value;
      } else {
        db.settings.push({ key, value });
      }
      writeDB(db);
      const preference = { pet: pet || null, accessories: accessories || [] };
      if (req.user!.orgId) {
        broadcastToOrg(req.user!.orgId, 'preferences:changed', {
          key: 'pet',
          value: preference,
          domain: 'work',
          orgId: req.user!.orgId,
          timestamp: new Date().toISOString(),
        });
      } else {
        broadcastPreferenceChange(uid, 'pet', preference);
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/preferences/operation_mode", requireAuth, (req, res) => {
    try {
      const uid = req.user!.uid;
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === `op_mode_${uid}`);
      if (setting) {
        res.json({ mode: parseStoredOperationMode(setting.value) });
      } else {
        res.json({ mode: 'assistant' });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put("/preferences/operation_mode", requireAuth, (req, res) => {
    try {
      const uid = req.user!.uid;
      const { mode } = req.body || {};
      if (!mode) return res.status(400).json({ error: 'mode is required' });
      const normalizedMode = normalizeOperationMode(mode);
      const db = readDB();
      if (!db.settings) db.settings = [];
      const key = `op_mode_${uid}`;
      const value = JSON.stringify({ mode: normalizedMode });
      const existing = db.settings.findIndex((s: any) => s.key === key);
      if (existing >= 0) {
        db.settings[existing].value = value;
      } else {
        db.settings.push({ key, value });
      }
      writeDB(db);
      const autonomyLevel = autonomyLevelForOperationMode(normalizedMode);
      if (autonomyLevel) saveGateConfig({ autonomyLevel }, uid);
      broadcastPreferenceChange(uid, 'operation_mode', { mode: normalizedMode });
      res.json({ ok: true, autonomyLevel: autonomyLevel || undefined });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
