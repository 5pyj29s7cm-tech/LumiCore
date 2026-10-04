// @vitest-environment jsdom
import React, { useLayoutEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useLegalDocument } from '../src/hooks/useLegalDocument';
import { toast } from 'sonner';
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it.each(['case', 'close'])('revokes the old document request during the %s commit before later layout work', async change => {
  let finish!: (value: string) => void, signal!: AbortSignal;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  function Owner() {
    const document = useLegalDocument('', { error: 'Failed' });
    return <><button onClick={() => document.generate(async current => {
      signal = current;
      const value = await pending;
      current.throwIfAborted();
      toast.success('Old case synchronized');
      return value;
    })}>Generate</button><output>{document.result}</output></>;
  }
  function CommitObserver({ changed }: { changed: boolean }) {
    useLayoutEffect(() => {
      if (!changed) return;
      expect(signal.aborted).toBe(true);
      finish('Old case result');
    }, [changed]);
    return null;
  }
  const page = (changed: boolean) => <>{!(changed && change === 'close') && <Owner key={changed ? 'new-case' : 'old-case'} />}<CommitObserver changed={changed} /></>;
  const view = render(page(false));
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
  expect(signal.aborted).toBe(false);
  await act(async () => { view.rerender(page(true)); });
  expect(toast.success).not.toHaveBeenCalled();
  expect(screen.queryByText('Old case result')).toBeNull();
});
