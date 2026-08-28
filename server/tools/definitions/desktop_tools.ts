import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { assertValidCommandForHost } from '../command_platform';
import { desktopFingerprintMatchesRequestedTarget } from '../../desktop/execution_plan';
import crypto from 'node:crypto';

function parseRelayPayload(value: unknown): Record<string, any> | null {
  let current = value;
  for (let depth = 0; depth < 3 && typeof current === 'string'; depth += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      return null;
    }
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, any>
    : null;
}

function activeWindowFingerprint(value: unknown): { title: string; processName: string } | null {
  const payload = parseRelayPayload(value);
  if (!payload) return null;
  const title = String(payload.title || payload.windowTitle || payload.window_title || '').trim();
  const processName = String(
    payload.processName || payload.process_name || payload.process || payload.executable || '',
  ).trim();
  return title || processName ? { title, processName } : null;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function desktopSystemInfo(_args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_system_info', {});
}

async function desktopCapabilityStatus(_args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_capability_status', {});
}

async function desktopListFiles(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  const routedTaskText = String(context?.routedTaskText || context?.actionIntent || '');
  const requestedPath = String(args.path || '').trim();
  const desktopFilesRequested = /(?:\u684c\u9762|\bdesktop\b).{0,24}(?:\u6587\u4ef6|\u6587\u4ef6\u5939|\u76ee\u5f55|\bfiles?\b|\bfolders?\b)/iu.test(routedTaskText);
  const desktopCountRequested = /(?:\u6587\u4ef6|\u6761\u76ee|\bfiles?\b|\bentries\b).{0,16}(?:\u6570\u91cf|\u591a\u5c11|\u51e0\u4e2a|\bcount\b|\bhow\s+many\b)|(?:\u6570\u91cf|\u591a\u5c11|\u51e0\u4e2a|\bcount\b|\bhow\s+many\b).{0,16}(?:\u6587\u4ef6|\u6761\u76ee|\bfiles?\b|\bentries\b)/iu.test(routedTaskText);
  const path = !requestedPath && desktopFilesRequested
    ? '~/Desktop'
    : requestedPath;
  const requestedLimit = Number(args.limit) || 100;
  return context.desktopRelay('desktop_list_files', {
    path,
    limit: desktopFilesRequested && desktopCountRequested
      ? Math.max(requestedLimit, 1000)
      : requestedLimit,
  });
}

async function desktopListApps(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_list_apps', {
    query: args.query || '',
    limit: args.limit || 80,
  });
}

async function desktopOpen(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  const target = String(args.target || '').trim();
  const application = String(args.application || args.browser || '').trim();
  const openResult = await context.desktopRelay('desktop_open', { target, application });
  let lastFingerprint: { title: string; processName: string } | null = null;
  let observationError = '';
  const retryDelays = [0, 250, 750, 1_500];

  for (const delay of retryDelays) {
    if (context?.isCancelled?.()) {
      return JSON.stringify({
        ok: false,
        status: 'cancelled',
        target,
        application,
        targetMatched: false,
      });
    }
    if (delay > 0) await wait(delay);
    try {
      const observed = await context.desktopRelay('desktop_active_window', {});
      const fingerprint = activeWindowFingerprint(observed);
      if (!fingerprint) continue;
      lastFingerprint = fingerprint;
      if (desktopFingerprintMatchesRequestedTarget(fingerprint, target, application)) {
        return JSON.stringify({
          ok: true,
          status: 'verified',
          target,
          application,
          targetMatched: true,
          actualTarget: fingerprint,
          openResult,
        });
      }
    } catch (error: any) {
      observationError = String(error?.message || error || 'Desktop state observation failed.');
    }
  }

  if (!lastFingerprint) {
    return JSON.stringify({
      ok: false,
      status: 'unverified',
      target,
      application,
      openResult,
      error: observationError || 'The desktop client returned no active-window fingerprint after opening the target.',
    });
  }
  return JSON.stringify({
    ok: false,
    status: 'target_mismatch',
    target,
    application,
    targetMatched: false,
    actualTarget: lastFingerprint,
    openResult,
    error: 'The foreground application does not match the exact requested target.',
  });
}

