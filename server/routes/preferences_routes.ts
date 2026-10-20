import { readSettingRecord, writeSetting } from "../persistence/settings_repository";
import { Router } from "express";

import { requireAuth } from "../middleware/auth";
import { broadcastPreferenceChange } from "../memory";
import { broadcastToOrg } from '../org/ws_sync';
import { getStoredOperationMode, saveStoredOperationMode, getStoredDesktopExecutionPreference, saveStoredDesktopExecutionPreference } from "../cognition/operation_mode_store";

export function mountPreferencesRoutes(router: Router, _jwtSecret: string) {
  const petPreferenceKey = (user: NonNullable<Express.Request['user']>) => (
    user.orgId ? `pet_prefs_org_${user.orgId}` : `pet_prefs_${user.uid}`
  );

  router.get("/preferences/pet", requireAuth, (req, res) => {
    try {
      const setting = readSettingRecord(petPreferenceKey(req.user!));
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
        return res.status(403).json({ error: 'Only an organization owner or administrator can change the shared organization appearance overlay.' });
      }
      const { pet, accessories } = req.body || {};
      writeSetting(petPreferenceKey(req.user!), JSON.stringify({ pet: pet || null, accessories: accessories || [] }));
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

  router.get('/preferences/desktop_execution', requireAuth, (req, res) => {
    res.json({ preference: getStoredDesktopExecutionPreference(req.user!.uid) });
  });
  router.put('/preferences/desktop_execution', requireAuth, async (req, res) => {
    const preference = req.body?.preference;
    if (preference !== 'internal' && preference !== 'external') return res.status(400).json({ error: 'Invalid desktop execution preference' });
    try {
      const saved = await saveStoredDesktopExecutionPreference(req.user!.uid, preference);
      broadcastPreferenceChange(req.user!.uid, 'desktop_execution', { preference: saved }, { domain: req.user!.orgId ? 'work' : 'personal', orgId: req.user!.orgId });
      res.json({ ok: true, preference: saved });
    } catch { res.status(500).json({ error: 'Desktop execution preference could not be saved' }); }
  });

  router.get("/preferences/operation_mode", requireAuth, (req, res) => {
    try {
      res.json({ mode: getStoredOperationMode(req.user!.uid) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put("/preferences/operation_mode", requireAuth, (req, res) => {
    try {
      const uid = req.user!.uid;
      const { mode } = req.body || {};
      if (!mode) return res.status(400).json({ error: 'mode is required' });
      const saved = saveStoredOperationMode(uid, mode);
      broadcastPreferenceChange(uid, 'operation_mode', { mode: saved.mode });
      res.json({ ok: true, mode: saved.mode });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
