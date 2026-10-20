import { apiFetch } from '../services/apiClient';

export type KnowledgeFileSource = File[] | string[];

/** File chooser and desktop drops use the same server storage and receipt. */
export async function importKnowledgeFiles(source: KnowledgeFileSource, scopedUrl: (path: string) => string, signal?: AbortSignal) {
  const paths = typeof source[0] === 'string';
  const body = paths ? JSON.stringify({ paths: source }) : new FormData();
  if (body instanceof FormData) (source as File[]).forEach(file => body.append('files', file));
  const response = await apiFetch(scopedUrl(paths ? '/api/files/import-paths' : '/api/files/upload'), {
    method: 'POST', body, signal,
    ...(paths ? { headers: { 'Content-Type': 'application/json', 'X-Lumi-Desktop-Import': 'file-drop' } } : {}),
  });
  const data = await response.json();
  signal?.throwIfAborted();
  if (!response.ok || !Array.isArray(data.files) || !data.files.length) {
    throw new Error(data.error || data.failed?.map((file: any) => `${file.fileName}: ${file.error}`).join('\n') || 'File import failed');
  }
  const failed = data.failed?.length ? data.failed : (data.skipped || []).map((file: any) => ({ fileName: String(file.path).split(/[\\/]/).pop(), error: file.error }));
  return { ...data, failed };
}
