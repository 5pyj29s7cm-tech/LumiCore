import React, { useEffect, useState } from 'react';
import { Battery, FileText } from 'lucide-react';
import { desktopWorkflowCopy } from '../i18n/locales/desktopWorkflows';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';

export function BatteryIndicator({ lang = 'zh' }: { lang?: 'en' | 'zh' }) {
  const [level, setLevel] = useState<number | null>(null);
  const [charging, setCharging] = useState(false);

  useEffect(() => {
    const navigation = navigator as any;
    if (!navigation.getBattery) return;
    navigation.getBattery().then((battery: any) => {
      setLevel(Math.round(battery.level * 100));
      setCharging(battery.charging);
      battery.addEventListener('levelchange', () => setLevel(Math.round(battery.level * 100)));
      battery.addEventListener('chargingchange', () => setCharging(battery.charging));
    }).catch(() => setLevel(null));
  }, []);

  if (level === null) return <Battery size={14} />;

  return (
    <div
      className="flex items-center gap-1"
      title={formatUiMessage(
        'desktop-ui.battery-value0-value1.18d968c4e5',
        { value0: level, value1: charging ? desktopWorkflowCopy(lang).common.chargingSuffix : '' },
        lang,
      )}
    >
      <Battery size={14} className={level <= 20 ? 'text-red-400' : level <= 50 ? 'text-yellow-400' : ''} />
      <span className="text-xs font-bold">{level}%</span>
    </div>
  );
}

export function MeetingModeButton({
  t,
  lang,
  active,
  live,
  onClick,
}: {
  t?: any;
  lang: 'en' | 'zh';
  active: boolean;
  live: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-w-[156px] items-center justify-center gap-2 rounded-2xl border px-3 py-2 text-xs font-black uppercase tracking-[0.16em] transition-all ${
        active
          ? 'border-cyan-400/30 bg-cyan-400/15 text-cyan-100 shadow-[0_12px_32px_rgba(34,211,238,0.12)]'
          : 'border-white/10 bg-white/[0.035] text-white/45 hover:bg-white/[0.075] hover:text-white/75'
      }`}
      title={t?.modeMeetingTitle || uiMessage('desktop-ui.meeting-mode.958510fb80', lang)}
    >
      <span className={`h-2 w-2 rounded-full ${live ? 'bg-cyan-300 animate-pulse' : active ? 'bg-cyan-300' : 'bg-white/25'}`} />
      <FileText size={14} />
      <span>{t?.modeMeeting || uiMessage('desktop-ui.meeting.e16a90b510', lang)}</span>
    </button>
  );
}

export function DayInkLandscape() {
  return (
    <div className="lumi-day-landscape" aria-hidden="true">
      <div className="lumi-day-paper" />
      <div className="lumi-day-mist lumi-day-mist-back" />
      <div className="lumi-day-mountains lumi-day-mountains-back" />
      <div className="lumi-day-mountains lumi-day-mountains-mid" />
      <div className="lumi-day-ground" />
      <div className="lumi-day-ink-lines" />
      <div className="lumi-day-vignette" />
    </div>
  );
}
