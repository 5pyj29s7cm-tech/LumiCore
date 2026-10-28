import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WINDOWS_PRINTER_POWERSHELL } from './printer_inventory';

export const PRINTER_TEST_PAGE_LINES = [
  'Lumi - Windows Driver Test Page',
  'This page was rendered through the selected installed Windows printer driver.',
  'One page, one copy. No queue, port, driver or default-printer settings were changed.',
  'Check the paper output at the printer. Spooler submission alone does not prove physical completion.',
] as const;
export const PRINTER_JOB_LIMITATIONS = [
  'Only the built-in single-page test is supported; arbitrary DOCX/PDF documents are not rendered by this capability.',
  'A submitted or disappearing spooler job does not independently verify physical paper output.',
  'An unknown submission outcome must be checked before any new print request; this capability never automatically retries.',
] as const;
export interface PrinterJobExecOptions { encoding: 'utf8'; timeout: number; maxBuffer: number; windowsHide: true; env: NodeJS.ProcessEnv }
export type PrinterJobExecRunner = (executable: string, args: string[], options: PrinterJobExecOptions) => Promise<{ stdout: string; stderr?: string }>;
export interface PrinterJobOwnerOptions { platform?: NodeJS.Platform; execRunner?: PrinterJobExecRunner; requestId?: () => string }
export interface PrinterJobQueue { name: string; driverName: string | null; portName: string | null }
export interface PrinterJobError { code: string; message: string; win32ErrorCode?: number }
interface PrinterJobBase {
  ok: boolean; supported: boolean; platform: string; observedAt: string; printerName: string; jobId: number | null;
  queue: PrinterJobQueue | null; physicalCompletionVerified: false; errors: PrinterJobError[]; limitations: string[];
}
export interface PrinterTestPageResult extends PrinterJobBase {
  source: 'windows_gdi'; status: 'submitted' | 'not_submitted' | 'submission_unknown' | 'unsupported';
  requestId: string; documentName: string; pages: 1; copies: 1;
  submission: { startDocSucceeded: boolean; endDocSucceeded: boolean; abortDocAttempted: boolean; abortDocResult: number | null; phase: string } | null;
}
export interface PrinterJobStatusResult extends PrinterJobBase {
  source: 'windows_spooler_getjob'; status: 'job_observed' | 'not_observed' | 'unavailable' | 'unsupported';
  /** Raw GetJob result when supplied; an absence observation is not an operation failure. */
  win32ResultCode: number | null;
  job: { id: number; statusFlags: number; statusText: string | null; totalPages: number; pagesPrinted: number; submittedAt: string | null } | null;
}

