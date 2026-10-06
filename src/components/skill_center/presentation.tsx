import type React from "react";
import { Sparkles, ShoppingBag, Download, RefreshCw, Wrench, CheckCircle, Globe, Search, Zap, Palette, Terminal, Monitor, Film, ExternalLink, AlertTriangle, ShieldCheck, Mail, QrCode, Link, Image, FileText, CloudSun, Languages, Calculator, StickyNote, Timer, TrendingUp, Music, GraduationCap, BriefcaseBusiness, Stethoscope } from "lucide-react";
import { Button } from "../ui/button";
import { uiMessage } from "../../i18n/uiMessages";
import type { MarketplaceSkill, SkillAvailability } from './contracts';
import { getInstallActionText, AVAILABILITY_CLASSES } from './availability';

export const ICON_CLASSES: Record<string, string> = {
  CloudSun: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  Languages: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  Calculator: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  StickyNote: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  Timer: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  Globe: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Mail: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  QrCode: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  Key: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  Link: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  Image: 'bg-pink-500/10 text-pink-400 border-pink-500/20',
  FileText: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  Palette: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Sparkles: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  ShoppingBag: 'bg-lime-500/10 text-lime-400 border-lime-500/20',
  ShieldCheck: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  Wrench: 'bg-slate-500/10 text-slate-300 border-slate-500/20',
  GraduationCap: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  BriefcaseBusiness: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  Stethoscope: 'bg-red-500/10 text-red-400 border-red-500/20',
  Terminal: 'bg-green-500/10 text-green-400 border-green-500/20',
  Monitor: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  Search: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  Film: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
};

export const ICON_COMPONENTS: Record<string, React.ReactNode> = Object.fromEntries(Object.entries({
  Calculator, CloudSun, FileText, Globe, Image, Languages, Link,
  Mail, Music, QrCode, ShieldCheck, Sparkles, ShoppingBag, GraduationCap,
  BriefcaseBusiness, Stethoscope, StickyNote, Terminal, Timer, TrendingUp, Monitor,
  Search, Palette, Film, Wrench, Zap,
}).map(([name, Icon]) => [name, <Icon size={18} />]));

export function SkillInstallButton({
  skill, installed, installing, variant, lang, t, onInstall,
}: {
  skill: MarketplaceSkill; installed: boolean; installing: string | null;
  variant: 'recommended' | 'marketplace' | 'detail'; lang: 'en' | 'zh'; t: any;
  onInstall: () => void;
}) {
  const state = installed ? 'installed'
    : skill.officialIdentityStatus === 'conflict' ? 'conflict'
    : skill.installSource !== 'bundled' || skill.runtimeInstallable === false ? 'review'
    : installing === skill.id ? 'installing' : 'available';
  const available = state === 'available';
  const size = variant === 'detail' ? 14 : 12;
  const Icon = { installed: CheckCircle, conflict: AlertTriangle, review: ShieldCheck, installing: RefreshCw, available: Download }[state];
  const label = state === 'installed' ? getInstallActionText(true, lang, t)
    : state === 'conflict' ? 'Review conflict'
    : state === 'review' ? (variant === 'marketplace' ? uiMessage('skill-center.review-required.20260901', lang) : 'External MCP review')
    : state === 'installing' ? (t.installingStatus || 'Installing...') : getInstallActionText(false, lang, t);
  const style = variant === 'recommended'
    ? (installed ? 'bg-green-500/20 text-green-300' : 'bg-white/10 text-white/70 hover:bg-white/18')
    : installed ? 'bg-green-500/20 text-green-400 cursor-default'
    : variant === 'marketplace' && (state === 'review' || state === 'conflict') ? 'bg-amber-500/10 text-amber-300/70 cursor-not-allowed'
    : variant === 'marketplace' && state === 'installing' ? 'bg-celestial-saturn/50 text-black cursor-wait'
    : 'bg-celestial-saturn text-black hover:scale-105';
  const spacing = variant === 'recommended' ? 'px-3 py-2' : variant === 'detail' ? 'px-5 py-2.5' : 'px-3 py-1.5';
  return (
    <Button disabled={!available} className={`text-xs font-bold h-auto rounded-xl transition-all ${spacing} ${style}`}
      onClick={event => { event.stopPropagation(); if (available) onInstall(); }}>
      <Icon size={size} className={`${variant === 'recommended' ? '' : 'mr-1'} ${state === 'installing' ? 'animate-spin' : ''}`} />
      {label}
    </Button>
  );
}

export function SkillStatusCallout({ availability, compact = false }: { availability: SkillAvailability; compact?: boolean }) {
  const icon = availability.tone === 'green'
    ? <CheckCircle size={compact ? 11 : 13} />
    : availability.tone === 'cyan'
      ? <ExternalLink size={compact ? 11 : 13} />
      : availability.tone === 'amber' || availability.tone === 'red'
        ? <AlertTriangle size={compact ? 11 : 13} />
        : <ShieldCheck size={compact ? 11 : 13} />;
  return (
    <div className={`rounded-xl border ${compact ? 'px-3 py-2' : 'px-3.5 py-3'} ${AVAILABILITY_CLASSES[availability.tone]}`}>
      <div className="flex items-center gap-1.5 text-[12px] font-black uppercase">
        {icon}
        <span>{availability.label}</span>
      </div>
      <p className={`${compact ? 'line-clamp-1 text-[11px]' : 'text-xs'} mt-1 leading-relaxed opacity-75`}>
        {availability.detail}
      </p>
    </div>
  );
}
