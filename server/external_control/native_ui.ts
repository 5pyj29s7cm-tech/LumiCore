import {
  captureMacosAccessibilitySnapshot,
  runMacosAccessibilityAction,
} from './macos_accessibility';
import {
  captureWindowsUiSnapshot,
  runWindowsUiAction,
} from './windows_uia';
import type {
  DesktopUiActionOptions,
  DesktopUiSnapshotOptions,
  NativeUiAdapter,
} from './native_ui_contract';

export type {
  DesktopUiAction,
  DesktopUiActionOptions,
  DesktopUiSnapshotOptions,
  DesktopUiTarget,
  NativeUiAdapter,
} from './native_ui_contract';

const WINDOWS_ADAPTER: NativeUiAdapter = {
  id: 'windows-uia',
  platform: 'win32',
  captureSnapshot: captureWindowsUiSnapshot,
  runAction: runWindowsUiAction,
};

const MACOS_ADAPTER: NativeUiAdapter = {
  id: 'macos-accessibility',
  platform: 'darwin',
  captureSnapshot: captureMacosAccessibilitySnapshot,
  runAction: runMacosAccessibilityAction,
};

export function getNativeUiAdapter(
  platform: NodeJS.Platform = process.platform,
): NativeUiAdapter | null {
  if (platform === 'win32') return WINDOWS_ADAPTER;
  if (platform === 'darwin') return MACOS_ADAPTER;
  return null;
}

export async function captureNativeUiSnapshot(
  options: DesktopUiSnapshotOptions = {},
): Promise<unknown> {
  const adapter = getNativeUiAdapter();
  if (!adapter) {
    return {
      status: 'not_supported',
      platform: process.platform,
      note: 'Native semantic UI control is supported by the Windows UIA and macOS Accessibility adapters.',
    };
  }
  return adapter.captureSnapshot(options);
}

export async function runNativeUiAction(
  options: DesktopUiActionOptions,
): Promise<unknown> {
  const adapter = getNativeUiAdapter();
  if (!adapter) {
    return {
      status: 'not_supported',
      platform: process.platform,
      note: 'Native semantic UI control is supported by the Windows UIA and macOS Accessibility adapters.',
    };
  }
  return adapter.runAction(options);
}
