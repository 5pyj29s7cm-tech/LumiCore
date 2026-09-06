import { Loader2 } from 'lucide-react';
import type { MemoryAvatarMedia, MemoryAvatarMediaVariant } from '../../shared/memory_avatar';
import { useMemoryAvatarMediaResource } from '../hooks/useMemoryAvatarMediaResource';
import { memoryMediaCopy } from '../i18n/locales/memoryMedia';

export function MemoryAvatarMediaPreview({ ownerId, avatarId, media, locale, variant = 'original', enabled = true }: {
  ownerId: string; avatarId: string; media: MemoryAvatarMedia; locale: 'zh' | 'en'; variant?: MemoryAvatarMediaVariant; enabled?: boolean;
}) {
  const copy = memoryMediaCopy(locale);
  const resource = useMemoryAvatarMediaResource({ ownerId, avatarId, mediaId: media.id, variant, enabled });
  const still = media.kind === 'image' || variant === 'thumbnail' || variant === 'poster';
  return <div className="min-w-0 overflow-hidden rounded-xl bg-black/20">
    {resource.loading && <p role="status" className="flex items-center gap-2 p-3 text-xs text-white/55"><Loader2 size={14} className="animate-spin" />{copy.loadingPreview}</p>}
    {resource.error && <p role="alert" className="p-3 text-xs leading-5 text-amber-100/80">{copy.previewFailed}</p>}
    {resource.url && (still
      ? <img src={resource.url} alt={media.title} className="max-h-64 w-full object-contain" />
      : media.kind === 'audio' || variant === 'audio'
        ? <audio src={resource.url} aria-label={media.title} controls preload="metadata" className="w-full max-w-full" />
        : <video src={resource.url} aria-label={media.title} controls playsInline preload="metadata" className="max-h-64 w-full object-contain" />)}
  </div>;
}
