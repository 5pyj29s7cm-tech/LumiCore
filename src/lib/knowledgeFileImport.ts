import { apiFetch } from '../services/apiClient';

export type KnowledgeFileSource = File[];

/** File chooser and desktop drops use the same server storage and receipt. */
export async function importKnowledgeFiles(source: KnowledgeFileSource, scopedUrl: (path: string) => string, signal?: AbortSignal) {
  const body = new FormData();
  source.forEach(file => body.append('files', file));
  const response = await apiFetch(scopedUrl('/api/files/upload'), { method: 'POST', body, signal });
  const data = await response.json();
  signal?.throwIfAborted();
  if (!response.ok || !Array.isArray(data.files) || !data.files.length) {
    throw new Error(data.error || data.failed?.map((file: any) => `${file.fileName}: ${file.error}`).join('\n') || 'File import failed');
  }
  const failed = data.failed?.length ? data.failed : (data.skipped || []).map((file: any) => ({ fileName: String(file.path).split(/[\\/]/).pop(), error: file.error }));
  return { ...data, failed };
}
