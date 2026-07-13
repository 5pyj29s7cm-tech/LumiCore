import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Zap, CheckCircle, XCircle, Clock, Monitor, Terminal, Search, ChevronDown, RefreshCw, X } from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';
import { toast } from 'sonner';
import { useT } from '@/lib/useT';
import { uiMessage } from '../i18n/uiMessages';

interface AutoTask {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  source: string;
  planId?: string;
  priority: number;
  mode: 'desktop' | 'terminal' | 'analysis';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
  toolCallsCount?: number;
  tokensUsed?: number;
}

type FilterMode = 'all' | 'running' | 'completed' | 'failed' | 'cancelled' | 'desktop' | 'terminal' | 'analysis';

export function AutonomousFeed({ expanded: initialExpanded }: { expanded?: boolean }) {
  const socket = useSocket();
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [tasks, setTasks] = useState<AutoTask[]>([]);
  const [queue, setQueue] = useState<AutoTask[]>([]);
  const [history, setHistory] = useState<AutoTask[]>([]);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [expanded, setExpanded] = useState(initialExpanded ?? false);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [cancellingIds, setCancellingIds] = useState<string[]>([]);

  const loadTasks = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [queueRes, historyRes] = await Promise.all([
        fetch('/api/autonomy/queue', { credentials: 'include' }),
        fetch('/api/autonomy/history?limit=50', { credentials: 'include' }),
      ]);
      const queueData = await queueRes.json().catch(() => ({}));
      const historyData = await historyRes.json().catch(() => ({}));
      if (!queueRes.ok) throw new Error(queueData.error || 'Failed to load autonomous queue');
      if (!historyRes.ok) throw new Error(historyData.error || 'Failed to load autonomous history');
      setQueue(queueData.queue || []);
      setHistory(historyData.tasks || []);
    } catch (err: any) {
      const message = err?.message || 'Failed to load autonomous work';
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadTasks(); }, []);

  useEffect(() => {
    if (!socket) return;

    const onStarted = (data: { taskId: string; title: string; mode: string; timestamp: string }) => {
      const mode: AutoTask['mode'] = (data.mode === 'desktop' || data.mode === 'terminal' || data.mode === 'analysis') ? data.mode : 'analysis';
      const nextTask: AutoTask = {
        id: data.taskId, title: data.title, description: '',
        mode,
        status: 'running' as const, source: 'curiosity', priority: 5, createdAt: data.timestamp,
      };
      setQueue(prev => [nextTask, ...prev.filter(t => t.id !== data.taskId)]);
      setTasks(prev => [nextTask, ...prev.filter(t => t.id !== data.taskId)]);
    };

    const onCompleted = (data: { taskId: string; title: string; result: string; toolCallsCount: number; tokensUsed: number; timestamp: string }) => {
      setTasks(prev => prev.map(t => t.id === data.taskId ? {
        ...t, status: 'completed' as const, result: data.result, toolCallsCount: data.toolCallsCount, tokensUsed: data.tokensUsed, completedAt: data.timestamp,
      } : t));
      setQueue(prev => prev.filter(t => t.id !== data.taskId));
      const newHistoryItem: AutoTask = {
        id: data.taskId, title: data.title, description: '', mode: 'analysis',
        status: 'completed', source: 'curiosity', priority: 5, createdAt: data.timestamp,
        result: data.result, toolCallsCount: data.toolCallsCount, tokensUsed: data.tokensUsed,
        completedAt: data.timestamp,
      };
      setHistory(prev => [newHistoryItem, ...prev].slice(0, 50));
      toast.success(`Autonomous: ${data.title.slice(0, 60)}`);
    };

    const onFailed = (data: { taskId: string; title: string; error: string; timestamp: string }) => {
      setTasks(prev => prev.map(t => t.id === data.taskId ? { ...t, status: 'failed' as const, error: data.error } : t));
      setQueue(prev => prev.filter(t => t.id !== data.taskId));
      const failedTask: AutoTask = {
        id: data.taskId,
        title: data.title,
        description: '',
        status: 'failed',
        source: 'curiosity',
        priority: 5,
        mode: 'analysis',
        createdAt: data.timestamp,
        completedAt: data.timestamp,
        error: data.error,
      };
      setHistory(prev => [failedTask, ...prev].slice(0, 50));
      toast.error(`Autonomous failed: ${data.title.slice(0, 50)}`);
    };

    socket.on('autonomous:task_started', onStarted);
    socket.on('autonomous:task_completed', onCompleted);
    socket.on('autonomous:task_failed', onFailed);

    return () => {
      socket.off('autonomous:task_started', onStarted);
      socket.off('autonomous:task_completed', onCompleted);
      socket.off('autonomous:task_failed', onFailed);
    };
  }, [socket]);

  const cancelTask = async (task: AutoTask) => {
    setCancellingIds(prev => prev.includes(task.id) ? prev : [...prev, task.id]);
    try {
      const res = await fetch(`/api/autonomy/tasks/${task.id}/cancel`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to cancel task');
      const cancelledTask = { ...task, status: 'cancelled' as const, completedAt: new Date().toISOString() };
      setQueue(prev => prev.filter(t => t.id !== task.id));
      setTasks(prev => prev.filter(t => t.id !== task.id));
      setHistory(prev => [cancelledTask, ...prev.filter(t => t.id !== task.id)].slice(0, 50));
      toast.success(uiMessage('autonomous-feed.autonomous-task-cancelled.3452aa8efe'));
    } catch (err: any) {
      toast.error(err?.message || 'Failed to cancel task');
    } finally {
      setCancellingIds(prev => prev.filter(id => id !== task.id));
    }
  };

  const liveItems = [...queue, ...tasks.filter(t => !queue.some(q => q.id === t.id) && (t.status === 'pending' || t.status === 'running'))];
  const allItems = [...liveItems, ...history.filter(t => !liveItems.some(live => live.id === t.id))].filter(t => {
    switch (filter) {
      case 'completed': return t.status === 'completed';
      case 'failed': return t.status === 'failed';
      case 'cancelled': return t.status === 'cancelled';
      case 'running': return t.status === 'pending' || t.status === 'running';
      case 'desktop': return t.mode === 'desktop';
      case 'terminal': return t.mode === 'terminal';
      case 'analysis': return t.mode === 'analysis';
      default: return true;
    }
  });

  const modeIcon = (mode: string) => {
    switch (mode) {
      case 'desktop': return <Monitor size={14} className="text-cyan-400" />;
      case 'terminal': return <Terminal size={14} className="text-emerald-400" />;
      default: return <Search size={14} className="text-violet-400" />;
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'running': return <Zap size={14} className="text-amber-400 animate-pulse" />;
      case 'completed': return <CheckCircle size={14} className="text-emerald-400" />;
      case 'failed': return <XCircle size={14} className="text-red-400" />;
      case 'cancelled': return <XCircle size={14} className="text-white/40" />;
      default: return <Clock size={14} className="text-white/40" />;
    }
  };

  const filters: { id: FilterMode; label: string }[] = [
    { id: 'all', label: uiMessage('autonomous-feed.all.eae0ae1b46') },
    { id: 'running', label: uiMessage('autonomous-feed.active.ebb6679ed2') },
    { id: 'completed', label: uiMessage('autonomous-feed.done.9ffd599475') },
    { id: 'failed', label: uiMessage('autonomous-feed.failed.948e2ae057') },
    { id: 'cancelled', label: uiMessage('autonomous-feed.cancelled.bf41d7d123') },
    { id: 'desktop', label: uiMessage('autonomous-feed.desktop.849ee52db0') },
    { id: 'analysis', label: uiMessage('autonomous-feed.analysis.2e6c72d59d') },
  ];

  return (
    <div className="lumi-panel overflow-hidden bg-black/20">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setExpanded(!expanded);
          }
        }}
        className="flex w-full items-center justify-between p-4 transition-colors hover:bg-white/[0.03]"
      >
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-amber-300/15 bg-amber-400/10 text-amber-300">
            <Zap size={16} />
          </span>
          <span className="text-sm font-black uppercase tracking-[0.12em] text-white/75">{uiMessage('autonomous-feed.autonomous-learning.ce7e4bb92f')}</span>
          {liveItems.length > 0 && (
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[10px] font-mono text-white/35">{liveItems.length} {uiMessage('autonomous-feed.live.b49692fb4a')}</span>
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); void loadTasks(); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                void loadTasks();
              }
            }}
            className="lumi-icon-button h-7 w-7 rounded-lg"
            title={uiMessage('autonomous-feed.refresh-autonomous-work.00dccc5c6e')}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
          <ChevronDown size={16} className={`text-white/40 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {expanded && (
        <div className="border-t border-white/5">
          {/* Filter bar */}
          <div className="custom-scrollbar flex gap-1 overflow-x-auto px-4 py-2">
            {filters.map(f => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-full border px-3 py-1 text-xs font-bold whitespace-nowrap transition-colors ${
                  filter === f.id ? 'border-amber-300/25 bg-amber-400/10 text-amber-100' : 'border-transparent text-white/40 hover:border-white/[0.08] hover:bg-white/[0.04] hover:text-white/70'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {loadError && (
            <div className="mx-4 mb-2 rounded-xl border border-red-400/15 bg-red-500/10 px-3 py-2 text-xs text-red-200/80">
              {loadError}
            </div>
          )}

          {/* Task list */}
          <div className="max-h-80 overflow-y-auto custom-scrollbar px-2 pb-2 space-y-1">
            <AnimatePresence>
              {loading && allItems.length === 0 ? (
                <div className="lumi-panel py-8 text-center text-xs text-white/30">
                  {uiMessage('autonomous-feed.loading-autonomous-learning.14b3f53441')}
                </div>
              ) : allItems.length === 0 ? (
                <div className="lumi-panel py-8 text-center text-xs text-white/30">
                  {uiMessage('autonomous-feed.no-autonomous-learning-tasks-yet.41b8e1c56b')}
                </div>
              ) : (
                allItems.map(task => (
                  <motion.div
                    key={task.id}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="cursor-pointer rounded-2xl border border-white/[0.06] bg-white/[0.025] p-3 transition-colors hover:border-white/[0.1] hover:bg-white/[0.05]"
                    onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
                  >
                    <div className="flex items-center gap-2">
                      {statusIcon(task.status)}
                      {modeIcon(task.mode)}
                      <span className="text-sm font-bold text-white/60 truncate flex-1">{task.title}</span>
                      {task.toolCallsCount != null && (
                        <span className="text-xs text-white/30 font-mono">{task.toolCallsCount} tools</span>
                      )}
                      {(task.status === 'pending' || task.status === 'running') && (
                        <button
                          onClick={(event) => { event.stopPropagation(); void cancelTask(task); }}
                          disabled={cancellingIds.includes(task.id)}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-red-400/15 bg-red-500/10 text-red-200/55 hover:bg-red-500/18 hover:text-red-100 disabled:opacity-30"
                          title={uiMessage('autonomous-feed.cancel-task.ea0c83beba')}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>

                    {expandedTask === task.id && (
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: 'auto' }}
                        className="mt-2 space-y-1 border-t border-white/[0.08] pt-2 text-xs text-white/50"
                      >
                        {task.result && (
                          <p className="text-white/60 leading-relaxed">{task.result.slice(0, 300)}</p>
                        )}
                        {task.error && <p className="text-red-400/70">{task.error}</p>}
                        <div className="flex gap-4 text-white/30">
                          {task.tokensUsed != null && <span>{task.tokensUsed} tokens</span>}
                          <span>Priority: {task.priority}</span>
                          <span>Status: {task.status}</span>
                          {task.completedAt && (
                            <span>{new Date(task.completedAt).toLocaleTimeString()}</span>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </motion.div>
                ))
              )}
            </AnimatePresence>
          </div>
        </div>
      )}
    </div>
  );
}
