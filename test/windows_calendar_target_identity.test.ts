import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
const source = fs.readFileSync('server/adapters/windows_productivity.ts', 'utf8');
const selector = source.split('const TARGET_OUTLOOK_EVENT = `')[1].split('\n`;')[0];
const deleteBody = source.match(/deleteEvent: async input => runPowerShell\(`[\s\S]*?\$\{TARGET_OUTLOOK_EVENT\}([\s\S]*?)`, input\)/)![1];
function receipt(input: any) {
  // Execute the actual selector/delete script with synthetic COM-shaped objects.
  // No Outlook process, profile, calendar, or external application is accessed.
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(input)).toString('base64')}')) | ConvertFrom-Json
$calendar = [PSCustomObject]@{ EntryID = 'calendar-a'; StoreID = 'store-a' }
$old = [PSCustomObject]@{ EntryID = 'old'; Subject = 'Weekly sync'; Parent = $calendar; IsRecurring = $false }
$intended = [PSCustomObject]@{ EntryID = 'intended'; Subject = 'Weekly sync'; Parent = $calendar; IsRecurring = $false }
$old | Add-Member ScriptMethod Delete { throw 'Wrong calendar event was selected' }
$intended | Add-Member ScriptMethod Delete { $global:deleted = 'intended' }
$ns = [PSCustomObject]@{ Calendar = $calendar; Events = @($old, $intended) }
$ns | Add-Member ScriptMethod GetDefaultFolder { param($kind) return $this.Calendar }
$ns | Add-Member ScriptMethod GetItemFromID { param($id, $store) return $this.Events | Where-Object { $_.EntryID -eq $id } }
${selector}
${deleteBody}
`;
  if (/New-Object\s+-ComObject/i.test(script)) throw new Error('Test cannot access COM.');
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim());
}
describe.skipIf(process.platform !== 'win32')('Outlook stable target selector with synthetic objects', () => {
  it('deletes only the observed event id among duplicate subjects', () => {
    expect(receipt({ subject: 'Weekly sync', eventId: 'intended', calendarId: 'calendar-a' })).toMatchObject({ status: 'deleted', eventId: 'intended', calendarId: 'calendar-a' });
  });
  it.each([
    [{ subject: 'Weekly sync' }, 'target_required'],
    [{ subject: 'Weekly sync', eventId: 'intended', calendarId: 'wrong' }, 'not_found'],
    [{ subject: 'Changed', eventId: 'intended', calendarId: 'calendar-a' }, 'stale_target'],
  ])('refuses missing or mismatched identity (%j)', (input, status) => {
    expect(receipt(input)).toMatchObject({ ok: false, status });
  });
});
