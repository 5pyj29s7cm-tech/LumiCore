import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelDashScopeTaskBestEffort } from '../server/tools/dashscope_async_task';

describe('DashScope asynchronous task cancellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses the documented POST endpoint with a fresh live signal and no body', async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify('request-id'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cancelDashScopeTaskBestEffort('task/id', 'secret-key')).resolves.toEqual({
      outcome: 'remote_cancelled',
      httpStatus: 200,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://dashscope.aliyuncs.com/api/v1/tasks/task%2Fid/cancel',
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer secret-key' },
    });
    expect(init.body).toBeUndefined();
    expect(init.signal?.aborted).toBe(false);
  });

  it('only classifies the documented UnsupportedOperation response as a state rejection', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'UnsupportedOperation' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'InvalidApiKey' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cancelDashScopeTaskBestEffort('pending-task', 'secret-key')).resolves.toEqual({
      outcome: 'remote_cancel_rejected_state',
      httpStatus: 400,
      errorCode: 'UnsupportedOperation',
    });
    await expect(cancelDashScopeTaskBestEffort('pending-task', 'secret-key')).resolves.toEqual({
      outcome: 'remote_cancel_failed',
      httpStatus: 401,
      errorCode: 'InvalidApiKey',
    });
  });

  it('fails closed when the independent cancellation request times out', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })
    ));
    vi.stubGlobal('fetch', fetchMock);

    const pending = cancelDashScopeTaskBestEffort('pending-task', 'secret-key', 10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toEqual({ outcome: 'remote_cancel_failed' });
  });
});
