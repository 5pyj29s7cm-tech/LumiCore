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
  const processId = Number(options.processId || 0);
  const nativeWindowHandle = Number(options.nativeWindowHandle || 0);
  if (!(Number.isFinite(processId) && processId > 0) && !(Number.isFinite(nativeWindowHandle) && nativeWindowHandle > 0)) {
    return {
      status: 'target_mismatch',
      targetMatched: false,
      action: options.action,
      note: 'A fresh desktop_ui_snapshot processId or nativeWindowHandle is required before native UI actuation.',
    };
  }
  const adapter = getNativeUiAdapter();
  if (!adapter) {
    return {
      status: 'not_supported',
      platform: process.platform,
      note: 'Native semantic UI control is supported by the Windows UIA and macOS Accessibility adapters.',
    };
  }
  const result = await adapter.runAction(options);
  return finalizeNativeUiActionResult(options, result);
}

export function finalizeNativeUiActionResult(
  options: DesktopUiActionOptions,
  result: unknown,
): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const payload = result as Record<string, any>;
  if (payload.status !== 'ok') return payload;
  const processId = Number(options.processId || 0);
  const nativeWindowHandle = Number(options.nativeWindowHandle || 0);
  const selected = payload.selectedBefore && typeof payload.selectedBefore === 'object'
    ? payload.selectedBefore as Record<string, any>
    : {};
  const processMatched = processId > 0 ? Number(selected.processId || 0) === processId : true;
  const handleMatched = nativeWindowHandle > 0
    ? Number(selected.nativeWindowHandle || 0) === nativeWindowHandle
    : true;
  const targetMatched = processMatched && handleMatched;
  return {
    ...payload,
    status: targetMatched ? payload.status : 'target_mismatch',
    targetMatched,
    expectedTarget: {
      ...(processId > 0 ? { processId } : {}),
      ...(nativeWindowHandle > 0 ? { nativeWindowHandle } : {}),
    },
    ...(!targetMatched
      ? { note: 'The native UI target identity changed before actuation completed.' }
      : {}),
  };
}
