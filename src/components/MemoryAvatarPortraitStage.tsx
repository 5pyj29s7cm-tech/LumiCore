import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { useMemoryAvatarMediaResource } from '../hooks/useMemoryAvatarMediaResource';
import { memoryPortraitCopy } from '../i18n/locales/memoryPortrait';

export function MemoryAvatarPortraitStage({ ownerId, avatarId, mediaId, stream, surface, speaking, name, locale }: {
  ownerId: string; avatarId: string; mediaId?: string; stream: MediaStream | null; surface?: HTMLDivElement | null; speaking: boolean; name: string; locale: 'zh' | 'en';
}) {
  const copy = memoryPortraitCopy(locale);
  // Try the image thumbnail, then the video's poster. Never download a full
  // video just to show the selected still.
  const [variant, setVariant] = useState<'thumbnail' | 'poster'>('thumbnail');
  const resource = useMemoryAvatarMediaResource({ ownerId, avatarId, mediaId, variant });
  const video = useRef<HTMLVideoElement>(null);
  const sdkHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!surface || !sdkHost.current) return;
    sdkHost.current.append(surface);
    return () => { surface.remove(); };
  }, [surface]);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => { setVariant('thumbnail'); }, [ownerId, avatarId, mediaId]);
  useEffect(() => { if (resource.error && variant === 'thumbnail') setVariant('poster'); }, [resource.error, variant]);
  useEffect(() => {
    const element = video.current;
    setBlocked(false);
    if (!element || !stream) return;
    let active = true;
    element.srcObject = stream;
    void element.play().catch(() => { if (active) setBlocked(true); });
    return () => { active = false; element.pause(); element.srcObject = null; };
  }, [stream]);
  return <div className="relative h-full w-full bg-[#17201f]">
    {resource.url && <img src={resource.url} alt={name} className="absolute inset-0 h-full w-full object-contain" />}
    {resource.error && variant === 'poster' && <p role="alert" className="absolute inset-x-6 top-24 text-center text-xs text-[#ccbda3]">{copy.previewFailed}</p>}
    <video ref={video} autoPlay playsInline aria-label={copy.label} className={`absolute inset-0 h-full w-full object-contain ${stream && speaking && !surface ? '' : 'invisible'}`} />
    <div ref={sdkHost} aria-label={copy.label} className="absolute inset-0" />
    {blocked && <button type="button" onClick={() => { void video.current?.play().then(() => setBlocked(false)).catch(() => setBlocked(true)); }} className="absolute inset-x-6 top-1/3 z-10 mx-auto flex max-w-xs items-center justify-center gap-2 rounded-xl bg-[#d4c5a8] px-4 py-3 text-xs text-[#273024]"><Play size={16} />{copy.play}</button>}
  </div>;
}
