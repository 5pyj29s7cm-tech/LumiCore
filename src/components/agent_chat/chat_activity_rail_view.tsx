import { motion } from 'motion/react';
import { Loader2, Zap, Cpu, ChevronRight, FolderOpen } from 'lucide-react';
import { GlassCard } from "../SharedUI";
import { uiMessage } from "../../i18n/uiMessages";
import type { AgentChatViewInput } from './AgentChatView';

export function renderChatActivityRail({ knowledgeStatusText, refreshKnowledgeFiles, knowledgeLoading, chatFileSections, renderChatFileRow, t, isElectron, activeCapabilities }: Pick<AgentChatViewInput, "knowledgeStatusText" | "refreshKnowledgeFiles" | "knowledgeLoading" | "chatFileSections" | "renderChatFileRow" | "t" | "isElectron" | "activeCapabilities">) {
  return (
<motion.div
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1], delay: 0.15 }}
              className="hidden w-80 flex-shrink-0 space-y-4 overflow-y-auto custom-scrollbar xl:block 2xl:w-96">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1], delay: 0.16 }}>
          <GlassCard className="p-5 rounded-[2rem] space-y-4 border-emerald-400/20" hoverEffect={false}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-white/45">
                  <FolderOpen size={14} />
                  {uiMessage('agent-chat-page.chat-files.bfc05d58f7')}
                </h4>
                <p className="mt-1 truncate text-[11px] text-white/32">{knowledgeStatusText}</p>
              </div>
              <button
                type="button"
                onClick={() => void refreshKnowledgeFiles()}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/40 transition-colors hover:bg-white/10 hover:text-white/70"
                title={uiMessage('agent-chat-page.refresh-files.7b90fd0f8a')}
                aria-label={uiMessage('agent-chat-page.refresh-files.7b90fd0f8a')}
              >
                {knowledgeLoading ? <Loader2 size={14} className="animate-spin" /> : <ChevronRight size={14} />}
              </button>
            </div>

            <div className="max-h-[22rem] space-y-3 overflow-y-auto pr-1 custom-scrollbar">
              {chatFileSections.pending.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('agent-chat-page.current-attachments.9deb8aeeb4')}</div>
                  {chatFileSections.pending.map(renderChatFileRow)}
                </div>
              )}
              {chatFileSections.generated.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('agent-chat-page.generated-files.f3b9745393')}</div>
                  {chatFileSections.generated.map(renderChatFileRow)}
                </div>
              )}
              {chatFileSections.knowledge.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('agent-chat-page.knowledge-files.cc19d1427e')}</div>
                  {chatFileSections.knowledge.map(renderChatFileRow)}
                </div>
              )}
              {chatFileSections.pending.length === 0 && chatFileSections.generated.length === 0 && chatFileSections.knowledge.length === 0 && (
                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3 py-4 text-center text-xs text-white/35">
                  {uiMessage('agent-chat-page.no-files-available-yet.6ac4767777')}
                </div>
              )}
            </div>
          </GlassCard>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1], delay: 0.2 }}>
          <GlassCard className="p-6 rounded-[2.5rem] space-y-4 border-celestial-saturn/20" hoverEffect={false}>
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">{t.activeCapabilities || 'Active Capabilities'}</h4>
              {isElectron && (
                <div className="px-2 py-0.5 rounded-full bg-celestial-saturn/20 text-xs text-celestial-saturn font-black">NODE_NATIVE</div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {activeCapabilities.map((cap, i) => (
                <div key={i} className="px-3 py-1.5 rounded-xl bg-white/5 border border-white/5 text-xs text-white/60 font-bold flex items-center gap-2">
                  <div className="w-1 h-1 rounded-full bg-celestial-saturn" />
                  {cap}
                </div>
              ))}
            </div>
          </GlassCard>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1], delay: 0.36 }}>
          <GlassCard className="p-6 rounded-[2.5rem] space-y-4" hoverEffect={false}>
            <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">{t.agentStats || 'LumiCore Stats'}</h4>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60 flex items-center gap-2"><Cpu size={14}/> {t.logicEngine || 'Logic Engine'}</span>
                <span className="text-sm font-bold text-celestial-saturn">v1.0.2</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60 flex items-center gap-2"><Zap size={14}/> {t.syncSpeed || 'Sync Speed'}</span>
                <span className="text-sm font-bold text-celestial-mars">8.4ms</span>
              </div>
            </div>
          </GlassCard>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1], delay: 0.44 }}>
          <GlassCard className="p-6 rounded-[2.5rem] space-y-4" hoverEffect={false}>
            <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">{t.neuralMeshStatus || 'Neural Mesh Status'}</h4>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-bold">{t.encryptedLinkActive || 'Encrypted Link Active'}</span>
            </div>
            <p className="text-xs text-white/40 leading-relaxed">
              {t.agentSyncDesc || 'LumiCore is synchronized with the local node. All interactions remain in your private memory store.'}
            </p>
          </GlassCard>
          </motion.div>
            </motion.div>
  );
}
