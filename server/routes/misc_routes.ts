// Misc routes that didn't fit into other modules: founder vision, feedback, admin config
import { Router } from "express";
import { flushDBOrThrow, readDB, writeDB } from "../../db_layer";
import { requireAdmin, requireAuth, requireLocalRequest } from "../middleware/auth";

export function mountMiscRoutes(router: Router, _jwtSecret: string, _llm: {
  getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any;
}) {
  // ── Founder Vision ──
  router.get("/founder/vision", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
    try {
      const db = readDB();
      res.json({ vision: db.founderVision || '' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/founder/vision", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
    try {
      const { vision } = req.body || {};
      if (typeof vision !== 'string') return res.status(400).json({ error: 'vision is required' });
      if (vision.length > 20_000) return res.status(400).json({ error: 'vision must be 20000 characters or fewer' });
      const updatedAt = new Date().toISOString();
      const db = readDB();
      db.founderVision = vision;
      db.founderVisionUpdatedAt = updatedAt;
      writeDB(db);
      await flushDBOrThrow();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Feedback ──
  router.post("/feedback", requireAuth, async (req, res) => {
    try {
      const { email, message, type, contact, position } = req.body || {};
      const normalized = {
        email: String(email || '').trim(),
        message: String(message || '').trim(),
        type: String(type || 'general').trim(),
        contact: String(contact || '').trim(),
        position: String(position || '').trim(),
      };
      if (!normalized.message) return res.status(400).json({ error: 'message is required' });
      if (normalized.email.length > 320) return res.status(400).json({ error: 'email must be 320 characters or fewer' });
      if (normalized.message.length > 4_000) return res.status(400).json({ error: 'message must be 4000 characters or fewer' });
      if (normalized.type.length > 64) return res.status(400).json({ error: 'type must be 64 characters or fewer' });
      if (normalized.contact.length > 500) return res.status(400).json({ error: 'contact must be 500 characters or fewer' });
      if (normalized.position.length > 500) return res.status(400).json({ error: 'position must be 500 characters or fewer' });
      const db = readDB();
      if (!db.feedback) db.feedback = [];
      db.feedback.push({
        id: Math.random().toString(36).substring(2, 15),
        ...normalized,
        userId: req.user!.uid,
        createdAt: new Date().toISOString(),
      });
      writeDB(db);
      await flushDBOrThrow();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admin Config ──
  router.get("/admin/config", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
    try {
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === 'admin_config');
      const config = setting ? JSON.parse(setting.value) : {};
      res.json({ adminEmail: config.adminEmail || '' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/admin/config", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
    try {
      const { adminEmail } = req.body || {};
      if (typeof adminEmail !== 'string' || adminEmail.length > 320) {
        return res.status(400).json({ error: 'adminEmail must be a string of 320 characters or fewer' });
      }
      const db = readDB();
      if (!db.settings) db.settings = [];
      const key = 'admin_config';
      const value = JSON.stringify({ adminEmail: adminEmail || '' });
      const existing = db.settings.findIndex((s: any) => s.key === key);
      if (existing >= 0) {
        db.settings[existing].value = value;
      } else {
        db.settings.push({ key, value });
      }
      writeDB(db);
      await flushDBOrThrow();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

}
