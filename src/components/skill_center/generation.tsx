import { motion } from "motion/react";
import { Sparkles, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { uiMessage } from "../../i18n/uiMessages";
import { GeneratedSkillHistory } from "../GeneratedSkillHistory";
import type { useSkillCenterState } from './useSkillCenterState';

export function renderSkillGeneration({ lang, generatedDraft, setGeneratedDraft, setActiveTab, t, genDescription, setGenDescription, handleGenerate, generating, SAMPLE_PROMPTS, installingGeneratedDraft, handleInstallGeneratedDraft }: Pick<ReturnType<typeof useSkillCenterState>, "lang" | "generatedDraft" | "setGeneratedDraft" | "setActiveTab" | "t" | "genDescription" | "setGenDescription" | "handleGenerate" | "generating" | "SAMPLE_PROMPTS" | "installingGeneratedDraft" | "handleInstallGeneratedDraft">) {
  return (
<motion.div key="generate" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="space-y-6">
            <GeneratedSkillHistory lang={lang} refreshToken={generatedDraft?.review.contentHash}
              onReview={draft => setGeneratedDraft(draft)} onInstalled={() => setActiveTab('installed')} />
            <div className="lumi-panel p-6 space-y-4">
              <div className="flex items-center gap-3">
                <Sparkles className="text-celestial-saturn" size={18} />
                <h4 className="text-sm font-bold uppercase tracking-tight text-white">{t.generateNewSkill || 'Generate a New Skill'}</h4>
              </div>
              <p className="text-xs text-white/55 leading-relaxed">
                {t.skillGenerateDesc || 'Describe what the skill should do. Lumi generates a complete MCP server package.'}
              </p>
              <div className="flex gap-2">
                <Input value={genDescription} onChange={e => setGenDescription(e.target.value)}
                  placeholder={t.skillGeneratePlaceholder || 'e.g. Check if a website is down...'}
                  className="lumi-field flex-1 py-2 text-xs"
                  onKeyDown={e => e.key === 'Enter' && handleGenerate()} />
                <Button onClick={handleGenerate} disabled={generating || !genDescription.trim()}
                  className="lumi-button-primary bg-celestial-saturn text-black hover:bg-celestial-saturn/90">
                  {generating ? (t.generating || '...') : (t.generateBtn || 'Generate')}
                </Button>
              </div>
              <div className="flex gap-2 flex-wrap">
                {SAMPLE_PROMPTS.map(ex => (
                  <button key={ex} onClick={() => setGenDescription(ex)} className="rounded-lg border border-white/[0.08] bg-white/[0.045] px-2 py-1 text-[12px] text-white/55 transition-colors hover:border-white/15 hover:text-white/75">
                    {ex}
                  </button>
                ))}
              </div>
            </div>
            {generatedDraft && (
              <div className="lumi-panel space-y-4 border border-amber-400/15 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <ShieldCheck size={16} className="text-amber-300" />
                      <h4 className="text-sm font-bold text-white/90">
                        {uiMessage('skill-center.pending-generated-draft.20260901', lang)}
                      </h4>
                    </div>
                    <p className="mt-2 text-xs text-white/55">
                      {generatedDraft.skillName} · {generatedDraft.toolName}
                    </p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase ${generatedDraft.review.risk === 'high' ? 'bg-red-500/10 text-red-300' : generatedDraft.review.risk === 'medium' ? 'bg-amber-500/10 text-amber-300' : 'bg-green-500/10 text-green-300'}`}>
                    {generatedDraft.review.risk} risk
                  </span>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl bg-white/[0.035] p-4">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-white/45">{uiMessage('skill-center.permissions.20260901', lang)}</p>
                    <p className="mt-2 text-xs leading-relaxed text-white/65">
                      {generatedDraft.review.permissions.length ? generatedDraft.review.permissions.join(' · ') : uiMessage('skill-center.no-extra-permissions.20260901', lang)}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-white/[0.035] p-4">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-white/45">{uiMessage('skill-center.side-effects.20260901', lang)}</p>
                    <p className="mt-2 text-xs leading-relaxed text-white/65">
                      {generatedDraft.review.sideEffects.length ? generatedDraft.review.sideEffects.join(' · ') : uiMessage('skill-center.no-state-changes.20260901', lang)}
                    </p>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl bg-white/[0.035] p-4">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-white/45">{uiMessage('skill-center.validation-evidence.20260901', lang)}</p>
                    <p className="mt-2 text-xs leading-relaxed text-white/65">{generatedDraft.review.trialRun.note}</p>
                    <p className="mt-2 text-[11px] leading-relaxed text-amber-200/65">
                      {generatedDraft.review.evidence.limitations.join(' · ')}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-white/[0.035] p-4">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-white/45">{uiMessage('skill-center.artifact-hash.20260901', lang)}</p>
                    <code className="mt-2 block break-all text-[11px] leading-relaxed text-cyan-200/70">{generatedDraft.review.contentHash}</code>
                    <p className="mt-3 text-[11px] font-bold uppercase tracking-wider text-white/45">{uiMessage('skill-center.execution-command.20260901', lang)}</p>
                    <code className="mt-1 block text-[11px] text-white/60">npx --no-install tsx index.ts</code>
                  </div>
                </div>
                <div className="rounded-2xl bg-white/[0.035] p-4">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-white/45">{uiMessage('skill-center.static-findings.20260901', lang)}</p>
                  <p className="mt-2 text-xs leading-relaxed text-white/65">
                    {generatedDraft.review.staticCheck.findings.length
                      ? generatedDraft.review.staticCheck.findings.join(' · ')
                      : uiMessage('skill-center.no-static-findings.20260901', lang)}
                  </p>
                </div>
                {generatedDraft.generatedCode && (
                  <details className="rounded-2xl border border-white/[0.06] bg-black/20 p-4">
                    <summary className="cursor-pointer text-xs font-bold text-white/65">{uiMessage('skill-center.generated-source.20260901', lang)}</summary>
                    <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/35 p-3 text-[11px] leading-relaxed text-white/55">{generatedDraft.generatedCode}</pre>
                  </details>
                )}
                <div className="rounded-2xl border border-white/[0.06] bg-black/20 p-4 text-xs leading-relaxed text-white/55">
                  {uiMessage('skill-center.generated-draft-install-explanation.20260901', lang)}
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => setGeneratedDraft(null)}
                    disabled={installingGeneratedDraft}
                    className="text-white/55"
                  >
                    {uiMessage('skill-center.not-now.20260901', lang)}
                  </Button>
                  <Button
                    onClick={handleInstallGeneratedDraft}
                    disabled={installingGeneratedDraft}
                    className="lumi-button-primary bg-celestial-saturn text-black hover:bg-celestial-saturn/90"
                  >
                    {installingGeneratedDraft ? <RefreshCw size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                    {uiMessage('skill-center.approve-install.20260901', lang)}
                  </Button>
                </div>
              </div>
            )}
          </motion.div>
  );
}
