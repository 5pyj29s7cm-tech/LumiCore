import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, ShoppingBag, Cpu, Github } from "lucide-react";
import { toast } from "sonner";
import { useSocket } from "@/hooks/useSocket";
import { getSavedKeyStatus } from "@/services/settingsKeys";
import { apiFetch, apiJson } from "@/services/apiClient";
import { WORK_RECOMMENDATION_RULES } from "../../i18n/locales/skillRecommendations";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { externalCapabilityCopy } from "../../i18n/locales/externalCapabilities";
import { fetchExternalCapabilities, type ExternalCapabilityProjection } from "@/services/externalCapabilities";
import type { SkillCenterTab, SortKey, GeneratedSkillDraft, MarketplaceSkill, InstalledSkill, ProfessionProfile, ExternalResult, SkillRecommendation } from './contracts';
import { findInstalledSkillForMarket } from './availability';
import { PROFESSION_RECOMMENDATION_MAP } from './recommendations';

// Each query owns its data and latest request; unrelated lists never invalidate one another.
function useSkillQuery<T>(key: string | null, initial: T, load: (signal: AbortSignal) => Promise<T>, delay = 0) {
  const [state, setState] = useState({ key, data: initial, loading: Boolean(key), error: '' });
  const owner = useRef(key); owner.current = key;
  const loader = useRef(load); loader.current = load;
  const empty = useRef(initial); empty.current = initial;
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const key = owner.current;
    if (!key) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const current = () => owner.current === key && request.current === controller && !controller.signal.aborted;
    setState(previous => ({ key, data: previous.key === key ? previous.data : empty.current, loading: true, error: '' }));
    try {
      // Coalesce events in one tick, but a later mutation still starts a fresh read.
      await Promise.resolve();
      if (!current()) return;
      const data = await loader.current(controller.signal);
      if (current()) setState({ key, data, loading: false, error: '' });
    } catch (error: any) {
      if (current()) setState(previous => ({ ...previous, loading: false, error: error?.message || 'Request failed' }));
    }
  }, []);
  useEffect(() => {
    owner.current = key;
    if (!key) setState({ key, data: empty.current, loading: false, error: '' });
    const timer = delay ? setTimeout(() => void refresh(), delay) : undefined;
    if (!delay) void refresh();
    return () => { owner.current = null; clearTimeout(timer); request.current?.abort(); };
  }, [key, delay, refresh]);
  return { ...(state.key === key ? state : { data: initial, loading: Boolean(key), error: '' }), refresh };
}

