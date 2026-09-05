import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { getPrivacySettings, updatePrivacySettings, type PrivacySettingsState } from '@/services/privacyService';
import { privacyCopy } from '@/i18n/locales/privacy';
import type { Locale } from '@/i18n/runtime';

export function PrivacyModeSettings({ locale, workspace, sessionId }: {
  locale: Locale;
  workspace: 'personal' | 'work';
  sessionId: string;
}) {
  const copy = privacyCopy(locale);
  const scope = `${sessionId}:${workspace}`;
  const [state, setState] = useState<{ scope: string; value: PrivacySettingsState } | null>(null);
  const [busy, setBusy] = useState<'loading' | 'saving' | null>('loading');
  const [error, setError] = useState<'load' | 'save' | null>(null);
  const [saved, setSaved] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const settings = state?.scope === scope ? state.value : null;

  const reload = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy('loading');
    setError(null);
    setSaved(false);
    try {
      const value = await getPrivacySettings(controller.signal);
      if (!controller.signal.aborted) setState({ scope, value });
    } catch {
      if (!controller.signal.aborted) setError('load');
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }, [scope]);

  useEffect(() => {
    void reload();
    return () => { controllerRef.current?.abort(); };
  }, [reload]);

  const canEdit = Boolean(settings?.canManage && !settings.locked && workspace === 'personal');
  const changeMode = async () => {
    if (busy || error || !settings || !canEdit) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy('saving');
    setError(null);
    setSaved(false);
    try {
      const value = await updatePrivacySettings(settings.configuredMode === 'strict' ? 'standard' : 'strict', controller.signal);
      if (!controller.signal.aborted) {
        setState({ scope, value });
        setSaved(true);
      }
    } catch {
      if (!controller.signal.aborted) setError('save');
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  };

  return (
    <div className="space-y-4 rounded-2xl border border-celestial-saturn/20 bg-celestial-saturn/[0.06] p-4" aria-busy={Boolean(busy)}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <ShieldCheck size={20} className="shrink-0 text-celestial-saturn" />
          <div>
            <p id="privacy-mode-label" className="text-sm font-bold text-white/90">{copy.title}</p>
            <p className="mt-1 text-xs text-white/45">{copy.defaultOff}</p>
          </div>
        </div>
        <button type="button" role="switch" aria-labelledby="privacy-mode-label" aria-describedby="privacy-mode-description"
          aria-checked={settings?.configuredMode === 'strict'} disabled={Boolean(busy || error || !settings || !canEdit)}
          onClick={() => { void changeMode(); }}
          className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${settings?.configuredMode === 'strict' ? 'border-celestial-saturn/40 bg-celestial-saturn/25' : 'border-white/10 bg-white/5'}`}>
          <span className={`absolute top-1 h-5 w-5 rounded-full transition-all ${settings?.configuredMode === 'strict' ? 'left-6 bg-celestial-saturn' : 'left-1 bg-white/35'}`} />
        </button>
      </div>
      <div id="privacy-mode-description" className="space-y-2 text-xs leading-relaxed text-white/60">
        <ul className="list-disc space-y-1.5 pl-4">
          <li>{copy.cloudEffect}</li>
          <li>{copy.toolsEffect}</li>
          <li>{copy.localEffect}</li>
        </ul>
        <p>{copy.noLaunch}</p>
        <p>{copy.shared}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3 text-xs">
        <p className="text-white/65">{settings ? `${copy.current}: ${settings.mode === 'strict' ? copy.strict : copy.standard}` : error ? copy.unknown : copy.loading}</p>
        <button type="button" onClick={() => { void reload(); }} disabled={Boolean(busy)} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-white/60 transition-colors hover:bg-white/5 disabled:opacity-40">
          <RefreshCw size={12} />{copy.refresh}
        </button>
      </div>
      {settings?.locked ? (
        <p className="flex items-start gap-2 text-xs leading-relaxed text-amber-200/80"><LockKeyhole size={14} className="shrink-0" />{copy.locked}</p>
      ) : settings && !canEdit ? <p className="text-xs leading-relaxed text-white/50">{copy.restricted}</p> : null}
      <div aria-live="polite" className="text-xs leading-relaxed">
        {busy && <p className="flex items-center gap-2 text-white/55"><Loader2 size={13} className="animate-spin" />{busy === 'saving' ? copy.saving : copy.loading}</p>}
        {settings?.restartRequired && <p className="text-amber-200/90">{copy.restart}</p>}
        {saved && !settings?.restartRequired && <p className="text-emerald-200/80">{copy.saved}</p>}
      </div>
      {error && <p role="alert" className="text-xs leading-relaxed text-red-200/85">{error === 'load' ? copy.loadFailed : copy.saveFailed}</p>}
    </div>
  );
}
