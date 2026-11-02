import { Component, Suspense, lazy, useMemo, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { withRequestDeadline } from '../lib/requestDeadline';
import { sanctuaryModulesCopy, type SanctuaryModuleKind } from '../i18n/locales/sanctuaryModules';

export const SANCTUARY_MODULE_TIMEOUT_MS = 15_000;

class ModuleBoundary extends Component<{ children: ReactNode; fallback: (error: unknown) => ReactNode }, { failed: boolean; error: unknown }> {
  state = { failed: false, error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { failed: true, error }; }
  render() { return this.state.failed ? this.props.fallback(this.state.error) : this.props.children; }
}

/** A local module boundary, not a registered client surface or a business retry. */
export function SanctuaryLazyPanel<P extends object>({ load, kind, locale, onBack, children }: {
  load: () => Promise<{ default: ComponentType<P> }>;
  kind: SanctuaryModuleKind;
  locale: 'zh' | 'en';
  onBack: () => void;
  children: (Content: LazyExoticComponent<ComponentType<P>>) => ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  // React.lazy retains a rejection. An explicit retry needs a fresh lazy wrapper.
  // Dynamic import itself cannot be cancelled and browsers may retain module
  // failures; this bounds waiting, without promising a new network download.
  const Content = useMemo(() => lazy(() => withRequestDeadline(
    () => load(), undefined, SANCTUARY_MODULE_TIMEOUT_MS,
  )), [load, attempt]);
  const copy = sanctuaryModulesCopy(locale);
  const panel = copy.modules[kind];
  const visual = kind === 'scene' || kind === 'portrait';
  const feedback = (failed: boolean, error?: unknown) => {
    const timedOut = Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'TimeoutError');
    return <div className={`pointer-events-auto relative z-20 flex h-full min-h-[180px] items-start justify-center px-4 ${visual ? 'pt-16' : 'pt-10'}`}>
      <div role={failed ? 'alert' : 'status'} aria-live="polite" className="max-w-sm rounded-xl border border-white/15 bg-[#1c2424] p-4 text-center text-sm text-foreground">
        <p>{failed ? (timedOut ? panel.timeout : panel.failed) : panel.loading}</p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{failed ? copy.retryHint : panel.hint}</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {failed && <button type="button" onClick={() => setAttempt(value => value + 1)} className="rounded-lg border border-white/20 px-3 py-2 text-xs hover:bg-white/5">{copy.retry}</button>}
          <button type="button" onClick={onBack} className="rounded-lg border border-white/20 px-3 py-2 text-xs hover:bg-white/5">{panel.back}</button>
        </div>
      </div>
    </div>;
  };
  return <ModuleBoundary key={attempt} fallback={error => feedback(true, error)}>
    <Suspense fallback={feedback(false)}>{children(Content)}</Suspense>
  </ModuleBoundary>;
}
