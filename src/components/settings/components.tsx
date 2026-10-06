import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { uiMessage } from "../../i18n/uiMessages";

export function SidebarItem({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button
      onClick={onClick}
      className={`relative flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ${active ? 'border border-white/10 bg-white/[0.075] text-white' : 'border border-transparent text-white/55 hover:bg-white/[0.045] hover:text-white/75'}`}
    >
      <div className={`flex-shrink-0 w-4 h-4 flex items-center justify-center ${active ? 'text-celestial-saturn' : 'text-current'}`}>{icon}</div>
      <span className="truncate text-[13px] font-medium">{label}</span>
      {active && <div className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-celestial-saturn" />}
    </button>
  );
}

export type ProviderTestState = 'idle' | 'testing' | 'ok' | 'error';

export function SettingsDisclosure({
  icon,
  label,
  badges,
  defaultOpen = false,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  badges?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="group border-b border-white/10 last:border-b-0">
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 py-3 text-left marker:content-none">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/8 bg-white/[0.035] text-white/70">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-white/80">{label}</span>
        {badges}
        <ChevronDown size={15} className="shrink-0 text-white/30 transition-transform group-open:rotate-180" />
      </summary>
      <div className="pb-5 sm:pl-11">
        {children}
      </div>
    </details>
  );
}

export function GenerationModelInput({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const modelOptions = Array.from(new Set([value, ...options].map(option => option.trim()).filter(Boolean)));
  return (
    <label className="grid gap-2 md:grid-cols-[150px_minmax(0,1fr)] md:items-center">
      <span className="text-xs font-bold text-white/55">{label}</span>
      <span className="relative">
        <select
          id={id}
          value={value}
          onChange={event => onChange(event.target.value)}
          disabled={modelOptions.length === 0}
          className="w-full appearance-none rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 pr-9 font-mono text-xs text-white outline-none focus:border-celestial-saturn/45 disabled:opacity-45"
        >
          {modelOptions.length === 0 && <option value="">{uiMessage('settings.no-models-configured.0c98ec7051')}</option>}
          {modelOptions.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
        <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/35" />
      </span>
    </label>
  );
}

export function SettingsSection({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-5">
      <div className="flex items-center gap-2.5">
        {icon || null}
        <h3 className="text-base font-semibold text-white/90">{title}</h3>
      </div>
      <div className="space-y-4">
        {children}
      </div>
    </section>
  );
}

export function SettingsItem({ label, desc, active = false, storageKey, onChange, t }: { label: string; desc: string; active?: boolean; storageKey?: string; onChange?: (v: boolean) => void; t?: any }) {
  const [isActive, setIsActive] = useState(() => {
    if (storageKey) {
      try { return localStorage.getItem(storageKey) === 'true'; } catch { return active; }
    }
    return active;
  });

  const toggle = () => {
    const next = !isActive;
    setIsActive(next);
    if (storageKey) {
      localStorage.setItem(storageKey, String(next));
    }
    onChange?.(next);
    toast.info(`${label}: ${next ? (t?.enabled || uiMessage('settings.enabled.4508d98328')) : (t?.disabled || uiMessage('settings.disabled.68b069bc6a'))}`);
  };

  return (
    <div className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5">
      <div className="space-y-1">
        <div className="font-bold text-sm text-white/90">{label}</div>
        <div className="text-xs text-white/40 uppercase tracking-widest">{desc}</div>
      </div>
      <div onClick={toggle} className={`w-10 h-5 rounded-full p-1 transition-colors cursor-pointer ${isActive ? 'bg-celestial-saturn' : 'bg-white/10'}`}>
        <div className={`w-3 h-3 rounded-full bg-white transition-transform ${isActive ? 'translate-x-5' : 'translate-x-0'}`} />
      </div>
    </div>
  );
}
