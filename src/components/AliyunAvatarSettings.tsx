import { useEffect, useRef, useState } from 'react';
import { aliyunAvatarService } from '../services/aliyunAvatarService';
import type { AliyunAvatarConfig } from '../../shared/aliyun_avatar';
import { aliyunAvatarCopy } from '../i18n/locales/aliyunAvatar';

export function AliyunAvatarSettings(props: { ownerId: string; avatarId: string; locale: 'zh' | 'en'; onBeforeMutation?: () => void | Promise<void> }) {
  return <Form key={JSON.stringify([props.ownerId, props.avatarId])} {...props} />;
}
function Form({ avatarId, locale, onBeforeMutation }: { avatarId: string; locale: 'zh' | 'en'; onBeforeMutation?: () => void | Promise<void> }) {
  const copy = aliyunAvatarCopy(locale);
  const [config, setConfig] = useState<AliyunAvatarConfig | null>(null);
  const [keyId, setKeyId] = useState(''), [secret, setSecret] = useState(''), [project, setProject] = useState(''), [instance, setInstance] = useState('');
  const [enabled, setEnabled] = useState(false), [consent, setConsent] = useState(false), [busy, setBusy] = useState(true), [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<'' | 'saved' | 'error' | 'loadError'>('');
  const current = useRef<AbortController | null>(null);
  useEffect(() => {
    const request = new AbortController(); current.current = request; setBusy(true); setConfig(null); setNotice('');
    setKeyId(''); setSecret('');
    void aliyunAvatarService.config(avatarId, request.signal).then(value => {
      if (request.signal.aborted) return;
      setConfig(value); setEnabled(value.enabled); setProject(value.projectId); setInstance(value.instanceId); setConsent(value.enabled);
    }).catch(() => { if (!request.signal.aborted) setNotice('loadError'); }).finally(() => { if (!request.signal.aborted) setBusy(false); });
    return () => { request.abort(); current.current?.abort(); };
  }, [avatarId, reload]);
  const save = async (clearKey = false) => {
    if (busy || !config) return;
    const request = new AbortController(); current.current = request; setBusy(true); setNotice('');
    try {
      await onBeforeMutation?.(); request.signal.throwIfAborted();
      const value = await aliyunAvatarService.save(avatarId, { enabled: !clearKey && enabled, cloudConsent: consent, projectId: project.trim(), instanceId: instance.trim(),
        ...(clearKey ? { clearKey: true } : keyId.trim() || secret.trim() ? { accessKeyId: keyId.trim(), accessKeySecret: secret.trim() } : {}) }, request.signal);
      if (!request.signal.aborted) { setConfig(value); setEnabled(value.enabled); setKeyId(''); setSecret(''); setNotice('saved'); }
    } catch { if (!request.signal.aborted) setNotice('error'); }
    finally { if (!request.signal.aborted) setBusy(false); }
  };
  const input = 'mt-1 block w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none focus:border-[#b7c7a5]/40';
  const cleanup = async () => {
    if (busy) return;
    const request = new AbortController(); current.current = request; setBusy(true); setNotice('');
    try { const value = await aliyunAvatarService.cleanup(avatarId, request.signal); if (!request.signal.aborted) setConfig(value); }
    catch { if (!request.signal.aborted) setNotice('error'); }
    finally { if (!request.signal.aborted) setBusy(false); }
  };
  const valid = config && (!enabled || (consent && project.trim() && instance.trim() && (config.configured || (keyId.trim() && secret.trim())))) && (!keyId.trim() === !secret.trim());
  return <section className="space-y-3 rounded-xl border border-[#c5baa2]/25 bg-black/10 p-3" aria-label={copy.title}>
    <h4 className="text-xs font-medium text-[#d7deca]">{copy.title}</h4>
    <p className="text-[11px] leading-5 text-[#9eac96]">{copy.hint}</p>
    <a href="https://avatar.console.aliyun.com/lingmou/chat" target="_blank" rel="noreferrer" className="text-[11px] text-[#d4c5a8] underline">{copy.console}</a>
    <p className="text-[11px] text-[#aebca4]">{config?.configured ? copy.savedKey : copy.noKey}</p>
    {config && !config.cloudAllowed && <p role="status" className="text-[11px] text-amber-100">{copy.strict}</p>}
    {config?.cleanupPending && <p role="status" className="text-[11px] leading-5 text-amber-100">{copy.cleanup}</p>}
    {config?.cleanupPending && <button type="button" disabled={busy} onClick={() => void cleanup()} className="text-[11px] text-[#d4c5a8] underline">{copy.retryCleanup}</button>}
    <fieldset disabled={busy || !config} className="space-y-3 text-[11px] text-[#c2cfb7]">
      <label className="block">{copy.keyId}<input type="password" autoComplete="off" spellCheck={false} value={keyId} onChange={e => setKeyId(e.target.value)} className={input} /></label>
      <label className="block">{copy.secret}<input type="password" autoComplete="off" spellCheck={false} value={secret} onChange={e => setSecret(e.target.value)} className={input} /></label>
      <label className="block">{copy.project}<input value={project} onChange={e => setProject(e.target.value)} spellCheck={false} className={input} /></label>
      <label className="block">{copy.instance}<input value={instance} onChange={e => setInstance(e.target.value)} spellCheck={false} className={input} /></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={!config?.cloudAllowed && !enabled} onChange={e => setEnabled(e.target.checked)} />{copy.enabled}</label>
      {enabled && <label className="flex items-start gap-2 leading-5"><input className="mt-1" type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />{copy.consent}</label>}
    </fieldset>
    <div className="flex gap-3 text-[11px]"><button type="button" disabled={busy || !valid} onClick={() => void save()} className="rounded-lg bg-[#c5baa2]/20 px-3 py-2 text-[#ddd4bf] disabled:opacity-40">{busy ? copy.busy : copy.save}</button>
      {config?.configured && <button type="button" disabled={busy} onClick={() => void save(true)} className="text-[#aebca4] underline">{copy.clear}</button>}</div>
    {notice && <p role={notice === 'saved' ? 'status' : 'alert'} className="text-[11px] leading-5 text-[#d4c5a8]">{copy[notice]}</p>}
    {(notice === 'error' || notice === 'loadError') && <button type="button" onClick={() => setReload(value => value + 1)} className="text-[11px] text-[#bbc9ad] underline">{copy.retry}</button>}
  </section>;
}
