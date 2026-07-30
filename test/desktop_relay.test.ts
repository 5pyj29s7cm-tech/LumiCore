import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceRegistry } from '../server/devices';
import {
  getDesktopControlQueueLength,
  resetDesktopControlLeasesForTests,
} from '../server/desktop/control_lease';
import {
  createDesktopRelay,
  desktopRelayRoomForUser,
  getPendingDesktopRelayCount,
  handleDesktopRelayResult,
  isCoLocatedNativeDesktopRuntime,
  joinDesktopRelayRoom,
} from '../server/socket/desktop_relay';

function mockIo(sockets: Record<string, any> = {}, rooms: Record<string, string[]> = {}) {
  const emitted: any[] = [];
  const socketMap = new Map(Object.entries(sockets));
  return {
    emitted,
    io: {
      sockets: {
        sockets: socketMap,
        adapter: {
          rooms: new Map(Object.entries(rooms).map(([name, ids]) => [name, new Set(ids)])),
        },
      },
      to(target: string) {
        return {
          emit(event: string, payload: any) {
            emitted.push({ target, event, payload });
          },
        };
      },
    } as any,
  };
}

describe('desktop relay routing', () => {
  afterEach(() => {
    resetDesktopControlLeasesForTests();
  });

  it('allows native semantic UI adapters only in a proven co-located desktop runtime', () => {
    expect(isCoLocatedNativeDesktopRuntime('win32', { LUMI_DESKTOP: '1' })).toBe(true);
    expect(isCoLocatedNativeDesktopRuntime('darwin', { LUMI_DESKTOP: '1' })).toBe(true);
    expect(isCoLocatedNativeDesktopRuntime('win32', {})).toBe(false);
    expect(isCoLocatedNativeDesktopRuntime('darwin', {})).toBe(false);
    expect(isCoLocatedNativeDesktopRuntime('linux', { LUMI_DESKTOP: '1' })).toBe(false);
  });

  it('joins desktop clients to a user-scoped desktop relay room', () => {
    const joined: string[] = [];
    const socket = {
      data: {},
      join(room: string) {
        joined.push(room);
      },
    } as any;

    expect(joinDesktopRelayRoom(socket, 'user_room_test', 'desktop')).toBe(true);
    expect(joined).toEqual([desktopRelayRoomForUser('user_room_test')]);
    expect(socket.data.lumiDeviceType).toBe('desktop');

    const webSocket = { data: {}, join: () => joined.push('unexpected') } as any;
    expect(joinDesktopRelayRoom(webSocket, 'user_room_test', 'web')).toBe(false);
  });

  it('routes a chat request to the registered desktop socket and resolves cross-socket results', async () => {
    const userId = `relay_user_${Date.now()}_a`;
    const sent: any[] = [];
    const desktopSocket = {
      connected: true,
      emit: (event: string, payload: any) => sent.push({ target: 'desktop', event, payload }),
    };
    const requestSocket = {
      connected: true,
      emit: (event: string, payload: any) => sent.push({ target: 'request', event, payload }),
      once: () => {},
      off: () => {},
    };

    deviceRegistry.register(userId, 'sock_desktop_a', {
      name: 'Relay Test Desktop A',
      type: 'desktop',
      deviceFingerprint: `fp_${userId}`,
    });

    const { io } = mockIo({ sock_desktop_a: desktopSocket });
    const relay = createDesktopRelay({
      io,
      userId,
      source: 'chat',
      requestSocket: requestSocket as any,
      timeoutMs: 1000,
    });

    const promise = relay('desktop_active_window', {});
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].target).toBe('desktop');
    expect(sent[0].event).toBe('tool:desktop_exec');
    expect(sent[0].payload.name).toBe('desktop_active_window');

    expect(handleDesktopRelayResult(sent[0].payload.correlationId, { output: 'forged' }, 'sock_attacker')).toBe(false);
    expect(getPendingDesktopRelayCount()).toBe(1);
    expect(handleDesktopRelayResult(sent[0].payload.correlationId, { output: '{"title":"WeChat"}' }, 'sock_desktop_a')).toBe(true);
    await expect(promise).resolves.toBe('{"title":"WeChat"}');
    expect(getPendingDesktopRelayCount()).toBe(0);
  });

  it('selects one preferred desktop socket instead of broadcasting duplicate input actions', async () => {
    const userId = `relay_user_${Date.now()}_b`;
    const sent: any[] = [];
    const desktopOne = { connected: true, emit: (event: string, payload: any) => sent.push({ target: 'one', event, payload }) };
    const desktopTwo = { connected: true, emit: (event: string, payload: any) => sent.push({ target: 'two', event, payload }) };

    deviceRegistry.register(userId, 'sock_desktop_b1', {
      name: 'Relay Test Desktop B1',
      type: 'desktop',
      deviceFingerprint: `fp_${userId}_1`,
    });
    deviceRegistry.register(userId, 'sock_desktop_b2', {
      name: 'Relay Test Desktop B2',
      type: 'desktop',
      deviceFingerprint: `fp_${userId}_2`,
    });

    const room = desktopRelayRoomForUser(userId);
    const { io } = mockIo(
      { sock_desktop_b1: desktopOne, sock_desktop_b2: desktopTwo },
      { [room]: ['sock_desktop_b1', 'sock_desktop_b2'] },
    );
    const relay = createDesktopRelay({ io, userId, source: 'task', timeoutMs: 1000 });

    const promise = relay('desktop_keyboard_type', { text: 'hello' });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].event).toBe('tool:desktop_exec');

    const selectedSocketId = sent[0].target === 'one' ? 'sock_desktop_b1' : 'sock_desktop_b2';
    expect(handleDesktopRelayResult(sent[0].payload.correlationId, { output: 'typed' }, selectedSocketId)).toBe(true);
    await expect(promise).resolves.toBe('typed');
    expect(getPendingDesktopRelayCount()).toBe(0);
  });

  it('never routes a work-domain action to the same user personal desktop', async () => {
    const userId = `relay_scope_${Date.now()}`;
    const sent: any[] = [];
    const personalSocket = {
      connected: true,
      emit: (event: string, payload: any) => sent.push({ target: 'personal', event, payload }),
    };
    const orgSocket = {
      connected: true,
      emit: (event: string, payload: any) => sent.push({ target: 'org-a', event, payload }),
    };

    deviceRegistry.register(userId, 'scope_personal_socket', {
      name: 'Scoped Desktop', type: 'desktop', domain: 'personal', orgId: '', deviceFingerprint: 'scope-personal',
    });
    deviceRegistry.register(userId, 'scope_org_socket', {
      name: 'Scoped Desktop', type: 'desktop', domain: 'work', orgId: 'org-a', deviceFingerprint: 'scope-org-a',
    });

    const { io } = mockIo({
      scope_personal_socket: personalSocket,
      scope_org_socket: orgSocket,
    });
    const relay = createDesktopRelay({
      io,
      userId,
      domain: 'work',
      orgId: 'org-a',
      source: 'chat',
      timeoutMs: 1000,
    });

    const promise = relay('desktop_active_window', {});
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].target).toBe('org-a');
    expect(handleDesktopRelayResult(sent[0].payload.correlationId, { output: 'org-window' }, 'scope_org_socket')).toBe(true);
    await expect(promise).resolves.toBe('org-window');
  });

  it('cancels a pending desktop action and tells the selected desktop client to stop it', async () => {
    const userId = `relay_abort_${Date.now()}`;
    const sent: any[] = [];
    const desktopSocket = {
      connected: true,
      emit: (event: string, payload: any) => sent.push({ event, payload }),
    };
    deviceRegistry.register(userId, 'scope_abort_socket', {
      name: 'Abort Desktop', type: 'desktop', domain: 'personal', orgId: '', deviceFingerprint: userId,
    });
    const { io } = mockIo({ scope_abort_socket: desktopSocket });
    const controller = new AbortController();
    const relay = createDesktopRelay({
      io,
      userId,
      source: 'chat',
      timeoutMs: 1000,
      signal: controller.signal,
    });

    const promise = relay('desktop_keyboard_type', { text: 'do not finish' });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].event).toBe('tool:desktop_exec');
    controller.abort();
    await expect(promise).rejects.toThrow(/cancelled/i);
    expect(sent.some(item => item.event === 'tool:desktop_cancel')).toBe(true);
    expect(getPendingDesktopRelayCount()).toBe(0);
  });

  it('rejects and forgets a pending action when the requesting socket disconnects', async () => {
    const userId = `relay_disconnect_${Date.now()}`;
    const sent: any[] = [];
    const disconnectHandlers = new Set<() => void>();
    const desktopSocket = {
      connected: true,
      emit: (event: string, payload: any) => sent.push({ event, payload }),
    };
    const requestSocket = {
      id: 'request_disconnect_socket',
      connected: true,
      data: {},
      once: (event: string, handler: () => void) => {
        if (event === 'disconnect') disconnectHandlers.add(handler);
      },
      off: (event: string, handler: () => void) => {
        if (event === 'disconnect') disconnectHandlers.delete(handler);
      },
    };
    deviceRegistry.register(userId, 'scope_disconnect_desktop', {
      name: 'Disconnect Desktop',
      type: 'desktop',
      domain: 'personal',
      orgId: '',
      deviceFingerprint: userId,
    });
    const { io } = mockIo({ scope_disconnect_desktop: desktopSocket });
    const relay = createDesktopRelay({
      io,
      userId,
      source: 'chat',
      requestSocket: requestSocket as any,
      cancelOnRequestSocketDisconnect: true,
      timeoutMs: 1000,
    });

    const promise = relay('desktop_keyboard_type', { text: 'must stop on disconnect' });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].event).toBe('tool:desktop_exec');
    const correlationId = sent[0].payload.correlationId;
    expect(disconnectHandlers.size).toBe(1);

    for (const handler of [...disconnectHandlers]) handler();

    await expect(promise).rejects.toThrow(/requesting client disconnected/i);
    expect(disconnectHandlers.size).toBe(0);
    expect(getPendingDesktopRelayCount()).toBe(0);
    expect(handleDesktopRelayResult(correlationId, { output: 'late success' }, 'scope_disconnect_desktop')).toBe(false);
  });

  it('holds one lease across a task and does not interleave a second foreground task', async () => {
    const userId = `relay_lease_${Date.now()}`;
    const sent: any[] = [];
    const desktopSocket = {
      connected: true,
      emit: (event: string, payload: any) => sent.push({ event, payload }),
    };
    const socketId = `relay_lease_socket_${Date.now()}`;
    deviceRegistry.register(userId, socketId, {
      name: 'Lease Desktop', type: 'desktop', deviceFingerprint: userId,
    });
    const { io } = mockIo({ [socketId]: desktopSocket });
    const firstRelay = createDesktopRelay({
      io, userId, source: 'chat', taskId: 'chat-turn-a', timeoutMs: 1000,
    });
    const secondRelay = createDesktopRelay({
      io, userId, source: 'task', taskId: 'task-turn-b', timeoutMs: 1000,
    });

    const firstCall = firstRelay('desktop_active_window');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(handleDesktopRelayResult(
      sent[0].payload.correlationId,
      { output: '{"title":"WPS","processName":"wps.exe"}' },
      socketId,
    )).toBe(true);
    await expect(firstCall).resolves.toContain('WPS');
    expect(firstRelay.getControlLease()?.windowBinding).toMatchObject({
      title: 'WPS', processName: 'wps.exe',
    });

    const secondCall = secondRelay('desktop_keyboard_type', { text: 'queued' });
    await vi.waitFor(() => expect(getDesktopControlQueueLength(userId)).toBe(1));
    expect(sent).toHaveLength(1);

    firstRelay.releaseControlLease('chat_complete');
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(handleDesktopRelayResult(
      sent[1].payload.correlationId,
      { output: 'typed' },
      socketId,
    )).toBe(true);
    await expect(secondCall).resolves.toBe('typed');
    secondRelay.releaseControlLease('task_complete');
  });

  it('lets voice preempt autonomous work and prevents the paused relay from continuing', async () => {
    const userId = `relay_preempt_${Date.now()}`;
    const sent: any[] = [];
    const pauses: string[] = [];
    const desktopSocket = {
      connected: true,
      emit: (event: string, payload: any) => sent.push({ event, payload }),
    };
    const socketId = `relay_preempt_socket_${Date.now()}`;
    deviceRegistry.register(userId, socketId, {
      name: 'Preempt Desktop', type: 'desktop', deviceFingerprint: userId,
    });
    const { io } = mockIo({ [socketId]: desktopSocket });
    const autonomousRelay = createDesktopRelay({
      io,
      userId,
      source: 'autonomous',
      taskId: 'autonomous-task',
      timeoutMs: 1000,
      onControlPaused: reason => pauses.push(reason),
    });
    const voiceRelay = createDesktopRelay({
      io, userId, source: 'voice', taskId: 'voice-turn', timeoutMs: 1000,
    });

    const autonomousCall = autonomousRelay('desktop_active_window');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(handleDesktopRelayResult(
      sent[0].payload.correlationId,
      { output: '{"title":"Draft","processName":"wps.exe"}' },
      socketId,
    )).toBe(true);
    await autonomousCall;

    const voiceCall = voiceRelay('desktop_active_window');
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(pauses).toEqual(['desktop_control_preempted_by_voice']);
    await expect(autonomousRelay('desktop_keyboard_type', { text: 'must not run' }))
      .rejects.toThrow(/desktop control is paused/i);
    expect(sent).toHaveLength(2);

    expect(handleDesktopRelayResult(
      sent[1].payload.correlationId,
      { output: '{"title":"Lumi","processName":"lumi.exe"}' },
      socketId,
    )).toBe(true);
    await voiceCall;
    voiceRelay.releaseControlLease('voice_complete');
  });
});
