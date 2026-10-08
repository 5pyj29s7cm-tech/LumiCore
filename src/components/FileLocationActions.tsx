import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { isTauriRuntime } from '@/services/apiBridge';
import { fileResourceOpenTarget, openFileResourceFolder } from '@/services/fileResource';
import { fileLocationCopy } from '@/i18n/locales/fileLocation';

/** Shared by creation results, archived media and conversation previews. */
export function FileLocationActions({ url, path, isZh }: { url: string; path?: string; isZh: boolean }) {
  const copy = fileLocationCopy(isZh);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [openedPath, setOpenedPath] = useState('');
  const desktop = isTauriRuntime();
  if (!fileResourceOpenTarget(url)) return null;
  const open = async (downloads: boolean) => {
    setBusy(true); setError(false);
    try {
      if (downloads) {
        const { downloadDir } = await import('@tauri-apps/api/path');
        const { invoke } = await import('@tauri-apps/api/core');
        const folder = await downloadDir();
        const result = await invoke<{ success: boolean }>('open_item', { target: folder });
        if (!result?.success) throw new Error('Open Downloads failed');
      } else setOpenedPath(await openFileResourceFolder(url));
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const button = 'inline-flex items-center gap-1.5 rounded-lg border border-current/20 px-2.5 py-1.5 text-[11px] font-semibold transition-colors hover:bg-current/5 disabled:opacity-40';
  return <div data-file-location className="mt-3 min-w-0 space-y-2 text-xs">
    {(path || openedPath) && <p className="break-all opacity-65"><span>{copy.savedAt}: </span><span>{path || openedPath}</span></p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={button} disabled={busy} onClick={() => void open(false)}><FolderOpen size={13} />{copy.openFolder}</button>
      {desktop && <button type="button" className={button} disabled={busy} onClick={() => void open(true)}><FolderOpen size={13} />{copy.openDownloads}</button>}
    </div>
    <p className="text-[10px] leading-4 opacity-50">{desktop ? copy.desktopDownloadHint : copy.browserDownloadHint}</p>
    {error && <p role="alert" className="text-amber-500">{copy.failed}</p>}
  </div>;
}
