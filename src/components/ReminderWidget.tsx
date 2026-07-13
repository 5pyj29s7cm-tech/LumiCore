import { useState, useEffect } from 'react';
import { Clock, Plus, AlertCircle, Loader2 } from 'lucide-react';
import { GlassCard } from './SharedUI';
import { toast } from 'sonner';
import { useT } from '../lib/useT';

interface Reminder {
  id: string;
  content: string;
  dueAt: string | null;
  status: 'pending' | 'fired';
}

export function ReminderWidget({ onOpenFull }: { onOpenFull: () => void }) {
  const t = useT();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [quickAdd, setQuickAdd] = useState('');
  const [adding, setAdding] = useState(false);

  const fetchReminders = async () => {
    try {
      const res = await fetch('/api/reminders', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setReminders((data || []).filter((r: Reminder) => r.status === 'pending'));
      }
    } catch {}
  };

  useEffect(() => {
    fetchReminders();
    const interval = setInterval(fetchReminders, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleQuickAdd = async () => {
    if (!quickAdd.trim()) return;
    setAdding(true);
    try {
      const res = await fetch('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: quickAdd.trim() }),
        credentials: 'include',
      });
      if (res.ok) {
        setQuickAdd('');
        toast.success(t.reminderAdded);
        fetchReminders();
      }
    } catch {}
    setAdding(false);
  };

  return (
    <GlassCard className="p-5 rounded-[2rem] space-y-3 border-white/5 bg-black/30 backdrop-blur-3xl">
      <div
        className="flex items-center justify-between cursor-pointer"
        onClick={onOpenFull}
      >
        <h4 className="text-xs font-black uppercase tracking-widest text-white/55 flex items-center gap-2">
          <Clock size={12} className="text-amber-400" />
          {t.notifReminder} {reminders.length > 0 ? `(${reminders.length})` : ''}
        </h4>
        <span className="text-white/35 text-[12px] hover:text-white/55">{t.viewAll}</span>
      </div>

      {reminders.length > 0 && (
        <div className="space-y-1.5">
          {reminders.slice(0, 3).map(r => {
            const overdue = r.dueAt && new Date(r.dueAt) < new Date();
            return (
              <div key={r.id} className="flex items-center gap-2 text-xs">
                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${overdue ? 'bg-red-400' : 'bg-amber-400/60'}`} />
                <span className={`truncate ${overdue ? 'text-red-300/80' : 'text-white/50'}`}>
                  {r.content}
                </span>
                {overdue && <AlertCircle size={10} className="text-red-400 flex-shrink-0" />}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          value={quickAdd}
          onChange={e => setQuickAdd(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleQuickAdd(); }}
          placeholder={t.quickAddReminder}
          className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-white/50 placeholder:text-white/35 focus:outline-none focus:border-amber-500/20"
        />
        <button
          onClick={handleQuickAdd}
          disabled={!quickAdd.trim() || adding}
          className="p-1.5 rounded-lg bg-white/5 border border-white/5 text-white/45 hover:text-amber-400 hover:border-amber-500/20 disabled:opacity-20 transition-all"
        >
          {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
        </button>
      </div>
    </GlassCard>
  );
}
