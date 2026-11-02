import { Component, Suspense, useEffect, type ReactNode } from 'react';
import { MemoryAvatarRenderResourceContext, type MemoryAvatarRenderResources } from '../../lib/memoryAvatarRenderResources';

class LayerBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}

function LayerReady({ onReady }: { onReady: () => void }) {
  useEffect(() => { onReady(); }, [onReady]);
  return null;
}

/** Each scene layer resolves independently inside the Canvas, without suspending its parent page. */
export function ResourceLayer({ resources, disabled, onReady, onError, children }: {
  resources: MemoryAvatarRenderResources; disabled: boolean;
  onReady: () => void; onError: () => void; children: ReactNode;
}) {
  if (disabled) return null;
  return <MemoryAvatarRenderResourceContext.Provider value={resources}>
    <LayerBoundary onError={onError}>
      <Suspense fallback={null}>{children}<LayerReady onReady={onReady} /></Suspense>
    </LayerBoundary>
  </MemoryAvatarRenderResourceContext.Provider>;
}
