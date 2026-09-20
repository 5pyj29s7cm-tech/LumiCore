import { lazy, Suspense } from 'react';
import { Loader2, X } from 'lucide-react';
import type { KnowledgeBaseProps } from './KnowledgeBase';

const KnowledgeBase = lazy(() => import('./KnowledgeBase').then(module => ({ default: module.KnowledgeBase })));

/** Own the destination immediately, including the first asynchronous chunk load. */
export function KnowledgeBaseEntry(props: KnowledgeBaseProps) {
  const title = props.t?.knowledgeBase || 'Knowledge Base';
  return <section
    data-knowledge-surface
    data-theme-scope="dark"
    aria-label={title}
    aria-hidden={!props.isOpen}
    className="lumi-below-topbar fixed inset-x-0 bottom-0 z-[90]"
    style={{ display: props.isOpen ? 'block' : 'none', background: '#080812' }}
  >
    <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center text-white/70">
      <div role="status" className="flex items-center gap-3"><Loader2 size={20} className="animate-spin" /><span>{title} · {props.t?.loading || 'Loading'}</span></div>
      <button type="button" aria-label={props.t?.close || 'Close'} onClick={props.onClose} className="absolute right-6 top-6 rounded-xl border border-white/15 p-3 hover:bg-white/10"><X size={18} /></button>
    </div>}>
      <KnowledgeBase {...props} />
    </Suspense>
  </section>;
}
