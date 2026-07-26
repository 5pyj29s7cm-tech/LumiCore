import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type {
  CalendarCreateInput,
  CalendarModifyInput,
  ProductivityAdapter,
} from './productivity_contract';

const execFileAsync = promisify(execFile);

const POWERSHELL_PREFIX = `
$ErrorActionPreference = 'Stop'
$payload = $env:LUMI_PRODUCTIVITY_PAYLOAD | ConvertFrom-Json
`;

async function runPowerShell(script: string, payload: object = {}): Promise<Record<string, unknown>> {
  const scriptPath = path.join(os.tmpdir(), `lumi_productivity_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}.ps1`);
  fs.writeFileSync(scriptPath, `${POWERSHELL_PREFIX}\n${script}`, 'utf8');
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ], {
      timeout: 25_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        LUMI_PRODUCTIVITY_PAYLOAD: JSON.stringify(payload),
      },
    });
    const text = String(stdout || '').trim();
    if (!text) throw new Error('The Outlook adapter returned no receipt.');
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error: any) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`Windows Outlook adapter failed: ${detail.slice(0, 500)}`);
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

const OPEN_OUTLOOK = `
$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace('MAPI')
`;

export const windowsProductivityAdapter: ProductivityAdapter = {
  id: 'windows.outlook_com',
  platform: 'windows',

  calendarToday: async () => runPowerShell(`
${OPEN_OUTLOOK}
$calendar = $ns.GetDefaultFolder(9)
$start = (Get-Date).Date
$finish = $start.AddDays(1)
$items = $calendar.Items
$items.IncludeRecurrences = $true
$items.Sort('[Start]')
$found = @()
foreach ($item in $items) {
  if ($item.Start -ge $start -and $item.Start -lt $finish) {
    $found += [PSCustomObject]@{
      id = [string]$item.EntryID
      subject = [string]$item.Subject
      start = $item.Start.ToString('o')
      end = $item.End.ToString('o')
      location = [string]$item.Location
    }
  }
}
[PSCustomObject]@{ ok = $true; status = 'observed'; provider = 'outlook'; items = $found } | ConvertTo-Json -Compress -Depth 6
`),

  upcomingEvents: async days => runPowerShell(`
${OPEN_OUTLOOK}
$calendar = $ns.GetDefaultFolder(9)
$start = (Get-Date).Date
$finish = $start.AddDays([int]$payload.days)
$items = $calendar.Items
$items.IncludeRecurrences = $true
$items.Sort('[Start]')
$found = @()
foreach ($item in $items) {
  if ($item.Start -ge $start -and $item.Start -lt $finish) {
    $found += [PSCustomObject]@{
      id = [string]$item.EntryID
      subject = [string]$item.Subject
      start = $item.Start.ToString('o')
      end = $item.End.ToString('o')
      location = [string]$item.Location
    }
  }
  if ($found.Count -ge 30) { break }
}
[PSCustomObject]@{ ok = $true; status = 'observed'; provider = 'outlook'; items = $found } | ConvertTo-Json -Compress -Depth 6
`, { days }),

  sendEmail: async input => runPowerShell(`
$outlook = New-Object -ComObject Outlook.Application
$mail = $outlook.CreateItem(0)
$mail.To = [string]$payload.to
$mail.Subject = [string]$payload.subject
$mail.Body = [string]$payload.body
$mail.Save()
$entryId = [string]$mail.EntryID
$mail.Send()
[PSCustomObject]@{ ok = $true; status = 'sent'; sent = $true; provider = 'outlook'; recipient = [string]$payload.to; messageId = $entryId } | ConvertTo-Json -Compress
`, input),

  recentEmails: async limit => runPowerShell(`
${OPEN_OUTLOOK}
$inbox = $ns.GetDefaultFolder(6)
$items = $inbox.Items
$items.Sort('[ReceivedTime]', $true)
$found = @()
foreach ($item in $items) {
  if ($found.Count -ge [int]$payload.limit) { break }
  $found += [PSCustomObject]@{
    id = [string]$item.EntryID
    from = [string]$item.SenderName
    subject = [string]$item.Subject
    received = $item.ReceivedTime.ToString('o')
    unread = [bool]$item.UnRead
  }
}
[PSCustomObject]@{ ok = $true; status = 'observed'; provider = 'outlook'; items = $found } | ConvertTo-Json -Compress -Depth 6
`, { limit }),

  createEvent: async input => runPowerShell(`
$outlook = New-Object -ComObject Outlook.Application
$item = $outlook.CreateItem(1)
$item.Subject = [string]$payload.subject
$item.Start = [DateTime]::Parse([string]$payload.start)
$item.End = [DateTime]::Parse([string]$payload.end)
$item.Location = [string]$payload.location
$item.Body = [string]$payload.body
$item.ReminderSet = $true
$item.ReminderMinutesBeforeStart = [int]$payload.reminderMinutes
$item.AllDayEvent = [bool]$payload.allDay
$item.Save()
[PSCustomObject]@{ ok = $true; status = 'created'; created = $true; provider = 'outlook'; eventId = [string]$item.EntryID; subject = [string]$item.Subject } | ConvertTo-Json -Compress
`, input),

  modifyEvent: async input => runPowerShell(`
${OPEN_OUTLOOK}
$calendar = $ns.GetDefaultFolder(9)
$calendar.Items.IncludeRecurrences = $true
$found = $null
foreach ($item in $calendar.Items) {
  if ($item.Subject -eq [string]$payload.subject -and $item.Start -ge [DateTime]::Now.AddDays(-1)) { $found = $item; break }
}
if (-not $found) {
  [PSCustomObject]@{ ok = $false; status = 'not_found'; updated = $false; provider = 'outlook'; subject = [string]$payload.subject } | ConvertTo-Json -Compress
  exit 0
}
if ($null -ne $payload.newSubject -and [string]$payload.newSubject) { $found.Subject = [string]$payload.newSubject }
if ($null -ne $payload.newStart -and [string]$payload.newStart) { $found.Start = [DateTime]::Parse([string]$payload.newStart) }
if ($null -ne $payload.newEnd -and [string]$payload.newEnd) { $found.End = [DateTime]::Parse([string]$payload.newEnd) }
if ($null -ne $payload.newLocation) { $found.Location = [string]$payload.newLocation }
if ($null -ne $payload.newBody) { $found.Body = [string]$payload.newBody }
$found.Save()
[PSCustomObject]@{ ok = $true; status = 'updated'; updated = $true; provider = 'outlook'; eventId = [string]$found.EntryID; subject = [string]$found.Subject } | ConvertTo-Json -Compress
`, input),

  deleteEvent: async input => runPowerShell(`
${OPEN_OUTLOOK}
$calendar = $ns.GetDefaultFolder(9)
$calendar.Items.IncludeRecurrences = $true
$found = $null
foreach ($item in $calendar.Items) {
  if ($item.Subject -eq [string]$payload.subject) { $found = $item; break }
}
if (-not $found) {
  [PSCustomObject]@{ ok = $false; status = 'not_found'; deleted = $false; provider = 'outlook'; subject = [string]$payload.subject } | ConvertTo-Json -Compress
  exit 0
}
$eventId = [string]$found.EntryID
$found.Delete()
[PSCustomObject]@{ ok = $true; status = 'deleted'; deleted = $true; provider = 'outlook'; eventId = $eventId; subject = [string]$payload.subject } | ConvertTo-Json -Compress
`, input),
};
