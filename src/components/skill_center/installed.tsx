import { motion, AnimatePresence } from "motion/react";
import { Cpu, Trash2, Power, PowerOff, RefreshCw, Wrench, Upload, AlertTriangle } from "lucide-react";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { ExternalCapabilityManagerSection } from "../ExternalCapabilityCenter";
import type { useSkillCenterState } from './useSkillCenterState';
import { getInstalledSkillAvailability, hasSkillRuntimeIssue } from './availability';
import { SkillStatusCallout } from './presentation';

export function renderInstalledSkills({ canUseExternalCapabilities, externalCapabilities, canReviewExternalCapabilities, externalCapabilitiesError, externalCapabilitiesLoading, lang, fetchReviewedExternalCapabilities, recommendationCopy, brokenSkillCount, handleCleanupBroken, cleaningBroken, loading, installedSkills, t, setDetailSkill, handleRepair, repairing, handleToggle, handlePublish, handleUninstall }: Pick<ReturnType<typeof useSkillCenterState>, "canUseExternalCapabilities" | "externalCapabilities" | "canReviewExternalCapabilities" | "externalCapabilitiesError" | "externalCapabilitiesLoading" | "lang" | "fetchReviewedExternalCapabilities" | "recommendationCopy" | "brokenSkillCount" | "handleCleanupBroken" | "cleaningBroken" | "loading" | "installedSkills" | "t" | "setDetailSkill" | "handleRepair" | "repairing" | "handleToggle" | "handlePublish" | "handleUninstall">) {
  return (
<motion.div key="installed" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="space-y-6">
            {canUseExternalCapabilities && (externalCapabilities.length > 0 || canReviewExternalCapabilities || externalCapabilitiesError) && (
              <ExternalCapabilityManagerSection
                capabilities={externalCapabilities}
                loading={externalCapabilitiesLoading}
                error={externalCapabilitiesError}
                lang={lang}
                canDeactivate={canReviewExternalCapabilities}
                onRefresh={fetchReviewedExternalCapabilities}
              />
            )}
            <div className="lumi-panel p-5">
              <div className="flex items-center gap-2">
                <Cpu size={17} className="text-cyan-200" />
                <h4 className="text-sm font-black uppercase tracking-normal text-white/85">{recommendationCopy.managementTitle}</h4>
              </div>
              <p className="mt-2 max-w-3xl text-xs leading-relaxed text-white/45">{recommendationCopy.managementHint}</p>
            </div>
            {brokenSkillCount > 0 && (
              <div className="flex items-center justify-between gap-3 rounded-2xl border border-red-500/10 bg-red-500/5 p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <AlertTriangle size={16} className="shrink-0 text-red-300" />
                  <p className="text-xs font-bold text-red-200">
                    {formatUiMessage('skill-center.value0-incomplete-skill-package-value1.880bdf7b48', { value0: brokenSkillCount, value1: { en: brokenSkillCount > 1 ? 's' : '', zh: '' } }, (lang === 'zh') ? 'zh' : 'en')}
                  </p>
                </div>
                <button
                  onClick={handleCleanupBroken}
                  disabled={cleaningBroken}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200 transition-colors hover:bg-red-500/20 disabled:opacity-40"
                >
                  {cleaningBroken ? <RefreshCw size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  {uiMessage('skill-center.clean-broken.b337dc6228', (lang === 'zh') ? 'zh' : 'en')}
                </button>
              </div>
            )}
            {loading && installedSkills.length === 0 ? (
              <div className="lumi-panel p-16 text-center">
                <p className="text-white/40 text-sm">{t.loading || 'Loading...'}</p>
              </div>
            ) : installedSkills.length === 0 ? (
              <div className="lumi-panel p-16 text-center">
                <Wrench size={40} className="text-white/45 mx-auto mb-4" />
                <p className="text-white/40 font-bold uppercase tracking-widest text-sm">{t.noSkillsInstalled || 'No skills installed'}</p>
                <p className="text-white/45 text-xs mt-2">{t.skillBrowseMarketplace || 'Browse the marketplace or generate one.'}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <AnimatePresence>
                  {installedSkills.map(skill => {
                    const availability = getInstalledSkillAvailability(skill, lang);
                    return (
                    <motion.div
                      key={skill.name}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      onClick={() => setDetailSkill(skill)}
                      className="lumi-panel cursor-pointer p-6 transition-all hover:border-white/15 hover:bg-white/[0.06]"
                    >
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-bold text-white/90 text-sm">{skill.name}</h4>
                          <span className="text-xs text-white/55 font-mono">{skill.toolCount} {t.toolsCount || 'tools'}{skill.installedAt ? ` · ${new Date(skill.installedAt).toLocaleDateString()}` : ''}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {hasSkillRuntimeIssue(skill) && (
                            <button onClick={(e) => { e.stopPropagation(); handleRepair(skill.name); }}
                              disabled={repairing === skill.name}
                              className="p-2 rounded-lg text-amber-300 transition-colors hover:bg-amber-500/10 disabled:opacity-40"
                              title={uiMessage('skill-center.repair.3f5a830aaf', (lang === 'zh') ? 'zh' : 'en')}
                            >
                              <RefreshCw size={13} className={repairing === skill.name ? 'animate-spin' : ''} />
                            </button>
                          )}
                          <button onClick={(e) => { e.stopPropagation(); handleToggle(skill.name, !skill.enabled); }}
                            disabled={skill.broken || repairing === skill.name}
                            className={`p-2 rounded-lg transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${skill.enabled ? 'text-green-400 hover:bg-green-500/10' : 'text-white/45 hover:bg-white/5'}`}
                            title={skill.enabled ? (t.skillDisableBtn || 'Disable') : (t.skillEnableBtn || 'Enable')}
                          >
                            {skill.enabled ? <Power size={13} /> : <PowerOff size={13} />}
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); handlePublish(skill.name); }}
                            className="p-2 hover:bg-violet-500/10 rounded-lg text-white/45 hover:text-violet-400 transition-colors"
                            title={t.publishBtn || 'Publish'}
                          >
                            <Upload size={13} />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); handleUninstall(skill.name); }}
                            className="p-2 hover:bg-red-500/10 rounded-lg text-white/45 hover:text-red-400 transition-colors"
                            title={t.uninstallBtn || 'Uninstall'}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      <p className="text-xs text-white/50 leading-relaxed mb-4 line-clamp-2">{skill.description}</p>
                      <div className="mb-4">
                        <SkillStatusCallout availability={availability} compact />
                      </div>

                      {/* Tags */}
                      <div className="flex items-center gap-2 flex-wrap">
                        {skill.autoGenerated && (
                          <span className="flex items-center gap-1 px-2 py-0.5 bg-emerald-500/10 rounded-full text-[12px] text-emerald-400 font-bold">{t.autoGenerated || 'Auto'}</span>
                        )}
                        {skill.connected && (
                          <span className="flex items-center gap-1 px-2 py-0.5 bg-green-500/10 rounded-full text-[12px] text-green-400 font-bold">{t.connected || 'Connected'}</span>
                        )}
                        {skill.broken && (
                          <span className="flex items-center gap-1 px-2 py-0.5 bg-red-500/10 rounded-full text-[12px] text-red-300 font-bold">
                            <AlertTriangle size={11} />{uiMessage('skill-center.broken.565289cc16', (lang === 'zh') ? 'zh' : 'en')}
                          </span>
                        )}
                        {!skill.broken && skill.startupError && (
                          <span className="flex items-center gap-1 px-2 py-0.5 bg-amber-500/10 rounded-full text-[12px] text-amber-300 font-bold">
                            <AlertTriangle size={11} />{uiMessage('skill-center.needs-repair.53833da009', (lang === 'zh') ? 'zh' : 'en')}
                          </span>
                        )}
                        {!skill.broken && skill.enabled && !skill.connected && (
                          <span className="flex items-center gap-1 px-2 py-0.5 bg-amber-500/10 rounded-full text-[12px] text-amber-300 font-bold">
                            <AlertTriangle size={11} />{uiMessage('skill-center.not-connected.e55a06aa6b', (lang === 'zh') ? 'zh' : 'en')}
                          </span>
                        )}
                        {!skill.broken && skill.healthStatus && !skill.enabled && !['connected', 'disconnected', 'unknown'].includes(skill.healthStatus) && (
                          <span className="flex items-center gap-1 px-2 py-0.5 bg-amber-500/10 rounded-full text-[12px] text-amber-300 font-bold">
                            <AlertTriangle size={11} />{skill.healthStatus}
                          </span>
                        )}
                        <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[12px] font-bold ${skill.enabled ? 'bg-green-500/10 text-green-400' : 'bg-white/5 text-white/45'}`}>
                          {skill.enabled ? (t.enabled || 'Enabled') : (t.disabled || 'Disabled')}
                        </span>
                      </div>
                    </motion.div>
                  );})}
                </AnimatePresence>
              </div>
            )}
          </motion.div>
  );
}
