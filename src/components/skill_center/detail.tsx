import { motion } from "motion/react";
import { Download, Trash2, Power, PowerOff, RefreshCw, Star, Wrench, CheckCircle, Zap, Tag, Key, ExternalLink, AlertTriangle, X, Settings2 } from "lucide-react";
import { Button } from "../ui/button";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { getSkillSettingsTarget } from "../../../shared/model_service_settings";
import type { InstalledSkill } from './contracts';
import { getDisplayAvailability, getInstalledSkillAvailability, hasSkillRuntimeIssue, getSkillSettingsSectionLabel } from './availability';
import { ICON_CLASSES, ICON_COMPONENTS, SkillStatusCallout, SkillInstallButton } from './presentation';

export function SkillDetailPane({ detailSkill, setDetailSkill, t, lang, marketSkills, installedSkills, installing, repairing, savedKeys, handleInstall, handleToggle, handleUninstall, handleRepair }: {
  detailSkill: any;
  setDetailSkill: (v: any) => void;
  t: any;
  lang: 'en' | 'zh';
  marketSkills: any[];
  installedSkills: InstalledSkill[];
  installing: string | null;
  repairing: string | null;
  savedKeys: Record<string, boolean>;
  handleInstall: (skill: any) => void;
  handleToggle: (name: string, enabled: boolean) => void;
  handleUninstall: (name: string) => void;
  handleRepair: (name: string) => void;
}) {
  const isMarketSkill = 'id' in detailSkill;
  const mSkill: any | undefined = isMarketSkill
    ? detailSkill
    : marketSkills.find(s => s.id === `skill-${detailSkill.name}`);
  const settingsTarget = getSkillSettingsTarget(mSkill?.apiKeyEnv);
  const marketAvailability = mSkill
    ? getDisplayAvailability(mSkill, installedSkills, savedKeys, lang)
    : undefined;
  const installedAvailability = !mSkill && !isMarketSkill && detailSkill
    ? getInstalledSkillAvailability(detailSkill, lang)
    : undefined;
  const resolvedInstalledSkill = marketAvailability?.installedSkill;
  const marketInstalled = Boolean(mSkill?.installed || resolvedInstalledSkill);
  const detailRuntimeIssue = !isMarketSkill && hasSkillRuntimeIssue(detailSkill);
  return (
    <motion.div
      key="skill-detail-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => setDetailSkill(null)}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
    >
      <motion.div
        key={(detailSkill as any).id || (detailSkill as any).name || 'detail'}
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98 }}
        transition={{ duration: 0.16 }}
        onClick={(event) => event.stopPropagation()}
        className="lumi-panel max-h-[min(760px,calc(100vh-48px))] w-full max-w-3xl overflow-y-auto p-6 space-y-5 shadow-2xl"
      >
        <button
          onClick={() => setDetailSkill(null)}
          className="flex items-center gap-2 text-xs font-bold text-white/45 hover:text-white/70 transition-colors"
        >
          <X size={14} /> {t.close || 'Close'}
        </button>

      <div className="flex items-center gap-3">
        <div className={`w-12 h-12 rounded-xl border flex items-center justify-center shrink-0 ${
          mSkill ? ICON_CLASSES[mSkill.icon] || 'bg-white/5 text-white/55 border-white/10' : 'bg-white/5 text-white/55 border-white/10'
        }`}>
          {mSkill ? (ICON_COMPONENTS[mSkill.icon] || <Zap size={22} />) : <Zap size={22} />}
        </div>
        <div>
          <h3 className="text-lg font-bold text-white">
            {mSkill?.name ?? detailSkill.name}
          </h3>
          {mSkill && (
            <span className="text-xs text-white/55 font-mono">
              v {mSkill.version || '1.0'} &middot; {mSkill.toolCount || 1} tools
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-white/45">
        {mSkill && (
          <>
            <span className="flex items-center gap-1"><Tag size={10} /> {mSkill.category}</span>
            <span>{mSkill.author}</span>
            <span className="flex items-center gap-1"><Download size={10} /> {mSkill.downloads.toLocaleString()}</span>
            <span className="flex items-center gap-1"><Star size={10} className="text-amber-400" fill="currentColor" /> {mSkill.rating > 0 ? mSkill.rating.toFixed(1) : '--'}</span>
          </>
        )}
        {!isMarketSkill && detailSkill && (
          <>
            <span>{detailSkill.toolCount} tools</span>
            {detailSkill.installedAt && (
              <span>Installed {new Date(detailSkill.installedAt).toLocaleDateString()}</span>
            )}
            <span>{detailSkill.source}</span>
          </>
        )}
      </div>

      <p className="text-sm text-white/60 leading-relaxed">
        {mSkill?.description ?? detailSkill.description}
      </p>

      {marketAvailability && <SkillStatusCallout availability={marketAvailability} />}
      {!marketAvailability && installedAvailability && <SkillStatusCallout availability={installedAvailability} />}

      {mSkill?.requiresSetup && mSkill.setupNote && (
        <div className="p-4 bg-purple-500/5 border border-purple-500/10 rounded-2xl">
          <span className="flex items-center gap-1.5 text-xs font-bold uppercase text-purple-400 mb-2">
            <Wrench size={12} /> Setup Required
          </span>
          <p className="text-sm text-purple-200/70 leading-relaxed">{mSkill.setupNote}</p>
        </div>
      )}

      {mSkill?.requiresApiKey && mSkill.apiKeyEnv && settingsTarget && (
        <div className="space-y-3 rounded-lg border border-cyan-400/15 bg-cyan-400/[0.04] p-4">
          <div className="flex items-center gap-1.5">
            <Key size={12} className="text-cyan-300" />
            <span className="text-xs font-bold uppercase text-cyan-200">
              {uiMessage('skill-center.required-connection.287063c109', (lang === 'zh') ? 'zh' : 'en')}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-white/55">
            {formatUiMessage('skill-center.value0-is-managed-in-value1-settings.41f04ac801', {
              value0: settingsTarget.label,
              value1: getSkillSettingsSectionLabel(settingsTarget.settingsSection, (lang === 'zh') ? 'zh' : 'en'),
            }, (lang === 'zh') ? 'zh' : 'en')}
          </p>
          <div className="flex items-center justify-between gap-3">
            {savedKeys[mSkill.apiKeyEnv] ? (
              <span className="flex items-center gap-1 text-sm text-green-400"><CheckCircle size={14} /> {t.keyConfigured || 'Key configured'}</span>
            ) : (
              <span className="flex items-center gap-1 text-sm text-amber-300"><AlertTriangle size={14} /> {uiMessage('skill-center.needs-api-key.2e4a04bc58', (lang === 'zh') ? 'zh' : 'en')}</span>
            )}
            <Button
              onClick={() => {
                window.dispatchEvent(new CustomEvent('lumi:client-action', {
                  detail: { action: 'open_settings', section: settingsTarget.settingsSection },
                }));
                setDetailSkill(null);
              }}
              className="h-9 shrink-0 rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-3 text-xs font-bold text-cyan-100 hover:bg-cyan-300/15"
            >
              <Settings2 size={13} className="mr-1.5" />
              {uiMessage('skill-center.open-required-settings.4e70b69abc', (lang === 'zh') ? 'zh' : 'en')}
            </Button>
          </div>
        </div>
      )}

      {mSkill && (mSkill.npmPackage || mSkill.repoUrl) && (
        <div className="flex items-center gap-3 text-xs">
          {mSkill.npmPackage && (
            <a href={`https://www.npmjs.com/package/${mSkill.npmPackage}`} target="_blank" rel="noopener" className="flex items-center gap-1 text-cyan-400 hover:underline">
              <ExternalLink size={10} /> npm
            </a>
          )}
          {mSkill.repoUrl && (
            <a href={mSkill.repoUrl} target="_blank" rel="noopener" className="flex items-center gap-1 text-purple-400 hover:underline">
              <ExternalLink size={10} /> GitHub
            </a>
          )}
        </div>
      )}

      {!isMarketSkill && detailSkill && (
        <div className="flex items-center gap-2 flex-wrap">
          {detailSkill.autoGenerated && (
            <span className="px-2 py-0.5 bg-emerald-500/10 rounded-full text-xs text-emerald-400 font-bold">{t.autoGenerated || 'Auto-generated'}</span>
          )}
          {detailSkill.connected && (
            <span className="px-2 py-0.5 bg-green-500/10 rounded-full text-xs text-green-400 font-bold">{t.connected || 'Connected'}</span>
          )}
          {detailSkill.broken && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-red-500/10 rounded-full text-xs text-red-300 font-bold">
              <AlertTriangle size={11} />{uiMessage('skill-center.broken.565289cc16', (lang === 'zh') ? 'zh' : 'en')}
            </span>
          )}
          {!detailSkill.broken && detailSkill.startupError && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-amber-500/10 rounded-full text-xs text-amber-300 font-bold">
              <AlertTriangle size={11} />{uiMessage('skill-center.needs-repair.53833da009', (lang === 'zh') ? 'zh' : 'en')}
            </span>
          )}
          {!detailSkill.broken && detailSkill.enabled && !detailSkill.connected && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-amber-500/10 rounded-full text-xs text-amber-300 font-bold">
              <AlertTriangle size={11} />{uiMessage('skill-center.not-connected.e55a06aa6b', (lang === 'zh') ? 'zh' : 'en')}
            </span>
          )}
          {!detailSkill.broken && detailSkill.healthStatus && !['connected', 'disconnected', 'unknown'].includes(detailSkill.healthStatus) && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-amber-500/10 rounded-full text-xs text-amber-300 font-bold">
              <AlertTriangle size={11} />{detailSkill.healthStatus}
            </span>
          )}
          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
            detailSkill.enabled ? 'bg-green-500/10 text-green-400' : 'bg-white/5 text-white/45'
          }`}>
            {detailSkill.enabled ? (t.enabled || 'Enabled') : (t.disabled || 'Disabled')}
          </span>
        </div>
      )}

      {!isMarketSkill && detailSkill?.broken && (
        <div className="rounded-2xl border border-red-500/10 bg-red-500/5 p-4 text-xs leading-relaxed text-red-100/75">
          {uiMessage('skill-center.this-skill-package-has-no.f678ca8ea2', (lang === 'zh') ? 'zh' : 'en')}
        </div>
      )}

      <div className="flex items-center gap-3 pt-2 border-t border-white/5">
        {mSkill && isMarketSkill ? (
          <SkillInstallButton skill={mSkill} installed={marketInstalled} installing={installing} variant="detail" lang={lang} t={t}
            onInstall={() => { handleInstall(mSkill); setDetailSkill(null); }} />
        ) : detailSkill ? (
          <>
            {detailRuntimeIssue && (
              <button
                onClick={() => handleRepair(detailSkill.name)}
                disabled={repairing === detailSkill.name}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-40"
              >
                <RefreshCw size={13} className={repairing === detailSkill.name ? 'animate-spin' : ''} />
                {uiMessage('skill-center.repair.c5b19788e4', (lang === 'zh') ? 'zh' : 'en')}
              </button>
            )}
            <button
              onClick={() => handleToggle(detailSkill.name, !detailSkill.enabled)}
              disabled={detailSkill.broken || repairing === detailSkill.name}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-colors ${
                detailSkill.enabled
                  ? 'text-white/55 hover:bg-white/5'
                  : 'text-green-400 bg-green-500/10 hover:bg-green-500/20'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {detailSkill.enabled ? <PowerOff size={13} /> : <Power size={13} />}
              {detailSkill.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={() => { handleUninstall(detailSkill.name); setDetailSkill(null); }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-red-400 bg-red-500/10 hover:bg-red-500/20 transition-colors"
            >
              <Trash2 size={13} /> Uninstall
            </button>
          </>
        ) : null}
      </div>
      </motion.div>
    </motion.div>
  );
}
