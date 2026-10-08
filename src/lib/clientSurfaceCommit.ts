export interface ClientSurfaceQueryRoot {
  querySelector(selectors: string): Element | null;
  querySelectorAll?(selectors: string): NodeListOf<Element>;
}

export interface WaitForClientSurfaceOptions {
  root?: ClientSurfaceQueryRoot;
  timeoutMs?: number;
  now?: () => number;
  schedule?: (callback: () => void) => void;
}

function normalizeSurfaceId(surfaceId: string): string {
  const normalized = String(surfaceId || '').trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    throw new Error('Invalid Lumi client surface id: ' + surfaceId);
  }
  return normalized;
}

export function getRenderedClientSurfaceSelector(surfaceId: string): string {
  return '[data-lumi-rendered-surface="' + normalizeSurfaceId(surfaceId) + '"]';
}

export function isClientSurfaceRendered(
  surfaceId: string,
  root: ClientSurfaceQueryRoot = document,
): boolean {
  const selector = getRenderedClientSurfaceSelector(surfaceId);
  const elements = root.querySelectorAll?.(selector) ?? [root.querySelector(selector)];
  return Array.from(elements).some(element => element && !element.closest?.(
    '[aria-hidden="true"], [inert], [data-lumi-surface-inactive="' + normalizeSurfaceId(surfaceId) + '"]',
  ));
}

export function waitForClientSurfaceRendered(
  surfaceId: string,
  options: WaitForClientSurfaceOptions = {},
): Promise<boolean> {
  const root = options.root || document;
  const timeoutMs = Math.max(50, options.timeoutMs ?? 1800);
  const now = options.now || Date.now;
  const schedule = options.schedule || ((callback: () => void) => window.requestAnimationFrame(callback));
  const startedAt = now();

  return new Promise(resolve => {
    const inspect = () => {
      if (isClientSurfaceRendered(surfaceId, root)) {
        resolve(true);
        return;
      }
      if (now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      schedule(inspect);
    };
    inspect();
  });
}
