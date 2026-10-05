import { Router, Request, Response } from "express";
import { readDatabaseTables, commitDatabaseTables } from "../../db_layer";
import { requireAuth } from "../middleware/auth";
import { sendDurableMutation } from './durable_mutation';

export interface NotificationRecord {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
}

function ensureNotifications(db: any) {
  if (!db.notifications) db.notifications = [];
}

export function pushNotification(userId: string, item: {
  type: string; title: string; message: string;
}) {
  try {
    const db = readDatabaseTables(["notifications"]);
    ensureNotifications(db);
    (db.notifications as NotificationRecord[]).push({
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      userId,
      type: item.type,
      title: item.title,
      message: item.message,
      timestamp: Date.now(),
      read: false,
    });
    // Keep last 200 per user
    const userNotifs = db.notifications.filter((n: NotificationRecord) => n.userId === userId);
    if (userNotifs.length > 200) {
      const toRemove = userNotifs.slice(0, userNotifs.length - 200).map((n: NotificationRecord) => n.id);
      db.notifications = db.notifications.filter((n: NotificationRecord) => !toRemove.includes(n.id));
    }
    commitDatabaseTables(db);
  } catch {}
}

export function mountNotificationRoutes(router: Router) {
  router.get("/notifications", requireAuth, (req: Request, res: Response) => {
    try {
      const db = readDatabaseTables(["notifications"]);
      ensureNotifications(db);
      const userNotifs = (db.notifications as NotificationRecord[])
        .filter(n => n.userId === req.user!.uid)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 100);
      res.json({ notifications: userNotifs, unreadCount: userNotifs.filter(n => !n.read).length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const update = (clear: boolean) => async (req: Request, res: Response) => {
    try {
      const db = readDatabaseTables(["notifications"]);
      ensureNotifications(db);
      const owned = (db.notifications as NotificationRecord[]).filter(n => n.userId === req.user!.uid);
      const marked = owned.filter(n => !n.read).length;
      if (clear) db.notifications = (db.notifications as NotificationRecord[]).filter(n => n.userId !== req.user!.uid);
      else owned.forEach(n => { n.read = true; });
      commitDatabaseTables(db);
      return await sendDurableMutation(req, res, { success: true, ids: owned.map(n => n.id), ...(clear ? {} : { marked }) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };
  router.post("/notifications/read-all", requireAuth, update(false));
  router.delete("/notifications", requireAuth, update(true));
}
