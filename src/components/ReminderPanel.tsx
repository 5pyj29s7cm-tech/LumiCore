import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Bell, Clock, CheckCircle2, Trash2, Plus, Calendar, AlertCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { uiMessage } from '../i18n/uiMessages';

interface Reminder {
  id: string;
  userId: string;
  content: string;
  dueAt: string | null;
  status: 'pending' | 'fired';
  sourceInteractionId: string;
  createdAt: string;
  firedAt?: string | null;
}

export function ReminderPanel({ t }: { t?: any }) {
  const isZh = t?.langCode !== 'en';
  const ui = useCallback((zh: string, en: string) => isZh ? zh : en, [isZh]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [newContent, setNewContent] = useState('');
  const [newDueAt, setNewDueAt] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  const fetchReminders = useCallback(async () => {
    try {
      setError('');
      const res = await fetch('/api/reminders', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('reminder-panel.failed-to-load-reminders.0092eaf0c9'));
      setReminders(Array.isArray(data) ? data : []);
    } catch (err: any) {
      const message = err?.message || uiMessage('reminder-panel.failed-to-load-reminders.0092eaf0c9');
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [ui]);

  useEffect(() => { fetchReminders(); }, [fetchReminders]);

  const handleAdd = async () => {
    if (!newContent.trim()) return;
    setAdding(true);
    try {
      const res = await fetch('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent.trim(), dueAt: newDueAt || null }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('reminder-panel.failed-to-create-reminder.880d5a66e2'));
      setNewContent('');
      setNewDueAt('');
      toast.success(uiMessage('reminder-panel.reminder-created.784ae064fc'));
      fetchReminders();
    } catch (err: any) {
      toast.error(err?.message || uiMessage('reminder-panel.failed-to-create-reminder.880d5a66e2'));
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/reminders/${id}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('reminder-panel.failed-to-delete-reminder.0167264b7f'));
      setReminders(prev => prev.filter(r => r.id !== id));
      toast.success(uiMessage('reminder-panel.deleted.e8250ae78f'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('reminder-panel.failed-to-delete-reminder.0167264b7f'));
    }
  };

  const handleMarkFired = async (id: string) => {
    try {
      const res = await fetch(`/api/reminders/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'fired' }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('reminder-panel.failed-to-update-reminder.73f8821573'));
      fetchReminders();
    } catch (err: any) {
      toast.error(err?.message || uiMessage('reminder-panel.failed-to-update-reminder.73f8821573'));
    }
  };

  const pending = reminders.filter(r => r.status === 'pending');
  const fired = reminders.filter(r => r.status === 'fired');

  if (loading) {
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
        <div className="rounded-xl border border-red-400/20 bg-red-500/8 px-3 py-2 text-xs text-red-200/80">
          {error}
        </div>
      )}
      <div className="p-4 bg-white/5 rounded-2xl border border-white/5 space-y-3">
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
            disabled={!newContent.trim() || adding}
            className="flex items-center gap-1.5 px-4 py-2 bg-amber-500/15 border border-amber-500/25 rounded-xl text-xs font-bold text-amber-400 hover:bg-amber-500/25 disabled:opacity-30 transition-all"
          >
            {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            {uiMessage('reminder-panel.add.cd6f2f52ff')}
          </button>
        </div>
      </div>

      {/* Pending reminders */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-celestial-saturn" />
          <span className="text-xs font-black uppercase tracking-wider text-white/55">
            {uiMessage('reminder-panel.pending.ff1f5b13d3')} ({pending.length})
          </span>
        </div>
        {pending.length === 0 ? (
          <p className="text-xs text-white/40 py-4 text-center">{uiMessage('reminder-panel.no-pending-reminders.b06a20dfd7')}</p>
        ) : (
          pending.map(r => (
            <ReminderCard key={r.id} reminder={r} onDelete={handleDelete} onMarkFired={handleMarkFired} isZh={isZh} />
          ))
        )}
      </div>

      {/* Recently fired */}
      {fired.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-emerald-400" />
            <span className="text-xs font-black uppercase tracking-wider text-white/45">
              {uiMessage('reminder-panel.done.c5272e0498')} ({fired.length})
            </span>
          </div>
          {fired.slice(0, 10).map(r => (
            <ReminderCard key={r.id} reminder={r} onDelete={handleDelete} isZh={isZh} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReminderCard({
  reminder,
  onDelete,
  onMarkFired,
  isZh,
}: {
  reminder: Reminder;
  onDelete: (id: string) => void;
  onMarkFired?: (id: string) => void;
  isZh: boolean;
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
            onClick={() => onMarkFired(reminder.id)}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-emerald-500/10 transition-colors"
            title={uiMessage('reminder-panel.mark-complete.0115f22552', (isZh) ? 'zh' : 'en')}
          >
            <CheckCircle2 size={12} className="text-emerald-400" />
          </button>
        )}
        <button
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
