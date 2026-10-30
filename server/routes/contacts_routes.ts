import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getContacts, searchContacts, addContact, updateContact, deleteContact, recordInteraction } from "../contacts/store";
import { RELATIONSHIP_LABELS } from "../contacts/types";
import { sendDurableMutation } from './durable_mutation';

export function mountContactsRoutes(router: Router, _jwtSecret: string) {
  // List contacts (optional ?search= query)
  router.get("/contacts", requireAuth, (req, res) => {
    try {
      if (req.query.search !== undefined && typeof req.query.search !== 'string') return res.status(400).json({ error: 'Invalid search' });
      const q = req.query.search as string | undefined;
      const contacts = q ? searchContacts(req.user!.uid, q) : getContacts(req.user!.uid);
      if (req.query.limit !== undefined || req.query.offset !== undefined) {
        const limit = Number(req.query.limit ?? 25), offset = Number(req.query.offset ?? 0);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0
          || (req.query.limit !== undefined && typeof req.query.limit !== 'string') || (req.query.offset !== undefined && typeof req.query.offset !== 'string')) return res.status(400).json({ error: 'Invalid pagination' });
        return res.json({ contacts: contacts.slice(offset, offset + limit), total: contacts.length, limit, offset, relationshipLabels: RELATIONSHIP_LABELS });
      }
      res.json({ contacts, relationshipLabels: RELATIONSHIP_LABELS });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create contact
  router.post("/contacts", requireAuth, async (req, res) => {
    try {
      const contact = addContact(req.user!.uid, req.body);
      return await sendDurableMutation(req, res, contact, undefined, { retryable: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update contact
  router.put("/contacts/:id", requireAuth, async (req, res) => {
    try {
      const contact = updateContact(req.params.id, req.user!.uid, req.body);
      if (!contact) return res.status(404).json({ error: "Contact not found" });
      return await sendDurableMutation(req, res, contact);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete contact
  router.delete("/contacts/:id", requireAuth, async (req, res) => {
    try {
      const ok = deleteContact(req.params.id, req.user!.uid);
      if (!ok) return res.status(404).json({ error: "Contact not found" });
      return await sendDurableMutation(req, res, { success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Record interaction
  router.post("/contacts/:id/interact", requireAuth, async (req, res) => {
    try {
      const contact = recordInteraction(req.params.id, req.user!.uid, req.body.note);
      if (!contact) return res.status(404).json({ error: "Contact not found" });
      return await sendDurableMutation(req, res, contact, undefined, { retryable: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
