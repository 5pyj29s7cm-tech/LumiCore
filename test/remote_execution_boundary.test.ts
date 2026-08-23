import './helpers';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import {
  executionBoundaryPromptOverlay,
  REMOTE_RESTRICTED_TOOL_ALLOWLIST,
  restrictSystemPromptForExecutionBoundary,
  restrictToolPolicyForExecutionBoundary,
  restrictVisibleToolNamesForExecutionBoundary,
  restrictVisibleToolRouteForExecutionBoundary,
} from '../server/tools/remote_policy';
import { buildSocketToolSecurityContext } from '../server/socket/scope';
import { registerDeviceHandlers } from '../server/socket/device';
import { registerTerminalHandlers } from '../server/socket/terminal';

const WILDCARD_POLICY = {
  allowedTools: ['*'],
  requireConfirmation: [],
  forbiddenTools: [],
  maxIterations: 80,
};

function registerProbe(registry: ToolRegistry, name: string, permission: 'public' | 'user' = 'user') {
  const handler = vi.fn(async () => `executed:${name}`);
  registry.register({
    name,
    description: `${name} boundary probe`,
    parameters: { type: 'object', properties: {} },
    permission,
    securityLevel: 'safe',
    handler,
  });
  return handler;
}

function remoteContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'remote-user',
    authenticated: true,
    authRole: 'user',
    localExecution: false,
    executionBoundary: 'remote_restricted' as const,
    source: 'rest_chat',
    toolPolicy: WILDCARD_POLICY,
    ...overrides,
  };
}

