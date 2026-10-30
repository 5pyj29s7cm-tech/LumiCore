import { useEffect, useRef, useState } from 'react';
import { businessRecoveryCopy } from '../i18n/locales/businessRecovery';
import { downloadIndustryArtifact } from '../lib/industryWorkflowClient';
import type { useIndustryWorkflow } from '../hooks/useIndustryWorkflow';

export function IndustryWorkflowRecovery({ workflow, lang }: { workflow: ReturnType<typeof useIndustryWorkflow>; lang: string }) {
  const c = businessRecoveryCopy(lang), { history } = workflow;
  const [error, setError] = useState(''), [downloading, setDownloading] = useState(false);
  const owner = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); owner.current = controller; return () => controller.abort(); }, []);
  const download = async (artifact: typeof workflow.artifacts[number]) => {
    const controller = owner.current; if (!controller || controller.signal.aborted || downloading) return;
    setDownloading(true); setError('');
    try { await downloadIndustryArtifact(workflow.taskId, artifact, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])); }
    catch (error) { if (!controller.signal.aborted) setError(String(error)); }
    finally { if (!controller.signal.aborted) setDownloading(false); }
  };
  return <section className="space-y-3 rounded-xl border border-white/10 p-4">
    {workflow.status === 'cancelling' && <p role="status">{c.cancelPending}</p>}
    {workflow.status === 'cancellation_unconfirmed' && <p role="alert">{c.cancelUnknown}</p>}
    {workflow.status === 'cancellation_unconfirmed' && <button type="button" disabled={workflow.busy} onClick={() => void workflow.stop()}>{c.retryCancel}</button>}
    <h3>{c.history}</h3><p className="text-xs opacity-60">{c.bounded}</p>
    <button type="button" disabled={history.loading || workflow.busy} onClick={() => void workflow.loadHistory()}>{history.error ? c.retry : c.load}</button>
    {history.error && <p role="alert">{history.error}</p>}
    {history.loaded && !history.items.length && <p>{c.empty}</p>}
    <ul>{history.items.map(task => <li key={task.id}><button type="button" disabled={workflow.busy} onClick={() => void workflow.restore(task.id)}>{c.restore}: {task.title || task.id} · {task.status} · {task.updatedAt}</button></li>)}</ul>
    {history.cursor && <button type="button" disabled={history.loading || workflow.busy} onClick={() => void workflow.loadHistory(true)}>{c.more}</button>}
    {workflow.artifacts.length > 0 && <div><h4>{c.artifacts}</h4>{workflow.artifacts.map(artifact => <div key={artifact.sha256}><span>{artifact.basename || artifact.path}</span><button type="button" disabled={downloading || workflow.busy} onClick={() => void download(artifact)}>{c.download}</button><code className="block text-xs">SHA-256 {artifact.sha256}</code></div>)}</div>}
    {error && <p role="alert">{error}</p>}
    {workflow.task?.metadata?.workTakeoverToolRuns && <details><summary>{c.evidence}</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(workflow.task.metadata.workTakeoverToolRuns, null, 2)}</pre></details>}
  </section>;
}
