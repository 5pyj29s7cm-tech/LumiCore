import { Suspense, lazy } from "react";
import { motion, AnimatePresence } from "motion/react";
import { RefreshCw, Zap, AlertTriangle, ShieldCheck } from "lucide-react";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { ExternalCapabilityIntakeDialog } from "../ExternalCapabilityCenter";
import type { useSkillCenterState } from './useSkillCenterState';
import { renderFeaturedSkills } from './featured';
import { renderSkillMarketplace } from './marketplace';
import { renderInstalledSkills } from './installed';
import { renderSkillGeneration } from './generation';
import { SkillDetailPane } from './detail';

const GitHubMCPBrowser = lazy(() => import("../GitHubMCPBrowser").then(m => ({ default: m.GitHubMCPBrowser })));

export function renderSkillCenter(input: ReturnType<typeof useSkillCenterState>) {
  const { t, canUseExternalCapabilities, canReviewExternalCapabilities, setExternalCapabilityIntakeOpen, externalCopy, sortedMarket, refreshAll, loadError, lang, tabs, setActiveTab, activeTab, installedSkills, savedKeys, setDetailSkill, installing, handleInstall, fetchReviewedExternalCapabilities, handleRepair, repairing, handleToggle, handleUninstall, detailSkill, marketSkills, externalCapabilityIntakeOpen } = input;


  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="lumi-panel flex items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-celestial-saturn/20 bg-celestial-saturn/10">
            <Zap className="text-celestial-saturn" size={20} />
          </div>
          <h3 className="text-xl font-bold uppercase tracking-tighter text-white/90">{t.skillCenter || 'Skill Center'}</h3>
        </div>
        <div className="flex items-center gap-2">
          {canUseExternalCapabilities && canReviewExternalCapabilities && (
            <button
              type="button"
              onClick={() => setExternalCapabilityIntakeOpen(true)}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-cyan-300/15 bg-cyan-300/[0.07] px-3 text-xs font-bold text-cyan-100 transition-colors hover:bg-cyan-300/12"
            >
              <ShieldCheck size={13} />
              {externalCopy.intakeAction}
            </button>
          )}
          <span className="text-xs text-white/45 font-mono">{sortedMarket.length} {t.available || 'available'}</span>
          <button
            onClick={refreshAll}
            className="lumi-icon-button h-8 w-8"
            title={t.refresh || 'Refresh'}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <p className="text-sm text-white/40 max-w-xl">
        {t.skillMarketDesc || 'Browse, install and generate MCP skills. Each skill expands Lumi\'s capabilities with new tools, APIs, and automations. Installed skills appear in your MCP ecosystem.'}
      </p>

      {loadError && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-400/15 bg-amber-500/10 px-4 py-3 text-xs text-amber-100/80">
          <span className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-300" />
            {formatUiMessage('skill-center.skill-center-load-issue-value0.c32306f8d7', { value0: loadError }, (lang === 'zh') ? 'zh' : 'en')}
          </span>
          <button
            onClick={refreshAll}
            className="rounded-lg bg-amber-300/10 px-3 py-1.5 font-semibold text-amber-200 hover:bg-amber-300/18"
          >
            {uiMessage('skill-center.retry.563171cfe4', (lang === 'zh') ? 'zh' : 'en')}
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="lumi-panel flex w-fit gap-1 p-1">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeTab === tab.id
                ? 'bg-white/10 text-white'
                : 'text-white/55 hover:bg-white/[0.045] hover:text-white/75'
            }`}
          >
            {tab.icon}
            {tab.label}
            {tab.id === 'installed' && installedSkills.length > 0 && (
              <span className="text-xs px-1.5 py-0.5 bg-white/10 rounded-full text-white/40">{installedSkills.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <AnimatePresence>
        {activeTab === 'featured' && (
          renderFeaturedSkills(input)
        )}

        {activeTab === 'marketplace' && (
          renderSkillMarketplace(input)
        )}

        {activeTab === 'mcp' && (
          <motion.div key="mcp" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="overflow-hidden rounded-3xl border border-white/5 bg-white/[0.03]">
            <Suspense fallback={null}>
              <GitHubMCPBrowser t={t} embedded />
            </Suspense>
          </motion.div>
        )}

        {activeTab === 'installed' && (
          renderInstalledSkills(input)
        )}

        {activeTab === 'generate' && (
          renderSkillGeneration(input)
        )}


      </AnimatePresence>
      <AnimatePresence>
        {detailSkill && (
          <SkillDetailPane detailSkill={detailSkill} setDetailSkill={setDetailSkill} t={t} lang={lang} marketSkills={marketSkills} installedSkills={installedSkills} installing={installing} repairing={repairing} savedKeys={savedKeys} handleInstall={handleInstall} handleToggle={handleToggle} handleUninstall={handleUninstall} handleRepair={handleRepair} />
        )}
      </AnimatePresence>
      {canUseExternalCapabilities && canReviewExternalCapabilities && (
        <ExternalCapabilityIntakeDialog
          open={externalCapabilityIntakeOpen}
          lang={lang}
          onClose={() => setExternalCapabilityIntakeOpen(false)}
          onActivated={fetchReviewedExternalCapabilities}
        />
      )}
    </div>
  );
}
