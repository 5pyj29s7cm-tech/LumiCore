import { execFileSync, execSync } from 'node:child_process';

/**
 * Host inspection process adapter. Callers may decide which facts to collect,
 * but only this adapter owns OS process execution. It is deliberately read-only
 * and returns an empty result when a probe is unavailable or times out.
 */
export function runHostProbeCommand(command: string, timeoutMs = 15_000): string {
  try {
    return execSync(command, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

export function runWindowsPowerShellText(script: string, timeoutMs = 5_000): string {
  if (process.platform !== 'win32') return '';
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
    ).trim();
  } catch {
    return '';
  }
}

export function runWindowsPowerShellJson(script: string, timeoutMs = 2_500): unknown {
  const utf8Script = [
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    script,
  ].join('\n');
  const output = runWindowsPowerShellText(utf8Script, timeoutMs);
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

export function queryWindowsGpuName(timeoutMs = 5_000): string {
  return runWindowsPowerShellText(
    "Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Idd|Indirect|Mirror|Virtual' } | Select-Object -First 1 -ExpandProperty Name",
    timeoutMs,
  );
}
