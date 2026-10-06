import type React from "react";
import { FileText } from "lucide-react";

export function CaseField({ label, value, onChange, type = 'text', onReminder }: { label: string; value: string; onChange: (value: string) => void; type?: 'text' | 'date'; onReminder?: () => void }) {
  return (
    <label className="space-y-1.5">
      <span className="text-xs text-white/42">{label}</span>
      <div className="flex gap-2">
        <input
          type={type}
          value={value}
          onChange={event => onChange(event.target.value)}
          className="lumi-field h-10 min-w-0 flex-1 rounded-lg focus:border-amber-400/50"
        />
        {onReminder && (
          <button type="button" onClick={onReminder} className="lumi-button h-10 rounded-lg px-3 text-xs">
            +
          </button>
        )}
      </div>
    </label>
  );
}

export function LegalMeetingInlineButton({ label, onClick, className = '' }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 text-xs font-black uppercase tracking-[0.12em] text-cyan-100 transition-colors hover:border-cyan-300/35 hover:bg-cyan-400/15 ${className}`}
    >
      <span className="h-2 w-2 rounded-full bg-cyan-300" />
      <FileText size={14} />
      <span>{label}</span>
    </button>
  );
}

export function LegalMeetingActionButton({ title, desc, onClick }: { title: string; desc: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="lumi-panel group border-cyan-400/15 bg-cyan-400/[0.045] p-4 text-left transition-colors hover:border-cyan-300/30 hover:bg-cyan-400/[0.075]"
    >
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-200 group-hover:bg-cyan-400/15">
        <FileText size={16} />
      </div>
      <div className="text-sm font-bold text-cyan-100">{title}</div>
      <div className="mt-1 text-xs leading-5 text-cyan-100/48">{desc}</div>
    </button>
  );
}

export function LegalActionButton({ icon, title, desc, onClick }: { icon: React.ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="lumi-panel group p-4 text-left transition-colors hover:border-amber-400/25 hover:bg-amber-400/[0.045]"
    >
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.08] text-amber-300 group-hover:bg-amber-400/[0.12]">
        {icon}
      </div>
      <div className="text-sm font-bold text-white/82">{title}</div>
      <div className="mt-1 text-xs leading-5 text-white/35">{desc}</div>
    </button>
  );
}
