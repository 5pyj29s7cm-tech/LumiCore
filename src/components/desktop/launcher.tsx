import React, { useState } from "react";
import { type ExternalCapabilityProjection, type ExternalCapabilityAction } from "@/services/externalCapabilities";
import { Play, FileText, Sparkles, Wrench, Box, Search, ChevronRight, BrainCircuit } from "lucide-react";
import { motion } from "motion/react";

export interface DesktopIconDefinition {
  id: string;
  label?: string;
  labelKey?: string;
  icon: React.ReactNode;
  colorClass: string;
  windowId?: string;
  externalLaunch?: {
    capability: ExternalCapabilityProjection;
    action: ExternalCapabilityAction;
  };
}


export function externalCapabilityDesktopIcon(icon: string | undefined): React.ReactNode {
  const normalized = String(icon || '').toLowerCase();
  if (/film|video|play|media/.test(normalized)) return <Play size={24} />;
  if (/document|file|text|contract|legal/.test(normalized)) return <FileText size={24} />;
  if (/spark|ai|magic|generate/.test(normalized)) return <Sparkles size={24} />;
  if (/tool|wrench|mcp|plugin/.test(normalized)) return <Wrench size={24} />;
  return <Box size={24} />;
}

export function Spotlight({ isOpen, onClose, onSelect, apps, t }: { isOpen: boolean; onClose: () => void; onSelect: (id: string) => void; apps: any[]; t: any }) {
  const [query, setQuery] = useState('');

  const filteredApps = apps.filter(app =>
    app.label.toLowerCase().includes(query.toLowerCase()) ||
    app.id.toLowerCase().includes(query.toLowerCase())
  );

  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-sm flex items-start justify-center pt-[15vh] px-4 pointer-events-auto"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: -20, scale: 0.95 }}
        animate={{ y: 0, scale: 1 }}
        className="w-full max-w-xl glass-dark border border-white/10 rounded-[2rem] overflow-hidden shadow-[0_50px_100px_rgba(0,0,0,0.8)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6 flex items-center gap-4 border-b border-white/5">
          <Search size={24} className="text-white/40" />
          <input
            autoFocus
            placeholder={t.searchNeuralHub || "Search Lumi Neural Hub..."}
            className="flex-1 bg-transparent border-none outline-none text-xl font-bold text-white placeholder:text-white/45"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <div className="px-2 py-1 bg-white/5 rounded text-xs font-black text-white/40 tracking-widest border border-white/5">ESC</div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
          {filteredApps.length > 0 ? (
            filteredApps.map(app => (
              <button
                key={app.id}
                onClick={() => { onSelect(app.id); onClose(); }}
                className="w-full p-4 flex items-center gap-4 hover:bg-white/5 rounded-2xl transition-colors text-left group"
              >
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${app.color} flex items-center justify-center p-2 shadow-lg`}>
                  {React.isValidElement(app.icon) ? React.cloneElement(app.icon, { size: 24 }) : app.icon}
                </div>
                <div className="flex-1">
                  <div className="text-sm font-black text-white tracking-tight">{app.label}</div>
                  <div className="text-xs text-white/55 uppercase tracking-widest">{t.neuralApp || 'Neural Application'}</div>
                </div>
                <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                  <ChevronRight size={16} className="text-white/40" />
                </div>
              </button>
            ))
          ) : (
             <div className="p-12 text-center text-white/45">
                <BrainCircuit size={48} className="mx-auto mb-4 opacity-10" />
                <p className="text-xs font-black uppercase tracking-widest">{t.noNeuralNodes || 'No neural nodes found'}</p>
             </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
