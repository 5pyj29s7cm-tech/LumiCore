export type ChatUploadSource = File | string;
export type ChatUploadKind = 'files' | 'paths';
export interface ChatUploadFailure { name: string; error: string }
interface UploadItem { id: string; source: ChatUploadSource; name: string }
interface UploadBatch { id: string; kind: ChatUploadKind; signature: string; items: UploadItem[]; failed: Map<string, string> }
export interface ChatUploadAttempt { token: symbol; batch: UploadBatch; items: UploadItem[] }

function sourceSignature(source: ChatUploadSource): unknown {
  return typeof source === 'string' ? source : [source.name, source.size, source.lastModified, source.type];
}

/** Owns only the current view's upload batch; no file bytes or identities enter localStorage. */
export class ChatAttachmentUploads {
  private active: symbol | null = null;
  private retryBatch: UploadBatch | null = null;
  get busy(): boolean { return this.active !== null; }
  get canRetry(): boolean { return Boolean(this.retryBatch?.failed.size); }

  reset(): void { this.active = null; this.retryBatch = null; }

  begin(kind: ChatUploadKind, sources: ChatUploadSource[], remaining: number, retry = false): ChatUploadAttempt | null {
    if (this.busy || remaining <= 0) return null;
    const signature = JSON.stringify(sources.map(sourceSignature));
    const previous = this.retryBatch;
    let batch: UploadBatch;
    let items: UploadItem[];
    if (previous && (retry || (previous.kind === kind && previous.signature === signature))) {
      batch = previous;
      // An explicit retry reuses only failed items. Re-selecting the same batch
      // lets the server verify byte hashes before replaying the earlier successes.
      items = retry ? batch.items.filter(item => batch.failed.has(item.id)).slice(0, remaining)
        : sources.map((source, index) => ({ ...batch.items[index], source }));
      if (!retry) batch.items = items;
    } else {
      items = sources.slice(0, remaining).map((source, index) => ({
        id: `item_${index}`, source, name: typeof source === 'string' ? source.split(/[\\/]/).pop() || source : source.name,
      }));
      if (items.length === 0) return null;
      batch = { id: `upload_${crypto.randomUUID().replace(/-/g, '')}`, kind, signature: JSON.stringify(items.map(item => sourceSignature(item.source))), items, failed: new Map() };
    }
    if (items.length === 0) return null;
    const token = Symbol('chat-upload');
    this.active = token;
    this.retryBatch = batch;
    return { token, batch, items };
  }

  complete(attempt: ChatUploadAttempt, payload: any, fallbackError: string): ChatUploadFailure[] {
    if (this.active !== attempt.token) return [];
    const failed = Array.isArray(payload?.failed) ? payload.failed : [];
    const succeeded = new Set((Array.isArray(payload?.files) ? payload.files : []).map((file: any) => file.uploadItemId));
    for (const [index, item] of attempt.items.entries()) {
      const problem = failed.find((row: any) => row.itemId === item.id || row.index === index);
      // Legacy successful responses have no item IDs; only use order when the full batch succeeded.
      const legacySuccess = !failed.length && payload?.files?.length === attempt.items.length;
      if (!problem && (succeeded.has(item.id) || legacySuccess)) attempt.batch.failed.delete(item.id);
      else {
        attempt.batch.failed.set(item.id, String(problem?.error || payload?.error || fallbackError));
      }
    }
    if (attempt.batch.failed.size === 0) this.retryBatch = null;
    return attempt.batch.items.filter(item => attempt.batch.failed.has(item.id))
      .map(item => ({ name: item.name, error: attempt.batch.failed.get(item.id)! }));
  }

  finish(attempt: ChatUploadAttempt): void { if (this.active === attempt.token) this.active = null; }
}