async function desktopShowLumiWindow(_args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_show_lumi_window', {});
}

async function desktopPathInfo(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_path_info', {
    target: args.target || args.path || '',
  });
}

async function desktopWriteTextFile(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  const filePath = String(args.path || '').trim();
  if (!filePath) throw new Error('desktop_write_text_file requires an exact file path');
  const content = String(args.content ?? '');
  const encoding = String(args.encoding || 'utf-8').trim().toLowerCase();
  const overwritePolicy = String(args.overwritePolicy || 'fail_if_exists').trim().toLowerCase();
  if (!['utf-8', 'utf8', 'utf-8-bom', 'utf8-bom'].includes(encoding)) {
    throw new Error('desktop_write_text_file encoding must be utf-8 or utf-8-bom');
  }
  if (!['fail_if_exists', 'replace'].includes(overwritePolicy)) {
    throw new Error('desktop_write_text_file overwritePolicy must be fail_if_exists or replace');
  }

  const relayResult = await context.desktopRelay('desktop_write_text_file', {
    path: filePath,
    content,
    encoding,
    overwritePolicy,
  });
  const nativeReceipt = parseRelayPayload(relayResult);
  if (!nativeReceipt) {
    throw new Error('The native desktop client returned no structured text-file write receipt');
  }
  const expectedBytes = Buffer.byteLength(content, 'utf8')
    + (encoding === 'utf-8-bom' || encoding === 'utf8-bom' ? 3 : 0);
  const nativeBytes = Number(nativeReceipt.bytesWritten ?? -1);
  const receiptVerified = nativeReceipt.success === true
    && nativeReceipt.readBackMatched === true
    && nativeBytes === expectedBytes;
  return JSON.stringify({
    ok: receiptVerified,
    status: receiptVerified ? 'verified' : 'unverified',
    receiptType: 'native_text_file_write',
    path: String(nativeReceipt.path || filePath),
    bytesWritten: nativeBytes,
    encoding: String(nativeReceipt.encoding || encoding),
    overwritePolicy: String(nativeReceipt.overwritePolicy || overwritePolicy),
    overwritten: nativeReceipt.overwritten === true,
    readBackMatched: nativeReceipt.readBackMatched === true,
    contentSha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    contentCharacters: content.length,
    verificationScope: 'native_byte_read_back',
    limitations: [
      'This receipt verifies bytes written and read back by the native client; use a text reader when the response must quote the resulting content.',
    ],
  });
}

async function desktopRunCommand(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  assertValidCommandForHost(args.command, context.desktopPlatform || process.platform);
  return context.desktopRelay('desktop_run_command', {
    command: args.command || '',
    cwd: args.cwd || '',
  });
}

async function desktopIdleTime(_args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_idle_time', {});
}

async function desktopPollActivity(_args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_poll_activity', {});
}

