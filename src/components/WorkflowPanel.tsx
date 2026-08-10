import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { BrainCircuit, Wrench, CheckCircle2, XCircle, MessageSquare, ChevronRight, ShieldAlert } from 'lucide-react';
import { FocusThreadPanel } from './FocusThreadPanel';
import type { ConversationFocusThread } from '@/hooks/useFocusThreads';
import { RuntimeEvidencePanel } from './RuntimeEvidencePanel';
import type { StructuredRuntimeStatus } from '@/hooks/useRuntimeStatus';
import { LumiScenePanel } from './LumiScenePanel';
import type { LumiSceneSnapshot } from '../../shared/lumi_scene';

export interface WorkflowStep {
  id: string;
  type: 'thinking' | 'background' | 'confirmation' | 'tool_start' | 'tool_result' | 'response' | 'error';
  text: string;
  time: number;
  detail?: string;
}

type WorkflowStatus = 'idle' | 'thinking' | 'background' | 'executing' | 'waiting_confirmation' | 'done' | 'error';

export interface BackgroundWorkflowTask {
  id: string;
  title?: string;
  status: 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  workerNames?: string[];
  toolCallsCount?: number;
  error?: string;
  resultPreview?: string;
  updatedAt?: string;
}

interface WorkflowPanelProps {
  visible: boolean;
  agentStatus: WorkflowStatus;
  steps: WorkflowStep[];
  t?: any;
  placement?: 'center' | 'corner';
  backgroundTasks?: BackgroundWorkflowTask[];
  focusThreads?: ConversationFocusThread[];
  focusThreadsLoading?: boolean;
  runtimeStatus?: StructuredRuntimeStatus | null;
  runtimeStatusLoading?: boolean;
  runtimeStatusError?: string;
  scene?: LumiSceneSnapshot | null;
  sceneLoading?: boolean;
  sceneError?: string;
  onCancelBackgroundTask?: (taskId: string) => void;
}

function StatusLights({ status }: { status: WorkflowPanelProps['agentStatus'] }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={`w-3 h-3 rounded-full transition-all duration-500 ${
          status === 'thinking'
            ? 'bg-yellow-400 shadow-[0_0_12px_rgba(250,204,21,0.6)] animate-pulse'
            : status === 'background'
              ? 'bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.55)] animate-pulse'
            : 'bg-white/10'
        }`}
        style={status === 'thinking' || status === 'background' ? { animationDuration: '1.5s' } : undefined}
      />
      <div
        className={`w-3 h-3 rounded-full transition-all duration-500 ${
          status === 'executing'
            ? 'bg-green-400 shadow-[0_0_12px_rgba(74,222,128,0.6)] animate-pulse'
            : status === 'waiting_confirmation'
              ? 'bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.65)] animate-pulse'
            : 'bg-white/10'
        }`}
        style={status === 'executing' || status === 'waiting_confirmation' ? { animationDuration: '0.8s' } : undefined}
      />
      <div
        className={`w-3 h-3 rounded-full transition-all duration-500 ${
          status === 'done'
            ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]'
            : status === 'error'
              ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.7)] animate-pulse'
              : 'bg-white/10'
        }`}
        style={status === 'error' ? { animationDuration: '0.4s' } : undefined}
      />
    </div>
  );
}

function StatusLabel({ status, t }: { status: WorkflowPanelProps['agentStatus']; t?: any }) {
  const label =
    status === 'thinking' ? (t?.thinking || 'Thinking...') :
    status === 'background' ? (t?.workflowBackground || 'Working in background...') :
    status === 'waiting_confirmation' ? (t?.workflowWaitingConfirm || 'Waiting for approval') :
    status === 'executing' ? (t?.workflowExecuting || 'Executing tools...') :
    status === 'done' ? (t?.workflowDone || 'Done') :
    status === 'error' ? (t?.workflowError || 'Error') :
    (t?.workflowIdle || 'Idle');
  const color =
    status === 'thinking' ? 'text-yellow-400' :
    status === 'background' ? 'text-cyan-300' :
    status === 'waiting_confirmation' ? 'text-amber-300' :
    status === 'executing' ? 'text-green-400' :
    status === 'done' ? 'text-emerald-400' :
    status === 'error' ? 'text-red-500' :
    'text-white/55';
  return <span className={`text-xs font-black uppercase tracking-widest ${color}`}>{label}</span>;
}

function StepIcon({ type }: { type: WorkflowStep['type'] }) {
  switch (type) {
    case 'thinking':
      return <BrainCircuit size={12} className="text-yellow-400 shrink-0" />;
    case 'background':
      return <BrainCircuit size={12} className="text-cyan-300 shrink-0" />;
    case 'confirmation':
      return <ShieldAlert size={12} className="text-amber-300 shrink-0" />;
    case 'tool_start':
      return <Wrench size={12} className="text-blue-400 shrink-0" />;
    case 'tool_result':
      return <CheckCircle2 size={12} className="text-green-400 shrink-0" />;
    case 'response':
      return <MessageSquare size={12} className="text-purple-400 shrink-0" />;
    case 'error':
      return <XCircle size={12} className="text-red-400 shrink-0" />;
  }
}

function taskStatusLabel(status: BackgroundWorkflowTask['status'], t?: any): string {
  switch (status) {
    case 'queued':
      return t?.workflowTaskQueued || 'Queued';
    case 'running':
      return t?.workflowTaskRunning || 'Running';
    case 'cancelling':
      return t?.workflowTaskCancelling || 'Cancelling';
    case 'completed':
      return t?.workflowTaskCompleted || 'Completed';
    case 'failed':
      return t?.workflowTaskFailed || 'Failed';
    case 'cancelled':
      return t?.workflowTaskCancelled || 'Cancelled';
  }
}

