// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from './apiClient';
import { getBackendOrigin } from './apiBridge';
import { logout } from './authService';
import { cloneVoice, deleteVoice, designVoice, getVoiceCloneStatus, listVoices, synthesizeSpeech, uploadSamples } from './voiceService';
import { startIndustryWorkflow, verifyIndustryWorkflow, executeIndustryWorkflow, executeFinanceDeliveryWorkflow } from '../lib/industryWorkflowClient';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => { localStorage.clear(); invoke.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); delete (window as any).__TAURI_INTERNALS__; vi.resetModules(); });

describe('confirmed frontend writes', () => {
  it('routes business workflow writes and streamed execution through current desktop credentials', async () => {
    (window as any).__TAURI_INTERNALS__ = {}; localStorage.setItem('lumi_auth_token', 'synthetic-token'); localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof');
    const taskId = 'task/a?b', task = { id: taskId, status: 'in_progress' }, start = { task, handoffPrompt: 'Scoped task', contract: { entryId: 'accounting' } };
    const finance = { ok: true, persisted: true, status: 'verified', task, artifacts: [] }, verification = { task, verification: { status: 'blocked' } };
    const cancel = vi.fn(); const stream = new ReadableStream({ start(controller) { for (const block of ['data: {"chunk":"Working"}\n\n', 'data: {"done":true,"text":"Verified result","industryWorkflow":{"status":"delivered"}}\n\n']) controller.enqueue(new TextEncoder().encode(block)); }, cancel });
    const fetcher = vi.fn().mockResolvedValueOnce(reply(start)).mockResolvedValueOnce(reply(verification)).mockResolvedValueOnce(reply(finance)).mockResolvedValueOnce({ ok: true, body: stream }); vi.stubGlobal('fetch', fetcher);
    expect(await startIndustryWorkflow({ entryId: 'accounting', sourceInput: 'Synthetic' })).toEqual(start);
    expect(await verifyIndustryWorkflow({ taskId, workbenchInput: { rows: [] } })).toEqual(verification);
    const controller = new AbortController(); expect(await executeFinanceDeliveryWorkflow({ taskId, financeInput: { period: '2026-09' }, signal: controller.signal })).toEqual(finance);
    const progress = vi.fn(); expect(await executeIndustryWorkflow({ taskId, prompt: 'Scoped task', routeText: 'Source', signal: controller.signal, onProgress: progress })).toMatchObject({ text: 'Verified result', status: 'delivered' }); expect(progress).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(1); expect(stream.locked).toBe(false);
    for (const [url, init] of fetcher.mock.calls) { expect(new URL(String(url)).origin).toBe(getBackendOrigin()); expect(new URL(String(url)).pathname).toMatch(/^\/api\//); expect(init.credentials).toBe('include'); expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-token'); expect(new Headers(init.headers).get('x-lumi-desktop-session')).toBe('synthetic-proof'); }
    expect(fetcher.mock.calls[1][0]).toContain('/task%2Fa%3Fb/verify'); expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ resultText: '', filePaths: [], source: 'industry_client', workbenchInput: { rows: [] } }); expect(fetcher.mock.calls[2][1].signal).toBe(controller.signal);
    expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual({ industryWorkflowTaskId: taskId, industryWorkflowSourceInput: 'Source', messages: [{ role: 'user', content: 'Scoped task' }] });
    controller.abort(); await expect(startIndustryWorkflow({ entryId: 'accounting' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); await expect(executeIndustryWorkflow({ taskId, prompt: 'Stopped', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects incomplete business receipts and never replays failed business writes', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); (window as any).__TAURI_INTERNALS__ = {};
    const requests = [() => startIndustryWorkflow({ entryId: 'accounting' }), () => verifyIndustryWorkflow({ taskId: 'task' }), () => executeFinanceDeliveryWorkflow({ taskId: 'task', financeInput: {} })];
    for (const request of requests) {
      for (const response of [reply({ error: 'Business denied' }, 403), reply({ ok: false, error: 'Business rejected' }), reply({ ok: true })]) { fetcher.mockResolvedValueOnce(response); await expect(request()).rejects.toThrow(); }
    }
    fetcher.mockReset().mockRejectedValue(new TypeError('Failed to fetch'));
    for (const request of [...requests, () => executeIndustryWorkflow({ taskId: 'task', prompt: 'Synthetic' })]) await expect(request()).rejects.toThrow('Failed to fetch'); expect(fetcher).toHaveBeenCalledTimes(4);
    fetcher.mockResolvedValueOnce({ ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"chunk":"Partial"}\n\n')); controller.close(); } }) }); await expect(executeIndustryWorkflow({ taskId: 'task', prompt: 'Synthetic' })).rejects.toThrow('before a final receipt');
    const cancel = vi.fn(), failedStream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"error":"Execution denied"}\n\n')); }, cancel });
    fetcher.mockResolvedValueOnce({ ok: true, body: failedStream }); await expect(executeIndustryWorkflow({ taskId: 'task', prompt: 'Synthetic' })).rejects.toThrow('Execution denied'); expect(cancel).toHaveBeenCalledTimes(1); expect(failedStream.locked).toBe(false);
  });

  it('uses current desktop routing and credentials for voice JSON, samples and binary audio', async () => {
    const sample = new File(['sample'], 'voice.wav', { type: 'audio/wav' }), audio = new ArrayBuffer(8);
    const payload = { voiceId: 'voice/a?b', urls: ['sample'], filenames: ['voice.wav'], count: 1 };
    const fetcher = vi.fn().mockResolvedValue({ ...reply(payload), arrayBuffer: async () => audio }); vi.stubGlobal('fetch', fetcher);
    (window as any).__TAURI_INTERNALS__ = {}; localStorage.setItem('lumi_auth_token', 'synthetic-token'); localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof');
    expect(await uploadSamples([sample])).toEqual(payload);
    await cloneVoice(['sample'], 'test', 'ark', { confirmPostpaidBilling: true }); await designVoice('prompt', 'test', 'relay');
    await getVoiceCloneStatus(payload.voiceId); await deleteVoice(payload.voiceId);
    const controller = new AbortController(); expect(await synthesizeSpeech('hello', 'voice', 'relay', 'model', controller.signal)).toBe(audio);
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe(getBackendOrigin()); expect(new URL(String(url)).pathname).toMatch(/^\/api\/voice\//); expect(init.credentials).toBe('include');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-token'); expect(new Headers(init.headers).get('x-lumi-desktop-session')).toBe('synthetic-proof');
    }
    expect(fetcher.mock.calls[0][1].body.getAll('samples')).toEqual([sample]); expect(new Headers(fetcher.mock.calls[0][1].headers).has('Content-Type')).toBe(false);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ sampleUrls: ['sample'], name: 'test', provider: 'ark', confirmPostpaidBilling: true });
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ prompt: 'prompt', name: 'test', provider: 'relay' });
    expect(fetcher.mock.calls[3][0]).toContain('/clone-status/voice%2Fa%3Fb'); expect(fetcher.mock.calls[4][0]).toContain('/voice/voice%2Fa%3Fb');
    expect(fetcher.mock.calls[5][1].signal).toBe(controller.signal); controller.abort(); await expect(synthesizeSpeech('hello', 'voice', undefined, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(fetcher).toHaveBeenCalledTimes(6);
    fetcher.mockResolvedValue(reply({ provider: 'ark', configured: true, capabilities: { clone: true }, cloned: [payload] }));
    expect(await listVoices('ark?test')).toEqual({ provider: 'ark', configured: true, capabilities: { clone: true, design: false }, cloned: [payload], premade: [] }); expect(fetcher.mock.calls.at(-1)![0]).toContain('?provider=ark%3Ftest');
  });

  it('rejects voice HTTP errors and malformed JSON, and never replays voice writes after network failure', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); (window as any).__TAURI_INTERNALS__ = {};
    for (const request of [() => uploadSamples([]), () => cloneVoice([], 'test'), () => designVoice('prompt', 'test'), () => getVoiceCloneStatus('voice'), () => listVoices(), () => deleteVoice('voice'), () => synthesizeSpeech('hello', 'voice')]) {
      fetcher.mockResolvedValueOnce(reply({ error: 'Voice denied' }, 403)); await expect(request()).rejects.toThrow('Voice denied');
    }
    fetcher.mockResolvedValueOnce({ ...reply(null, 502), json: async () => { throw new SyntaxError('html'); } }); await expect(synthesizeSpeech('hello', 'voice')).rejects.toThrow('HTTP 502');
    fetcher.mockResolvedValueOnce({ ...reply(null), json: async () => { throw new SyntaxError('invalid JSON'); } }); await expect(cloneVoice([], 'test')).rejects.toThrow('invalid JSON');
    fetcher.mockReset().mockRejectedValue(new TypeError('Failed to fetch'));
    for (const request of [() => uploadSamples([]), () => cloneVoice([], 'test'), () => designVoice('prompt', 'test'), () => deleteVoice('voice'), () => synthesizeSpeech('hello', 'voice')]) await expect(request()).rejects.toThrow('Failed to fetch');
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('includes desktop proof and rejects a denied save', async () => {
    localStorage.setItem('lumi_auth_token', 'synthetic-token');
    localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof');
    const fetcher = vi.fn().mockResolvedValue(reply({ error: 'denied' }, 403));
    vi.stubGlobal('fetch', fetcher);
    await expect(apiJson('/api/remote-devices', { method: 'PUT' })).rejects.toThrow('denied');
    const headers = new Headers(fetcher.mock.calls[0][1].headers);
    expect(headers.get('Authorization')).toBe('Bearer synthetic-token');
    expect(headers.get('x-lumi-desktop-session')).toBe('synthetic-proof');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('clears both credentials immediately when logout is offline', async () => {
    localStorage.setItem('lumi_auth_token', 'synthetic-token');
    localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = logout();
    expect(localStorage.getItem('lumi_auth_token')).toBeNull();
    expect(localStorage.getItem('lumi_desktop_session_proof')).toBeNull();
    expect(await result).toEqual({ remoteRevoked: false });
  });

  it('does not persist OS slider values when native control fails', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    const { systemService } = await import('./systemService');
    localStorage.setItem('lumi_volume', '25');
    localStorage.setItem('lumi_brightness', '40');
    invoke.mockRejectedValue(new Error('native unavailable'));
    await expect(systemService.setVolume(90)).rejects.toThrow('native unavailable');
    await expect(systemService.setBrightness(90)).rejects.toThrow('native unavailable');
    expect(localStorage.getItem('lumi_volume')).toBe('25');
    expect(localStorage.getItem('lumi_brightness')).toBe('40');
    await expect(systemService.getVolume()).rejects.toThrow('native unavailable');
    await expect(systemService.getBrightness()).rejects.toThrow('native unavailable');
  });

  it('commits OS slider values only after native completion', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    const { systemService } = await import('./systemService');
    let complete!: () => void;
    invoke.mockReturnValue(new Promise<void>(resolve => { complete = resolve; }));
    const pending = systemService.setVolume(30);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(localStorage.getItem('lumi_volume')).toBeNull();
    complete(); await pending;
    expect(localStorage.getItem('lumi_volume')).toBe('30');
  });
});
