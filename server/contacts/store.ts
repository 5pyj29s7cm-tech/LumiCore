import { readDB, writeDB } from "../../db_layer";
import { Contact, ContactInput } from "./types";

export function getContacts(userId: string): Contact[] {
  return (readDB().contacts || []).filter((c: Contact) => c.userId === userId);
}

export function searchContacts(userId: string, query: string): Contact[] {
  const q = query.toLowerCase();
  return (readDB().contacts || []).filter((c: Contact) =>
    c.userId === userId && (
      c.name.toLowerCase().includes(q) ||
      c.tags.some(t => t.toLowerCase().includes(q)) ||
      c.notes.toLowerCase().includes(q) ||
      c.traits.toLowerCase().includes(q)
    )
  );
}

export function addContact(userId: string, input: ContactInput): Contact {
  const db = readDB();
  if (!db.contacts) db.contacts = [];
  const now = new Date().toISOString();
  const contact: Contact = {
    id: Math.random().toString(36).substring(2, 15),
    userId,
    name: input.name,
    phone: input.phone,
    email: input.email,
    company: input.company,
    relationship: input.relationship || 'other',
    tags: input.tags || [],
    notes: input.notes || '',
    traits: input.traits || '',
    preferences: input.preferences || '',
    lastContacted: input.lastContacted || null,
    createdAt: now,
    updatedAt: now,
  };
  db.contacts.push(contact);
  writeDB(db);
  return contact;
}

export function updateContact(id: string, userId: string, input: Partial<ContactInput> | ((contact: Contact) => Partial<ContactInput>)): Contact | null {
  const db = readDB();
  const idx = (db.contacts || []).findIndex((c: Contact) => c.id === id && c.userId === userId);
  if (idx === -1) return null;
  const existing = db.contacts[idx];
  if (typeof input === 'function') input = input(existing);
  const updated: Contact = {
    ...existing,
    name: input.name ?? existing.name,
    phone: input.phone ?? existing.phone,
    email: input.email ?? existing.email,
    company: input.company ?? existing.company,
    relationship: input.relationship ?? existing.relationship,
    tags: input.tags ?? existing.tags,
    notes: input.notes ?? existing.notes,
    traits: input.traits ?? existing.traits,
    preferences: input.preferences ?? existing.preferences,
    lastContacted: input.lastContacted !== undefined ? input.lastContacted : existing.lastContacted,
    updatedAt: new Date().toISOString(),
  };
  db.contacts[idx] = updated;
  writeDB(db);
  return updated;
}

export function deleteContact(id: string, userId: string): boolean {
  const db = readDB();
  const idx = (db.contacts || []).findIndex((c: Contact) => c.id === id && c.userId === userId);
  if (idx === -1) return false;
  db.contacts.splice(idx, 1);
  writeDB(db);
  return true;
}

export function recordInteraction(id: string, userId: string, note?: string): Contact | null {
  const now = new Date().toISOString();
  return updateContact(id, userId, contact => ({
    lastContacted: now,
    notes: note ? `${contact.notes}\n[${now.slice(0, 10)}] ${note}` : contact.notes,
  }));
}

export function matchContactsFromText(userId: string, text: string): Contact[] {
  return (readDB().contacts || []).filter((c: Contact) =>
    c.userId === userId && c.name && text.includes(c.name)
  );
}
