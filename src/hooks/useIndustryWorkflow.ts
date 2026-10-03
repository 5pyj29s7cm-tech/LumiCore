import { useEffect, useRef, useState } from 'react';
import { buildIndustryWorkflowIdempotencyKey, executeFinanceDeliveryWorkflow, executeIndustryWorkflow, startIndustryWorkflow, type IndustryWorkflowExecutionResult } from '../lib/industryWorkflowClient';

const EMPTY = { busy: false, taskId: '', text: '', status: '', error: '' };

/** The workspace owns the account/entry key; a run owns all of its asynchronous results. */
export function useIndustryWorkflow() {
  const [state, setState] = useState(EMPTY);
  const lifetime = useRef<AbortController | null>(null), pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const owner = new AbortController(); lifetime.current = owner;
    return () => { owner.abort(); pending.current = null; };
  }, []);
  const reset = (error = '') => {
    pending.current?.abort(); pending.current = null;
    setState({ ...EMPTY, error, status: error ? 'needs_input' : '' });
  };
  const stop = () => {
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
      setState(value => ({ ...value, taskId: started.task.id, status: 'in_progress' }));
      if (financeInput) {
        const delivery = await executeFinanceDeliveryWorkflow({ taskId: started.task.id, financeInput, signal });
        progress({ status: delivery.status, text: [delivery.task.result || '', ...delivery.artifacts.map(artifact => `${artifact.path}\nSHA-256 ${artifact.sha256}`)].filter(Boolean).join('\n\n') });
      } else {
        progress(await executeIndustryWorkflow({ taskId: started.task.id, sourceInput: request.sourceInput, prompt: `${started.handoffPrompt}\n\n${prompt}`, signal, onProgress: progress }));
      }
    } catch (error) {
      if (current()) setState(value => ({ ...value, status: 'blocked', error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (current()) { pending.current = null; setState(value => ({ ...value, busy: false })); }
    }
  };
  return { ...state, run, stop, reset };
}
