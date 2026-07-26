export interface DesktopUiSnapshotOptions {
  root?: 'active' | 'focused' | 'desktop';
  /** Optional root selector used to inspect a native window without foregrounding it. */
  name?: string;
  nameContains?: string;
  automationId?: string;
  controlType?: string;
  className?: string;
  processId?: number;
  nativeWindowHandle?: number;
  allMatches?: boolean;
  maxDepth?: number;
  maxNodes?: number;
  includeOffscreen?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DesktopUiTarget {
  root?: 'active' | 'focused' | 'desktop';
  name?: string;
  nameContains?: string;
  automationId?: string;
  controlType?: string;
  className?: string;
  processId?: number;
  nativeWindowHandle?: number;
  index?: number;
  maxDepth?: number;
  maxNodes?: number;
  includeOffscreen?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type DesktopUiAction = 'focus' | 'click' | 'invoke' | 'type';

export interface DesktopUiActionOptions extends DesktopUiTarget {
  action: DesktopUiAction;
  text?: string;
  append?: boolean;
  fallbackClick?: boolean;
  verify?: boolean;
  delayAfterMs?: number;
}

export interface NativeUiAdapter {
  id: 'windows-uia' | 'macos-accessibility';
  platform: 'win32' | 'darwin';
  captureSnapshot: (options?: DesktopUiSnapshotOptions) => Promise<unknown>;
  runAction: (options: DesktopUiActionOptions) => Promise<unknown>;
}
