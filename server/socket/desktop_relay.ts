import { createHash, randomUUID } from "crypto";
import type { Server, Socket } from "socket.io";
import { deviceRegistry, nativeClientIdentitiesEqual } from "../devices";
import { resolveSocketScope } from './scope';
import { captureOrganizationMembershipAuthorization, isOrganizationMembershipAuthorizationCurrent, type OrganizationMembershipAuthorization } from '../org/membership_authorization';
import { captureNativeUiSnapshot, runNativeUiAction } from "../external_control/native_ui";
import {
  executeTaskRegressionDesktopRelay,
  hasTaskRegressionDesktopRelayAuthorization,
} from "../evidence/task_regression_desktop_relay";
import {
  acquireDesktopControlLease,
  type DesktopControlLeaseHandle,
  type DesktopControlLeaseSnapshot,
  type DesktopControlWindowBinding,
} from "../desktop/control_lease";

type DesktopRelayPayload = {
  correlationId: string;
  name: string;
  arguments: Record<string, any>;
};

type DesktopRelayResult = {
  output?: string;
  error?: string;
  /** False means the native worker has not established that execution stopped. */
  stopped?: boolean;
};

type PendingDesktopRelay = {
  resolve: (output: string) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  deliveryTimeout?: ReturnType<typeof setTimeout>;
  executionDispatched?: boolean;
  onDisconnect?: () => void;
  onAbort?: () => void;
  signal?: AbortSignal;
  requestSocket?: Socket;
  targetSocketId?: string;
  binding?: { userId: string; domain: 'personal' | 'work'; orgId: string; nativeIdentity: any; membership?: OrganizationMembershipAuthorization; io: Server };
  name?: string;
  cancelReason?: string;
  cancelTimeout?: ReturnType<typeof setTimeout>;
  abandoned?: boolean;
  completed?: boolean;
  stop?: (reason: string) => void;
};

export type DesktopRelayLifecycle = (event: {
  correlationId: string;
  name: string;
  arguments: Record<string, any>;
  result?: string;
  error?: string;
}) => void;

export type DesktopRelayOptions = {
  io: Server;
  userId: string;
  domain?: 'personal' | 'work';
  orgId?: string;
  source: 'chat' | 'task' | 'voice' | 'autonomous' | string;
  requestSocket?: Socket;
  emitToolLifecycle?: DesktopRelayLifecycle;
  formatResultForLifecycle?: (output: string) => string;
  timeoutMs?: number;
  deliveryAckTimeoutMs?: number;
  cancellationGraceMs?: number;
  cancelOnRequestSocketDisconnect?: boolean;
  signal?: AbortSignal;
  taskId?: string;
  requestId?: string;
  leaseTimeoutMs?: number;
  leaseDurationMs?: number;
  onControlPaused?: (reason: string) => void;
};

export type DesktopRelay = ((toolName: string, args?: Record<string, any>) => Promise<string>) & {
  releaseControlLease: (reason?: string) => void;
  getControlLease: () => DesktopControlLeaseSnapshot | null;
  /**
   * A user-activity pause is a turn boundary, not a transient lease conflict.
   * Callers use this read-only latch to stop their model/tool loop without
   * aborting or cancelling the durable task that can be resumed later.
   */
  getControlPauseReason: () => string | null;
};

