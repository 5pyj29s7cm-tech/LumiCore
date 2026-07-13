import React, { useState, useEffect } from 'react';
import { Users, Plus, Phone, Mail, MapPin, MessageSquare, Edit3, Trash2, Search } from 'lucide-react';
import { useT } from '../lib/useT';
import { uiMessage } from '../i18n/uiMessages';

interface Contact {
  id: string; name: string; phone?: string; email?: string; company?: string;
  relationship?: string; notes?: string; interactionCount?: number; lastInteraction?: string;
}

export function ContactsPanel() {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => isZh ? zh : en;
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', phone: '', email: '', company: '', relationship: 'friend', notes: '' });
  const [interactNote, setInteractNote] = useState('');

  useEffect(() => { loadContacts(); }, []);

  const loadContacts = async (query?: string) => {
    try {
      const url = query ? `/api/contacts?search=${encodeURIComponent(query)}` : '/api/contacts';
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) {
        const d = await res.json();
        setContacts(d.contacts || []);
      }
    } catch {} finally { setLoading(false); }
  };

  const saveContact = async () => {
    if (!newContact.name.trim()) return;
    try {
      const res = await fetch('/api/contacts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newContact), credentials: 'include',
      });
      if (res.ok) {
        const c = await res.json();
        setContacts(prev => [...prev, c]);
        setNewContact({ name: '', phone: '', email: '', company: '', relationship: 'friend', notes: '' });
        setShowNew(false);
      }
    } catch {}
  };

  const updateContact = async () => {
    if (!editing) return;
    try {
      const res = await fetch(`/api/contacts/${editing.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing), credentials: 'include',
      });
      if (res.ok) {
        const updated = await res.json();
        setContacts(prev => prev.map(c => c.id === updated.id ? updated : c));
        setEditing(null);
      }
    } catch {}
  };

  const deleteContact = async (id: string) => {
    try {
      await fetch(`/api/contacts/${id}`, { method: 'DELETE', credentials: 'include' });
      setContacts(prev => prev.filter(c => c.id !== id));
    } catch {}
  };

  const recordInteraction = async (id: string, note: string) => {
    if (!note.trim()) return;
    try {
      const res = await fetch(`/api/contacts/${id}/interact`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }), credentials: 'include',
      });
      if (res.ok) {
        const updated = await res.json();
        setContacts(prev => prev.map(c => c.id === updated.id ? updated : c));
        setInteractNote('');
      }
    } catch {}
  };

  if (loading) return <div className="p-6 text-white/40">Loading...</div>;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white flex items-center gap-2"><Users size={20} className="text-blue-400" />{uiMessage('contacts-panel.contacts.cafbf1d042')}</h2>
        <button onClick={() => setShowNew(!showNew)} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm flex items-center gap-1">
          <Plus size={14} /> {uiMessage('contacts-panel.add.cd6f2f52ff')}
        </button>
      </div>

      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
        <input
          value={search} onChange={e => { setSearch(e.target.value); loadContacts(e.target.value); }}
          placeholder={uiMessage('contacts-panel.search-contacts.fcf6775e68')} className="w-full pl-9 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 text-sm"
        />
      </div>

      {showNew && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
          <input value={newContact.name} onChange={e => setNewContact(p => ({ ...p, name: e.target.value }))} placeholder={uiMessage('contacts-panel.name.f5479c3217')} className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 text-sm" />
          <div className="grid grid-cols-2 gap-3">
            <input value={newContact.phone} onChange={e => setNewContact(p => ({ ...p, phone: e.target.value }))} placeholder={uiMessage('contacts-panel.phone.9460aa6b4b')} className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 text-sm" />
            <input value={newContact.email} onChange={e => setNewContact(p => ({ ...p, email: e.target.value }))} placeholder={uiMessage('contacts-panel.email.6d5db1ea96')} className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 text-sm" />
          </div>
          <input value={newContact.company} onChange={e => setNewContact(p => ({ ...p, company: e.target.value }))} placeholder={uiMessage('contacts-panel.company.861038ccb3')} className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 text-sm" />
          <div className="flex gap-2">
            <button onClick={saveContact} disabled={!newContact.name.trim()} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm">{uiMessage('contacts-panel.save.ec8e6d5819')}</button>
            <button onClick={() => setShowNew(false)} className="px-4 py-2 bg-white/5 hover:bg-white/10 text-white/60 rounded-lg text-sm">{uiMessage('contacts-panel.cancel.998b9c48fb')}</button>
          </div>
        </div>
      )}

      {contacts.length === 0 && <div className="text-white/30 text-center py-12">{uiMessage('contacts-panel.no-contacts-yet.69426093b0')}</div>}

      <div className="space-y-2">
        {contacts.map(c => (
          <div key={c.id} className="bg-white/5 border border-white/10 rounded-xl p-4 group">
            {editing?.id === c.id ? (
              <div className="space-y-3">
                <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm" />
                <input value={editing.phone || ''} onChange={e => setEditing({ ...editing, phone: e.target.value })} className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm" />
                <input value={editing.email || ''} onChange={e => setEditing({ ...editing, email: e.target.value })} className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm" />
                <div className="flex gap-2">
                  <button onClick={updateContact} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs">{uiMessage('contacts-panel.save.ec8e6d5819')}</button>
                  <button onClick={() => setEditing(null)} className="px-3 py-1.5 bg-white/5 text-white/60 rounded-lg text-xs">{uiMessage('contacts-panel.cancel.998b9c48fb')}</button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-white font-medium">{c.name}</span>
                    {c.relationship && <span className="text-white/30 text-xs ml-2">{c.relationship}</span>}
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => setEditing(c)} className="p-1.5 text-white/30 hover:text-blue-400"><Edit3 size={12} /></button>
                    <button onClick={() => deleteContact(c.id)} className="p-1.5 text-white/30 hover:text-red-400"><Trash2 size={12} /></button>
                  </div>
                </div>
                <div className="flex items-center gap-4 mt-2 text-xs text-white/40">
                  {c.phone && <span className="flex items-center gap-1"><Phone size={10} />{c.phone}</span>}
                  {c.email && <span className="flex items-center gap-1"><Mail size={10} />{c.email}</span>}
                  {c.company && <span className="flex items-center gap-1"><MapPin size={10} />{c.company}</span>}
                </div>
                {c.lastInteraction && <div className="text-white/25 text-xs mt-1">{uiMessage('contacts-panel.last-interaction.54940c42fc')}: {new Date(c.lastInteraction).toLocaleDateString(isZh ? 'zh-CN' : undefined)}</div>}
                <div className="flex items-center gap-2 mt-2">
                  <input
                    value={interactNote} onChange={e => setInteractNote(e.target.value)}
                    placeholder={uiMessage('contacts-panel.add-interaction-note.9422abeeab')} className="flex-1 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-white/60 text-xs placeholder:text-white/20"
                    onKeyDown={e => { if (e.key === 'Enter') { recordInteraction(c.id, interactNote); } }}
                  />
                  <button onClick={() => recordInteraction(c.id, interactNote)} disabled={!interactNote.trim()} className="p-1.5 text-white/30 hover:text-green-400 disabled:opacity-30">
                    <MessageSquare size={12} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
