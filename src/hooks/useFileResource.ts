import { useEffect, useMemo, useState } from 'react';
import { getStoredToken } from '@/services/authService';
import { isDisplayableResourceUrl, loadFileResource, localFileResourcePath } from '@/services/fileResource';

/** Authenticated local previews use Blob URLs, which are already allowed by desktop CSP. */
export function useFileResource(source: string | undefined) {
  const token = getStoredToken();
  const requestKey = useMemo(() => ({ source, token }), [source, token]);
  const [result, setResult] = useState<{ key?: typeof requestKey; url?: string; error?: Error }>({});
  const local = Boolean(source && localFileResourcePath(source));
  useEffect(() => {
    if (!source || !local) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void loadFileResource(source, controller.signal).then(resource => {
      if (controller.signal.aborted) {
        resource.release();
        return;
      }
      release = resource.release;
      setResult({ key: requestKey, url: resource.url });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ key: requestKey, error });
    });
    return () => {
      controller.abort();
      release?.();
    };
  }, [local, requestKey, source]);

  if (!local) return { url: source && isDisplayableResourceUrl(source) ? source : undefined, error: undefined };
  return result.key === requestKey ? result : { url: undefined, error: undefined };
}
