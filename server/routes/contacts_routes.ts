import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getContacts, searchContacts, addContact, updateContact, deleteContact, recordInteraction } from "../contacts/store";
import { RELATIONSHIP_LABELS } from "../contacts/types";
import { sendDurableMutation } from './durable_mutation';

export function mountContactsRoutes(router: Router, _jwtSecret: string) {
  // List contacts (optional ?search= query)
  router.get("/contacts", requireAuth, (req, res) => {
    try {
      const q = req.query.search as string | undefined;
      const contacts = q ? searchContacts(req.user!.uid, q) : getContacts(req.user!.uid);
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
