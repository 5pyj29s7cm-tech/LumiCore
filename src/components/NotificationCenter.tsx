import { motion, AnimatePresence } from 'motion/react';
import { Bell, CheckCheck, Trash2, Info, AlertTriangle, CheckCircle, Zap, MessageSquare } from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { useT } from '../lib/useT';
import { useState } from 'react';

const ICONS: Record<string, React.ReactNode> = {
  info: <Info size={14} className="text-blue-400" />,
  warning: <AlertTriangle size={14} className="text-amber-400" />,
  success: <CheckCircle size={14} className="text-emerald-400" />,
  system: <Zap size={14} className="text-violet-400" />,
};

export function NotificationCenter({ onChatMessage }: { onChatMessage?: (item: any) => void }) {
  const { notifications, markAllNotificationsRead, clearNotifications } = useApp();
  const t = useT();
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const handleClick = (item: any) => {
    setDismissedIds(prev => new Set([...prev, item.id]));
    onChatMessage?.(item);
  };

  // Filter: show all in-memory notifications, excluding dismissed
  const visibleItems = notifications
    .filter(n => !dismissedIds.has(n.id))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  return (
    <div className="flex h-full flex-col overflow-hidden bg-zinc-950/55 text-white backdrop-blur-xl">
      <div className="flex items-center gap-3 border-b border-white/[0.08] px-6 py-4">
        <div className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-amber-300/15 bg-amber-500/15">
          <Bell size={20} className="text-amber-400" />
          {visibleItems.filter(n => !n.read).length > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-xs font-black">
              {visibleItems.filter(n => !n.read).length > 9 ? '9+' : visibleItems.filter(n => !n.read).length}
            </span>
          )}
        </div>
        <div>
          <h2 className="text-sm font-bold text-white/90">{t.ncTitle || 'Notification Center'}</h2>
          <p className="text-xs text-white/55">
            {visibleItems.length > 0 ? visibleItems.filter(n => !n.read).length + ' ' + (t.unreadCount || 'unread') : (t.allCaughtUp || 'All caught up')}
          </p>
        </div>
        <div className="flex-1" />
        {visibleItems.length > 0 && (
          <div className="flex gap-2">
            <button
              onClick={markAllNotificationsRead}
              className="lumi-icon-button h-8 w-8 rounded-lg"
            >
              <CheckCheck size={14} />
            </button>
            <button
              onClick={clearNotifications}
              className="lumi-icon-button h-8 w-8 rounded-lg hover:text-red-300"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      <div className="custom-scrollbar flex-1 overflow-y-auto p-4">
        {visibleItems.length === 0 ? (
          <div className="lumi-panel flex flex-col items-center justify-center py-16 text-white/40">
            <Bell size={48} className="mb-4 opacity-20" />
            <span className="text-xs font-bold uppercase tracking-widest">{t.ncEmpty || 'No notifications'}</span>
            <span className="text-xs mt-1">{t.systemEventsHere || 'System events and alerts will appear here'}</span>
          </div>
        ) : (
          <div className="space-y-1">
            <AnimatePresence>
              {visibleItems.map(n => (
                <motion.div
                  key={n.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, scale: 0.9, x: 20 }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter') handleClick(n); }}
                  onClick={() => handleClick(n)}
                  className={`group flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 transition-colors hover:border-white/[0.1] hover:bg-white/[0.07] ${
                    n.read ? 'border-transparent bg-white/[0.02]' : 'border-white/[0.08] bg-white/[0.05]'
                  }`}
                >
                  <div className="mt-0.5 flex-shrink-0 rounded-lg border border-white/[0.06] bg-white/[0.04] p-1.5">
                    {ICONS[n.type] || ICONS.info}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-white/80">{n.title}</span>
                      <span className="text-xs text-white/45">{new Date(n.timestamp).toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-white/40 mt-0.5">{n.message}</p>
                  </div>
                  <div className="flex-shrink-0">
                    {!n.read ? (
                      <div className="w-2 h-2 rounded-full bg-blue-400 mt-1.5" />
                    ) : (
                      <MessageSquare size={12} className="text-white/35 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
