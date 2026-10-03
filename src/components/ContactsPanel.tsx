import { useState } from 'react';
import { Users, Plus, Phone, Mail, MapPin, MessageSquare, Edit3, Trash2, Search } from 'lucide-react';
import { useT } from '../lib/useT';
import { uiMessage } from '../i18n/uiMessages';
import { useApp } from '../contexts/AppContext';
import { useApiCollection } from '../hooks/useApiCollection';
import type { Contact } from '../../server/contacts/types';

const isContact = (value: any): value is Contact => Boolean(value && typeof value.id === 'string' && value.id && typeof value.name === 'string'
  && ['phone', 'email', 'company', 'notes', 'traits', 'relationship', 'lastContacted'].every(field => value[field] == null || typeof value[field] === 'string')
  && (value.tags == null || (Array.isArray(value.tags) && value.tags.every((tag: unknown) => typeof tag === 'string'))));
type ContactDraft = Pick<Contact, 'name' | 'phone' | 'email' | 'company'> & { id?: string };
const contactFields = [
  ['name', 'contacts-panel.name.f5479c3217'], ['phone', 'contacts-panel.phone.9460aa6b4b'],
  ['email', 'contacts-panel.email.6d5db1ea96'], ['company', 'contacts-panel.company.861038ccb3'],
] as const;

export function ContactsPanel() {
  const { user } = useApp();
  return user ? <ContactsEditor key={`${user.uid}:${user.role}`} /> : null;
}

function ContactsEditor() {
  const t = useT();
  const { items: contacts, busy, error, sync } = useApiCollection('/api/contacts', isContact, 'contacts');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const save = async () => {
    if (!draft?.name.trim()) return;
    if (await sync(draft.id ? 'PUT' : 'POST', draft.id, { ...draft, name: draft.name.trim(), ...(!draft.id ? { relationship: 'friend' } : {}) })) setDraft(null);
  };
  const query = search.trim().toLowerCase();
  const visible = contacts?.filter(contact => [contact.name, contact.phone, contact.email, contact.company, contact.notes, contact.traits, ...(contact.tags ?? [])].some(value => value?.toLowerCase().includes(query))) ?? [];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      {error && <div role="alert" className="text-red-300 text-sm">{error}<button disabled={busy} onClick={() => sync()} className="ml-3 underline">{uiMessage('knowledge-base.retry.9db2a8180b')}</button></div>}
      {!contacts ? <div className="text-white/40">{busy ? 'Loading...' : ''}</div> : <>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white flex items-center gap-2"><Users size={20} className="text-blue-400" />{uiMessage('contacts-panel.contacts.cafbf1d042')}</h2>
          <button disabled={busy} onClick={() => setDraft(draft ? null : { name: '' })} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm flex items-center gap-1">
            <Plus size={14} /> {uiMessage('contacts-panel.add.cd6f2f52ff')}
          </button>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={uiMessage('contacts-panel.search-contacts.fcf6775e68')} className="w-full pl-9 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 text-sm" />
        </div>
        {draft && (
          <fieldset disabled={busy} className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
            {contactFields.map(([field, label]) => <input key={field} value={draft[field] ?? ''} onChange={e => setDraft({ ...draft, [field]: e.target.value })} placeholder={uiMessage(label)} className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 text-sm" />)}
            <div className="flex gap-2">
              <button onClick={save} disabled={!draft.name.trim()} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm">{uiMessage('contacts-panel.save.ec8e6d5819')}</button>
              <button onClick={() => setDraft(null)} className="px-4 py-2 bg-white/5 hover:bg-white/10 text-white/60 rounded-lg text-sm">{uiMessage('contacts-panel.cancel.998b9c48fb')}</button>
            </div>
          </fieldset>
        )}
        {visible.length === 0 && <div className="text-white/30 text-center py-12">{uiMessage('contacts-panel.no-contacts-yet.69426093b0')}</div>}
        <div className="space-y-2">
          {visible.map(contact => <ContactCard key={contact.id} contact={contact} busy={busy} isZh={t.langCode !== 'en'} onEdit={() => setDraft({ id: contact.id, name: contact.name, phone: contact.phone, email: contact.email, company: contact.company })} sync={sync} />)}
        </div>
      </>}
    </div>
  );
}

function ContactCard({ contact: c, busy, isZh, onEdit, sync }: {
  contact: Contact; busy: boolean; isZh: boolean; onEdit: () => void;
  sync: (method: string, id: string, body?: unknown, action?: string) => Promise<boolean>;
}) {
  const [note, setNote] = useState('');
  const record = async () => {
    if (note.trim() && await sync('POST', c.id, { note: note.trim() }, '/interact')) setNote('');
  };
  return (
    <fieldset disabled={busy} className="bg-white/5 border border-white/10 rounded-xl p-4 group">
      <div className="flex items-center justify-between">
        <div><span className="text-white font-medium">{c.name}</span>{c.relationship && <span className="text-white/30 text-xs ml-2">{c.relationship}</span>}</div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button title={uiMessage('knowledge-base-browser.edit.e9740dbb21')} onClick={onEdit} className="p-1.5 text-white/30 hover:text-blue-400"><Edit3 size={12} /></button>
          <button title={uiMessage('reminder-panel.delete.5b875326d1')} onClick={() => sync('DELETE', c.id)} className="p-1.5 text-white/30 hover:text-red-400"><Trash2 size={12} /></button>
        </div>
      </div>
      <div className="flex items-center gap-4 mt-2 text-xs text-white/40">
        {c.phone && <span className="flex items-center gap-1"><Phone size={10} />{c.phone}</span>}
        {c.email && <span className="flex items-center gap-1"><Mail size={10} />{c.email}</span>}
        {c.company && <span className="flex items-center gap-1"><MapPin size={10} />{c.company}</span>}
      </div>
      {c.lastContacted && <div className="text-white/25 text-xs mt-1">{uiMessage('contacts-panel.last-interaction.54940c42fc')}: {new Date(c.lastContacted).toLocaleDateString(isZh ? 'zh-CN' : undefined)}</div>}
      <div className="flex items-center gap-2 mt-2">
        <input value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void record(); }} placeholder={uiMessage('contacts-panel.add-interaction-note.9422abeeab')} className="flex-1 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-white/60 text-xs placeholder:text-white/20" />
        <button onClick={record} disabled={!note.trim()} className="p-1.5 text-white/30 hover:text-green-400 disabled:opacity-30"><MessageSquare size={12} /></button>
      </div>
    </fieldset>
  );
}
