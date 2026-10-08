import { useEffect, useLayoutEffect, useRef, useState, type VideoHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import { getLocale } from '@/i18n/runtime';
import { chatPreviewCopy } from '@/i18n/locales/chatPreview';

/** Keep the same media element while expanding inside the app, without native fullscreen. */
export function VideoPlayer({ isZh = getLocale() === 'zh', className, controlsList, ...props }: VideoHTMLAttributes<HTMLVideoElement> & { isZh?: boolean }) {
  const copy = chatPreviewCopy(isZh);
  const anchor = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [host] = useState(() => typeof document === 'undefined' ? null : document.createElement('div'));
  const [expanded, setExpanded] = useState(false);
  const previousExpanded = useRef(false);
  useLayoutEffect(() => {
    const target = expanded ? document.body : anchor.current;
    if (!host || !target) return;
    target.appendChild(host);
    if (!expanded && anchor.current) anchor.current.style.height = '';
    if (expanded || previousExpanded.current) toggle.current?.focus();
    previousExpanded.current = expanded;
  }, [expanded, host]);
  useLayoutEffect(() => () => { host?.remove(); }, [host]);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        setExpanded(false); toggle.current?.focus();
      } else if (event.key === 'Tab') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (document.activeElement === toggle.current) video.current?.focus();
        else toggle.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [expanded]);
  const changeSize = () => {
    if (!expanded && anchor.current) anchor.current.style.height = anchor.current.getBoundingClientRect().height + 'px';
    setExpanded(value => !value);
  };
  const content = <div data-video-player data-video-expanded={expanded ? 'true' : 'false'}
    role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined} aria-label={expanded ? props['aria-label'] || copy.expandVideo : undefined}
    className={expanded ? 'fixed inset-0 z-[20020] flex items-center justify-center bg-black p-3 sm:p-6' : 'relative h-full w-full'}>
    <video {...props} ref={video} playsInline tabIndex={0} controlsList={[controlsList, 'nofullscreen'].filter(Boolean).join(' ')}
      className={expanded ? 'h-full w-full max-w-full object-contain' : className} />
    {props.controls && <button ref={toggle} type="button" onClick={changeSize} aria-expanded={expanded}
      aria-label={expanded ? copy.restoreVideo : copy.expandVideo} title={expanded ? copy.restoreVideo : copy.expandVideo}
      className="absolute right-3 top-3 z-10 rounded-lg border border-white/25 bg-black/65 p-2 text-white hover:bg-black/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
      {expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
    </button>}
  </div>;
  return <div ref={anchor} className="relative h-full w-full min-w-0">{host ? createPortal(content, host) : content}</div>;
}