// Microsoft GDI StartDoc supplies the exact job id; GetJob reads that queue/id.
// https://learn.microsoft.com/windows/win32/api/wingdi/nf-wingdi-startdocw
// https://learn.microsoft.com/windows/win32/printdocs/documentproperties
// https://learn.microsoft.com/windows/win32/printdocs/getjob
export const WINDOWS_PRINTER_GDI_BRIDGE = String.raw`using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public interface ILumiPrintPageApi {
  int StartDoc(IntPtr dc, string name);
  int StartPage(IntPtr dc);
  void DrawPage(IntPtr dc, string[] lines);
  int EndPage(IntPtr dc);
  int EndDoc(IntPtr dc);
  int AbortDoc(IntPtr dc);
  int LastError { get; }
}
public sealed class LumiPrintSubmission {
  public int JobId;
  public bool StartDocSucceeded;
  public bool Submitted;
  public bool AbortDocAttempted;
  public int? AbortDocResult;
  public string Phase = "prepare";
  public string Error;
  public int? Win32ErrorCode;
}
public sealed class LumiPrintJobObservation {
  public bool Found;
  public int JobId;
  public uint StatusFlags;
  public string StatusText;
  public uint TotalPages;
  public uint PagesPrinted;
  public string SubmittedAt;
  public int? Win32ErrorCode;
}
public static class LumiPrinterGdi {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct DocInfo {
    public int Size;
    [MarshalAs(UnmanagedType.LPWStr)] public string Name;
    [MarshalAs(UnmanagedType.LPWStr)] public string Output;
    [MarshalAs(UnmanagedType.LPWStr)] public string DataType;
    public uint Type;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct DevModePrefix {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    public ushort SpecVersion, DriverVersion, Size, DriverExtra;
    public uint Fields;
    public short Orientation, PaperSize, PaperLength, PaperWidth, Scale, Copies;
  }
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] private struct SystemTime { public ushort Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct JobInfo {
    public uint JobId;
    public IntPtr PrinterName, MachineName, UserName, Document, DataType, StatusText;
    public uint Status, Priority, Position, TotalPages, PagesPrinted;
    public SystemTime Submitted;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] private static extern bool ClosePrinter(IntPtr printer);
  [DllImport("winspool.drv", EntryPoint = "DocumentPropertiesW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern int DocumentProperties(IntPtr window, IntPtr printer, string name, IntPtr output, IntPtr input, uint mode);
  [DllImport("winspool.drv", EntryPoint = "GetJobW", SetLastError = true)]
  private static extern bool GetJob(IntPtr printer, uint id, uint level, IntPtr output, uint size, out uint needed);
  [DllImport("winspool.drv", EntryPoint = "DeviceCapabilitiesW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern int DeviceCapabilities(string device, string port, ushort capability, IntPtr output, IntPtr devMode);
  [DllImport("gdi32.dll", EntryPoint = "CreateDCW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern IntPtr CreateDC(string driver, string device, string output, IntPtr devMode);
  [DllImport("gdi32.dll", SetLastError = true)] private static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll", EntryPoint = "StartDocW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern int NativeStartDoc(IntPtr dc, ref DocInfo info);
  [DllImport("gdi32.dll", EntryPoint = "StartPage", SetLastError = true)] private static extern int NativeStartPage(IntPtr dc);
  [DllImport("gdi32.dll", EntryPoint = "EndPage", SetLastError = true)] private static extern int NativeEndPage(IntPtr dc);
  [DllImport("gdi32.dll", EntryPoint = "EndDoc", SetLastError = true)] private static extern int NativeEndDoc(IntPtr dc);
  [DllImport("gdi32.dll", EntryPoint = "AbortDoc", SetLastError = true)] private static extern int NativeAbortDoc(IntPtr dc);
  [DllImport("gdi32.dll")] private static extern int GetDeviceCaps(IntPtr dc, int index);
  [DllImport("gdi32.dll", EntryPoint = "CreateFontW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern IntPtr CreateFont(int height, int width, int escapement, int orientation, int weight, uint italic, uint underline, uint strikeOut, uint charset, uint outPrecision, uint clipPrecision, uint quality, uint pitchAndFamily, string face);
  [DllImport("gdi32.dll", SetLastError = true)] private static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
  [DllImport("gdi32.dll", SetLastError = true)] private static extern bool DeleteObject(IntPtr value);
  [DllImport("user32.dll", EntryPoint = "DrawTextW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern int DrawText(IntPtr dc, string text, int count, ref Rect rect, uint format);

  private sealed class NativePageApi : ILumiPrintPageApi {
    public int LastError { get { return Marshal.GetLastWin32Error(); } }
    public int StartDoc(IntPtr dc, string name) {
      DocInfo info = new DocInfo { Size = Marshal.SizeOf(typeof(DocInfo)), Name = name };
      return NativeStartDoc(dc, ref info);
    }
    public int StartPage(IntPtr dc) { return NativeStartPage(dc); }
    public int EndPage(IntPtr dc) { return NativeEndPage(dc); }
    public int EndDoc(IntPtr dc) { return NativeEndDoc(dc); }
    public int AbortDoc(IntPtr dc) { return NativeAbortDoc(dc); }
    public void DrawPage(IntPtr dc, string[] lines) {
      int dpiX = GetDeviceCaps(dc, 88), dpiY = GetDeviceCaps(dc, 90);
      int width = GetDeviceCaps(dc, 8), height = GetDeviceCaps(dc, 10);
      if (dpiX <= 0 || dpiY <= 0 || width <= 0 || height <= 0) throw new InvalidOperationException("Printer driver returned invalid page metrics.");
      IntPtr font = CreateFont(-Math.Max(12, dpiY * 11 / 72), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, "Segoe UI");
      if (font == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFont failed.");
      IntPtr previous = SelectObject(dc, font);
      try {
        if (previous == IntPtr.Zero || previous == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "SelectObject failed.");
        Rect rect = new Rect { Left = Math.Min(dpiX / 2, width / 10), Top = Math.Min(dpiY / 2, height / 10), Right = width - Math.Min(dpiX / 2, width / 10), Bottom = height - Math.Min(dpiY / 2, height / 10) };
        string text = String.Join("\r\n\r\n", lines);
        // DT_WORDBREAK | DT_NOPREFIX. GDI renders through the selected installed driver.
        if (DrawText(dc, text, text.Length, ref rect, 0x10 | 0x800) <= 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "DrawText failed.");
      } finally { if (previous != IntPtr.Zero && previous != new IntPtr(-1)) SelectObject(dc, previous); DeleteObject(font); }
    }
  }

  // The lifecycle seam lets offline tests execute failure/AbortDoc paths without opening a printer.
  public static LumiPrintSubmission Render(ILumiPrintPageApi api, IntPtr dc, string name, string[] lines) {
    LumiPrintSubmission result = new LumiPrintSubmission();
    try {
      result.Phase = "start_doc";
      result.JobId = api.StartDoc(dc, name);
      if (result.JobId <= 0) throw new Win32Exception(api.LastError, "StartDoc failed.");
      result.StartDocSucceeded = true;
      result.Phase = "start_page";
      if (api.StartPage(dc) <= 0) throw new Win32Exception(api.LastError, "StartPage failed.");
      result.Phase = "render_page"; api.DrawPage(dc, lines);
      result.Phase = "end_page";
      if (api.EndPage(dc) <= 0) throw new Win32Exception(api.LastError, "EndPage failed.");
      result.Phase = "end_doc";
      if (api.EndDoc(dc) <= 0) throw new Win32Exception(api.LastError, "EndDoc failed.");
      result.Submitted = true; result.Phase = "submitted";
    } catch (Exception error) {
      result.Error = error.Message;
      Win32Exception native = error as Win32Exception;
      if (native != null) result.Win32ErrorCode = native.NativeErrorCode;
    } finally {
      if (result.StartDocSucceeded && !result.Submitted) {
        result.AbortDocAttempted = true;
        try { result.AbortDocResult = api.AbortDoc(dc); } catch (Exception error) { result.Error += " AbortDoc: " + error.Message; }
      }
    }
    return result;
  }

  public static bool AcceptsOneCopy(uint fields, int copies, int maximumCopies) {
    return (fields & 0x100) != 0 ? copies == 1 : maximumCopies == 1;
  }

  public static LumiPrintSubmission Submit(string printerName, string portName, string documentName, string[] lines) {
    IntPtr printer = IntPtr.Zero, mode = IntPtr.Zero, dc = IntPtr.Zero;
    try {
      if (!OpenPrinter(printerName, out printer, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed.");
      int bytes = DocumentProperties(IntPtr.Zero, printer, printerName, IntPtr.Zero, IntPtr.Zero, 0);
      if (bytes < Marshal.SizeOf(typeof(DevModePrefix)) || bytes > 1048576) throw new InvalidOperationException("Invalid printer DEVMODE size.");
      mode = Marshal.AllocHGlobal(bytes);
      if (DocumentProperties(IntPtr.Zero, printer, printerName, mode, IntPtr.Zero, 2) != 1) throw new InvalidOperationException("Printer driver settings could not be read.");
      DevModePrefix settings = (DevModePrefix)Marshal.PtrToStructure(mode, typeof(DevModePrefix));
      if (settings.Size < Marshal.SizeOf(typeof(DevModePrefix))) throw new InvalidOperationException("Printer driver DEVMODE is too short.");
      // Application-local DM_COPIES override, merged by the driver. No SetPrinter/default change.
      Marshal.WriteInt32(mode, (int)Marshal.OffsetOf(typeof(DevModePrefix), "Fields"), unchecked((int)(settings.Fields | 0x100)));
      Marshal.WriteInt16(mode, (int)Marshal.OffsetOf(typeof(DevModePrefix), "Copies"), 1);
      if (DocumentProperties(IntPtr.Zero, printer, printerName, mode, mode, 2 | 8) != 1) throw new InvalidOperationException("Printer driver rejected per-job settings.");
      settings = (DevModePrefix)Marshal.PtrToStructure(mode, typeof(DevModePrefix));
      // A cleared bit makes dmCopies meaningless; allow a single-copy-only driver without requiring that field.
      int maximumCopies = (settings.Fields & 0x100) != 0 ? 0 : DeviceCapabilities(printerName, portName, 18, IntPtr.Zero, mode);
      if (!AcceptsOneCopy(settings.Fields, settings.Copies, maximumCopies)) throw new InvalidOperationException("Printer driver did not accept one-copy job settings.");
      dc = CreateDC("WINSPOOL", printerName, null, mode);
      if (dc == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDC failed.");
      return Render(new NativePageApi(), dc, documentName, lines);
    } catch (Exception error) {
      Win32Exception native = error as Win32Exception;
      return new LumiPrintSubmission { Error = error.Message, Win32ErrorCode = native == null ? (int?)null : native.NativeErrorCode };
    } finally {
      if (dc != IntPtr.Zero) DeleteDC(dc);
      if (mode != IntPtr.Zero) Marshal.FreeHGlobal(mode);
      if (printer != IntPtr.Zero) ClosePrinter(printer);
    }
  }

  public static LumiPrintJobObservation ReadJob(string printerName, int id) {
    IntPtr printer = IntPtr.Zero, buffer = IntPtr.Zero;
    try {
      if (!OpenPrinter(printerName, out printer, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed.");
      uint needed;
      bool initial = GetJob(printer, (uint)id, 1, IntPtr.Zero, 0, out needed);
      int error = Marshal.GetLastWin32Error();
      if (!initial && (error == 2 || error == 87)) return new LumiPrintJobObservation { JobId = id, Win32ErrorCode = error };
      if (!initial && error != 122) throw new Win32Exception(error, "GetJob size query failed.");
      if (needed < Marshal.SizeOf(typeof(JobInfo)) || needed > 1048576) throw new InvalidOperationException("Invalid GetJob response size.");
      buffer = Marshal.AllocHGlobal((int)needed);
      if (!GetJob(printer, (uint)id, 1, buffer, needed, out needed)) {
        error = Marshal.GetLastWin32Error();
        if (error == 2 || error == 87) return new LumiPrintJobObservation { JobId = id, Win32ErrorCode = error };
        throw new Win32Exception(error, "GetJob failed.");
      }
      JobInfo info = (JobInfo)Marshal.PtrToStructure(buffer, typeof(JobInfo));
      if (info.JobId != (uint)id) throw new InvalidOperationException("GetJob returned a different job identifier.");
      string submitted = null;
      if (info.Submitted.Year > 0) submitted = new DateTime(info.Submitted.Year, info.Submitted.Month, info.Submitted.Day, info.Submitted.Hour, info.Submitted.Minute, info.Submitted.Second, info.Submitted.Milliseconds, DateTimeKind.Utc).ToString("o");
      // Do not return other job owners, document names, or document content.
      return new LumiPrintJobObservation { Found = true, JobId = id, StatusFlags = info.Status, StatusText = info.StatusText == IntPtr.Zero ? null : Marshal.PtrToStringUni(info.StatusText), TotalPages = info.TotalPages, PagesPrinted = info.PagesPrinted, SubmittedAt = submitted };
    } finally { if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer); if (printer != IntPtr.Zero) ClosePrinter(printer); }
  }
}
`;