export function registerDesktopTools(registry: ToolRegistry): void {
  registry.register({
    name: 'desktop_capability_status',
    description:
      'Read native desktop readiness by capability: app discovery and launch, screen capture, input control, and macOS Accessibility/Screen Recording authorization. Use this before diagnosing desktop permissions. There is no separate Lumi external-app automation switch.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: desktopCapabilityStatus,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_system_info',
    description:
      'Get real host system info (OS, CPU, memory, home directory) from the desktop machine. Use this instead of get_system_info when you need actual hardware details, not just the server process view.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: desktopSystemInfo,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_list_files',
    description:
      'List files and directories on the user\'s real desktop machine at the given path using the native desktop client. Prefer this for Desktop/Documents folders, Chinese filenames, file discovery, and verifying that a generated file really exists. Use "~/Desktop" for the user\'s Desktop and limit 1000 for a requested count/inventory; an empty path defaults to the home directory unless the current request explicitly asks for Desktop files. Returns name, path, type, size, and modified time.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list. Use "~/Desktop" for the user Desktop. Leave empty for home directory.' },
        limit: { type: 'number', description: 'Maximum entries to return (default 100).' },
      },
      required: [],
    },
    handler: desktopListFiles,
    permission: 'user',
    securityLevel: 'safe',
    evidence: { capability: 'desktop_files', operation: 'observe', assurance: 'observed', subjectArgument: 'path' },
  });

  registry.register({
    name: 'desktop_open',
    description:
      'Open a file, folder, application, or URL using the native OS. On macOS this resolves installed .app bundles and localized aliases before preserving the direct LaunchServices/open fallback; on Windows it resolves launch history, Desktop/Start Menu shortcuts, and known install paths. App names such as WeChat, WPS, a browser, AutoCAD, or CAD should be opened through this tool instead of guessing paths. When the user names a specific application for a file or URL, pass it in application so the OS does not silently switch to another default app.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The file, folder, app name, or URL to open. Examples: "notepad.exe", "calc.exe", "C:\\Users", "https://github.com"' },
        application: { type: 'string', description: 'Optional explicit application name to open the target with, such as "Google Chrome", "Microsoft Edge", "Safari", or "WPS".' },
      },
      required: ['target'],
    },
    handler: desktopOpen,
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'desktop.target.open',
      family: 'desktop',
      lane: 'desktop',
      operation: 'mutate',
      risk: 'low',
      sideEffects: [{ type: 'desktop_control', scope: 'requested local target', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['target', 'targetMatched', 'actualTarget.processName'],
        requiredValues: { targetMatched: true },
        successStatuses: ['verified'],
        failureStatuses: ['target_mismatch', 'unverified', 'failed'],
        successSignals: ['requested application, file, folder, or URL is visibly active'],
        limitations: ['A launch request alone is never proof that the requested target became active.'],
      },
      intents: ['open or focus a named local target'],
    },
    evidence: { capability: 'desktop_target', operation: 'mutate', assurance: 'observed', subjectArgument: 'target' },
  });

  registry.register({
    name: 'desktop_list_apps',
    description:
      'List launchable local desktop applications known by the native client. On macOS it scans /Applications, /System/Applications, and the user Applications folder for .app bundles; on Windows it checks successful launch history, Desktop/Start Menu shortcuts, and common install paths. Use this before opening an app when the exact local path is unknown.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional app name or alias to search, such as "微信", "WPS", "浏览器", "剪映", "CAD", "WeChat", or "VS Code".' },
        limit: { type: 'number', description: 'Maximum entries to return (default 80).' },
      },
      required: [],
    },
    handler: desktopListApps,
    permission: 'user',
    securityLevel: 'safe',
    evidence: { capability: 'desktop_apps', operation: 'observe', assurance: 'observed', subjectArgument: 'query' },
  });

  registry.register({
    name: 'desktop_show_lumi_window',
    description:
      'Bring the Lumi desktop window to the foreground using the native client. Use this to return Lumi to the user or recover focus before client/UI work; it does not control external applications.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: desktopShowLumiWindow,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'client.window.focus',
      family: 'client',
      lane: 'client',
      operation: 'mutate',
      risk: 'low',
      sideEffects: [{ type: 'desktop_control', scope: 'Lumi main window only', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: [],
        successSignals: ['the native client confirms the Lumi main window is foreground'],
        limitations: ['A focus request receipt is not proof that another application remained unchanged.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'client.window.focus',
      operation: 'mutate',
      assurance: 'observed',
    }),
  });

  registry.register({
    name: 'desktop_path_info',
    description:
      'Check whether an exact file or folder path exists on the user\'s real desktop machine. Use this after creating files, especially CAD/doc/image outputs, before telling the user the file is ready.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Exact file or folder path to check.' },
        path: { type: 'string', description: 'Alias for target.' },
      },
      required: [],
    },
    handler: desktopPathInfo,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_write_text_file',
    description:
      'Write an exact text payload to an exact path on the user\'s real desktop machine through the native client. This is the cross-platform file semantic for Desktop/Documents and other host paths; never replace it with a shell command. Choose fail_if_exists to protect an existing file or replace only when overwriting is explicitly intended. Returns a native byte-level read-back receipt. A one-time user confirmation is always required.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Exact host file path, such as "~/Desktop/note.txt" or an absolute path.' },
        content: { type: 'string', description: 'Exact text content to write.' },
        encoding: { type: 'string', enum: ['utf-8', 'utf-8-bom'], description: 'Portable text encoding. Defaults to utf-8.' },
        overwritePolicy: { type: 'string', enum: ['fail_if_exists', 'replace'], description: 'Whether to protect an existing target or replace it. Defaults to fail_if_exists.' },
      },
      required: ['path', 'content'],
    },
    handler: desktopWriteTextFile,
    permission: 'user',
    securityLevel: 'confirm',
    capability: {
      ...capabilityContract({
      id: 'desktop.files.text.write',
      family: 'desktop_files',
      lane: 'files',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [{ type: 'local_write', scope: 'one exact native host text-file path', reversible: false }],
      verification: {
        strategy: 'measured',
        required: true,
        requiredFields: ['path', 'bytesWritten', 'contentSha256', 'readBackMatched'],
        requiredValues: { readBackMatched: true },
        successStatuses: ['verified'],
        failureStatuses: ['unverified', 'failed'],
        successSignals: ['the native client wrote the requested bytes and immediately read back the same bytes'],
        limitations: ['The receipt does not interpret the text or prove how another application will render it.'],
      },
      }),
      intents: ['write exact text to a native host file'],
      tags: ['text file', 'native host file', 'desktop file'],
    },
    evidence: capabilityEvidence({
      id: 'desktop.files.text.write',
      operation: 'mutate',
      assurance: 'verified',
      subjectArgument: 'path',
      limitations: ['Use a text reader when exact human-readable content must be quoted after writing.'],
    }),
  });

  registry.register({
    name: 'desktop_run_command',
    description:
      'Execute a shell command on the user\'s real desktop machine. Supports cmd.exe /C on Windows and sh -c on Linux/macOS. Use desktop_list_files for file discovery instead of shell dir/ls, especially for Unicode paths.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute on the host machine.' },
        cwd: { type: 'string', description: 'Working directory for the command. Leave empty for default.' },
      },
      required: ['command'],
    },
    preflight: (args, context) => {
      assertValidCommandForHost(args.command, context?.desktopPlatform || process.platform);
    },
    handler: desktopRunCommand,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'desktop.command.run',
      family: 'desktop',
      lane: 'system',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [{ type: 'process_execution', scope: 'real host shell command', reversible: false }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: [],
        successSignals: ['the native host command adapter returned without a non-zero or transport error'],
        limitations: ['Command completion does not independently verify every filesystem, application, or network side effect.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'desktop.command.run',
      operation: 'mutate',
      assurance: 'observed',
      subjectArgument: 'command',
      limitations: ['Use a domain verifier for claimed artifacts or application state.'],
    }),
  });

  registry.register({
    name: 'desktop_idle_time',
    description:
      'Read the current desktop idle-time signal from the native client. Use this to understand whether the user appears active or idle before proposing background/visible desktop work.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: desktopIdleTime,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_poll_activity',
    description:
      'Poll the native desktop activity snapshot, including foreground/idle signals exposed by the client. Use this for readiness checks, not for continuous surveillance.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: desktopPollActivity,
    permission: 'user',
    securityLevel: 'safe',
  });
}
