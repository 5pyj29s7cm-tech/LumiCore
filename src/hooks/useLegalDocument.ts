import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';
import { useApp } from '../contexts/AppContext';
import { apiJson } from '../services/apiClient';
import { uiMessage } from '../i18n/uiMessages';

export function useLegalDocumentScope(caseId?: string, orgId?: string): string {
  const { user, workDomain, orgConnection } = useApp();
  return JSON.stringify([user?.uid, workDomain, orgId || (workDomain === 'work' ? orgConnection?.orgId : ''), caseId]);
}

/** The owning component is keyed by account, organization and case. */
export function useLegalDocument(initialText: string, copy: { error: string; uploadFailed?: string; empty?: string; uploaded?: string }) {
  const [text, setText] = useState(initialText);
  const [output, setOutput] = useState({ text: '', error: '' });
  const [busy, setBusy] = useState<'' | 'upload' | 'generate' | 'archive'>('');
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; request.current?.abort(); };
  }, []);

  const run = async (kind: 'upload' | 'generate' | 'archive', operation: (signal: AbortSignal) => Promise<string>) => {
    if (!active.current || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(kind);
    if (kind === 'generate') setOutput({ text: '', error: '' });
    try {
      const value = await operation(controller.signal);
      if (controller.signal.aborted) return;
      if (kind === 'upload') {
        setText(previous => [previous, value].filter(Boolean).join('\n\n'));
        if (copy.uploaded) toast.success(copy.uploaded);
      } else if (kind === 'archive') {
        if (value) toast.success(value);
      } else setOutput({ text: value, error: '' });
    } catch (error: any) {
      if (!controller.signal.aborted) {
        const message = error?.message || copy.uploadFailed || copy.error;
        if (kind !== 'archive') setOutput({ text: '', error: `${copy.error}: ${message}` });
        if (kind !== 'generate') toast.error(message);
      }
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy('');
    }
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = '';
    if (!files.length) return;
    return run('upload', async signal => {
      const body = new FormData();
      files.forEach(file => body.append('files', file));
      const data = await apiJson('/api/files/upload', { method: 'POST', body, signal });
      const content = (Array.isArray(data?.files) ? data.files : [])
        .map((file: any) => String(file?.content || file?.preview || '').trim()).filter(Boolean).join('\n\n');
      if (!content) throw new Error(copy.empty || copy.error);
      return content;
    });
  };
  const save = (operation: () => boolean | Promise<boolean>, success = '') => run('archive', async () => {
    if (!await operation()) throw new Error(uiMessage('legal-hub.failed-to-archive-material.4ed52ef083'));
    return success;
  });
  return { text, setText, result: output.error || output.text, successfulResult: output.text, busy, upload, save, generate: (operation: (signal: AbortSignal) => Promise<string>) => run('generate', operation) };
}
