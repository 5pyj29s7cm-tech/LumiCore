import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
import { memoryAvatarEntryCopy } from '../i18n/locales/memoryAvatarEntry';

export type MemoryAvatarEntryState = {
  status: 'loading' | 'error';
  issue?: 'load' | 'timeout' | 'unauthorized' | 'personalScope' | 'invalid' | 'missing';
};

/** A read-only entry can always be dismissed without changing the previous surface. */
export function MemoryAvatarEntryFeedback({ state, locale, onClose, onRetry, lazy = false }: {
  state: MemoryAvatarEntryState; locale: 'zh' | 'en'; onClose: () => void; onRetry?: () => void; lazy?: boolean;
}) {
  const copy = memoryAvatarEntryCopy(locale);
  const loading = state.status === 'loading';
  return <section data-memory-avatar-entry="" role="dialog" aria-modal="true" aria-label={copy.title}
    className="pointer-events-auto fixed inset-0 z-[260] grid place-items-center bg-background/95 p-6 text-foreground">
    <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6">
      <h2 className="text-lg font-medium">{copy.title}</h2>
      <p role={loading ? 'status' : 'alert'} className="mt-4 flex items-start gap-3 text-sm leading-6 text-muted-foreground">
        {loading && <Loader2 className="mt-1 shrink-0 animate-spin" size={17} />}
        {loading ? (lazy ? copy.lazyLoading : copy.loading) : copy[state.issue || 'load']}
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {!loading && onRetry && <button type="button" onClick={onRetry} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2"><RefreshCw size={15} />{copy.retry}</button>}
        <button type="button" onClick={onClose} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2"><ArrowLeft size={15} />{loading ? copy.cancel : copy.back}</button>
      </div>
    </div>
  </section>;
}