describe('remote model/tool execution boundary', () => {
  it('exposes only the fixed remote-safe search capability to a network model', () => {
    const registry = new ToolRegistry();
    for (const name of [
      'web_search',
      'read_file',
      'list_directory',
      'search_files',
      'desktop_capture_screen',
      'desktop_running_processes',
      'credential_get',
      'settings_keys_write',
      'wechat_send_message',
    ]) registerProbe(registry, name);

    const policy = restrictToolPolicyForExecutionBoundary(WILDCARD_POLICY, 'remote_restricted');
    expect(policy.allowedTools).toEqual([...REMOTE_RESTRICTED_TOOL_ALLOWLIST]);
    expect(policy.maxIterations).toBe(4);
    expect(registry.getToolDeclarationsForPolicy(policy).map(item => item.function.name))
      .toEqual(['web_search']);
    expect(registry.getToolDeclarationsForPolicy(WILDCARD_POLICY, {
      context: remoteContext() as any,
    }).map(item => item.function.name)).toEqual(['web_search']);
  });

  it('redacts host capabilities from route diagnostics and model overlays', () => {
    const route = restrictVisibleToolRouteForExecutionBoundary({
      toolNames: ['read_file', 'web_search', 'desktop_running_processes', 'credential_get'],
      categories: ['files', 'web', 'system'],
      reasons: ['matched read_file and desktop_running_processes'],
      totalAvailable: 361,
      maxTools: 96,
      truncated: true,
      unavailableMcpServers: ['private-host-mcp'],
      forbiddenToolNames: ['settings_keys_write'],
    }, 'remote_restricted');

    expect(route).toMatchObject({
      toolNames: ['web_search'],
      categories: ['web'],
      reasons: ['remote execution boundary applied'],
      totalAvailable: 1,
      maxTools: 1,
      truncated: false,
      unavailableMcpServers: [],
      forbiddenToolNames: [],
    });
    expect(restrictVisibleToolNamesForExecutionBoundary(
      ['read_file', 'web_search', 'desktop_capture_screen'],
      'remote_restricted',
    )).toEqual(['web_search']);

    const overlay = executionBoundaryPromptOverlay(
      'Use read_file, desktop_capture_screen, credential_get, and settings_keys_write.',
      'remote_restricted',
    );
    expect(overlay).toContain('Remote execution boundary');
    expect(overlay).not.toMatch(/read_file|desktop_capture_screen|credential_get|settings_keys_write/);

    const systemPrompt = restrictSystemPromptForExecutionBoundary(
      'You have full desktop access. Use read_file, desktop_running_processes, credential_get, and settings_keys_write.',
      'remote_restricted',
    );
    expect(systemPrompt).toContain('You are Lumi');
    expect(systemPrompt).not.toMatch(/full desktop|read_file|desktop_running_processes|credential_get|settings_keys_write/);
  });

  it.each([
    'read_file',
    'list_directory',
    'search_files',
    'grep_files',
    'desktop_capture_screen',
    'desktop_running_processes',
    'run_command',
    'credential_get',
    'settings_keys_write',
    'wechat_send_message',
  ])('hard-denies %s before its handler even if policy and permission claim it is allowed', async (name) => {
    const registry = new ToolRegistry();
    const handler = registerProbe(registry, name, 'public');

    await expect(registry.execute(name, {}, remoteContext()))
      .rejects.toThrow(/unavailable on remote execution surfaces/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('allows authenticated remote web search but rejects a fabricated non-anonymous identity', async () => {
    const registry = new ToolRegistry();
    const handler = registerProbe(registry, 'web_search');

    await expect(registry.execute('web_search', {}, remoteContext()))
      .resolves.toBe('executed:web_search');
    await expect(registry.execute('web_search', {}, remoteContext({ authenticated: false })))
      .rejects.toThrow(/authenticated user/i);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps the authenticated native client capable while a service grant remains remote-restricted', async () => {
    const registry = new ToolRegistry();
    registerProbe(registry, 'read_file');
    registerProbe(registry, 'web_search');

    await expect(registry.execute('read_file', {}, {
      userId: 'desktop-user',
      authenticated: true,
      authRole: 'user',
      localExecution: true,
      executionBoundary: 'trusted_local',
      source: 'chat',
      toolPolicy: WILDCARD_POLICY,
    })).resolves.toBe('executed:read_file');

    await expect(registry.execute('web_search', {}, remoteContext({
      userId: 'mcp_remote',
      authenticated: false,
      trustedServiceExecution: true,
      source: 'mcp_chat',
    }))).resolves.toBe('executed:web_search');
    await expect(registry.execute('read_file', {}, remoteContext({
      userId: 'mcp_remote',
      authenticated: false,
      trustedServiceExecution: true,
      source: 'mcp_chat',
    }))).rejects.toThrow(/unavailable on remote execution surfaces/i);
  });

  it('does not infer native authority from loopback and uses only the middleware proof flag', () => {
    const loopbackWithoutProof = buildSocketToolSecurityContext({
      data: {
        authenticatedUserId: 'socket-user',
        authenticatedRole: 'user',
      },
      handshake: { address: '127.0.0.1' },
    } as any, { domain: 'personal', orgId: '' });
    expect(loopbackWithoutProof).toMatchObject({
      authenticated: true,
      localExecution: false,
      executionBoundary: 'remote_restricted',
    });

    const nativeProofVerified = buildSocketToolSecurityContext({
      data: {
        authenticatedUserId: 'socket-user',
        authenticatedRole: 'admin',
        trustedLocalExecution: true,
      },
      handshake: { address: '192.0.2.10' },
    } as any, { domain: 'personal', orgId: '' });
    expect(nativeProofVerified).toMatchObject({
      authenticated: true,
      authRole: 'admin',
      localExecution: true,
      executionBoundary: 'trusted_local',
    });
  });

  it('does not mount the direct host terminal for an ordinary authenticated socket', () => {
    const remoteEvents: string[] = [];
    registerTerminalHandlers({
      data: { authenticatedUserId: 'remote-terminal-user' },
      on: (event: string) => remoteEvents.push(event),
    }, () => 'remote-terminal-user');
    expect(remoteEvents).toEqual([]);

    const nativeEvents: string[] = [];
    registerTerminalHandlers({
      data: {
        authenticatedUserId: 'native-terminal-user',
        trustedLocalExecution: true,
      },
      on: (event: string) => nativeEvents.push(event),
    }, () => 'native-terminal-user');
    expect(nativeEvents).toEqual(expect.arrayContaining([
      'terminal:create',
      'terminal:input',
      'terminal:resize',
      'terminal:destroy',
    ]));
  });

  it('rejects a remote socket that tries to register itself as a desktop relay target', () => {
    const handlers = new Map<string, (...args: any[]) => void>();
    const emitted: Array<{ event: string; payload: any }> = [];
    const socket = {
      id: 'remote-fake-desktop-socket',
      data: { authenticatedUserId: 'remote-fake-desktop-user' },
      handshake: { auth: {}, address: '127.0.0.1' },
      on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler),
      emit: (event: string, payload: any) => emitted.push({ event, payload }),
      join: vi.fn(),
    } as any;

    registerDeviceHandlers(socket, () => 'remote-fake-desktop-user', {} as any);
    handlers.get('device:register')?.({
      name: 'forged desktop',
      type: 'desktop',
      capabilities: { filesystem: true, shell: true },
    });

    expect(socket.join).not.toHaveBeenCalled();
    expect(emitted).toContainEqual({
      event: 'device:registration_error',
      payload: expect.objectContaining({ code: 'DESKTOP_SESSION_PROOF_REQUIRED' }),
    });
  });
});
