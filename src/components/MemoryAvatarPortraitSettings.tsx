import { useEffect, useRef, useState } from 'react';
import { memoryAvatarPortraitService, type MemoryAvatarPortraitConfig } from '../services/memoryAvatarPortraitService';
import { memoryPortraitCopy } from '../i18n/locales/memoryPortrait';

export function MemoryAvatarPortraitSettings({ ownerId, locale }: { ownerId: string; locale: 'zh' | 'en' }) {
  return <PortraitSettingsForm key={ownerId} ownerId={ownerId} locale={locale} />;
}

function PortraitSettingsForm({ ownerId, locale }: { ownerId: string; locale: 'zh' | 'en' }) {
  const copy = memoryPortraitCopy(locale);
  const [config, setConfig] = useState<MemoryAvatarPortraitConfig | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'failed' | 'loadFailed' | null>(null);
  const [reload, setReload] = useState(0);
  const scope = useRef(ownerId); scope.current = ownerId;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const request = new AbortController(); controller.current = request;
    setKey(''); setConfig(null); setNotice(null); setBusy(true);
    void memoryAvatarPortraitService.config(request.signal).then(result => {
      if (!request.signal.aborted && scope.current === ownerId) setConfig(result);
    }).catch(() => { if (!request.signal.aborted) setNotice('loadFailed'); })
      .finally(() => { if (!request.signal.aborted) setBusy(false); });
    return () => { request.abort(); controller.current?.abort(); };
  }, [ownerId, reload]);
  const save = async (clear = false) => {
    if (busy || !config || (!clear && !key.trim())) return;
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setBusy(true); setNotice(null);
    try {
      const result = await memoryAvatarPortraitService.saveConfig({ ...(clear ? { clearKey: true } : { apiKey: key.trim() }), cloudConsent: true }, request.signal);
      if (!request.signal.aborted && scope.current === ownerId) { setConfig(result); setKey(''); setNotice('saved'); }
    } catch { if (!request.signal.aborted) setNotice('failed'); }
    finally { if (!request.signal.aborted) setBusy(false); }
  };
  return <section aria-label={copy.settings} className="space-y-3 rounded-xl border border-white/10 bg-black/10 p-3">
    <h4 className="text-xs font-medium text-[#d7deca]">{copy.settings}</h4>
    <p className="text-[11px] leading-5 text-[#9eac96]">{copy.hint}</p>
    {config && <p className="text-[11px] text-[#c2cfb7]">{config.configured ? copy.configured : copy.missing}</p>}
    {config && !config.cloudAllowed && <p role="status" className="text-[11px] text-amber-100/80">{copy.strict}</p>}
    {config?.cleanupPending && <p role="status" className="text-[11px] leading-5 text-amber-100/80">{copy.cleanupPending}</p>}
    {!config && busy && <p role="status" className="text-[11px] text-[#9eac96]">{copy.loading}</p>}
    <label className="block text-[11px] text-[#c2cfb7]">{copy.key}<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} disabled={busy || !config || !config.cloudAllowed} className="mt-1 block w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none focus:border-[#b7c7a5]/40" /></label>
    <p className="text-[10px] leading-4 text-[#8b9b83]">{copy.keyHint}</p>
    <div className="flex flex-wrap gap-3 text-[11px]">
      <button type="button" onClick={() => void save()} disabled={busy || !key.trim() || !config?.cloudAllowed} className="rounded-lg bg-[#c5baa2]/20 px-3 py-2 text-[#ddd4bf] disabled:opacity-40">{busy ? copy.saving : copy.save}</button>
      {config?.configured && <button type="button" disabled={busy} onClick={() => void save(true)} className="text-[#aebca4] underline underline-offset-2 disabled:opacity-40">{copy.clear}</button>}
    </div>
    {notice && <p role={notice === 'saved' ? 'status' : 'alert'} className="text-[11px] leading-5 text-[#d4c5a8]">{copy[notice]}</p>}
    {(notice === 'failed' || notice === 'loadFailed') && <button type="button" onClick={() => setReload(value => value + 1)} className="text-[11px] text-[#bbc9ad] underline">{copy.retry}</button>}
  </section>;
}