const PRINTER_JOB_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$reply = [ordered]@{ Queue=$null; Submission=$null; SubmissionAttempted=$false; Job=$null; Error=$null }
try {
  $request = ConvertFrom-Json $env:LUMI_PRINTER_JOB_REQUEST
  $queues = @(Get-Printer -ErrorAction Stop | Where-Object { [String]::Equals($_.Name, [string]$request.PrinterName, [StringComparison]::OrdinalIgnoreCase) })
  if ($queues.Count -ne 1) { throw 'The exact installed printer queue was not found.' }
  $queue = $queues[0]
  $reply.Queue = [ordered]@{ Name=[string]$queue.Name; DriverName=[string]$queue.DriverName; PortName=[string]$queue.PortName }
  Add-Type -Language CSharp -TypeDefinition @'
${WINDOWS_PRINTER_GDI_BRIDGE}
'@
  if ($request.Operation -eq 'submit') {
    if ([string]$queue.PortName -match '^(FILE:|PORTPROMPT:)$') { throw 'This queue requires an output-file dialog; select an installed physical printer queue.' }
    $reply.SubmissionAttempted = $true
    $reply.Submission = [LumiPrinterGdi]::Submit([string]$queue.Name, [string]$queue.PortName, [string]$request.DocumentName, [string[]]$request.Lines)
  } elseif ($request.Operation -eq 'status') {
    $reply.Job = [LumiPrinterGdi]::ReadJob([string]$queue.Name, [int]$request.JobId)
  } else { throw 'Unknown printer operation.' }
} catch { $reply.Error = $_.Exception.Message }
$reply | ConvertTo-Json -Depth 8 -Compress
`;

const defaultRunner: PrinterJobExecRunner = (executable, args, options) => new Promise((resolve, reject) => {
  execFile(executable, args, options, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stderr }));
    else resolve({ stdout, stderr });
  });
});
type Row = Record<string, unknown>;
function row(value: unknown): value is Row { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): string | null { return typeof value === 'string' && value.length ? value : null; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function validPrinterName(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function parseQueue(value: unknown, printerName: string): PrinterJobQueue | null {
  if (value === null) return null;
  if (!row(value) || typeof value.Name !== 'string' || value.Name.toLowerCase() !== printerName.toLowerCase()) throw new Error('Printer response did not identify the requested queue.');
  return { name: value.Name, driverName: text(value.DriverName), portName: text(value.PortName) };
}
async function execute(request: Row, options: PrinterJobOwnerOptions, timeout: number): Promise<Row> {
  // Payload is child-process data, never PowerShell source or an executable argument.
  const output = await (options.execRunner ?? defaultRunner)(WINDOWS_PRINTER_POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PRINTER_JOB_SCRIPT],
    { encoding: 'utf8', timeout, maxBuffer: 131072, windowsHide: true,
      env: { ...process.env, LUMI_PRINTER_JOB_REQUEST: JSON.stringify(request) } });
  if (typeof output.stdout !== 'string' || Buffer.byteLength(output.stdout, 'utf8') > 131072) throw new Error('Printer operation returned an invalid or oversized response.');
  const result: unknown = JSON.parse(output.stdout.replace(/^\uFEFF/, ''));
  if (!row(result) || !['Queue', 'Submission', 'Job', 'Error'].every(key => key in result)) throw new Error('Printer operation returned an invalid response.');
  return result;
}
function base(printerName: string, options: PrinterJobOwnerOptions): PrinterJobBase {
  const platform = options.platform ?? process.platform;
  return { ok: false, supported: platform === 'win32', platform, observedAt: new Date().toISOString(), printerName,
    jobId: null, queue: null, physicalCompletionVerified: false, errors: [], limitations: [...PRINTER_JOB_LIMITATIONS] };
}

/** Driver-rendered single-page test only. No retries or queue/default/driver changes. */
export async function submitPrinterTestPage(printerName: string, options: PrinterJobOwnerOptions = {}): Promise<PrinterTestPageResult> {
  const requestId = (options.requestId ?? randomUUID)();
  const result: PrinterTestPageResult = { ...base(printerName, options), source: 'windows_gdi', status: 'not_submitted',
    requestId, documentName: 'Lumi test page ' + requestId, pages: 1, copies: 1, submission: null };
  if (!result.supported) { result.status = 'unsupported'; return result; }
  if (!validPrinterName(printerName)) { result.errors.push({ code: 'invalid_printer_name', message: 'An exact installed printer queue name is required.' }); return result; }
  try {
    const reply = await execute({ Operation: 'submit', PrinterName: printerName, DocumentName: result.documentName,
      Lines: [...PRINTER_TEST_PAGE_LINES, 'Printer queue: ' + printerName, 'Request: ' + requestId, 'Created: ' + result.observedAt] }, options, 30000);
    result.queue = parseQueue(reply.Queue, printerName);
    if (text(reply.Error)) { result.status = reply.SubmissionAttempted === true ? 'submission_unknown' : 'not_submitted'; result.errors.push({ code: 'submission_failed', message: String(reply.Error) }); return result; }
    const receipt = reply.Submission;
    if (!row(receipt) || !result.queue || typeof receipt.StartDocSucceeded !== 'boolean' || typeof receipt.Submitted !== 'boolean'
      || typeof receipt.AbortDocAttempted !== 'boolean' || typeof receipt.Phase !== 'string' || !Number.isInteger(receipt.JobId)) throw new Error('Invalid GDI submission receipt.');
    const hasJob = integer(receipt.JobId) && receipt.JobId > 0;
    if (receipt.StartDocSucceeded !== hasJob || (receipt.AbortDocAttempted && !hasJob)
      || receipt.Submitted !== (receipt.Phase === 'submitted') || (receipt.Submitted && (!hasJob || receipt.AbortDocAttempted))) throw new Error('Inconsistent GDI submission receipt.');
    result.jobId = hasJob ? receipt.JobId as number : null;
    result.submission = { startDocSucceeded: receipt.StartDocSucceeded, endDocSucceeded: receipt.Submitted,
      abortDocAttempted: receipt.AbortDocAttempted, abortDocResult: typeof receipt.AbortDocResult === 'number' ? receipt.AbortDocResult : null, phase: receipt.Phase };
    if (receipt.Submitted && receipt.StartDocSucceeded && result.jobId && !receipt.AbortDocAttempted && receipt.Phase === 'submitted') {
      result.ok = true; result.status = 'submitted';
    } else {
      result.status = receipt.StartDocSucceeded ? 'submission_unknown' : 'not_submitted';
      result.errors.push({ code: 'submission_failed', message: text(receipt.Error) ?? 'The GDI print job was not confirmed as submitted.',
        ...(integer(receipt.Win32ErrorCode) ? { win32ErrorCode: receipt.Win32ErrorCode } : {}) });
    }
  } catch (error) {
    // A timeout/invalid acknowledgement can occur after StartDoc: never re-submit automatically.
    const code = row(error) ? error.code : undefined;
    result.status = code === 'ENOENT' || code === 'EACCES' ? 'not_submitted' : 'submission_unknown';
    result.errors.push({ code: result.status, message: message(error) });
  }
  return result;
}

/** Observe one exact queue/job id; not_observed is never proof of physical completion. */
export async function readPrinterJobStatus(printerName: string, jobId: number, options: PrinterJobOwnerOptions = {}): Promise<PrinterJobStatusResult> {
  const result: PrinterJobStatusResult = { ...base(printerName, options), source: 'windows_spooler_getjob', status: 'unavailable', jobId, job: null, win32ResultCode: null };
  if (!result.supported) { result.status = 'unsupported'; return result; }
  if (!validPrinterName(printerName) || !Number.isInteger(jobId) || jobId < 1 || jobId > 0x7fffffff) {
    result.errors.push({ code: 'invalid_job_target', message: 'An exact installed queue name and positive Windows job id are required.' }); return result;
  }
  try {
    const reply = await execute({ Operation: 'status', PrinterName: printerName, JobId: jobId }, options, 15000);
    result.queue = parseQueue(reply.Queue, printerName);
    if (text(reply.Error)) { result.errors.push({ code: 'job_query_failed', message: String(reply.Error) }); return result; }
    const job = reply.Job;
    if (!row(job) || !result.queue || typeof job.Found !== 'boolean' || job.JobId !== jobId) throw new Error('Invalid Windows print-job receipt.');
    if (!job.Found) {
      result.win32ResultCode = integer(job.Win32ErrorCode) ? job.Win32ErrorCode as number : null;
      if (job.Win32ErrorCode !== 2 && job.Win32ErrorCode !== 87) throw new Error('Missing print job without an operating-system result code.');
      result.ok = true; result.status = 'not_observed';
      return result;
    }
    if (![job.StatusFlags, job.TotalPages, job.PagesPrinted].every(integer)) throw new Error('Invalid Windows print-job counters.');
    result.ok = true; result.status = 'job_observed';
    result.job = { id: jobId, statusFlags: job.StatusFlags as number, statusText: text(job.StatusText), totalPages: job.TotalPages as number, pagesPrinted: job.PagesPrinted as number, submittedAt: text(job.SubmittedAt) };
  } catch (error) { result.errors.push({ code: 'job_query_failed', message: message(error) }); }
  return result;
}
