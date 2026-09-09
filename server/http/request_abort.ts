import type { Request, Response } from 'express';

/** Own only the work whose lifetime ends with this HTTP response. */
export function createRequestAbortController(req: Request, res: Response) {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('HTTP request cancelled.', 'AbortError'));
  const close = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort);
  res.once('close', close);
  if (req.aborted || (res.destroyed && !res.writableEnded)) abort();
  return {
    signal: controller.signal,
    dispose() { req.off('aborted', abort); res.off('close', close); },
  };
}
