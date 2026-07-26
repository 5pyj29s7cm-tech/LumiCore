import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Battery, FileText, Moon, Sparkles, Zap } from 'lucide-react';
import type { OperationMode } from '@/contexts/AppContext';
import { sounds } from '../services/soundService';
import { desktopWorkflowCopy } from '../i18n/locales/desktopWorkflows';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import { GlassCard } from './SharedUI';

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

export function DayInkLandscape({ variant }: { variant: 'celestial' | 'nebula' | 'cyber' }) {
  return (
    <div className="lumi-day-landscape" data-day-variant={variant} aria-hidden="true">
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

export function ThemeWidget({
  t,
  lang,
  theme,
  setTheme,
  operationMode,
  onModeChange,
}: {
  t?: any;
  lang: 'en' | 'zh';
  theme: string;
  setTheme: (value: string) => void;
  operationMode: OperationMode;
  onModeChange: (mode: OperationMode) => void;
}) {
  const themeOptions = [
    {
      id: 'celestial',
      label: t?.celestial || 'Celestial',
      mode: 'chat' as OperationMode,
      modeLabel: t?.modeChat || uiMessage('desktop-ui.chat.1594b2f45c', lang),
      accessLabel: uiMessage('desktop-ui.chat-only.083f4dceca', lang),
      icon: <Sparkles size={16} />,
      glow: 'from-celestial-saturn/35 to-cyan-300/20',
      orb: 'from-celestial-saturn to-cyan-200',
      line: 'bg-celestial-saturn',
    },
    {
      id: 'nebula',
      label: t?.nebula || 'Nebula',
      mode: 'assistant' as OperationMode,
      modeLabel: t?.modeAssistant || uiMessage('desktop-ui.assistant.90c4ae600c', lang),
      accessLabel: uiMessage('desktop-ui.foreground-full-access.05f024a485', lang),
      icon: <Moon size={16} />,
      glow: 'from-indigo-500/35 to-fuchsia-400/20',
      orb: 'from-indigo-500 to-fuchsia-400',
      line: 'bg-indigo-400',
    },
    {
      id: 'cyber',
      label: t?.cyber || 'Cyber',
      mode: 'autonomous' as OperationMode,
      modeLabel: t?.modeAutonomy || t?.modeAutoExecute || uiMessage('desktop-ui.autonomy.6aea974e38', lang),
      accessLabel: uiMessage('desktop-ui.24h-autonomous.1cd235aa0d', lang),
      icon: <Zap size={16} />,
      glow: 'from-emerald-400/30 to-teal-300/20',
      orb: 'from-emerald-400 to-teal-300',
      line: 'bg-emerald-400',
    },
  ];

  return (
    <GlassCard className="lumi-mode-panel rounded-[1.6rem] border-white/5 bg-black/20 p-3">
      <div className="grid grid-cols-3 gap-3">
        {themeOptions.map(option => {
          const active = theme === option.id && operationMode === option.mode;
          const visualActive = theme === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                if (option.mode !== 'autonomous' || operationMode === 'autonomous') setTheme(option.id);
                onModeChange(option.mode);
                sounds.playPulse();
              }}
              className={`lumi-mode-card group relative min-h-[134px] overflow-hidden rounded-[1.25rem] border p-3 text-left transition-all ${
                active
                  ? 'border-white/20 bg-white/[0.10] shadow-[0_18px_45px_rgba(0,0,0,0.28)]'
                  : visualActive
                    ? 'border-white/10 bg-white/[0.06]'
                    : 'border-white/5 bg-black/20 hover:bg-white/[0.05]'
              }`}
            >
              <div className={`lumi-mode-card-glow absolute inset-0 bg-gradient-to-br ${option.glow} transition-opacity group-hover:opacity-80 ${visualActive ? 'opacity-100' : 'opacity-40'}`} />
              <div className="relative flex h-full flex-col justify-between">
                <div className="flex items-start justify-between gap-2">
                  <div className={`lumi-mode-orb flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br ${option.orb} text-black shadow-lg`}>
                    {option.icon}
                  </div>
                  <span className={`h-2 w-2 rounded-full ${active ? option.line : 'bg-white/20'}`} />
                </div>
                <div>
                  <div className="text-[11px] font-black uppercase tracking-[0.14em] text-white/85">{option.label}</div>
                  <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white/45">{option.modeLabel}</div>
                  <div className="mt-2 min-h-[22px] rounded-lg border border-white/10 bg-black/20 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-white/70">{option.accessLabel}</div>
                  <div className="mt-2 h-1 rounded-full bg-white/10">
                    <motion.div
                      animate={{ width: active ? '100%' : visualActive ? '64%' : '28%' }}
                      className={`h-full rounded-full ${option.line}`}
                    />
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </GlassCard>
  );
}
