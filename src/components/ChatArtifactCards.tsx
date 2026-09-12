import React from 'react';
import { FileText, Play } from 'lucide-react';
import type { ChatArtifact } from '../../shared/chat_artifacts';
import type { ChatPreviewFile } from './ChatFilePreview';
import { FileResourceImage } from './FileResourceMedia';
import { chatPreviewCopy } from '@/i18n/locales/chatPreview';

export function ChatArtifactCards({ files, isZh, onPreview }: {
  files: ChatArtifact[]; isZh: boolean; onPreview: (file: ChatPreviewFile) => void;
}) {
  if (!files.length) return null;
  return <div className="my-3 flex flex-wrap gap-2">{files.map(file => <button key={file.id} type="button"
    onClick={() => onPreview(file)} className="flex max-w-full items-center gap-3 rounded-xl border border-emerald-400/25 bg-emerald-400/10 p-3 text-left hover:bg-emerald-400/20">
    {file.kind === 'image' ? <FileResourceImage src={file.url} alt="" className="h-14 w-20 rounded-lg object-cover" loading="lazy" />
      : file.kind === 'video' || file.kind === 'audio' ? <Play size={20} /> : <FileText size={20} />}
    <span className="min-w-0"><span className="block truncate text-sm">{file.fileName}</span><span className="text-xs opacity-60">{chatPreviewCopy(isZh).preview}</span></span>
  </button>)}</div>;
}
