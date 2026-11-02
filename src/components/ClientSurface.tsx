import { Suspense, useEffect, type ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

function SurfaceContent({ id, active, children }: { id: string; active: boolean; children: ReactNode }) {
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
  }, [id, active]);
  return <div style={{ display: 'contents' }} data-lumi-surface-inactive={active ? undefined : id} data-lumi-rendered-surface={active ? id : undefined}>{children}</div>;
}

/** Commit only resolved content; isolate failures without replacing the application shell. */
export function ClientSurface({ id, active = true, fallback = null, onClose, children }: {
  id: string; active?: boolean; fallback?: ReactNode; onClose?: () => void; children: ReactNode;
}) {
  return <ErrorBoundary key={id} surfaceId={id} onClose={onClose}>
    <Suspense fallback={fallback}>
      <SurfaceContent id={id} active={active}>{children}</SurfaceContent>
    </Suspense>
  </ErrorBoundary>;
}
