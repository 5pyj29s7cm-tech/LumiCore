import { motion, AnimatePresence } from "motion/react";
import { ShoppingBag, Download, RefreshCw, Star, Wrench, CheckCircle, Globe, Search, Zap, Tag, Key, ExternalLink, AlertTriangle } from "lucide-react";
import { Input } from "../ui/input";
import { uiMessage } from "../../i18n/uiMessages";
import { getSkillSettingsTarget } from "../../../shared/model_service_settings";
import type { useSkillCenterState } from './useSkillCenterState';
import type { SortKey } from './contracts';
import { getDisplayAvailability, getInstallActionText, getApiKeyConfigurationDetail } from './availability';
import { ICON_CLASSES, ICON_COMPONENTS, SkillStatusCallout, SkillInstallButton } from './presentation';

export function renderSkillMarketplace({ installProgress, t, search, setSearch, setActiveCategory, activeCategory, skillHallCategories, setSortKey, sortKey, sortedMarket, installedSkills, savedKeys, lang, setDetailSkill, installing, handleInstall, searchingExternal, externalError, npm, github }: Pick<ReturnType<typeof useSkillCenterState>, "installProgress" | "t" | "search" | "setSearch" | "setActiveCategory" | "activeCategory" | "skillHallCategories" | "setSortKey" | "sortKey" | "sortedMarket" | "installedSkills" | "savedKeys" | "lang" | "setDetailSkill" | "installing" | "handleInstall" | "searchingExternal" | "externalError" | "npm" | "github">) {
  return (
<motion.div key="marketplace" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="space-y-6">
            {/* Install progress banner */}
            <AnimatePresence>
              {installProgress && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3 bg-celestial-saturn/10 border border-celestial-saturn/20 rounded-2xl">
                    <RefreshCw size={14} className="animate-spin text-celestial-saturn" />
                    <div>
                      <span className="text-xs font-bold text-celestial-saturn uppercase">
                        {installProgress.stage === 'downloading' ? (t.installingStatus || 'Downloading...') :
                         installProgress.stage === 'copying' ? (t.installingStatus || 'Copying files...') :
                         installProgress.stage === 'connecting' ? (t.connectingStage || 'Connecting...') :
                         (t.installingStatus || 'Installing...')}
                      </span>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            {/* Filters row */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/45" />
                <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t.searchSkills || 'Search skills...'} className="lumi-field w-full py-2 pl-9 text-xs" />
              </div>
              {/* Category filter */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => setActiveCategory('')}
                  className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${!activeCategory ? 'bg-white/10 text-white' : 'bg-white/[0.045] text-white/55 hover:bg-white/10 hover:text-white/75'}`}
                >
                  {t.allCategories || 'All'}
                </button>
                {skillHallCategories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setActiveCategory(activeCategory === cat ? '' : cat)}
                    className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${activeCategory === cat ? 'bg-celestial-saturn/20 text-celestial-saturn' : 'bg-white/[0.045] text-white/55 hover:bg-white/10 hover:text-white/75'}`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
              {/* Sort */}
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] text-white/45">{t.sortBy || 'Sort'}:</span>
                {(['downloads', 'rating', 'newest'] as SortKey[]).map(k => (
                  <button
                    key={k}
                    onClick={() => setSortKey(k)}
                    className={`rounded-lg px-2 py-1 text-[12px] font-bold transition-all ${sortKey === k ? 'bg-white/10 text-white' : 'text-white/45 hover:bg-white/[0.045] hover:text-white/70'}`}
                  >
                    {(t as any)[k] || k}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <AnimatePresence>
                {sortedMarket.map(skill => {
                   const availability = getDisplayAvailability(skill, installedSkills, savedKeys, lang);
                   const settingsTarget = getSkillSettingsTarget(skill.apiKeyEnv);
                   const runtimeInstalled = !!availability.installedSkill;
                   const isInstalled = skill.installed || runtimeInstalled;
                   const identityConflict = skill.officialIdentityStatus === 'conflict';
                  return (
                  <motion.div
                    key={skill.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setDetailSkill(skill)}
                    className="lumi-panel cursor-pointer p-6 transition-all hover:border-white/15 hover:bg-white/[0.06]"
                  >
                    {/* Header */}
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${ICON_CLASSES[skill.icon] || 'bg-white/5 text-white/55 border-white/10'}`}>
                          {ICON_COMPONENTS[skill.icon] || <Zap size={18} />}
                        </div>
                        <div className="min-w-0">
                          <h4 className="font-bold text-white/90 text-sm">{skill.name}</h4>
                          <span className="text-xs text-white/55 font-mono">{t.version || 'v'} {skill.version || '1.0'} &middot; {skill.toolCount || 1} {t.toolsCount || 'tools'}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {skill.requiresApiKey && (
                          <span className="flex items-center gap-1 px-2 py-0.5 bg-amber-500/10 rounded-full text-xs font-bold uppercase text-amber-400" title={(t.requiresApiKey || 'Requires') + ' ' + skill.apiKeyEnv + ' API key'}>
                            <Key size={8} /> API
                          </span>
                        )}
                        {skill.requiresSetup && (
                          <span className="flex items-center gap-1 px-2 py-0.5 bg-purple-500/10 rounded-full text-xs font-bold uppercase text-purple-400" title={skill.setupNote || (t.setupRequired || 'Requires manual setup')}>
                            <Wrench size={8} /> Setup
                          </span>
                        )}
                        {isInstalled && (
                          <span className="flex items-center gap-1 px-2 py-1 bg-green-500/10 rounded-full text-[12px] font-bold uppercase text-green-400">
                            <CheckCircle size={10} /> {getInstallActionText(true, lang, t)}
                          </span>
                        )}
                        {identityConflict && (
                          <span className="flex items-center gap-1 px-2 py-1 bg-red-500/10 rounded-full text-[12px] font-bold uppercase text-red-300">
                            <AlertTriangle size={10} /> Identity conflict
                          </span>
                        )}
                      </div>
                    </div>

                    <p className="text-xs text-white/50 leading-relaxed mb-4 line-clamp-2">{skill.description}</p>
                    <div className="mb-4">
                      <SkillStatusCallout availability={availability} />
                    </div>

                    {/* Setup note */}
                    {skill.requiresSetup && skill.setupNote && (
                      <div className="mb-3 p-2 bg-purple-500/5 border border-purple-500/10 rounded-xl">
                        <p className="text-[12px] text-purple-300/70 leading-relaxed">{skill.setupNote}</p>
                      </div>
                    )}
                    {skill.requiresApiKey && skill.apiKeyUrl && (
                      <div className="mb-3 rounded-lg border border-cyan-400/10 bg-cyan-400/[0.04] p-2">
                        <p className="text-[12px] leading-relaxed text-cyan-200/60">
                          {getApiKeyConfigurationDetail(skill, lang, 'skill-center.configure-value0-before-real-calls.041e3cf5db')}
                          {' · '}
                          <a href={skill.apiKeyUrl} target="_blank" rel="noopener" className="underline hover:text-white">
                            {settingsTarget?.category === 'model_provider'
                              ? uiMessage('settings.provider-console.f2138df9a1', lang === 'zh' ? 'zh' : 'en')
                              : (t.getApiKey || 'get API key')}
                          </a>
                        </p>
                      </div>
                    )}

                    {/* Tags */}
                    <div className="flex items-center gap-2 flex-wrap mb-4">
                      <span className="flex items-center gap-1 px-2 py-0.5 bg-white/5 rounded-full text-[12px] text-white/55">
                        <Tag size={8} /> {skill.category}
                      </span>
                      <span className="text-[12px] text-white/45">{skill.author}</span>
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <span className="flex items-center gap-1 text-xs text-white/45">
                          <Download size={10} /> {skill.downloads.toLocaleString()}
                        </span>
                        <span className="flex items-center gap-1 text-xs text-white/45">
                          <Star size={10} className="text-amber-400" fill="currentColor" /> {skill.rating > 0 ? skill.rating.toFixed(1) : '--'}
                        </span>
                      </div>
                      <SkillInstallButton skill={skill} installed={isInstalled} installing={installing} variant="marketplace" lang={lang} t={t} onInstall={() => handleInstall(skill)} />
                    </div>
                  </motion.div>
                );})}
              </AnimatePresence>
            </div>
            {sortedMarket.length === 0 && (
              <div className="lumi-panel p-16 text-center">
                <ShoppingBag size={40} className="text-white/45 mx-auto mb-4" />
                <p className="text-white/40 font-bold uppercase tracking-widest text-sm">{t.noSkillsFound || 'No skills found'}</p>
                <p className="text-white/45 text-xs mt-2">{search || activeCategory ? (t.skillNoResultsFilter || 'No results. Try different filters.') : (t.skillCheckBack || 'Check back soon or generate your own.')}</p>
              </div>
            )}

            {/* External search results: npm + GitHub */}
              {searchingExternal && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-2 text-xs text-white/45 py-2">
                  <RefreshCw size={12} className="animate-spin" /> Searching npm & GitHub...
                </motion.div>
              )}

              {externalError && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-xs text-red-300/80 bg-red-500/10 border border-red-500/15 rounded-xl px-3 py-2">
                  {externalError}
                </motion.div>
              )}

              {/* npm registry results */}
              {npm.data.length > 0 && (
                <motion.div key="npm-section" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-2">
                  <div className="flex items-center gap-2 px-1">
                    <span className="text-xs font-bold uppercase text-red-400 tracking-wider">npm Registry</span>
                    <span className="text-[12px] text-white/45 font-mono">{npm.data.length} found</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {npm.data.map(skill => {
                      return (
                        <div key={skill.id}
                          className="p-4 bg-red-500/5 rounded-2xl border border-red-500/10 hover:border-red-500/20 transition-all flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center shrink-0">
                            <Download size={14} className="text-red-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h5 className="text-xs font-bold text-white/80 truncate">{skill.name}</h5>
                            <p className="text-xs text-white/55 line-clamp-1">{skill.description || skill.version || ''}</p>
                          </div>
                          <a
                            href={skill.url || skill.npmUrl || skill.repository}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg bg-red-500/10 px-3 py-1.5 text-xs font-bold text-red-300 transition-all hover:bg-red-500/20"
                          >
                            <ExternalLink size={11} /> {uiMessage('skill-center.review-source.20260901', lang)}
                          </a>
                        </div>
                      );
                    })}
                  </div>
                </motion.div>
              )}

              {/* GitHub results */}
              {github.data.length > 0 && (
                <motion.div key="github-section" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-2">
                  <div className="flex items-center gap-2 px-1">
                    <Globe size={11} className="text-purple-400" />
                    <span className="text-xs font-bold uppercase text-purple-400 tracking-wider">GitHub</span>
                    <span className="text-[12px] text-white/45 font-mono">{github.data.length} repos</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {github.data.map(repo => {
                      return (
                        <div key={repo.id}
                          className="p-4 bg-purple-500/5 rounded-2xl border border-purple-500/10 hover:border-purple-500/20 transition-all flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center shrink-0">
                            <Star size={14} className="text-purple-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h5 className="text-xs font-bold text-white/80 truncate">{repo.name}</h5>
                            <p className="text-xs text-white/55 line-clamp-1">
                              {repo.stars ? `★ ${repo.stars} · ` : ''}{repo.description || repo.language || ''}
                            </p>
                          </div>
                          <a
                            href={repo.url || repo.source}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg bg-purple-500/10 px-3 py-1.5 text-xs font-bold text-purple-300 transition-all hover:bg-purple-500/20"
                          >
                            <ExternalLink size={11} /> {uiMessage('skill-center.review-source.20260901', lang)}
                          </a>
                        </div>
                      );
                    })}
                  </div>
                </motion.div>
              )}
          </motion.div>
  );
}