const pendingDesktopRelays = new Map<string, PendingDesktopRelay>();
const completedDesktopRelays = new Map<string, { binding: NonNullable<PendingDesktopRelay['binding']>; at: number }>();
const RECEIPT_TTL_MS = 30 * 60_000;
function pruneDesktopReceipts() {
  for (const [id, receipt] of completedDesktopRelays) if (Date.now() - receipt.at > RECEIPT_TTL_MS) completedDesktopRelays.delete(id);
}
function matchesNativeOwner(binding: NonNullable<PendingDesktopRelay['binding']>, socket: Socket, userId: string): boolean {
  if (!socket.connected || socket.data?.trustedLocalExecution !== true || userId !== binding.userId
    || socket.data?.authenticatedUserId !== binding.userId || !binding.nativeIdentity
    || !nativeClientIdentitiesEqual(binding.nativeIdentity, socket.data?.nativeClientIdentity)) return false;
  return true;
}
function matchesRecoverySocket(binding: NonNullable<PendingDesktopRelay['binding']>, socket: Socket, userId: string): boolean {
  if (!matchesNativeOwner(binding, socket, userId)) return false;
  // An expired work token never becomes authority for personal recovery.
  const tokenOrg = String(socket.data?.authenticatedOrgId || '').trim();
  if (tokenOrg !== binding.orgId || Boolean(tokenOrg) !== (binding.domain === 'work')) return false;
  const scope = resolveSocketScope(socket, userId);
  return scope.domain === binding.domain && scope.orgId === binding.orgId
    && (binding.domain !== 'work' || isOrganizationMembershipAuthorizationCurrent(binding.membership, binding.orgId, binding.userId));
}

/** Only authenticated same-process recovery can rebind an already dispatched action. */
export function registerDesktopRelayRecoveryHandlers(socket: Socket, userId: () => string): void {
  socket.on('tool:desktop_resume', (_data: unknown, acknowledge?: (result: any) => void) => {
    pruneDesktopReceipts();
    const uid = userId();
    const executions: Array<{ correlationId: string; name?: string; state: string; cancel?: boolean }> = [];
    for (const [id, pending] of pendingDesktopRelays) {
      if (!pending.binding || !matchesRecoverySocket(pending.binding, socket, uid)) continue;
      pending.targetSocketId = socket.id;
      executions.push({ correlationId: id, name: pending.name, state: pending.abandoned ? 'outcome_unknown' : 'pending', cancel: Boolean(pending.cancelReason) });
    }
    for (const [id, receipt] of completedDesktopRelays) {
      if (matchesRecoverySocket(receipt.binding, socket, uid)) executions.push({ correlationId: id, state: 'acknowledged' });
    }
    acknowledge?.({ ok: true, executions });
  });
  // Physical stop-only reconciliation deliberately exposes no old-scope
  // result, arguments, tool name or task metadata. It cannot execute anything.
  socket.on('tool:desktop_drain_resume', (_data: unknown, acknowledge?: (result: any) => void) => {
    const executions: Array<{ correlationId: string; nativeCommand: boolean; unknown: boolean }> = [];
    for (const [id, pending] of pendingDesktopRelays) {
      if (!pending.executionDispatched || !pending.binding || !matchesNativeOwner(pending.binding, socket, userId())
        || matchesRecoverySocket(pending.binding, socket, userId())) continue;
      pending.stop?.('Original desktop scope is no longer authorized; stopping without delivering its result');
      executions.push({ correlationId: id, nativeCommand: pending.name === 'desktop_run_command', unknown: Boolean(pending.abandoned) });
    }
    acknowledge?.({ ok: true, executions });
  });
  const drain = (data: { correlationId?: string; stopped?: boolean; confirmation?: string }, manual: boolean) => {
    const id = String(data?.correlationId || '');
    const pending = pendingDesktopRelays.get(id);
    if (!pending?.executionDispatched || !pending.binding || !matchesNativeOwner(pending.binding, socket, userId())
      || matchesRecoverySocket(pending.binding, socket, userId())
      || (manual ? !pending.abandoned || data.confirmation !== 'I_HAVE_VERIFIED_THE_COMMAND_HAS_STOPPED' : data.stopped !== true)) return false;
    pending.targetSocketId = socket.id;
    return handleDesktopRelayResult(id, { error: manual
      ? 'outcome_unknown: user confirmed original physical operation stopped; old scope result remains unavailable and unverified.'
      : 'Original desktop scope is no longer authorized. Physical stop confirmed; no result was delivered.' }, socket.id);
  };
  socket.on('tool:desktop_drain_result', (data: any, acknowledge?: (result: any) => void) => acknowledge?.({ ok: drain(data, false) }));
  socket.on('tool:desktop_drain_confirm_stopped', (data: any, acknowledge?: (result: any) => void) => acknowledge?.({ ok: drain(data, true) }));
  socket.on('tool:desktop_authorize_stop_ack', (data: { correlationId?: string; drainOnly?: boolean } = {}, acknowledge?: (result: any) => void) => {
    const pending = pendingDesktopRelays.get(String(data.correlationId || ''));
    const allowed = Boolean(pending?.abandoned && pending.binding && (data.drainOnly
      ? matchesNativeOwner(pending.binding, socket, userId()) && !matchesRecoverySocket(pending.binding, socket, userId())
      : matchesRecoverySocket(pending.binding, socket, userId())));
    acknowledge?.({ ok: allowed, ...(allowed ? { nativeCommand: pending!.name === 'desktop_run_command' } : {}) });
  });
  socket.on('tool:desktop_confirm_stopped', (data: { correlationId?: string; confirmation?: string } = {}, acknowledge?: (result: any) => void) => {
    const id = String(data.correlationId || '');
    const pending = pendingDesktopRelays.get(id);
    if (data.confirmation !== 'I_HAVE_VERIFIED_THE_COMMAND_HAS_STOPPED' || !pending?.abandoned || !pending.binding
      || !matchesRecoverySocket(pending.binding, socket, userId())) { acknowledge?.({ ok: false }); return; }
    pending.targetSocketId = socket.id;
    // This releases only the concurrency hold. The already published durable
    // outcome remains unknown; a human statement is never a verified artifact.
    const accepted = handleDesktopRelayResult(id, { error: 'outcome_unknown: user confirmed the original desktop action has stopped; no task result was verified.' }, socket.id);
    acknowledge?.({ ok: accepted });
  });
}
const LOCAL_DESKTOP_UI_TOOLS = new Set([
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_click',
  'desktop_ui_invoke',
  'desktop_ui_type',
]);

function combineAbortSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 1) return { signal: active[0], dispose: () => undefined };
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of active) {
    const listener = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    if (signal.aborted) listener();
    else {
      signal.addEventListener('abort', listener, { once: true });
      listeners.push({ signal, listener });
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const item of listeners) item.signal.removeEventListener('abort', item.listener);
    },
  };
}

function extractDesktopWindowBinding(output: string): DesktopControlWindowBinding | null {
  try {
    const parsed = JSON.parse(output || '{}');
    const active = parsed?.activeWindow || parsed?.window || parsed?.foregroundWindow || parsed;
    if (!active || typeof active !== 'object') return null;
    const title = String(active.title || active.windowTitle || '').trim();
    const processName = String(active.process_name || active.processName || active.executable || '').trim();
    if (!title && !processName) return null;
    const identity = {
      title,
      processName,
      processId: Number(active.pid || active.processId || 0) || undefined,
      nativeWindowHandle: Number(active.nativeWindowHandle || active.hwnd || active.windowId || 0) || undefined,
      displayId: String(active.displayId || active.monitorId || '').trim() || undefined,
    };
    return {
      ...identity,
      fingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
      observedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function isCoLocatedNativeDesktopRuntime(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (platform === 'win32' || platform === 'darwin')
    && env.LUMI_DESKTOP === '1';
}

async function runLocalDesktopUiTool(
  toolName: string,
  args: Record<string, any>,
  signal?: AbortSignal,
): Promise<string | null> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return null;
  if (toolName === 'desktop_ui_snapshot') {
    return JSON.stringify(await captureNativeUiSnapshot({ ...args, signal }), null, 2);
  }
  const action = {
    desktop_ui_focus: 'focus',
    desktop_ui_click: 'click',
    desktop_ui_invoke: 'invoke',
    desktop_ui_type: 'type',
  }[toolName] as 'focus' | 'click' | 'invoke' | 'type' | undefined;
  if (!action) return null;
  return JSON.stringify(await runNativeUiAction({ ...args, action, signal }), null, 2);
}

function normalizeDesktopScope(domain?: string, orgId?: string) {
  const normalizedOrgId = String(orgId || '').trim();
  return domain === 'work' && normalizedOrgId
    ? { domain: 'work' as const, orgId: normalizedOrgId }
    : { domain: 'personal' as const, orgId: '' };
}

export function desktopRelayRoomForUser(userId: string, domain?: 'personal' | 'work', orgId?: string): string {
  const scope = normalizeDesktopScope(domain, orgId);
  const suffix = scope.domain === 'work' ? `org:${scope.orgId}` : 'personal';
  return `desktop:${userId || 'anonymous'}:${suffix}`;
}

export function isDesktopDeviceType(type?: string): boolean {
  return /^(desktop|tauri|windows|macos|linux)$/i.test(String(type || '').trim());
}

export function joinDesktopRelayRoom(
  socket: Socket,
  userId: string,
  deviceType?: string,
  domain?: 'personal' | 'work',
  orgId?: string,
): boolean {
  // Device metadata is caller-controlled. A remote web/socket client must not
  // become an execution target merely by registering itself as "desktop".
  // The Socket.IO middleware owns this proof-backed bit.
  if (socket.data?.trustedLocalExecution !== true) return false;
  if (!isDesktopDeviceType(deviceType)) return false;
  const scope = normalizeDesktopScope(domain, orgId);
  socket.join(desktopRelayRoomForUser(userId, scope.domain, scope.orgId));
  socket.data.lumiDeviceType = 'desktop';
  socket.data.lumiDesktopDomain = scope.domain;
  socket.data.lumiDesktopOrgId = scope.orgId;
  return true;
}

export function getPreferredDesktopSocketId(userId: string, domain?: 'personal' | 'work', orgId?: string): string | null {
  const scope = normalizeDesktopScope(domain, orgId);
  const devices = deviceRegistry.getActiveDevices(userId, scope)
    .filter(device => isDesktopDeviceType(device.type) && Boolean(device.socketId))
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  return devices[0]?.socketId || null;
}

export function handleDesktopRelayResult(correlationId: string, data: DesktopRelayResult = {}, senderSocketId?: string): boolean {
  const pending = pendingDesktopRelays.get(correlationId);
  if (!pending) {
    const receipt = completedDesktopRelays.get(correlationId);
    const sender = senderSocketId && receipt?.binding.io.sockets.sockets.get(senderSocketId);
    return Boolean(receipt && sender && matchesRecoverySocket(receipt.binding, sender, String(sender.data?.authenticatedUserId || '')));
  }
  if (!senderSocketId || !pending.targetSocketId || senderSocketId !== pending.targetSocketId) return false;
  if (pending.executionDispatched !== true) return false;
  if (pending.binding?.nativeIdentity) {
    const sender = senderSocketId && pending.binding.io.sockets.sockets.get(senderSocketId);
    if (!sender || !matchesNativeOwner(pending.binding, sender, pending.binding.userId)) return false;
    if (!matchesRecoverySocket(pending.binding, sender, pending.binding.userId)) {
      // Stop evidence can be collected after revocation; content cannot.
      data = { error: 'Original desktop scope authorization ended; no result was delivered.', stopped: data.stopped };
    }
  }
  if (data.stopped === false) {
    pending.stop?.('Native executor reported outcome_unknown; waiting for the original command to stop');
    return false;
  }

  pendingDesktopRelays.delete(correlationId);
  pending.completed = true;
  if (pending.binding) {
    pruneDesktopReceipts();
    completedDesktopRelays.set(correlationId, { binding: pending.binding, at: Date.now() });
  }
  clearTimeout(pending.timeout);
  if (pending.cancelTimeout) clearTimeout(pending.cancelTimeout);
  if (pending.deliveryTimeout) clearTimeout(pending.deliveryTimeout);
  if (pending.requestSocket && pending.onDisconnect) {
    pending.requestSocket.off('disconnect', pending.onDisconnect);
  }
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener('abort', pending.onAbort);
  }

  if (data.error) pending.reject(new Error(data.error));
  else pending.resolve(data.output || '');
  return true;
}

export function getPendingDesktopRelayCount(): number {
  return pendingDesktopRelays.size;
}

export function createDesktopRelay(options: DesktopRelayOptions): DesktopRelay {
  const timeoutMs = options.timeoutMs ?? 60000;
  const cancelOnDisconnect = options.cancelOnRequestSocketDisconnect ?? false;
  const scope = normalizeDesktopScope(options.domain, options.orgId);
  const leaseTaskId = String(options.taskId || '').trim();
  const autoReleaseLease = !leaseTaskId;
  let controlLease: DesktopControlLeaseHandle | null = null;
  let acquiringLease: Promise<DesktopControlLeaseHandle> | null = null;
  let controlPausedReason = '';

  const emitControlState = (snapshot: DesktopControlLeaseSnapshot) => {
    const room = scope.domain === 'work' && scope.orgId
      ? `org:${scope.orgId}`
      : `user:${options.userId}:personal`;
    options.io.to(room).emit('agent:desktop_control_state', {
      ...snapshot,
      domain: scope.domain,
      orgId: scope.orgId,
    });
  };
  const ensureControlLease = async (): Promise<DesktopControlLeaseHandle> => {
    if (controlPausedReason) {
      throw new Error(`Desktop control is paused: ${controlPausedReason}`);
    }
    if (controlLease?.heartbeat(options.leaseDurationMs)) return controlLease;
    if (!acquiringLease) {
      acquiringLease = acquireDesktopControlLease({
        userId: options.userId,
        taskId: leaseTaskId || `${options.source}:${randomUUID()}`,
        source: options.source,
        signal: options.signal,
        timeoutMs: options.leaseTimeoutMs,
        leaseMs: options.leaseDurationMs,
        onStateChange: emitControlState,
        onPause: reason => {
          controlPausedReason = reason;
          options.onControlPaused?.(reason);
          emitControlState(controlLease?.snapshot() || {
            leaseId: '',
            userId: options.userId,
            taskId: leaseTaskId,
            source: options.source,
            priority: 0,
            status: 'paused',
            reason,
            updatedAt: new Date().toISOString(),
          });
        },
      }).then(lease => {
        controlLease = lease;
        return lease;
      }).finally(() => {
        acquiringLease = null;
      });
    }
    return acquiringLease;
  };

  const relay = async (toolName: string, args: Record<string, any> = {}): Promise<string> => {
    if (
      options.requestSocket
      && options.requestSocket.data?.trustedLocalExecution !== true
    ) {
      throw new Error(`Desktop tool "${toolName}" is unavailable on remote execution surfaces.`);
    }
    if (options.signal?.aborted) {
      throw new Error(`Desktop tool "${toolName}" cancelled before execution`);
    }
    const lease = await ensureControlLease();
    const unresolved = [...pendingDesktopRelays.entries()].find(([, pending]) => pending.executionDispatched && pending.binding?.userId === options.userId);
    if (unresolved) {
      if (autoReleaseLease) lease.release('desktop_waiting_for_native_terminal');
      throw new Error(`Desktop outcome_unknown: execution ${unresolved[0]} is still awaiting its original desktop result. Reconnect that desktop to reconcile or stop it before starting another desktop action.`);
    }
    if (pendingDesktopRelays.size >= 512) throw new Error('Desktop receipt capacity reached; reconcile existing executions before starting more actions.');
    const nativeBusy = (identity: any, exceptId?: string) => Boolean(identity && [...pendingDesktopRelays.entries()].some(([id, pending]) => id !== exceptId && pending.executionDispatched && pending.binding?.nativeIdentity && nativeClientIdentitiesEqual(identity, pending.binding.nativeIdentity)));
    const preferred = getPreferredDesktopSocketId(options.userId, scope.domain, scope.orgId);
    const dispatchIdentity = options.requestSocket?.data?.nativeClientIdentity
      || (preferred && options.io.sockets.sockets.get(preferred)?.data?.nativeClientIdentity);
    if (nativeBusy(dispatchIdentity)) {
      if (autoReleaseLease) lease.release('desktop_waiting_for_native_terminal');
      throw new Error('Desktop outcome_unknown: this native device is awaiting a previous physical operation to stop. Return to its original owner to reconcile.');
    }
    const combined = combineAbortSignals([options.signal, lease.signal]);
    const executionSignal = combined.signal;
    try {
      if (
        [
          'desktop_write_text_file',
          'desktop_active_window',
          'desktop_list_files',
          'desktop_read_text_file',
        ].includes(toolName)
        && options.requestSocket
        && hasTaskRegressionDesktopRelayAuthorization(options.requestSocket)
      ) {
        const regressionCorrelationId = `desktop-${options.source}_${randomUUID()}`;
        options.emitToolLifecycle?.({
          correlationId: regressionCorrelationId,
          name: toolName,
          arguments: args,
        });
        try {
          const regressionResult = executeTaskRegressionDesktopRelay(
            options.requestSocket,
            toolName,
            args,
            String(options.requestId || ''),
          );
          options.emitToolLifecycle?.({
            correlationId: regressionCorrelationId,
            name: toolName,
            arguments: args,
            result: options.formatResultForLifecycle
              ? options.formatResultForLifecycle(regressionResult)
              : regressionResult,
          });
          return regressionResult;
        } catch (error: any) {
          const message = error?.message || String(error);
          options.emitToolLifecycle?.({
            correlationId: regressionCorrelationId,
            name: toolName,
            arguments: args,
            error: message,
          });
          throw error;
        }
      }
      if (LOCAL_DESKTOP_UI_TOOLS.has(toolName) && !isCoLocatedNativeDesktopRuntime()) {
        throw new Error(
          `Native desktop UI tool "${toolName}" is blocked because the server is not proven to share the selected Windows/macOS desktop session. Use computer_use on the connected desktop instead.`,
        );
      }
      if (isCoLocatedNativeDesktopRuntime() && LOCAL_DESKTOP_UI_TOOLS.has(toolName)) {
        const localUiCorrelationId = `desktop-${options.source}_${randomUUID()}`;
        try {
          const localUiResult = await runLocalDesktopUiTool(toolName, args, executionSignal);
          if (localUiResult !== null) {
            options.emitToolLifecycle?.({
              correlationId: localUiCorrelationId,
              name: toolName,
              arguments: args,
            });
            options.emitToolLifecycle?.({
              correlationId: localUiCorrelationId,
              name: toolName,
              arguments: args,
              result: options.formatResultForLifecycle
                ? options.formatResultForLifecycle(localUiResult)
                : localUiResult,
            });
            if (/^(?:desktop_active_window|desktop_ui_snapshot)$/i.test(toolName)) {
              const binding = extractDesktopWindowBinding(localUiResult);
              if (binding) lease.bindWindow(binding);
            }
            return localUiResult;
          }
        } catch (error: any) {
          const message = error?.message || String(error);
          options.emitToolLifecycle?.({
            correlationId: localUiCorrelationId,
            name: toolName,
            arguments: args,
            error: message,
          });
          throw error;
        }
      }

      const output = await new Promise<string>((resolve, reject) => {
      const cid = `${options.source}_${randomUUID()}`;
      const uiCid = `desktop-${cid}`;
      const room = desktopRelayRoomForUser(options.userId, scope.domain, scope.orgId);
      const payload: DesktopRelayPayload = { correlationId: cid, name: toolName, arguments: args };
      let settled = false;

      options.emitToolLifecycle?.({ correlationId: uiCid, name: toolName, arguments: args });

      const finishWithError = (message: string) => {
        if (settled) return;
        settled = true;
        const pending = pendingDesktopRelays.get(cid);
        if (pending) {
          pendingDesktopRelays.delete(cid);
          clearTimeout(pending.timeout);
          if (pending.deliveryTimeout) clearTimeout(pending.deliveryTimeout);
          if (pending.requestSocket && pending.onDisconnect) {
            pending.requestSocket.off('disconnect', pending.onDisconnect);
          }
          if (pending.signal && pending.onAbort) {
            pending.signal.removeEventListener('abort', pending.onAbort);
          }
        }
        options.emitToolLifecycle?.({ correlationId: uiCid, name: toolName, arguments: args, error: message });
        reject(new Error(message));
      };

      const requestStop = (reason: string) => {
        const pending = pendingDesktopRelays.get(cid);
        if (!pending) return;
        if (!pending.executionDispatched) { finishWithError(reason); return; }
        if (pending.cancelReason) return;
        pending.cancelReason = reason;
        clearTimeout(pending.timeout);
        const targetSocketId = pending.targetSocketId;
        if (targetSocketId) {
          options.io.sockets.sockets.get(targetSocketId)?.emit('tool:desktop_cancel', {
            correlationId: cid,
            name: toolName,
          });
        }
        pending.cancelTimeout = setTimeout(() => {
          if (pending.completed) return;
          pending.abandoned = true;
          // The caller can stop waiting, but its action identity still blocks
          // competing desktop work until a real terminal is reconciled.
          const message = `${reason}; outcome_unknown: cancellation was requested but native termination is not confirmed. Reconnect the original desktop to reconcile ${cid}.`;
          pending.reject(new Error(message));
        }, Math.max(10, options.cancellationGraceMs ?? 5_000));
        pending.cancelTimeout.unref?.();
      };
      const timeout = setTimeout(() => requestStop(`Desktop tool "${toolName}" timed out (${Math.round(timeoutMs / 1000)}s)`), timeoutMs);
      const onDisconnect = () => requestStop(`Desktop tool "${toolName}" cancellation requested: requesting client disconnected before returning a result`);
      const onAbort = () => requestStop(`Desktop tool "${toolName}" cancellation requested because the active task was stopped or superseded`);

      pendingDesktopRelays.set(cid, {
        resolve: (output: string) => {
          if (settled) return;
          settled = true;
          options.emitToolLifecycle?.({
            correlationId: uiCid,
            name: toolName,
            arguments: args,
            result: options.formatResultForLifecycle ? options.formatResultForLifecycle(output) : output,
          });
          resolve(output);
        },
        reject: (err: Error) => {
          if (settled) return;
          settled = true;
          options.emitToolLifecycle?.({ correlationId: uiCid, name: toolName, arguments: args, error: err.message });
          reject(err);
        },
        timeout,
        onDisconnect: cancelOnDisconnect ? onDisconnect : undefined,
        onAbort,
        signal: executionSignal,
        requestSocket: cancelOnDisconnect ? options.requestSocket : undefined,
        binding: { userId: options.userId, domain: scope.domain, orgId: scope.orgId, nativeIdentity: null, io: options.io },
        name: toolName,
        stop: requestStop,
      });

      const emitToDesktopTarget = (socketId: string): boolean => {
        const targetSocket = options.io.sockets.sockets.get(socketId);
        if (!targetSocket?.connected || targetSocket.data?.trustedLocalExecution !== true) return false;
        const pending = pendingDesktopRelays.get(cid);
        if (!pending) return false;
        pending.targetSocketId = socketId;
        if (pending.binding) pending.binding.nativeIdentity = targetSocket.data?.nativeClientIdentity || null;
        if (pending.binding?.nativeIdentity) {
          if (targetSocket.data.authenticatedUserId !== options.userId) { finishWithError('Desktop execution owner does not match the authenticated native connection.'); return true; }
          if (scope.domain === 'work') {
            try { pending.binding.membership = captureOrganizationMembershipAuthorization(scope.orgId, options.userId); }
            catch { finishWithError('Desktop organization membership is no longer authorized.'); return true; }
          }
        }
        // Socket connectivity and device registration do not prove that the
        // WebView still owns a live relay consumer after HMR or auth rebinding.
        // This is deliberately a two-phase delivery: the client first accepts
        // an offer without touching the desktop. Only a timely acknowledgement
        // causes the server to dispatch the executable event. A late callback
        // therefore cannot run a side effect after this request has failed.
        const deliveryAckMs = Math.min(
          timeoutMs,
          Math.max(10, options.deliveryAckTimeoutMs ?? 2_000),
        );
        pending.deliveryTimeout = setTimeout(() => {
          finishWithError(`Desktop client did not accept "${toolName}" for execution`);
        }, deliveryAckMs);
        targetSocket.emit('tool:desktop_offer', payload, (acknowledgement?: {
          accepted?: boolean;
          correlationId?: string;
        }) => {
          const current = pendingDesktopRelays.get(cid);
          if (!current || current.targetSocketId !== socketId) return;
          if (
            acknowledgement?.accepted !== true
            || String(acknowledgement.correlationId || '') !== cid
          ) {
            finishWithError(`Desktop client declined "${toolName}" for execution`);
            return;
          }
          if (current.executionDispatched) return;
          if (current.deliveryTimeout) {
            clearTimeout(current.deliveryTimeout);
            current.deliveryTimeout = undefined;
          }
          const liveTargetSocket = options.io.sockets.sockets.get(socketId);
          if (
            liveTargetSocket !== targetSocket
            || !liveTargetSocket?.connected
            || liveTargetSocket.data?.trustedLocalExecution !== true
          ) {
            finishWithError(`Desktop client disconnected before "${toolName}" could start`);
            return;
          }
          if (current.binding?.nativeIdentity && !matchesRecoverySocket(current.binding, liveTargetSocket, options.userId)) {
            finishWithError('Desktop execution authorization changed before dispatch.'); return;
          }
          if (nativeBusy(current.binding?.nativeIdentity, cid)) {
            finishWithError('Desktop outcome_unknown: this native device is still awaiting a previous physical operation to stop.'); return;
          }
          current.executionDispatched = true;
          liveTargetSocket.emit('tool:desktop_exec', payload);
        });
        return true;
      };

      if (cancelOnDisconnect && options.requestSocket) {
        options.requestSocket.once('disconnect', onDisconnect);
      }
      if (executionSignal) {
        executionSignal.addEventListener('abort', onAbort, { once: true });
        if (executionSignal.aborted) {
          onAbort();
          return;
        }
      }

      const preferredSocketId = getPreferredDesktopSocketId(options.userId, scope.domain, scope.orgId);
      if (preferredSocketId && emitToDesktopTarget(preferredSocketId)) return;

      const roomSockets = options.io.sockets.adapter.rooms.get(room);
      if (roomSockets?.size === 1) {
        if (emitToDesktopTarget(Array.from(roomSockets)[0])) return;
      }

      const requestSocketMatchesScope = options.requestSocket?.data?.lumiDeviceType === 'desktop'
        && (options.requestSocket.data.lumiDesktopDomain || 'personal') === scope.domain
        && String(options.requestSocket.data.lumiDesktopOrgId || '') === scope.orgId;
      if (options.requestSocket?.connected && requestSocketMatchesScope) {
        if (emitToDesktopTarget(options.requestSocket.id)) return;
      }

      finishWithError(`Desktop tool "${toolName}" cannot run: no desktop client is connected for this user`);
      });
      if (/^(?:desktop_active_window|desktop_ui_snapshot)$/i.test(toolName)) {
        const binding = extractDesktopWindowBinding(output);
        if (binding) lease.bindWindow(binding);
      }
      return output;
    } finally {
      combined.dispose();
      if (autoReleaseLease) {
        lease.release('desktop_single_call_complete');
        if (controlLease?.leaseId === lease.leaseId) controlLease = null;
      }
    }
  };
  const typedRelay = relay as DesktopRelay;
  typedRelay.releaseControlLease = (reason = 'desktop_task_complete') => {
    controlLease?.release(reason);
    controlLease = null;
  };
  typedRelay.getControlLease = () => controlLease?.snapshot() || null;
  typedRelay.getControlPauseReason = () => controlPausedReason || null;
  return typedRelay;
}
