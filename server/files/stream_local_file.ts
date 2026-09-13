import fs from 'node:fs';
import type { Request, Response } from 'express';

/** Serve an already authorized local file, including video seek requests. */
export function streamLocalFile(req: Request, res: Response, filePath: string, mime?: string): void {
  const { size } = fs.statSync(filePath);
  let range: { start: number; end: number } | undefined;
  if (/^(?:video|audio)\//.test(mime || '')) {
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(req.headers.range.trim());
      const start = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]));
      const end = match?.[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`); res.end(); return;
      }
      range = { start, end };
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
  }
  res.setHeader('Content-Length', String(range ? range.end - range.start + 1 : size));
  const stream = fs.createReadStream(filePath, range);
  stream.on('error', error => { if (!res.headersSent) res.status(500).end(); else res.destroy(error); });
  res.once('close', () => stream.destroy());
  stream.pipe(res);
}
