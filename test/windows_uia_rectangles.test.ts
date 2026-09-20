import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

describe.skipIf(process.platform !== 'win32')('Windows UIA rectangle serialization', () => {
  it('emits valid JSON for empty accessibility bounds and retains negative-monitor coordinates', () => {
    const source = readFileSync(new URL('../server/external_control/windows_uia.ts', import.meta.url), 'utf8');
    const functions = [...source.matchAll(/function RectToMap\(\$rect\) \{[\s\S]*?\n\}/gu)].map(match => match[0]);
    expect(functions).toHaveLength(2);
    for (const fn of functions) {
      const script = `Add-Type -AssemblyName WindowsBase\n${fn}\n[ordered]@{empty=(RectToMap ([System.Windows.Rect]::Empty)); negative=(RectToMap ([System.Windows.Rect]::new(-1900,0,1800,900)))} | ConvertTo-Json -Depth 5 -Compress`;
      const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }));
      expect(result.empty).toBeNull();
      expect(result.negative).toMatchObject({ x: -1900, y: 0, width: 1800, height: 900, right: -100 });
    }
  });
});
