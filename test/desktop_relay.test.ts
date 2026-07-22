import { describe, expect, it } from 'vitest';
import { deviceRegistry } from '../server/devices';
import {
  createDesktopRelay,
  desktopRelayRoomForUser,
  getPendingDesktopRelayCount,
  handleDesktopRelayResult,
  isCoLocatedWindowsDesktopRuntime,
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
  it('only allows server-side UI Automation in a proven co-located desktop runtime', () => {
    expect(isCoLocatedWindowsDesktopRuntime('win32', { LUMI_DESKTOP: '1' })).toBe(true);
    expect(isCoLocatedWindowsDesktopRuntime('win32', { LUMI_LOCAL_DESKTOP_UIA: '1' })).toBe(true);
    expect(isCoLocatedWindowsDesktopRuntime('win32', {})).toBe(false);
    expect(isCoLocatedWindowsDesktopRuntime('linux', { LUMI_DESKTOP: '1' })).toBe(false);
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
    expect(sent).toHaveLength(1);
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
    expect(sent).toHaveLength(1);
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
    expect(sent).toHaveLength(1);
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
    expect(sent[0].event).toBe('tool:desktop_exec');
    controller.abort();
    await expect(promise).rejects.toThrow(/cancelled/i);
    expect(sent.some(item => item.event === 'tool:desktop_cancel')).toBe(true);
    expect(getPendingDesktopRelayCount()).toBe(0);
  });
});
