import { useEffect, useRef, useState } from 'react';
import { buildIndustryWorkflowIdempotencyKey, executeFinanceDeliveryWorkflow, executeIndustryWorkflow, startIndustryWorkflow, cancelFinanceWorkflow, readIndustryWorkflowPage, readIndustryWorkflow, type IndustryArtifact, type IndustryWorkflowTaskRef, type IndustryWorkflowExecutionResult } from '../lib/industryWorkflowClient';

const EMPTY = { busy: false, taskId: '', text: '', status: '', error: '', artifacts: [] as IndustryArtifact[], task: null as IndustryWorkflowTaskRef | null };

/** The workspace owns the account/entry key; a run owns all of its asynchronous results. */
export function useIndustryWorkflow(entryId = '', workspaceId?: string) {
  const [state, setState] = useState(EMPTY);
  const lifetime = useRef<AbortController | null>(null), pending = useRef<AbortController | null>(null);
  const active = useRef({ taskId: '', finance: false });
  const cancelling = useRef<AbortController | null>(null);
  const historyOwner = useRef(0);
  const [history, setHistory] = useState({ items: [] as IndustryWorkflowTaskRef[], loading: false, error: '', loaded: false, cursor: '' });
  const matches = (task: IndustryWorkflowTaskRef) => task.metadata?.industryWorkflow?.entryId === entryId
    && (workspaceId === undefined || (task.metadata?.industryWorkflow?.context?.industryWorkspace?.id || '') === workspaceId);
  const loadHistory = async (more = false) => {
    const owner = lifetime.current, generation = ++historyOwner.current;
    if (!owner || owner.signal.aborted) return;
    setHistory(value => ({ ...value, loading: true, error: '' }));
    try {
      const page = await readIndustryWorkflowPage(entryId, workspaceId, more ? history.cursor : '', AbortSignal.any([owner.signal, AbortSignal.timeout(15_000)]));
      if (!owner.signal.aborted && generation === historyOwner.current) setHistory(current => ({ items: more ? [...current.items, ...page.tasks.filter(matches).filter(task => !current.items.some(item => item.id === task.id))] : page.tasks.filter(matches), loading: false, error: '', loaded: true, cursor: page.nextCursor || '' }));
    } catch (error) { if (!owner.signal.aborted && generation === historyOwner.current) setHistory(value => ({ ...value, loading: false, error: String(error) })); }
  };
  const taskState = (task: IndustryWorkflowTaskRef) => ({ ...EMPTY, taskId: task.id, task, status: task.status, text: task.result || '', artifacts: (task.metadata?.financeDeliveryExecution?.artifacts || []) as IndustryArtifact[] });
  const restore = async (id: string) => {
    const owner = lifetime.current;
    if (!owner || owner.signal.aborted || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    active.current = { taskId: '', finance: false };
    setState(value => ({ ...value, busy: true, error: '' }));
    try {
      const task = await readIndustryWorkflow(id, AbortSignal.any([owner.signal, controller.signal, AbortSignal.timeout(15_000)]));
      if (!matches(task)) throw new Error('Workflow does not match the current entry or workspace');
      if (!owner.signal.aborted && pending.current === controller) {
        active.current = { taskId: task.id, finance: ['tax-filing', 'report-delivery'].includes(entryId) };
        setState(taskState(task));
      }
    } catch (error) { if (!owner.signal.aborted && pending.current === controller) setState(value => ({ ...value, busy: false, error: String(error) })); }
    finally { if (pending.current === controller) pending.current = null; }
  };
  useEffect(() => {
    const owner = new AbortController(); lifetime.current = owner;
    return () => { owner.abort(); pending.current = null; };
  }, []);
  const reset = (error = '') => {
    pending.current?.abort(); pending.current = null;
    active.current = { taskId: '', finance: false };
    setState({ ...EMPTY, error, status: error ? 'needs_input' : '' });
  };
  const stop = async () => {
    if (active.current.finance && active.current.taskId) {
      const owner = lifetime.current;
      if (!owner || owner.signal.aborted || cancelling.current) return;
      const controller = pending.current || new AbortController(); pending.current = controller;
      cancelling.current = controller;
      setState(value => ({ ...value, busy: true, status: 'cancelling', error: '' }));
      try {
        const result = await cancelFinanceWorkflow(active.current.taskId, AbortSignal.any([owner.signal, AbortSignal.timeout(30_000)]));
        if (owner.signal.aborted || pending.current !== controller) return;
        controller.abort(); pending.current = null;
        setState({ ...taskState(result.task), ...(!result.cancelled && !['delivered','blocked'].includes(result.status) ? { status: 'cancellation_unconfirmed' } : {}) });
      } catch (error) {
        if (!owner.signal.aborted && pending.current === controller) {
          controller.abort(); pending.current = null;
          setState(value => ({ ...value, busy: false, status: 'cancellation_unconfirmed', error: String(error) }));
        }
      } finally { if (cancelling.current === controller) cancelling.current = null; }
      return;
    }
    if (!pending.current) return;
    pending.current.abort(); pending.current = null;
    setState(current => ({ ...current, busy: false, status: 'interrupted' }));
  };
  const run = async ({ prompt, financeInput, idempotent, ...request }: {
    entryId: string; source: string; sourceInput: string; prompt: string;
    financeInput?: Record<string, unknown>; idempotent?: boolean;
  }) => {
    const owner = lifetime.current;
    if (!owner || owner.signal.aborted || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    active.current = { taskId: '', finance: Boolean(financeInput) };
    const signal = AbortSignal.any([owner.signal, controller.signal]);
    const current = () => !signal.aborted && pending.current === controller;
    const progress = ({ text, status }: IndustryWorkflowExecutionResult) => {
      if (current()) setState(value => ({ ...value, text, status }));
    };
    setState({ ...EMPTY, busy: true, status: 'creating' });
    try {
      const startSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const idempotencyKey = idempotent ? await buildIndustryWorkflowIdempotencyKey(request) : undefined;
      startSignal.throwIfAborted();
      const started = await startIndustryWorkflow({ ...request, idempotencyKey }, startSignal);
      startSignal.throwIfAborted();
      active.current.taskId = started.task.id;
      setState(value => ({ ...value, taskId: started.task.id, status: 'in_progress' }));
      if (financeInput) {
        const delivery = await executeFinanceDeliveryWorkflow({ taskId: started.task.id, financeInput, signal });
        if (current()) setState(value => ({ ...value, artifacts: delivery.artifacts, task: delivery.task }));
        progress({ status: delivery.status, text: [delivery.task.result || '', ...delivery.artifacts.map(artifact => `${artifact.path}\nSHA-256 ${artifact.sha256}`)].filter(Boolean).join('\n\n') });
      } else {
        progress(await executeIndustryWorkflow({ taskId: started.task.id, sourceInput: request.sourceInput, prompt: `${started.handoffPrompt}\n\n${prompt}`, signal, onProgress: progress }));
      }
    } catch (error) {
      if (current() && cancelling.current !== controller) setState(value => ({ ...value, status: 'blocked', error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (current() && cancelling.current !== controller) { pending.current = null; setState(value => ({ ...value, busy: false })); }
    }
  };
  return { ...state, run, stop, reset, history, loadHistory, restore };
}