export function useSkillCenterState({
  t,
  lang,
  initialTab = 'featured',
  canUseExternalCapabilities = false,
  canReviewExternalCapabilities = false,
}: {
  t: any;
  lang: 'en' | 'zh';
  initialTab?: SkillCenterTab;
  canUseExternalCapabilities?: boolean;
  canReviewExternalCapabilities?: boolean;
}) {

  const [activeTab, setActiveTab] = useState<SkillCenterTab>(initialTab);
  const [installing, setInstalling] = useState<string | null>(null);
  const [repairing, setRepairing] = useState<string | null>(null);
  const [cleaningBroken, setCleaningBroken] = useState(false);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('downloads');
  const [genDescription, setGenDescription] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedDraft, setGeneratedDraft] = useState<GeneratedSkillDraft | null>(null);
  const [installingGeneratedDraft, setInstallingGeneratedDraft] = useState(false);
  const [installProgress, setInstallProgress] = useState<{ skillId: string; stage: string } | null>(null);
  const [detailSelection, setDetailSelection] = useState<Pick<MarketplaceSkill, 'id'> | Pick<InstalledSkill, 'name'> | null>(null);
  const setDetailSkill = (skill: MarketplaceSkill | InstalledSkill | null) => setDetailSelection(skill && ('id' in skill ? { id: skill.id } : { name: skill.name }));
  const [externalCapabilityIntakeOpen, setExternalCapabilityIntakeOpen] = useState(false);
  const socket = useSocket();

  const [translationReady, setTranslationReady] = useState(false);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const { data: marketSkills, error: marketError, refresh: fetchMarketplace } = useSkillQuery<MarketplaceSkill[]>(
    `market:${lang}`, [], async signal => {
      const data = await apiJson(`/api/marketplace/skills?lang=${lang}`, { signal });
      if (!Array.isArray(data)) throw new Error('Invalid skill catalog');
      return data;
    });
  const { data: installedSkills, loading, error: installedError, refresh: fetchInstalled } = useSkillQuery<InstalledSkill[]>(
    'installed', [], async signal => (await apiJson('/api/skills', { signal })).skills || []);
  const { data: categories, error: categoryError, refresh: fetchCategories } = useSkillQuery<string[]>(
    `categories:${lang}`, [], async signal => (await apiJson(`/api/marketplace/categories?lang=${lang}`, { signal })).map((c: any) => c.name));
  const loadError = [marketError, installedError, categoryError].filter(Boolean).join(' / ');
  const { data: savedKeys } = useSkillQuery<Record<string, boolean>>('keys', {}, () => getSavedKeyStatus());
  const { data: externalCapabilities, loading: externalCapabilitiesLoading, error: externalCapabilitiesError,
    refresh: fetchReviewedExternalCapabilities } = useSkillQuery<ExternalCapabilityProjection[]>(
    canUseExternalCapabilities ? 'capabilities' : null, [], () => fetchExternalCapabilities());
  const { data: professionProfiles, error: profileError, refresh: fetchProfiles } = useSkillQuery<ProfessionProfile[]>(
    'profiles', [], async signal => {
      const data = await apiJson('/api/explore/profession', { signal });
      return Array.isArray(data.profiles) ? data.profiles : [];
    });
  const { data: workSignalText, error: interactionsError, refresh: fetchInteractions } = useSkillQuery('interactions', '', async signal => {
    const data = await apiJson('/api/interactions?limit=80', { signal });
    return (Array.isArray(data) ? data : [])
      .flatMap((item: any) => [item?.content, item?.message, item?.prompt, item?.response, item?.summary, item?.title, item?.description])
      .filter(Boolean).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n').slice(0, 50000);
  });
  const recommendationError = [profileError, interactionsError].filter(Boolean).join(' / ');
  const fetchRecommendationSignals = () => { void fetchProfiles(); void fetchInteractions(); };
  const query = search.length >= 2 ? encodeURIComponent(search) : null;
  const npm = useSkillQuery<ExternalResult[]>(query && `npm:${query}`, [], async signal =>
    (await apiJson(`/api/marketplace/discover/npm?q=${query}`, { signal })).results?.slice(0, 6) || [], 400);
  const github = useSkillQuery<ExternalResult[]>(query && `github:${query}`, [], async signal =>
    (await apiJson(`/api/marketplace/discover/github?topic=${query}`, { signal })).results?.slice(0, 6) || [], 400);
  const searchingExternal = npm.loading || github.loading;
  const externalError = [npm.error, github.error].filter(Boolean).join(' / ');
  const refreshSkills = useCallback(() => Promise.all([fetchInstalled(), fetchMarketplace()]), [fetchInstalled, fetchMarketplace]);
  const refreshAll = () => { void refreshSkills(); void fetchCategories(); fetchRecommendationSignals(); };
  const detailSkill = detailSelection && ('id' in detailSelection
    ? marketSkills.find(skill => skill.id === detailSelection.id)
    : installedSkills.find(skill => skill.name === detailSelection.name));
  useEffect(() => { if (detailSelection && !detailSkill) setDetailSelection(null); }, [detailSelection, detailSkill]);

  useEffect(() => {
    if (!canUseExternalCapabilities) return undefined;
    const refresh = () => { void fetchReviewedExternalCapabilities(); };
    window.addEventListener('lumi:external-capabilities-changed', refresh);
    return () => window.removeEventListener('lumi:external-capabilities-changed', refresh);
  }, [canUseExternalCapabilities, fetchReviewedExternalCapabilities]);

  // Translate on first Chinese load, then re-fetch to show translated data
  useEffect(() => {
    let cancelled = false;
    if (lang === 'zh' && !translationReady) {
      apiFetch('/api/marketplace/translate?lang=zh', { method: 'POST' })
        .then(() => { if (!cancelled) { setTranslationReady(true); fetchMarketplace(); } })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [lang, translationReady, fetchMarketplace]);

  // Socket events for real-time updates
  useEffect(() => {
    if (!socket) return;
    const onInstalling = (data: { skillId: string; name: string; stage: string }) => {
      setInstallProgress({ skillId: data.skillId, stage: data.stage });
    };
    const onInstalled = () => {
      setInstallProgress(null);
      void refreshSkills();
    };
    socket.on('skill:installing', onInstalling);
    socket.on('skill:installed', onInstalled);
    const refreshEvents = ['skill:uninstalled', 'skill:updated', 'mcp:health_update'];
    for (const event of refreshEvents) socket.on(event, refreshSkills);
    return () => {
      socket.off('skill:installing', onInstalling);
      socket.off('skill:installed', onInstalled);
      for (const event of refreshEvents) socket.off(event, refreshSkills);
    };
  }, [socket, refreshSkills]);

  const handleInstall = async (skill: MarketplaceSkill) => {
    if ('installed' in skill && skill.installed) return;
    if (skill.runtimeInstallable === false) {
      toast.error('This Skill requires a reviewed external MCP runtime before it can be installed.');
      return;
    }
    const approved = window.confirm([
      `Install official Skill: ${skill.name}`,
      `Version: ${skill.version || '1.0'} · Declared tools: ${skill.toolCount || 1}`,
      'Runtime: local MCP process; activation is committed only after a non-empty live tool manifest is registered.',
      skill.requiresApiKey
        ? `Configuration required before use: ${skill.apiKeyEnv || 'API key'}`
        : 'No API key is declared by this package.',
      'The exact bundled package will be installed. Community/npm/GitHub search results are not executable here.',
    ].join('\n\n'));
    if (!approved) return;
    setInstalling(skill.id);
    try {
      const body = { skillId: skill.id, skillName: skill.name, installSource: skill.installSource };
      const data = await apiJson('/api/marketplace/skills/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
      });
      if (data.success) {
        toast.success(data.message || `"${skill.name}" ${t.skillInstalledToast}`);
        void refreshSkills();
      } else toast.error(data.error || 'Install failed');
    } catch (err: any) { toast.error(err.message); }
    finally { setInstalling(null); }
  };

  const handleUninstall = async (name: string) => {
    try {
      await apiJson(`/api/skills/${name}`, { method: 'DELETE' });
      toast.success(`"${name}" ${t.skillUninstalledToast}`);
      void refreshSkills();
    } catch (err: any) { toast.error(err.message); }
  };

  const handleRepair = async (name: string) => {
    setRepairing(name);
    try {
      const res = await apiFetch(`/api/skills/${name}/repair`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.reason || data.error || 'Repair failed');
      toast.success(formatUiMessage('skill-center.value0-repaired.46dd6808b8', { value0: name }, (lang === 'zh') ? 'zh' : 'en'));
      if (detailSkill?.name === name) setDetailSkill(null);
      void refreshSkills();
    } catch (err: any) {
      toast.error(err.message || 'Repair failed');
    } finally {
      setRepairing(null);
    }
  };

  const handleCleanupBroken = async () => {
    setCleaningBroken(true);
    try {
      const data = await apiJson('/api/skills/broken', { method: 'DELETE' });
      const removed = Array.isArray(data.removed) ? data.removed.length : 0;
      toast.success(formatUiMessage('skill-center.cleaned-value0-broken-skills.8180ac8311', { value0: removed }, (lang === 'zh') ? 'zh' : 'en'));
      void refreshSkills();
    } catch (err: any) {
      toast.error(err.message || 'Cleanup failed');
    } finally {
      setCleaningBroken(false);
    }
  };

  const handleToggle = async (name: string, enabled: boolean) => {
    try {
      await apiJson(`/api/skills/${name}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
      toast.success(`${enabled ? t.skillEnabledToast : t.skillDisabledToast} ${name}`);
      fetchInstalled();
    } catch (err: any) {
      toast.error(err.message || 'Toggle failed');
    }
  };

  const handleGenerate = async () => {
    if (!genDescription.trim()) return;
    setGenerating(true);
    try {
      const data = await apiJson('/api/skills/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: genDescription }),
        credentials: 'include',
      });
      if (!data.success) throw new Error(data.error || 'Generation failed');
      setGeneratedDraft(data as GeneratedSkillDraft);
      toast.success(uiMessage('skill-center.generated-draft-created.20260901', lang));
    } catch (err: any) { toast.error(err.message); }
    finally { setGenerating(false); }
  };

  const handleInstallGeneratedDraft = async () => {
    if (!generatedDraft) return;
    setInstallingGeneratedDraft(true);
    try {
      const data = await apiJson('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          source: 'local',
          path: generatedDraft.directory,
          name: generatedDraft.skillName,
          approved: true,
          approvedContentHash: generatedDraft.review.contentHash,
          approvalNonce: generatedDraft.approvalNonce,
        }),
      });
      if (data.success !== true || data.usable !== true) {
        throw new Error(data.error || 'Skill activation failed');
      }
      toast.success(uiMessage('skill-center.generated-skill-activated.20260901', lang));
      setGeneratedDraft(null);
      setGenDescription('');
      await refreshSkills();
      if (socket) socket.emit('skill:updated', { name: data.skillName || data.name });
    } catch (err: any) {
      toast.error(err.message || 'Skill activation failed');
    } finally {
      setInstallingGeneratedDraft(false);
    }
  };

  const handlePublish = async (skillName: string) => {
    try {
      const installed = installedSkills.find(s => s.name === skillName);
      if (!installed) return;
      await apiJson('/api/marketplace/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: skillName,
          description: installed.description,
          author: 'Community',
          category: 'Generated',
          toolCount: installed.toolCount,
        }),
      });
      toast.success(`Published "${skillName}" to community!`);
    } catch {}
  };

  // Filter and sort installable LumiCore skills.
  const skillHallCategories = categories.filter(cat => marketSkills.some(s => s.category === cat));
  const installedSkillRows = useMemo(() => (
    installedSkills
      .map(skill => ({
        skill,
        marketSkill: marketSkills.find(marketSkill => findInstalledSkillForMarket(marketSkill, [skill])),
      }))
      .sort((a, b) => Number(b.skill.connected) - Number(a.skill.connected) || Number(b.skill.enabled) - Number(a.skill.enabled) || a.skill.name.localeCompare(b.skill.name))
  ), [installedSkills, marketSkills]);
  const matchedWorkSignals = useMemo(() => (
    WORK_RECOMMENDATION_RULES
      .filter(rule => rule.pattern.test(workSignalText))
      .slice(0, 6)
  ), [workSignalText]);
  const recommendedSkills = useMemo<SkillRecommendation[]>(() => {
    const byId = new Map<string, MarketplaceSkill>();
    for (const skill of marketSkills) byId.set(skill.id, skill);
    const scored = new Map<string, { skill: MarketplaceSkill; score: number; reasons: string[] }>();
    const add = (skillId: string, score: number, reason: string) => {
      const skill = byId.get(skillId);
      if (!skill) return;
      const existing = scored.get(skillId);
      if (existing) {
        existing.score += score;
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      } else {
        scored.set(skillId, { skill, score, reasons: [reason] });
      }
    };

    for (const profile of professionProfiles) {
      const profession = String(profile.profession || '').toLowerCase();
      const confidence = Math.max(0.25, Math.min(1, Number(profile.confidence || 0.45)));
      const skillIds = PROFESSION_RECOMMENDATION_MAP[profession] || [];
      for (const skillId of skillIds) {
        add(
          skillId,
          55 * confidence,
          `Work profile: ${profile.profession} ${Math.round(confidence * 100)}%`,
        );
      }
    }

    for (const rule of WORK_RECOMMENDATION_RULES) {
      const matcher = new RegExp(rule.pattern.source, 'gi');
      const matches = workSignalText.match(matcher)?.length || 0;
      if (!matches) continue;
      for (const skillId of rule.skillIds) {
        add(
          skillId,
          Math.min(70, 24 + matches * 6),
          lang === 'zh' ? `Recent chats: ${rule.zh}` : `Recent chats: ${rule.en}`,
        );
      }
    }

    for (const { marketSkill, skill } of installedSkillRows) {
      if (!marketSkill) continue;
      add(
        marketSkill.id,
        skill.connected ? 18 : 10,
        'Already installed locally',
      );
    }

    return Array.from(scored.values())
      .sort((a, b) => b.score - a.score || b.skill.downloads - a.skill.downloads)
      .slice(0, 8);
  }, [installedSkillRows, lang, professionProfiles, marketSkills, workSignalText]);
  const filteredMarket = marketSkills.filter(s => {
    if (search && !s.name.toLowerCase().includes(search.toLowerCase()) && !s.description.toLowerCase().includes(search.toLowerCase())) return false;
    if (activeCategory && s.category !== activeCategory) return false;
    return true;
  });

  const sortedMarket = [...filteredMarket].sort((a, b) => {
    if (sortKey === 'downloads') return b.downloads - a.downloads;
    if (sortKey === 'rating') return b.rating - a.rating;
    return 0;
  });

  const tabs: { id: SkillCenterTab; label: string; icon: React.ReactNode }[] = [
    { id: 'featured', label: t.recommendedTab || (uiMessage('skill-center.recommended.bf507c36c7', (lang === 'zh') ? 'zh' : 'en')), icon: <Sparkles size={14} /> },
    { id: 'marketplace', label: t.marketplaceTab || 'Marketplace', icon: <ShoppingBag size={14} /> },
    { id: 'installed', label: t.skillManageTab || (uiMessage('skill-center.manage.1f04c52a55', (lang === 'zh') ? 'zh' : 'en')), icon: <Cpu size={14} /> },
    { id: 'mcp', label: t.mcp || 'MCP', icon: <Github size={14} /> },
    { id: 'generate', label: t.generateTab || 'Generate', icon: <Sparkles size={14} /> },
  ];
  const externalCopy = externalCapabilityCopy(lang);

  const SAMPLE_PROMPTS = [
    t.skillGeneratePlaceholder || 'e.g. Check if a website is down, generate QR codes...',
  ];
  const brokenSkillCount = installedSkills.filter(skill => skill.broken).length;
  const recommendationCopy = {
    title: uiMessage('skill-center.recommended-for-your-work.be5baee372', (lang === 'zh') ? 'zh' : 'en'),
    subtitle: uiMessage('skill-center.lumi-uses-the-work-profile.f505fa1fb5', (lang === 'zh') ? 'zh' : 'en'),
    profile: uiMessage('skill-center.work-profile.ed4798ec73', (lang === 'zh') ? 'zh' : 'en'),
    signals: uiMessage('skill-center.chat-signals.9bf2c1816a', (lang === 'zh') ? 'zh' : 'en'),
    recommendations: uiMessage('skill-center.recommended-installs.dbbecaa48a', (lang === 'zh') ? 'zh' : 'en'),
    installed: uiMessage('skill-center.available-capabilities.a150ef4d38', (lang === 'zh') ? 'zh' : 'en'),
    installedHint: uiMessage('skill-center.this-is-a-status-overview.ca69c2a0c5', (lang === 'zh') ? 'zh' : 'en'),
    noSignals: uiMessage('skill-center.not-enough-work-signals-yet.c81ce5b488', (lang === 'zh') ? 'zh' : 'en'),
    noRecommendations: uiMessage('skill-center.no-strong-recommendations-yet-talk.52c6b3ae62', (lang === 'zh') ? 'zh' : 'en'),
    noInstalled: uiMessage('skill-center.no-installed-skills-yet.48c5eca957', (lang === 'zh') ? 'zh' : 'en'),
    refresh: uiMessage('skill-center.refresh-recommendations.e25582e661', (lang === 'zh') ? 'zh' : 'en'),
    manage: uiMessage('skill-center.manage.1f04c52a55', (lang === 'zh') ? 'zh' : 'en'),
    managementTitle: uiMessage('skill-center.skill-mcp-management.7292e8b2ea', (lang === 'zh') ? 'zh' : 'en'),
    managementHint: uiMessage('skill-center.enable-disable-repair-publish-and.fa74468d2b', (lang === 'zh') ? 'zh' : 'en'),
  };
  const hasRecommendationSignals = professionProfiles.length > 0 || matchedWorkSignals.length > 0 || workSignalText.trim().length > 0;
  return { t, canUseExternalCapabilities, canReviewExternalCapabilities, setExternalCapabilityIntakeOpen, externalCopy, sortedMarket, refreshAll, loadError, lang, tabs, setActiveTab, activeTab, installedSkills, recommendationCopy, fetchRecommendationSignals, professionProfiles, matchedWorkSignals, hasRecommendationSignals, recommendationError, recommendedSkills, savedKeys, setDetailSkill, installing, handleInstall, installedSkillRows, installProgress, search, setSearch, setActiveCategory, activeCategory, skillHallCategories, setSortKey, sortKey, searchingExternal, externalError, npm, github, externalCapabilities, externalCapabilitiesError, externalCapabilitiesLoading, fetchReviewedExternalCapabilities, brokenSkillCount, handleCleanupBroken, cleaningBroken, loading, handleRepair, repairing, handleToggle, handlePublish, handleUninstall, generatedDraft, setGeneratedDraft, genDescription, setGenDescription, handleGenerate, generating, SAMPLE_PROMPTS, installingGeneratedDraft, handleInstallGeneratedDraft, detailSkill, marketSkills, externalCapabilityIntakeOpen };
}
