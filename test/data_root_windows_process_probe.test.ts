import { describe, expect, it, vi } from 'vitest';
import { __dataRootLeaseProcessProbeForTests } from '../server/runtime/data_root_lease';

function failedAttempt(code: string, message = code) {
  return {
    status: null,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error(message), { code }),
  };
}

describe('Windows data-root process identity probe', () => {
  it.each(['ETIMEDOUT', 'EAGAIN', 'EBUSY'])(
    'retries bounded transient spawn failure %s without weakening the identity',
    (code) => {
      const runner = vi.fn()
        .mockReturnValueOnce(failedAttempt(code))
        .mockReturnValueOnce({
          status: 0,
          stdout: '638924112345678901',
          stderr: '',
        });

      const result = __dataRootLeaseProcessProbeForTests.probeWindowsProcess(4242, runner);

      expect(result).toEqual({
        state: 'alive',
        startIdentity: 'win-start-ticks:638924112345678901',
      });
      expect(runner).toHaveBeenCalledTimes(2);
      expect(runner).toHaveBeenNthCalledWith(1, 4242, 10_000);
      expect(runner).toHaveBeenNthCalledWith(2, 4242, 10_000);
    },
  );

  it('does not retry a non-transient identity failure', () => {
    const runner = vi.fn().mockReturnValue(failedAttempt('EACCES', 'access denied'));

    const result = __dataRootLeaseProcessProbeForTests.probeWindowsProcess(4242, runner);

    expect(result).toEqual({ state: 'unknown', reason: 'access denied' });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('remains fail-closed after both bounded attempts time out', () => {
    const runner = vi.fn().mockReturnValue(failedAttempt('ETIMEDOUT', 'probe timed out'));

    const result = __dataRootLeaseProcessProbeForTests.probeWindowsProcess(4242, runner);

    expect(result).toEqual({
      state: 'unknown',
      reason: 'probe timed out after 2 bounded attempts',
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