function taskStatusClass(status: BackgroundWorkflowTask['status']): string {
  switch (status) {
    case 'queued':
      return 'border-white/10 bg-white/[0.04] text-white/55';
    case 'running':
      return 'border-cyan-300/20 bg-cyan-300/10 text-cyan-200';
    case 'cancelling':
      return 'border-amber-300/20 bg-amber-300/10 text-amber-200';
    case 'completed':
      return 'border-emerald-300/20 bg-emerald-300/10 text-emerald-200';
    case 'failed':
      return 'border-red-300/20 bg-red-300/10 text-red-200';
    case 'cancelled':
      return 'border-white/10 bg-white/[0.04] text-white/45';
  }
}

function canCancelTask(status: BackgroundWorkflowTask['status']): boolean {
  return status === 'queued' || status === 'running';
}

export default function WorkflowPanel({
  visible,
  agentStatus,
  steps,
  t,
  placement = 'center',
  backgroundTasks = [],
  focusThreads = [],
  focusThreadsLoading = false,
  runtimeStatus = null,
  runtimeStatusLoading = false,
  runtimeStatusError = '',
  scene = null,
  sceneLoading = false,
  sceneError = '',
  onCancelBackgroundTask,
}: WorkflowPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const latestStep = steps[steps.length - 1];
  const visibleBackgroundTasks = backgroundTasks.slice(0, 3);
  const isCorner = placement === 'corner';
  const verticalOffset = isCorner ? 20 : -20;
  const positionClass = isCorner
    ? 'fixed right-4 bottom-28 sm:right-6 z-[260] w-[360px] max-w-[calc(100vw-2rem)] pointer-events-auto'
    : 'fixed top-24 left-1/2 -translate-x-1/2 z-[260] w-[380px] max-w-[calc(100vw-2rem)] pointer-events-auto';

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [steps.length]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: verticalOffset, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: verticalOffset, scale: 0.95 }}
          transition={{ duration: 0.3 }}
          className={positionClass}
        >
          <div className="p-4 rounded-2xl bg-black/80 backdrop-blur-2xl border border-white/10 space-y-3">
            {/* Header with breathing lights */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <StatusLights status={agentStatus} />
                <StatusLabel status={agentStatus} t={t} />
              </div>
              <span className="text-xs text-white/45 font-mono">
                {steps.length > 0 ? `${steps.length} ${t?.workflowSteps || 'steps'}` : ''}
              </span>
            </div>

            {visibleBackgroundTasks.length > 0 && (
              <div className="space-y-2">
                {visibleBackgroundTasks.map((task) => {
                  const workers = task.workerNames?.filter(Boolean).slice(0, 3).join(', ');
                  const detail = [
                    workers,
                    task.toolCallsCount ? `${task.toolCallsCount} ${t?.workflowTaskTools || 'tool calls'}` : '',
                  ].filter(Boolean).join(' / ');
                  return (
                    <div
                      key={task.id}
                      className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2"
                    >
                      <BrainCircuit size={14} className="shrink-0 text-cyan-200" />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-xs font-bold text-white/85">
                            {task.title || task.id}
                          </span>
                          <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-black uppercase ${taskStatusClass(task.status)}`}>
                            {taskStatusLabel(task.status, t)}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-white/45">
                          {task.error || task.resultPreview || detail || task.id}
                        </div>
                      </div>
                      {onCancelBackgroundTask && canCancelTask(task.status) && (
                        <button
                          type="button"
                          onClick={() => onCancelBackgroundTask(task.id)}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:border-red-300/30 hover:bg-red-400/10 hover:text-red-200"
                          title={t?.workflowTaskCancel || 'Cancel background task'}
                          aria-label={t?.workflowTaskCancel || 'Cancel background task'}
                        >
                          <XCircle size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <FocusThreadPanel threads={focusThreads} loading={focusThreadsLoading} />

            <RuntimeEvidencePanel
              status={runtimeStatus}
              loading={runtimeStatusLoading}
              error={runtimeStatusError}
              variant="compact"
            />

            <LumiScenePanel scene={scene} loading={sceneLoading} error={sceneError} compact />

            {latestStep && (
              <div className="border-l border-white/10 pl-3 py-0.5">
                <div className="text-xs font-bold text-white/80 truncate">{latestStep.text}</div>
                {latestStep.detail && (
                  <div className="text-xs text-white/50 truncate mt-0.5">{latestStep.detail}</div>
                )}
              </div>
            )}

            {/* Step log */}
            {steps.length > 0 && (
              <div
                ref={listRef}
                className="space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar pr-1"
              >
                {steps.map((step) => (
                  <motion.div
                    key={step.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2 }}
                    className="flex items-start gap-2 text-xs text-white/60"
                  >
                    <StepIcon type={step.type} />
                    <div className="min-w-0 flex-1">
                      <span className="text-white/80">{step.text}</span>
                      {step.detail && (
                        <div className="text-white/55 truncate mt-0.5">{step.detail}</div>
                      )}
                    </div>
                    {step.type === 'tool_start' && (
                      <ChevronRight size={10} className="text-white/45 shrink-0 mt-0.5" />
                    )}
                  </motion.div>
                ))}
              </div>
            )}

            {/* Empty state */}
            {steps.length === 0 && focusThreads.length === 0 && !runtimeStatus && !scene && (
              <div className="text-xs text-white/45 text-center py-4">
                {t?.workflowWaiting || 'Waiting for agent activity...'}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
