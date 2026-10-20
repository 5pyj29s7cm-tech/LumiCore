import React from 'react';
import { toast } from 'sonner';
import { desktopModeCopy } from '../../i18n/locales/desktopMode';
import type { DesktopExecutionPreference } from '../../../shared/operation_modes';

type Props = {
  preference: DesktopExecutionPreference;
  lang: string;
  appearance: 'light' | 'dark';
  setPreference: (preference: DesktopExecutionPreference) => Promise<boolean>;
};

/** Both placements reflect one acknowledged execution preference, not wallpaper. */
export function DesktopModeSwitch({ preference, lang, appearance, setPreference }: Props) {
  const light = appearance === 'light';
  const copy = desktopModeCopy(lang === 'zh' ? 'zh' : 'en');
  const labels = [copy.internal, copy.external];
  return (
    <div role="group" aria-label={copy.label} data-desktop-mode-switch
      className={`inline-flex shrink-0 gap-1 rounded-xl border p-1 text-xs font-semibold ${light ? 'border-slate-300 bg-white/90 text-slate-700' : 'border-white/15 bg-zinc-950/70 text-white/70'}`}>
      {(['internal', 'external'] as const).map((value, index) => (
        <button key={String(value)} type="button" aria-pressed={preference === value}
          title={value === 'external' ? copy.externalHint : copy.internalHint}
          onClick={() => { void setPreference(value).then(ok => { if (!ok) toast.error(copy.saveUnconfirmed); }).catch(() => toast.error(copy.saveUnconfirmed)); }}
          className={`rounded-lg px-3 py-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500 ${preference === value ? (light ? 'bg-slate-200 text-slate-950' : 'bg-white/15 text-white') : (light ? 'hover:bg-slate-100' : 'hover:bg-white/10')}`}>
          {labels[index]}
        </button>
      ))}
    </div>
  );
}
