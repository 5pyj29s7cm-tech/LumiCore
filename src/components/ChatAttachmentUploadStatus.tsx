import React from 'react';
import type { ChatUploadFailure } from '../lib/chatAttachmentUploads';
import { chatAttachmentCopy } from '../i18n/locales/chatAttachments';

export function ChatAttachmentUploadStatus({ busy, failures, isZh, onRetry, onDismiss }: {
  busy: boolean; failures: ChatUploadFailure[]; isZh: boolean; onRetry: () => void; onDismiss: () => void;
}) {
  const copy = chatAttachmentCopy(isZh);
  if (!busy && failures.length === 0) return null;
  return <div className="mb-3 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-xs text-white/70" aria-live="polite">
    {busy ? <p role="status">{copy.processing}</p> : <>
      <p className="font-medium text-amber-200">{copy.failed}</p>
      <ul className="mt-2 space-y-1">
        {failures.map((item, index) => <li key={`${item.name}-${index}`} className="break-words [overflow-wrap:anywhere]">
          <span className="font-medium text-white/85">{item.name}</span>{' — '}{item.error}
        </li>)}
      </ul>
      <p className="mt-2 text-white/45">{copy.retryHelp}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={onRetry} className="rounded-lg bg-white/10 px-3 py-2 font-medium hover:bg-white/15">{copy.retry}</button>
        <button type="button" onClick={onDismiss} className="rounded-lg px-3 py-2 text-white/55 hover:bg-white/5">{copy.dismiss}</button>
      </div>
    </>}
  </div>;
}
