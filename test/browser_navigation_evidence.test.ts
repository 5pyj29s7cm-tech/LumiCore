import { describe, expect, it } from 'vitest';
import type { ToolExecutionRecord } from '../server/tools/types';
import { hasRequestedDesktopOpenEvidence } from '../server/cognition/action_desktop_evidence';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { buildDesktopExecutionStabilityPolicy } from '../server/cognition/desktop_execution_stability';

const target = 'https://docs.example.test/guide';
const taskText = '请用系统浏览器打开 ' + target + '，告诉我实际页面的标题、网址和内容。不要登录、下载或提交表单。';
function openRecord(payload: Record<string, unknown>, name = 'browser_open_task'): ToolExecutionRecord {
  return { name, arguments: name === 'desktop_open' ? { target } : { url: target, open: true }, result: JSON.stringify(payload),
    terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'Adapter observation returned.' } };
}

describe('browser navigation uses observed page outcome', () => {
  it.each(['desktop_open', 'browser_open_task'])('does not turn %s launch echo into page completion', name => {
    const record = openRecord({ target, opened: true, ok: true, status: 'launched', targetMatched: true,
      navigationVerified: false, pageLoadVerified: false,
      actualTarget: { processName: 'msedge.exe', title: 'Untitled - Microsoft Edge' } }, name);
    expect(hasRequestedDesktopOpenEvidence([record], taskText, target)).toBe(false);
  });

  it('does not replace a cautious full answer with an opened acknowledgment', () => {
    const responseText = '浏览器已接收打开请求，但页面加载核验尚未完成：当前没有网址和内容的实际观察。';
    const result = finalizeLumiResponse({ taskText, responseText, source: 'chat', toolRecords: [
      openRecord({ target, opened: true, status: 'launched', navigationVerified: false, pageLoadVerified: false }),
      { name: 'desktop_active_window', arguments: {}, result: JSON.stringify({ title: 'LumiCore', process_name: 'lumi-core.exe' }) },
      { name: 'desktop_execution_plan_receipt', arguments: {}, result: JSON.stringify({ finalState: 'target_mismatch', completionVerified: false }) },
    ] });
    expect(result.text).not.toMatch(/^已打开[^\n]+[。.]$/u);
    expect(result.blocked).toBe(true);
    expect(result.text).toBe(responseText);
  });

  it('does not infer a URL from a matching browser title after a mismatch', () => {
    const record = openRecord({ target, ok: false, status: 'target_mismatch', targetMatched: false,
      actualTarget: { processName: 'chrome.exe', title: 'docs.example.test guide - Chrome' } }, 'desktop_open');
    expect(hasRequestedDesktopOpenEvidence([record], taskText, target)).toBe(false);
  });
  function renderedPage() {
    return { target, opened: true, ok: true, status: 'verified', targetMatched: true,
      navigationVerified: true, pageLoadVerified: true, pageLoadState: 'document_observed',
      actualUrl: target, pageTitle: 'Sample guide',
      actualTarget: { processId: 44, nativeWindowHandle: 1234, processName: 'msedge.exe', title: 'Sample guide - Edge' },
      pageObservation: { source: 'windows-uia', observedAt: '2026-10-28T12:00:00.000Z',
        url: target, title: 'Sample guide', documentPresent: true, textSample: 'Getting started with a sample service.',
        loadingState: 'unknown', processId: 44, nativeWindowHandle: 1234, processName: 'msedge.exe', windowTitle: 'Sample guide - Edge' } };
  }

  it.each(['desktop_open', 'browser_open_task'])('accepts %s page facts from the same native window', name => {
    const record = openRecord(renderedPage(), name);
    expect(hasRequestedDesktopOpenEvidence([record], taskText, target)).toBe(true);
  });

  it('keeps the complete observed-page answer instead of replacing it with fixed prose', () => {
    const responseText = '当前网址：' + target + '\n页面标题：Sample guide\n已显示内容：Getting started with a sample service。此结果来自该浏览器窗口的页面观察。';
    const result = finalizeLumiResponse({ taskText, responseText, source: 'chat', toolRecords: [openRecord(renderedPage())] });
    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it.each(['https://other.example.test/guide', 'https://docs.example.test/admin'])('rejects unrelated observed URL %s', actualUrl => {
    const payload = renderedPage();
    payload.actualUrl = actualUrl;
    payload.pageObservation.url = actualUrl;
    expect(hasRequestedDesktopOpenEvidence([openRecord(payload)], taskText, target)).toBe(false);
  });

  it('does not convert an explicitly loading document to loaded', () => {
    const payload = renderedPage();
    payload.pageObservation.loadingState = 'loading';
    expect(hasRequestedDesktopOpenEvidence([openRecord(payload)], taskText, target)).toBe(false);
  });


  it('does not attach a second foreground plan to one measured native page open', () => {
    const result = buildDesktopExecutionStabilityPolicy({ channel: 'chat', text: taskText,
      capabilitySelection: { lane: 'desktop_control', primary: 'desktop_control', preferredTools: ['desktop_open'] } as any });
    expect(result.applies).toBe(false);
    expect(result.executionPlan).toBeNull();
    expect(result.promptOverlay).toBe('');
  });

  it.each(['Open https://docs.example.test/guide then type my name into the form.',
    'Open https://docs.example.test/guide and login to my account.'])('retains the existing desktop input plan for composite browser work: %s', text => {
    const result = buildDesktopExecutionStabilityPolicy({ channel: 'chat', text,
      capabilitySelection: { lane: 'web_or_account', primary: 'browser', preferredTools: ['browser_open_task'] } as any });
    expect(result.applies).toBe(true);
    expect(result.executionPlan).not.toBeNull();
  });

});
