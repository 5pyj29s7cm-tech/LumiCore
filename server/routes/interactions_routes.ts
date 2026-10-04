import { Router } from "express";
import { appendUserInteraction, listUserInteractions } from "../conversation/history_repository";
import { requireAuth } from "../middleware/auth";

export function mountInteractionsRoutes(router: Router, _jwtSecret: string) {
  router.get("/interactions", requireAuth, (req, res) => {
    try {
      const mode = req.query.mode as string | undefined;
      const limit = Number.parseInt(String(req.query.limit || ''), 10);
      res.json(listUserInteractions(req.user!.uid, {
        mode, order: 'newest', limit: Math.min(limit, 300),
      }));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/interactions", requireAuth, (req, res) => {
    try {
      const { content, role } = req.body;
      res.json(appendUserInteraction(req.user!.uid, content, role));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}
