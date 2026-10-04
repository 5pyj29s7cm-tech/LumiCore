import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

describe.skipIf(process.platform !== 'win32')('Windows deployment command failures', () => {
  it.each([0, 7])('stops the pipeline exactly when a native command exits with %i', exitCode => {
    // Load only the checked-command function: no build, install or shortcut runs.
    const source = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psQuote(path.resolve('scripts/deploy-windows.ps1'))}, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Deployment script has syntax errors' }
$definition = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Invoke-CheckedNativeCommand' }, $true)
Invoke-Expression $definition.Extent.Text
try {
  Invoke-CheckedNativeCommand -FilePath ${psQuote(process.execPath)} -ArgumentList @('-e', 'process.exit(${exitCode})')
  Write-Output 'continued-after-command'
} catch {
  Write-Output $_.Exception.Message
}
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    if (exitCode === 0) expect(result.stdout).toContain('continued-after-command');
    else {
      expect(result.stdout).toContain('failed with exit code 7. Deployment stopped.');
      expect(result.stdout).not.toContain('continued-after-command');
    }
  }, 20_000);

  it('preserves spaces, embedded quotes and trailing backslashes in native arguments', () => {
    const argumentsToCheck = ['space separated value', 'embedded"quote', 'D:\\folder with spaces\\', ''];
    const source = `
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psQuote(path.resolve('scripts/deploy-windows.ps1'))}, [ref]$tokens, [ref]$parseErrors)
$definition = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Invoke-CheckedNativeCommand' }, $true)
Invoke-Expression $definition.Extent.Text
Invoke-CheckedNativeCommand -FilePath ${psQuote(process.execPath)} -ArgumentList @('-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ${argumentsToCheck.map(psQuote).join(', ')})
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(argumentsToCheck);
  }, 20_000);

  it.each([0, 7])('also captures a cmd wrapper exit code %i', exitCode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-native-exit-'));
    try {
      const command = path.join(root, 'fixture with spaces.cmd');
      fs.writeFileSync(command, `@echo off\r\nexit /b ${exitCode}\r\n`);
      const source = `
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psQuote(path.resolve('scripts/deploy-windows.ps1'))}, [ref]$tokens, [ref]$parseErrors)
$definition = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Invoke-CheckedNativeCommand' }, $true)
Invoke-Expression $definition.Extent.Text
try {
  Invoke-CheckedNativeCommand -FilePath ${psQuote(command)}
  Write-Output 'continued-after-command'
} catch { Write-Output $_.Exception.Message }
`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
        encoding: 'utf8', windowsHide: true, timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      if (exitCode === 0) expect(result.stdout).toContain('continued-after-command');
      else {
        expect(result.stdout).toContain('failed with exit code 7. Deployment stopped.');
        expect(result.stdout).not.toContain('continued-after-command');
      }
    } finally {
      if (!fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup');
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
