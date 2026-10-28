import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { submitPrinterTestPage, readPrinterJobStatus, WINDOWS_PRINTER_GDI_BRIDGE } from '../server/devices/printer_jobs';

const queue = { Name: 'Fixture network queue', DriverName: 'Fixture driver', PortName: 'WSD-fixture' };
function reply(overrides: Record<string, unknown> = {}) {
  return { Queue: queue, SubmissionAttempted: true,
    Submission: { JobId: 73, StartDocSucceeded: true, Submitted: true, AbortDocAttempted: false, AbortDocResult: null, Phase: 'submitted', Error: null, Win32ErrorCode: null },
    Job: null, Error: null, ...overrides };
}
function fixture(output: unknown = reply()) {
  const execRunner = vi.fn(async () => ({ stdout: typeof output === 'string' ? output : JSON.stringify(output), stderr: '' }));
  return { execRunner, options: { platform: 'win32' as const, execRunner, requestId: () => 'offline-test-request' } };
}

describe('Windows driver test-page submission owner', () => {
  it('returns the exact GDI job id only after StartDoc and EndDoc succeeded', async () => {
    const { execRunner, options } = fixture();
    const result = await submitPrinterTestPage(queue.Name, options);
    expect(result).toMatchObject({ ok: true, status: 'submitted', source: 'windows_gdi', jobId: 73, pages: 1, copies: 1, physicalCompletionVerified: false,
      queue: { name: queue.Name, driverName: queue.DriverName, portName: queue.PortName }, submission: { startDocSucceeded: true, endDocSucceeded: true, abortDocAttempted: false } });
    expect(execRunner).toHaveBeenCalledTimes(1);
    const [executable, args, config] = execRunner.mock.calls[0] as unknown as [string, string[], any];
    expect(executable).toBe('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    expect(config).toMatchObject({ encoding: 'utf8', timeout: 30000, maxBuffer: 131072, windowsHide: true });
    expect(JSON.parse(config.env.LUMI_PRINTER_JOB_REQUEST)).toMatchObject({ Operation: 'submit', PrinterName: queue.Name, DocumentName: result.documentName });
    expect(args[4]).not.toMatch(/Set-Printer|SetDefaultPrinter|Remove-PrintJob|SetJob|StartDocPrinter|WritePrinter|Out-Printer/);
  });

  it('passes quote/dollar/backtick-bearing queue names only as JSON child data', async () => {
    const name = "Queue ' "+'`'+" $([not-a-command]) ; name";
    const { execRunner, options } = fixture(reply({ Queue: { ...queue, Name: name } }));
    expect((await submitPrinterTestPage(name, options)).status).toBe('submitted');
    const [, args, config] = execRunner.mock.calls[0] as unknown as [string, string[], any];
    expect(args.join(' ')).not.toContain(name);
    expect(JSON.parse(config.env.LUMI_PRINTER_JOB_REQUEST).PrinterName).toBe(name);
  });

  it.each(['', 'x'.repeat(1025), 'queue\nname', 'queue\u0000name'])('rejects an invalid queue name before process creation', async name => {
    const { execRunner, options } = fixture();
    expect(await submitPrinterTestPage(name, options)).toMatchObject({ ok: false, status: 'not_submitted', jobId: null });
    expect(execRunner).not.toHaveBeenCalled();
  });

  it('does not execute printing on unsupported hosts', async () => {
    const { execRunner, options } = fixture();
    expect((await submitPrinterTestPage(queue.Name, { ...options, platform: 'linux' })).status).toBe('unsupported');
    expect(execRunner).not.toHaveBeenCalled();
  });

  it('keeps queue/driver preparation rejection distinct from an attempted print', async () => {
    const { execRunner, options } = fixture(reply({ Queue: null, Submission: null, SubmissionAttempted: false, Error: 'Exact installed queue not found' }));
    expect(await submitPrinterTestPage(queue.Name, options)).toMatchObject({ ok: false, status: 'not_submitted', jobId: null, errors: [{ code: 'submission_failed', message: 'Exact installed queue not found' }] });
    expect(execRunner).toHaveBeenCalledTimes(1);
  });

  it('keeps an unsuccessful StartDoc result and its native error', async () => {
    const { options } = fixture(reply({ Submission: { JobId: 0, StartDocSucceeded: false, Submitted: false, AbortDocAttempted: false, AbortDocResult: null, Phase: 'start_doc', Error: 'StartDoc failed.', Win32ErrorCode: 5 } }));
    expect(await submitPrinterTestPage(queue.Name, options)).toMatchObject({ ok: false, status: 'not_submitted', jobId: null, submission: { phase: 'start_doc', abortDocAttempted: false }, errors: [{ win32ErrorCode: 5 }] });
  });

  it.each([1, 0])('preserves failures after StartDoc and the actual AbortDoc return %j', async abortResult => {
    const { options } = fixture(reply({ Submission: { JobId: 73, StartDocSucceeded: true, Submitted: false, AbortDocAttempted: true, AbortDocResult: abortResult, Phase: 'end_doc', Error: 'EndDoc failed.', Win32ErrorCode: 5 } }));
    expect(await submitPrinterTestPage(queue.Name, options)).toMatchObject({ ok: false, status: 'submission_unknown', jobId: 73,
      submission: { startDocSucceeded: true, endDocSucceeded: false, abortDocAttempted: true, abortDocResult: abortResult }, physicalCompletionVerified: false });
  });

  it('does not mislabel an exception after entering submission as never submitted', async () => {
    const { options } = fixture(reply({ Submission: null, Error: 'Print bridge call failed after entry' }));
    expect((await submitPrinterTestPage(queue.Name, options)).status).toBe('submission_unknown');
  });

  it('returns unknown on a timeout and never retries an ambiguous physical action', async () => {
    const { execRunner, options } = fixture();
    execRunner.mockRejectedValueOnce(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT', killed: true }));
    expect(await submitPrinterTestPage(queue.Name, options)).toMatchObject({ ok: false, status: 'submission_unknown', jobId: null, physicalCompletionVerified: false });
    expect(execRunner).toHaveBeenCalledTimes(1);
  });

  it.each(['not json', JSON.stringify(reply({ Queue: { ...queue, Name: 'Different queue' } })), JSON.stringify(reply({ Submission: { JobId: 0, StartDocSucceeded: false, Submitted: true, AbortDocAttempted: false, Phase: 'submitted' } }))])('keeps damaged/mismatched acknowledgements unknown', async output => {
    const { options } = fixture(output);
    expect((await submitPrinterTestPage(queue.Name, options)).status).toBe('submission_unknown');
  });
});

describe('exact Windows print-job observation', () => {
  it('keeps native flags/counters including zero without claiming paper completion', async () => {
    const { execRunner, options } = fixture(reply({ Submission: null, Job: { Found: true, JobId: 73, StatusFlags: 0, StatusText: null, TotalPages: 1, PagesPrinted: 0, SubmittedAt: '2026-10-28T00:00:00.000Z' } }));
    expect(await readPrinterJobStatus(queue.Name, 73, options)).toMatchObject({ ok: true, status: 'job_observed', physicalCompletionVerified: false,
      job: { id: 73, statusFlags: 0, totalPages: 1, pagesPrinted: 0 } });
    const [, , config] = execRunner.mock.calls[0] as unknown as [string, string[], any];
    expect(config.timeout).toBe(15000);
    expect(JSON.parse(config.env.LUMI_PRINTER_JOB_REQUEST)).toEqual({ Operation: 'status', PrinterName: queue.Name, JobId: 73 });
  });

  it.each([2, 87])('treats a timestamped missing-job observation as valid without claiming completion (Win32 %j)', async code => {
    const { options } = fixture(reply({ Submission: null, Job: { Found: false, JobId: 73, Win32ErrorCode: code } }));
    expect(await readPrinterJobStatus(queue.Name, 73, options)).toMatchObject({ ok: true, status: 'not_observed', job: null, physicalCompletionVerified: false, win32ResultCode: code, errors: [] });
  });

  it('allows a later fresh query after a job was not observed, without declaring permanent absence', async () => {
    const { execRunner, options } = fixture(reply({ Submission: null, Job: { Found: false, JobId: 73, Win32ErrorCode: 87 } }));
    expect(await readPrinterJobStatus(queue.Name, 73, options)).toMatchObject({ok:true,status:'not_observed',physicalCompletionVerified:false});
    execRunner.mockResolvedValueOnce({ stdout: JSON.stringify(reply({ Submission:null, Job:{Found:true,JobId:73,StatusFlags:0,StatusText:null,TotalPages:1,PagesPrinted:0,SubmittedAt:null} })), stderr:'' });
    expect(await readPrinterJobStatus(queue.Name, 73, options)).toMatchObject({ok:true,status:'job_observed',physicalCompletionVerified:false,job:{id:73,pagesPrinted:0}});
    expect(execRunner).toHaveBeenCalledTimes(2);
  });

  it('keeps denied query and wrong-id receipts unavailable', async () => {
    const denied = fixture(reply({ Job: null, Error: 'GetJob access denied' }));
    expect((await readPrinterJobStatus(queue.Name, 73, denied.options)).status).toBe('unavailable');
    const wrong = fixture(reply({ Job: { Found: true, JobId: 74, StatusFlags: 0, TotalPages: 1, PagesPrinted: 0 } }));
    expect((await readPrinterJobStatus(queue.Name, 73, wrong.options)).status).toBe('unavailable');
  });

  it.each([0, -1, 1.5, 2147483648])('rejects invalid job identifiers before any process', async id => {
    const { execRunner, options } = fixture();
    expect((await readPrinterJobStatus(queue.Name, id, options)).status).toBe('unavailable');
    expect(execRunner).not.toHaveBeenCalled();
  });
});

const tempDirs: string[] = [];
afterAll(async () => { await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true }))); });
it.runIf(process.platform === 'win32')('compiles the real GDI bridge and runs its exact lifecycle/AbortDoc branches using only an offline API', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lumi-print-bridge-test-')); tempDirs.push(dir);
  const sourcePath = path.join(dir, 'bridge.cs');
  const fake = String.raw`
public sealed class OfflinePrintApi : ILumiPrintPageApi {
  public string Fail;
  public string Calls = "";
  public int LastError { get { return 5; } }
  public int StartDoc(System.IntPtr dc, string name) { Calls += "start_doc,"; return Fail == "start_doc" ? 0 : 73; }
  public int StartPage(System.IntPtr dc) { Calls += "start_page,"; return Fail == "start_page" ? 0 : 1; }
  public void DrawPage(System.IntPtr dc, string[] lines) { Calls += "draw,"; if (Fail == "draw" || Fail == "abort_throws" || Fail == "abort_zero") throw new System.InvalidOperationException("draw failed"); }
  public int EndPage(System.IntPtr dc) { Calls += "end_page,"; return Fail == "end_page" ? 0 : 1; }
  public int EndDoc(System.IntPtr dc) { Calls += "end_doc,"; return Fail == "end_doc" ? 0 : 1; }
  public int AbortDoc(System.IntPtr dc) { Calls += "abort,"; if (Fail == "abort_throws") throw new System.InvalidOperationException("abort failed"); return Fail == "abort_zero" ? 0 : 1; }
}
public static class OfflinePrintCases {
  public static object[] Run() {
    string[] cases = new string[] { "success", "start_doc", "start_page", "draw", "end_page", "end_doc", "abort_throws", "abort_zero" };
    object[] results = new object[cases.Length];
    for (int i = 0; i < cases.Length; i++) {
      OfflinePrintApi api = new OfflinePrintApi { Fail = cases[i] };
      LumiPrintSubmission result = LumiPrinterGdi.Render(api, System.IntPtr.Zero, "offline-only", new string[] { "offline-only" });
      results[i] = new { Case = cases[i], Calls = api.Calls, Receipt = result };
    }
    return results;
  }
}
`;
  await writeFile(sourcePath, WINDOWS_PRINTER_GDI_BRIDGE + fake);
  const captured = fixture(); await submitPrinterTestPage(queue.Name, captured.options);
  const scriptPath = path.join(dir, 'printer.ps1');
  await writeFile(scriptPath, (captured.execRunner.mock.calls[0] as unknown as [string, string[]])[1][4]);
  const script = "$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseFile($env:LUMI_PRINT_SCRIPT_PATH,[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){throw ($errors | Out-String)}; Add-Type -Language CSharp -TypeDefinition ([IO.File]::ReadAllText($env:LUMI_PRINT_BRIDGE_SOURCE)); [pscustomobject]@{ScriptParseErrors=$errors.Count;Cases=[OfflinePrintCases]::Run();CopiesContracts=@([LumiPrinterGdi]::AcceptsOneCopy(256,1,0),[LumiPrinterGdi]::AcceptsOneCopy(0,9,1),[LumiPrinterGdi]::AcceptsOneCopy(256,2,1),[LumiPrinterGdi]::AcceptsOneCopy(0,1,99),[LumiPrinterGdi]::AcceptsOneCopy(0,1,0),[LumiPrinterGdi]::AcceptsOneCopy(0,1,-1))} | ConvertTo-Json -Depth 8 -Compress";
  const output = await promisify(execFile)('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, LUMI_PRINT_BRIDGE_SOURCE: sourcePath, LUMI_PRINT_SCRIPT_PATH: scriptPath } });
  const parsed = JSON.parse(output.stdout);
  expect(parsed.ScriptParseErrors).toBe(0);
  expect(parsed.CopiesContracts).toEqual([true, true, false, false, false, false]);
  const cases = parsed.Cases;
  expect(cases).toHaveLength(8);
  expect(cases[0]).toMatchObject({ Calls: 'start_doc,start_page,draw,end_page,end_doc,', Receipt: { Submitted: true, JobId: 73, AbortDocAttempted: false } });
  expect(cases[1]).toMatchObject({ Calls: 'start_doc,', Receipt: { Submitted: false, StartDocSucceeded: false, AbortDocAttempted: false } });
  for (const item of cases.slice(2)) {
    expect(item.Receipt).toMatchObject({ Submitted: false, JobId: 73, StartDocSucceeded: true, AbortDocAttempted: true });
    expect(item.Calls.endsWith('abort,')).toBe(true);
    expect(item.Calls.match(/start_doc/g)).toHaveLength(1);
  }
  expect(cases[6].Receipt.Error).toContain('AbortDoc: abort failed');
  expect(cases[7].Receipt.AbortDocResult).toBe(0);
}, 30000);
