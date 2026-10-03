import { useState } from 'react';
import { motion } from 'motion/react';
import { Bell, Clock, CheckCircle2, Trash2, Plus, Calendar, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { uiMessage } from '../i18n/uiMessages';
import { useApp } from '../contexts/AppContext';
import { useApiCollection } from '../hooks/useApiCollection';
import type { Reminder } from '../../server/memory/store';

const isReminder = (value: any): value is Reminder => Boolean(value && typeof value.id === 'string' && value.id && typeof value.content === 'string' && ['pending', 'fired'].includes(value.status));

export function ReminderPanel({ t }: { t?: any }) {
  const { user, workDomain, orgConnection } = useApp();
  return user ? <ReminderEditor key={`${user.uid}:${user.role}:${workDomain}:${orgConnection?.orgId ?? ''}`} t={t} /> : null;
}

function ReminderEditor({ t }: { t?: any }) {
  const isZh = t?.langCode !== 'en';
  const { items, busy, error, sync } = useApiCollection('/api/reminders', isReminder);
  const reminders = items ?? [];
  const [newContent, setNewContent] = useState('');
  const [newDueAt, setNewDueAt] = useState('');
  const handleAdd = async () => {
    if (newContent.trim() && await sync('POST', '', { content: newContent.trim(), dueAt: newDueAt || null })) {
      setNewContent(''); setNewDueAt('');
      toast.success(uiMessage('reminder-panel.reminder-created.784ae064fc'));
    }
  };
  const handleDelete = async (id: string) => {
    if (await sync('DELETE', id)) toast.success(uiMessage('reminder-panel.deleted.e8250ae78f'));
  };
  const handleMarkFired = (id: string) => { void sync('PUT', id, { status: 'fired' }); };

  const pending = reminders.filter(r => r.status === 'pending');
  const fired = reminders.filter(r => r.status === 'fired');

  if (!items && busy) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 size={20} className="animate-spin text-white/45" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Add new reminder */}
      {error && (
        <div role="alert" className="rounded-xl border border-red-400/20 bg-red-500/8 px-3 py-2 text-xs text-red-200/80">
          {error}<button disabled={busy} onClick={() => sync()} className="ml-3 underline">{uiMessage('knowledge-base.retry.9db2a8180b')}</button>
        </div>
      )}
      <fieldset disabled={busy || !items} className="p-4 bg-white/5 rounded-2xl border border-white/5 space-y-3">
        <div className="flex items-center gap-2">
          <Bell size={14} className="text-amber-400" />
          <span className="text-xs font-black uppercase tracking-wider text-white/50">{uiMessage('reminder-panel.new-reminder.a3acd643ad')}</span>
        </div>
        <input
          value={newContent}
          onChange={e => setNewContent(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
          placeholder={uiMessage('reminder-panel.reminder-content.6535ac6e1b')}
          className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white/70 placeholder:text-white/40 focus:outline-none focus:border-amber-500/20"
        />
        <div className="flex items-center gap-2">
          <Calendar size={12} className="text-white/45" />
          <input
            type="datetime-local"
            value={newDueAt}
            onChange={e => setNewDueAt(e.target.value)}
            className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-white/50 focus:outline-none focus:border-amber-500/20"
          />
          <button
            onClick={handleAdd}
            disabled={!newContent.trim() || busy}
            className="flex items-center gap-1.5 px-4 py-2 bg-amber-500/15 border border-amber-500/25 rounded-xl text-xs font-bold text-amber-400 hover:bg-amber-500/25 disabled:opacity-30 transition-all"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            {uiMessage('reminder-panel.add.cd6f2f52ff')}
          </button>
        </div>
      </fieldset>

      {[
        { id: 'pending', list: pending, icon: Clock, label: uiMessage('reminder-panel.pending.ff1f5b13d3'), color: 'text-celestial-saturn' },
        { id: 'fired', list: fired, icon: CheckCircle2, label: uiMessage('reminder-panel.done.c5272e0498'), color: 'text-emerald-400' },
      ].filter(group => group.id === 'pending' || group.list.length).map(group => (
        <div key={group.id} className="space-y-2">
          <div className="flex items-center gap-2">
            <group.icon size={14} className={group.color} />
            <span className="text-xs font-black uppercase tracking-wider text-white/55">
              {group.label} ({group.list.length})
            </span>
          </div>
          {items && !group.list.length && <p className="text-xs text-white/40 py-4 text-center">{uiMessage('reminder-panel.no-pending-reminders.b06a20dfd7')}</p>}
          {group.list.slice(0, group.id === 'fired' ? 10 : undefined).map(r => (
            <ReminderCard key={r.id} reminder={r} busy={busy} onDelete={handleDelete} onMarkFired={handleMarkFired} isZh={isZh} />
          ))}
        </div>
      ))}
    </div>
  );
}

function ReminderCard({
  reminder,
  onDelete,
  onMarkFired,
  isZh,
  busy,
}: {
  reminder: Reminder;
  onDelete: (id: string) => void;
  onMarkFired?: (id: string) => void;
  isZh: boolean;
  busy: boolean;
}) {
  const isFired = reminder.status === 'fired';
  const hasDue = !!reminder.dueAt;
  const isOverdue = hasDue && !isFired && new Date(reminder.dueAt!) < new Date();

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className={`p-3 rounded-xl border flex items-center gap-3 group ${
        isFired
          ? 'bg-white/5 border-white/5 opacity-40'
          : isOverdue
            ? 'bg-red-500/5 border-red-500/15'
            : 'bg-white/5 border-white/5'
      }`}
    >
      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
        isFired ? 'bg-emerald-400/40' : isOverdue ? 'bg-red-400' : 'bg-amber-400'
      }`} />
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${isFired ? 'text-white/50 line-through' : 'text-white/60'}`}>
          {reminder.content}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          {hasDue && (
            <span className={`text-[12px] font-mono ${isOverdue ? 'text-red-400' : 'text-white/45'}`}>
              {new Date(reminder.dueAt!).toLocaleString(isZh ? 'zh-CN' : undefined, {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
              {isOverdue && (uiMessage('reminder-panel.overdue.51d8770a0a', (isZh) ? 'zh' : 'en'))}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {!isFired && onMarkFired && (
          <button
            disabled={busy}
            onClick={() => onMarkFired(reminder.id)}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-emerald-500/10 transition-colors"
            title={uiMessage('reminder-panel.mark-complete.0115f22552', (isZh) ? 'zh' : 'en')}
          >
            <CheckCircle2 size={12} className="text-emerald-400" />
          </button>
        )}
        <button
          disabled={busy}
          onClick={() => onDelete(reminder.id)}
          className="p-1.5 rounded-lg bg-white/5 hover:bg-red-500/10 transition-colors"
          title={uiMessage('reminder-panel.delete.5b875326d1', (isZh) ? 'zh' : 'en')}
        >
          <Trash2 size={12} className="text-red-400" />
        </button>
      </div>
    </motion.div>
  );
}
