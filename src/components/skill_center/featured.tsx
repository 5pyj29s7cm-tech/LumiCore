import { motion } from "motion/react";
import { Sparkles, Cpu, RefreshCw, Star, CheckCircle, Zap, AlertTriangle } from "lucide-react";
import type { useSkillCenterState } from './useSkillCenterState';
import { getDisplayAvailability, getInstallActionText, getInstalledSkillAvailability } from './availability';
import { ICON_CLASSES, ICON_COMPONENTS, SkillStatusCallout, SkillInstallButton } from './presentation';

export function renderFeaturedSkills({ recommendationCopy, fetchRecommendationSignals, professionProfiles, matchedWorkSignals, lang, hasRecommendationSignals, recommendationError, recommendedSkills, installedSkills, savedKeys, setDetailSkill, t, installing, handleInstall, installedSkillRows, setActiveTab }: Pick<ReturnType<typeof useSkillCenterState>, "recommendationCopy" | "fetchRecommendationSignals" | "professionProfiles" | "matchedWorkSignals" | "lang" | "hasRecommendationSignals" | "recommendationError" | "recommendedSkills" | "installedSkills" | "savedKeys" | "setDetailSkill" | "t" | "installing" | "handleInstall" | "installedSkillRows" | "setActiveTab">) {
  return (
<motion.div key="featured" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="space-y-6">
            <div className="lumi-panel p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <Sparkles size={18} className="text-celestial-saturn" />
                    <h4 className="text-sm font-black uppercase tracking-normal text-white/85">{recommendationCopy.title}</h4>
                  </div>
                  <p className="mt-2 max-w-2xl text-xs leading-relaxed text-white/45">{recommendationCopy.subtitle}</p>
                </div>
                <button
                  onClick={fetchRecommendationSignals}
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.045] px-3 text-xs font-bold text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white/80"
                >
                  <RefreshCw size={13} />
                  {recommendationCopy.refresh}
                </button>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {professionProfiles.slice(0, 4).map(profile => {
                  const confidence = Number(profile.confidence || 0);
                  return (
                    <span key={profile.profession} className="rounded-full border border-celestial-saturn/20 bg-celestial-saturn/10 px-3 py-1 text-[12px] font-bold text-celestial-saturn/90">
                      {recommendationCopy.profile}: {profile.profession}{confidence ? ` ${Math.round(confidence * 100)}%` : ''}
                    </span>
                  );
                })}
                {matchedWorkSignals.map(signal => (
                  <span key={signal.en} className="rounded-full border border-cyan-300/15 bg-cyan-300/8 px-3 py-1 text-[12px] font-bold text-cyan-100/70">
                    {recommendationCopy.signals}: {lang === 'zh' ? signal.zh : signal.en}
                  </span>
                ))}
                {!hasRecommendationSignals && (
                  <span className="rounded-full border border-white/8 bg-white/[0.04] px-3 py-1 text-[12px] font-bold text-white/45">
                    {recommendationCopy.noSignals}
                  </span>
                )}
              </div>
            </div>

            {recommendationError && (
              <div className="flex items-center gap-2 rounded-2xl border border-amber-400/15 bg-amber-500/10 px-4 py-3 text-xs text-amber-100/75">
                <AlertTriangle size={14} className="text-amber-300" />
                {recommendationError}
              </div>
            )}

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 px-1">
                <div className="flex items-center gap-2">
                  <Star size={15} className="text-celestial-saturn" />
                  <h4 className="text-xs font-black uppercase tracking-widest text-white/65">{recommendationCopy.recommendations}</h4>
                </div>
                <span className="text-[12px] font-mono text-white/35">{recommendedSkills.length}</span>
              </div>

              {recommendedSkills.length === 0 ? (
                <div className="lumi-panel p-8 text-center">
                  <p className="text-sm text-white/45">{recommendationCopy.noRecommendations}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {recommendedSkills.map(({ skill, reasons }) => {
                    const availability = getDisplayAvailability(skill, installedSkills, savedKeys, lang);
                    const isInstalled = skill.installed || !!availability.installedSkill;
                    return (
                      <motion.div
                        key={skill.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        onClick={() => setDetailSkill(skill)}
                        className="lumi-panel cursor-pointer p-5 transition-all hover:border-white/15 hover:bg-white/[0.06]"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <div className={`w-10 h-10 rounded-xl border flex shrink-0 items-center justify-center ${ICON_CLASSES[skill.icon] || 'bg-white/5 text-white/55 border-white/10'}`}>
                              {ICON_COMPONENTS[skill.icon] || <Zap size={18} />}
                            </div>
                            <div className="min-w-0">
                              <h5 className="truncate text-sm font-bold text-white/88">{skill.name}</h5>
                              <span className="text-xs font-mono text-white/45">{skill.category} &middot; {skill.toolCount || 1} {t.toolsCount || 'tools'}</span>
                            </div>
                          </div>
                          {isInstalled && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-500/10 px-2 py-1 text-[12px] font-bold text-green-300">
                              <CheckCircle size={10} /> {getInstallActionText(true, lang, t)}
                            </span>
                          )}
                        </div>

                        <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-white/50">{skill.description}</p>
                        <div className="mt-3">
                          <SkillStatusCallout availability={availability} compact />
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {reasons.slice(0, 3).map(reason => (
                            <span key={reason} className="rounded-full border border-white/8 bg-white/[0.04] px-2 py-0.5 text-[11px] font-semibold text-white/45">
                              {reason}
                            </span>
                          ))}
                        </div>
                        <div className="mt-4 flex justify-end">
                          <SkillInstallButton skill={skill} installed={isInstalled} installing={installing} variant="recommended" lang={lang} t={t} onInstall={() => handleInstall(skill)} />
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1 px-1 sm:flex-row sm:items-end sm:justify-between">
                <div className="flex items-center gap-2">
                  <Cpu size={15} className="text-cyan-200" />
                  <h4 className="text-xs font-black uppercase tracking-widest text-white/65">{recommendationCopy.installed}</h4>
                </div>
                <p className="max-w-2xl text-[12px] leading-relaxed text-white/35">{recommendationCopy.installedHint}</p>
              </div>

              {installedSkillRows.length === 0 ? (
                <div className="lumi-panel p-8 text-center">
                  <p className="text-sm text-white/45">{recommendationCopy.noInstalled}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {installedSkillRows.map(({ skill, marketSkill }) => {
                    const availability = getInstalledSkillAvailability(skill, lang);
                    return (
                      <motion.div
                        key={skill.name}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        onClick={() => {
                          setActiveTab('installed');
                          setDetailSkill(skill);
                        }}
                        className="lumi-panel cursor-pointer p-5 transition-all hover:border-white/15 hover:bg-white/[0.06]"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <div className={`w-10 h-10 rounded-xl border flex shrink-0 items-center justify-center ${marketSkill ? (ICON_CLASSES[marketSkill.icon] || 'bg-white/5 text-white/55 border-white/10') : 'border-cyan-300/15 bg-cyan-300/8 text-cyan-100/70'}`}>
                              {marketSkill ? (ICON_COMPONENTS[marketSkill.icon] || <Zap size={18} />) : <Cpu size={18} />}
                            </div>
                            <div className="min-w-0">
                              <h5 className="truncate text-sm font-bold text-white/88">{marketSkill?.name || skill.name}</h5>
                              <span className="text-xs font-mono text-white/45">{skill.toolCount} {t.toolsCount || 'tools'} &middot; {skill.source}</span>
                            </div>
                          </div>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] font-bold text-white/50">
                            {recommendationCopy.manage}
                          </span>
                        </div>

                        <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-white/50">{marketSkill?.description || skill.description}</p>
                        <div className="mt-3">
                          <SkillStatusCallout availability={availability} compact />
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {skill.connected && (
                            <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-bold text-green-300">{t.connected || 'Connected'}</span>
                          )}
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${skill.enabled ? 'bg-green-500/10 text-green-300' : 'bg-white/5 text-white/45'}`}>
                            {skill.enabled ? (t.enabled || 'Enabled') : (t.disabled || 'Disabled')}
                          </span>
                          {marketSkill && (
                            <span className="rounded-full bg-white/[0.04] px-2 py-0.5 text-[11px] font-bold text-white/40">{marketSkill.category}</span>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
  );
}
