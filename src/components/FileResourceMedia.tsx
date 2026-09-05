import React, { useEffect, useRef } from 'react';
import { useFileResource } from '@/hooks/useFileResource';

function useResourceError(error: Error | undefined, callback?: () => void) {
  const latestCallback = useRef(callback);
  useEffect(() => { latestCallback.current = callback; }, [callback]);
  useEffect(() => { if (error) latestCallback.current?.(); }, [error]);
}

export function FileResourceImage({ src, onResourceError, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { onResourceError?: () => void }) {
  const resource = useFileResource(src);
  useResourceError(resource.error, onResourceError);
  return <img {...props} src={resource.url} />;
}

export function FileResourceVideo({ src, onResourceError, ...props }: React.VideoHTMLAttributes<HTMLVideoElement> & { onResourceError?: () => void }) {
  const resource = useFileResource(src);
  useResourceError(resource.error, onResourceError);
  return <video {...props} src={resource.url} />;
}
