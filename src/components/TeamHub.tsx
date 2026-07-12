import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Users, Bot, ExternalLink, Trash2, Power, PowerOff, Loader2, RefreshCw, CheckCircle2, AlertTriangle, Clock3, Info, X, ShieldCheck, Terminal, Tags, Activity, Send } from 'lucide-react';
import { toast } from 'sonner';
import { useSocket } from '@/hooks/useSocket';
import { apiFetch } from '@/services/apiClient';
import { useApp } from '../contexts/AppContext';

type ExternalCatalogSkill = {
  id: string;
  name: string;
  description?: string;
  author?: string;
  category?: string;
  icon?: string;
  installSource?: 'bundled' | 'community' | 'npm' | 'github';
  installPath?: string;
  installed?: boolean;
  version?: string;
  toolCount?: number;
  runtime?: 'internal' | 'external';
  externalCommand?: string;
  externalAgentId?: string;
  externalHealthStatus?: string;
  requiresSetup?: boolean;
  setupNote?: string;
};

export function TeamHub({ t }: { t?: any }) {
  const socket = useSocket();
  const { workDomain, switchDomain } = useApp();
  const [agents, setAgents] = useState<any[]>([]);
  const [externalCatalog, setExternalCatalog] = useState<ExternalCatalogSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingExternalCatalog, setLoadingExternalCatalog] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showConnectForm, setShowConnectForm] = useState(false);
  const [connectName, setConnectName] = useState('');
  const [connectCategory, setConnectCategory] = useState('general');
  const [connectSkillTags, setConnectSkillTags] = useState('');
  const [connectCommand, setConnectCommand] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [addingExternalSkillId, setAddingExternalSkillId] = useState<string | null>(null);
  const [testingIds, setTestingIds] = useState<string[]>([]);
  const [submittingTemplateIds, setSubmittingTemplateIds] = useState<string[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const loadAgentsFailedText = t?.loadAgentsFailed || 'Failed to load agents';
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const catalogLang = isZh ? 'zh' : 'en';

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await apiFetch('/api/agents');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || loadAgentsFailedText);
      setAgents(Array.isArray(data) ? data : data.agents || []);
    } catch (err: any) {
      const message = err?.message || loadAgentsFailedText;
      setLoadError(message);
      toast.error(message);
    }
    setLoading(false);
  }, [loadAgentsFailedText]);

  const fetchExternalCatalog = useCallback(async () => {
    setLoadingExternalCatalog(true);
    try {
      const res = await apiFetch(`/api/marketplace/skills?lang=${catalogLang}`);
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data.error || 'External agent catalog failed');
      setExternalCatalog((Array.isArray(data) ? data : []).filter((skill: ExternalCatalogSkill) => skill.runtime === 'external'));
    } catch (err: any) {
      toast.error(err.message || 'External agent catalog failed');
    } finally {
      setLoadingExternalCatalog(false);
    }
  }, [catalogLang]);

  useEffect(() => { fetchAgents(); fetchExternalCatalog(); }, [fetchAgents, fetchExternalCatalog]);

  useEffect(() => {
    if (!socket) return;
    socket.on('agent:created', fetchAgents);
    socket.on('agent:updated', fetchAgents);
    socket.on('agent:removed', fetchAgents);
    socket.on('skill:installed', fetchExternalCatalog);
    return () => {
      socket.off('agent:created', fetchAgents);
      socket.off('agent:updated', fetchAgents);
      socket.off('agent:removed', fetchAgents);
      socket.off('skill:installed', fetchExternalCatalog);
    };
  }, [socket, fetchAgents, fetchExternalCatalog]);

  useEffect(() => {
    const handleAgentsChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (detail.agentId) setSelectedAgentId(String(detail.agentId));
      if (detail.agent?.id) setSelectedAgentId(String(detail.agent.id));
      fetchAgents();
      fetchExternalCatalog();
    };
    window.addEventListener('lumi:agents-changed', handleAgentsChanged);
    return () => window.removeEventListener('lumi:agents-changed', handleAgentsChanged);
  }, [fetchAgents, fetchExternalCatalog]);

  useEffect(() => {
    const selectFromStorage = () => {
      try {
        const pending = window.sessionStorage.getItem('lumi:team:selected-agent-id');
        if (pending) {
          setSelectedAgentId(pending);
          window.sessionStorage.removeItem('lumi:team:selected-agent-id');
        }
      } catch {}
    };
    const handleSelect = (event: Event) => {
      const agentId = (event as CustomEvent).detail?.agentId;
      if (agentId) setSelectedAgentId(String(agentId));
      fetchAgents();
    };
    selectFromStorage();
    window.addEventListener('lumi:team:select-agent', handleSelect);
    window.addEventListener('focus', selectFromStorage);
    return () => {
      window.removeEventListener('lumi:team:select-agent', handleSelect);
      window.removeEventListener('focus', selectFromStorage);
    };
  }, [fetchAgents]);

  const handleConnectExternal = async () => {
    if (!connectName.trim() || !connectCommand.trim()) return;
    setConnecting(true);
    try {
      const res = await apiFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: connectName.trim(),
          category: connectCategory,
          skillTags: connectSkillTags ? connectSkillTags.split(',').map((s: string) => s.trim()) : [],
          runtime: 'external',
          externalCommand: connectCommand.trim(),
          executionMode: 'sequential',
          territory: 'open',
        }),
        credentials: 'include',
      });
      if (res.ok) {
        const created = await res.json().catch(() => null);
        toast.success(t?.agentConnected || 'External agent connected');
        setShowConnectForm(false);
        setConnectName('');
        setConnectCommand('');
        setConnectSkillTags('');
        if (created?.id) setAgents(prev => [created, ...prev.filter(a => a.id !== created.id)]);
        else fetchAgents();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || t?.connectFailed || 'Connection failed');
      }
    } catch (err: any) {
      toast.error(err.message || t?.connectFailed || 'Connection failed');
    }
    setConnecting(false);
  };

  const handleAddExternalSkill = async (skill: ExternalCatalogSkill) => {
    if (skill.installed) {
      if (skill.externalAgentId) setSelectedAgentId(skill.externalAgentId);
      return;
    }
    setAddingExternalSkillId(skill.id);
    try {
      const body: any = {
        skillId: skill.id,
        skillName: skill.name,
        installSource: skill.installSource || 'bundled',
      };
      if (skill.installPath) body.installPath = skill.installPath;
      const res = await apiFetch('/api/marketplace/skills/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.error || data.message || 'Failed to add external agent');
      toast.success(data.message || ui(`"${skill.name}" 已加入 Team`, `"${skill.name}" added to Team`));
      window.dispatchEvent(new CustomEvent('lumi:agents-changed', { detail: { agentId: data.agentId, name: skill.name } }));
      await Promise.all([fetchAgents(), fetchExternalCatalog()]);
      if (data.agentId) setSelectedAgentId(data.agentId);
    } catch (err: any) {
      toast.error(err.message || 'Failed to add external agent');
    } finally {
      setAddingExternalSkillId(null);
    }
  };

  const handleTestConnection = async (agent: any) => {
    setTestingIds(prev => prev.includes(agent.id) ? prev : [...prev, agent.id]);
    try {
      const res = await apiFetch(`/api/agents/${agent.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: `Lumi health check for ${agent.name || 'external agent'}. Reply briefly.` }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Connection test failed');
      if (data.agent) {
        setAgents(prev => prev.map(a => a.id === agent.id ? data.agent : a));
        setSelectedAgentId(current => current === agent.id ? data.agent.id : current);
      }
      if (data.ok) toast.success(ui('外部 agent 连接正常', 'External agent is reachable'));
      else toast.error(data.result?.output || ui('外部 agent 测试失败', 'External agent test failed'));
    } catch (err: any) {
      toast.error(err.message || ui('外部 agent 测试失败', 'External agent test failed'));
    } finally {
      setTestingIds(prev => prev.filter(id => id !== agent.id));
    }
  };

  const buildOrgTemplateConfig = (agent: any) => {
    const config = parseConfig(agent);
    const skillTags = listFrom(agent.skillTags).length > 0 ? listFrom(agent.skillTags) : listFrom(config.skillTags);
    const knowledgeDomains = listFrom(agent.knowledgeDomains).length > 0 ? listFrom(agent.knowledgeDomains) : listFrom(config.knowledgeDomains);
    const description = agentDescription(agent);
    const templateConfig: Record<string, any> = {
      ...config,
      name: agent.name,
      description,
      category: agent.category || config.category || 'general',
      personalityId: agent.personalityId || config.personalityId || 'lumi',
      modelPreference: agent.modelPreference || config.modelPreference || '',
      memoryScope: agent.memoryScope || config.memoryScope || 'shared',
      autonomyLevel: agent.autonomyLevel || config.autonomyLevel || 'reactive',
      executionMode: agent.executionMode || config.executionMode || '',
      territory: agent.territory || config.territory || 'open',
      skillTags,
      knowledgeDomains,
      allowCrossPollination: agent.allowCrossPollination ?? config.allowCrossPollination ?? true,
      initialPrompt: config.initialPrompt || config.systemPrompt || description,
      runtime: 'internal',
    };
    delete templateConfig.domain;
    delete templateConfig.orgId;
    delete templateConfig.installedTemplateId;
    delete templateConfig.installedTemplateVersion;
    delete templateConfig.externalCommand;
    delete templateConfig.runtimeConfig;
    return templateConfig;
  };

  const handleSubmitAgentTemplate = async (agent: any) => {
    if (agent.runtime === 'external') {
      toast.error(ui('外部 CLI 桥接 agent 不直接提交为组织模板，请先做成内部 agent 配置。', 'External CLI bridge agents cannot be submitted as organization templates directly.'));
      return;
    }
    if (agent.installedTemplateId) {
      toast.info(ui('这个 agent 已经来自组织模板，不需要重复提交。', 'This agent already came from an organization template.'));
      return;
    }

    setSubmittingTemplateIds(prev => prev.includes(agent.id) ? prev : [...prev, agent.id]);
    try {
      if (workDomain !== 'work') {
        const switched = await switchDomain('work');
        if (!switched.success) {
          throw new Error(switched.message || ui('请先加入组织或切换到工作域，再提交审核。', 'Join an organization or switch to Work before submitting.'));
        }
      }

      const description = agentDescription(agent);
      const templateRes = await apiFetch('/api/org/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: agent.name || ui('未命名团队智能体', 'Untitled team agent'),
          description,
          category: agent.category || 'general',
          icon: 'Bot',
          config: buildOrgTemplateConfig(agent),
        }),
      });
      const template = await templateRes.json().catch(() => ({}));
      if (!templateRes.ok) throw new Error(template.error || ui(`智能体模板创建失败（${templateRes.status}）`, `Agent template create failed (${templateRes.status})`));
      const templateId = template.id || template.template?.id;
      if (!templateId) throw new Error(ui('智能体模板创建成功，但没有返回模板 ID。', 'Agent template created without a template ID.'));

      const submitRes = await apiFetch(`/api/org/templates/${templateId}/submit`, { method: 'POST' });
      const submitted = await submitRes.json().catch(() => ({}));
      if (!submitRes.ok) throw new Error(submitted.error || ui(`提交审核失败（${submitRes.status}）`, `Submit for review failed (${submitRes.status})`));

      toast.success(ui('已提交到组织智能体审核队列', 'Submitted to organization agent review'));
      window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'review' } }));
    } catch (err: any) {
      toast.error(err.message || ui('提交审核失败', 'Submit for review failed'));
    } finally {
      setSubmittingTemplateIds(prev => prev.filter(id => id !== agent.id));
    }
  };

  const handleDelete = async (id: string, name?: string) => {
    const ok = window.confirm(ui(
      `确认移除「${name || id}」？它的记忆、会话记录也会一起删除。`,
      `Remove "${name || id}"? Its memories and conversations will also be deleted.`,
    ));
    if (!ok) return;
    try {
      const res = await apiFetch(`/api/agents/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setAgents(prev => prev.filter(a => a.id !== id));
        setSelectedAgentId(current => current === id ? null : current);
        window.dispatchEvent(new CustomEvent('lumi:agents-changed', { detail: { removedAgentId: id } }));
        toast.success(t?.agentRemoved || 'Agent removed');
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || t?.removeFailed || 'Failed to remove');
      }
    } catch (err: any) {
      toast.error(err.message || t?.removeFailed || 'Failed to remove');
    }
  };

  const handleToggle = async (agent: any) => {
    const nextFrozen = !(agent.isFrozen ?? false);
    try {
      const res = await apiFetch(`/api/agents/${agent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isFrozen: nextFrozen }),
        credentials: 'include',
      });
      if (res.ok) {
        setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, isFrozen: nextFrozen } : a));
        toast.info(nextFrozen ? (t?.agentFrozen || 'Agent frozen') : (t?.agentActivated || 'Agent activated'));
      }
    } catch (err: any) {
      toast.error(err.message || t?.toggleFailed || 'Toggle failed');
    }
  };

  const internalAgents = agents.filter(a => a.runtime !== 'external');
  const externalAgents = agents.filter(a => a.runtime === 'external');
  const readyExternalCount = externalAgents.filter(agent => agent.healthStatus === 'online' && agent.isFrozen !== true).length;
  const installableExternalCount = externalCatalog.filter(skill => !skill.installed).length;
  const hasTeamContent = agents.length > 0 || loadingExternalCatalog || externalCatalog.length > 0;
  const selectedAgent = selectedAgentId ? agents.find(agent => agent.id === selectedAgentId) || null : null;

  const healthMeta = (agent: any) => {
    if (agent.healthStatus === 'online') return { icon: <CheckCircle2 size={13} />, label: ui('可用', 'Online'), className: 'border-emerald-400/15 bg-emerald-500/10 text-emerald-300' };
    if (agent.healthStatus === 'error') return { icon: <AlertTriangle size={13} />, label: ui('异常', 'Error'), className: 'border-red-400/15 bg-red-500/10 text-red-200' };
    return { icon: <Clock3 size={13} />, label: ui('未测试', 'Untested'), className: 'border-white/10 bg-white/[0.04] text-white/45' };
  };

  const catalogStatusMeta = (skill: ExternalCatalogSkill) => {
    if (skill.installed && skill.externalHealthStatus === 'online') {
      return { icon: <CheckCircle2 size={13} />, label: ui('可调用', 'Callable'), className: 'border-emerald-400/15 bg-emerald-500/10 text-emerald-300' };
    }
    if (skill.installed) {
      return { icon: <Clock3 size={13} />, label: ui('已在 Team', 'In Team'), className: 'border-amber-400/15 bg-amber-500/10 text-amber-200' };
    }
    return { icon: <ExternalLink size={13} />, label: ui('可加入', 'Available'), className: 'border-cyan-300/15 bg-cyan-500/10 text-cyan-200' };
  };

  const formatTime = (value?: string) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(isZh ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  const parseObjectValue = (value: unknown) => {
    if (!value) return {};
    if (typeof value === 'object') return value as Record<string, any>;
    if (typeof value !== 'string') return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const parseConfig = (agent: any) => ({
    ...parseObjectValue(agent?.data),
    ...parseObjectValue(agent?.config),
  });

  const parseRuntimeConfig = (agent: any) => {
    try {
      const parsed = typeof agent?.runtimeConfig === 'string' ? JSON.parse(agent.runtimeConfig) : agent?.runtimeConfig;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const agentDescription = (agent: any) => {
    const config = parseConfig(agent);
    return config.description || agent.description || agent.data?.description || ui('暂无介绍。可以通过技能标签和类别判断它适合处理的任务。', 'No description yet. Use its category and skill tags to judge what work fits.');
  };

  const listFrom = (value: unknown): string[] => {
    const raw = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : [];
    return raw.map(item => String(item || '').trim()).filter(Boolean);
  };

  const dispatchState = (agent: any) => {
    if (agent.isFrozen) return ui('已暂停，不参与调度', 'Paused, not scheduled');
    if (agent.runtime === 'external' && agent.healthStatus !== 'online') return ui('等待连接测试通过', 'Waiting for a passing health test');
    if (agent.status === 'terminated') return ui('已终止', 'Terminated');
    return ui('可参与调度', 'Ready for orchestration');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="lumi-panel flex items-center justify-between gap-4 p-5">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-black uppercase tracking-[0.08em] text-white/90">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-300/15 bg-cyan-400/10 text-cyan-300">
              <Users size={20} />
            </span>
            {t?.teamHub || 'Agent Team'}
          </h2>
          <p className="text-sm text-white/40 max-w-xl mt-1">
            {ui('Lumi 的工作团队。内部 agent 可直接调度，外部 agent 通过本机 CLI 连接，先测试健康状态再交给 orchestrator。', "Lumi's working team. Internal agents are dispatched directly; external agents connect through local CLI commands and should pass a health test before orchestration.")}
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-bold text-white/35">
            <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-1">
              {ui(`内部 ${internalAgents.length}`, `${internalAgents.length} internal`)}
            </span>
            <span className="rounded-full border border-cyan-300/15 bg-cyan-500/10 px-2 py-1 text-cyan-200/60">
              {ui(`外部就绪 ${readyExternalCount}/${externalAgents.length}`, `${readyExternalCount}/${externalAgents.length} external ready`)}
            </span>
            <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-1">
              {ui(`可加入 ${installableExternalCount}`, `${installableExternalCount} available`)}
            </span>
          </div>
        </div>
        <button
          onClick={() => setShowConnectForm(!showConnectForm)}
          className="lumi-button-primary shrink-0 border-cyan-400/25 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25"
        >
          <ExternalLink size={12} />
          {t?.connectExternal || ui('连接外部 Agent', 'Connect External Agent')}
        </button>
      </div>

      <AnimatePresence>
        {showConnectForm && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="lumi-panel space-y-4 border-cyan-500/15 bg-cyan-500/5 p-5">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-300/15 bg-cyan-500/10 text-cyan-300">
                  <Info size={15} />
                </span>
                <div>
                  <p className="text-sm font-bold text-cyan-100/80">{ui('外部 Agent 是本机 CLI 桥接', 'External agents are local CLI bridges')}</p>
                  <p className="mt-1 text-xs leading-relaxed text-cyan-100/45">
                    {ui('这里保存的是命令模板，不是账号绑定。Lumi 会把子任务替换进 {task}，测试通过后才会让它参与团队调度。', 'This stores a command template, not an account binding. Lumi substitutes subtasks into {task}; only agents with a passing health test join orchestration.')}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                {[
                  { icon: <Terminal size={14} />, title: ui('命令模板', 'Command'), detail: ui('必须包含一次 {task}', 'Must include one {task}') },
                  { icon: <ShieldCheck size={14} />, title: ui('安全边界', 'Safety'), detail: ui('拒绝危险 shell 串联', 'Blocks risky shell chaining') },
                  { icon: <Activity size={14} />, title: ui('调度条件', 'Routing'), detail: ui('健康测试通过才启用', 'Enabled after health test') },
                ].map(item => (
                  <div key={item.title} className="rounded-xl border border-cyan-300/10 bg-black/20 px-3 py-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-widest text-cyan-200/65">
                      {item.icon}
                      {item.title}
                    </div>
                    <div className="mt-1 text-[11px] text-white/35">{item.detail}</div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input value={connectName} onChange={e => setConnectName(e.target.value)}
                  placeholder={t?.agentName || 'Agent Name'} className="lumi-field py-2 text-xs" />
                <select value={connectCategory} onChange={e => setConnectCategory(e.target.value)}
                  className="lumi-field py-2 text-xs text-white/80">
                  {['general','code','content','analysis','search','automation','assistant','media'].map(c => (
                    <option key={c} value={c} className="bg-gray-900">{c}</option>
                  ))}
                </select>
                <input value={connectSkillTags} onChange={e => setConnectSkillTags(e.target.value)}
                  placeholder={t?.agentSkillTags || ui('能力标签，用逗号分隔，如 analysis, code', 'Skill tags, comma separated, e.g. analysis, code')} className="lumi-field py-2 text-xs" />
                <input value={connectCommand} onChange={e => setConnectCommand(e.target.value)}
                  placeholder={t?.agentCommandHint || 'openclaw send --task "{task}"'} className="lumi-field py-2 font-mono text-xs" />
              </div>
              <div className="flex gap-2">
                <button onClick={handleConnectExternal}
                  disabled={connecting || !connectName.trim() || !connectCommand.trim()}
                  className="lumi-button-primary h-9 border-cyan-300/25 bg-cyan-300/90 px-4 text-xs text-slate-950 hover:bg-cyan-200">
                  {connecting ? (t?.connectingBtn || 'Connecting...') : (t?.connectBtn || 'Connect')}
                </button>
                <button onClick={() => setShowConnectForm(false)}
                  className="lumi-button h-9 px-4 text-xs">
                  {t?.cancel || 'Cancel'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {loading ? (
        <div className="lumi-panel p-16 text-center">
          <Loader2 size={32} className="text-white/40 mx-auto mb-4 animate-spin" />
          <p className="text-white/40 text-sm">{t?.loading || 'Loading...'}</p>
        </div>
      ) : loadError ? (
        <div className="lumi-panel border-red-400/15 bg-red-500/5 p-8 text-center">
          <p className="text-sm text-red-200/80">{loadError}</p>
          <button onClick={() => void fetchAgents()} className="lumi-button mt-4">{t?.retry || 'Retry'}</button>
        </div>
      ) : !hasTeamContent ? (
        <div className="lumi-panel p-16 text-center">
          <Users size={40} className="text-white/45 mx-auto mb-4" />
          <p className="text-white/40 font-bold uppercase tracking-widest text-sm">{t?.noTeamMembers || 'No team members yet'}</p>
          <p className="text-white/45 text-xs mt-2">{t?.teamCreateHint || 'Use agent_create in chat to add a teammate.'}</p>
        </div>
      ) : (
        <>
          {/* External Agent Catalog */}
          {(loadingExternalCatalog || externalCatalog.length > 0) && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-black uppercase tracking-widest text-white/50">{ui('外部 Agent 大厅', 'External Agent Hall')}</h3>
                <button
                  onClick={() => void fetchExternalCatalog()}
                  className="lumi-icon-button h-8 w-8"
                  title={t?.refresh || 'Refresh'}
                >
                  <RefreshCw size={13} className={loadingExternalCatalog ? 'animate-spin' : ''} />
                </button>
              </div>
              {loadingExternalCatalog ? (
                <div className="lumi-panel p-8 text-center">
                  <Loader2 size={22} className="mx-auto mb-3 animate-spin text-cyan-200/50" />
                  <p className="text-xs text-white/35">{ui('正在读取外部 Agent...', 'Loading external agents...')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {externalCatalog.map((skill) => {
                    const meta = catalogStatusMeta(skill);
                    const isAdding = addingExternalSkillId === skill.id;
                    return (
                      <motion.div
                        key={skill.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="lumi-panel space-y-3 border-cyan-500/15 bg-cyan-500/[0.04] p-5"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cyan-300/15 bg-cyan-500/10 text-cyan-300">
                              <Terminal size={16} />
                            </span>
                            <div className="min-w-0">
                              <h4 className="truncate text-sm font-bold text-white/90">{skill.name}</h4>
                              <p className="text-[11px] uppercase text-cyan-200/45">{skill.category || 'external'} · {skill.toolCount || 1} {ui('工具', 'tools')}</p>
                            </div>
                          </div>
                          <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-bold ${meta.className}`}>
                            {meta.icon}
                            {meta.label}
                          </span>
                        </div>
                        {skill.description && (
                          <p className="line-clamp-2 text-xs leading-relaxed text-white/48">{skill.description}</p>
                        )}
                        {skill.setupNote && (
                          <div className="rounded-lg border border-amber-300/10 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-100/55">
                            {skill.setupNote}
                          </div>
                        )}
                        {skill.externalCommand && (
                          <div className="truncate rounded-lg bg-black/35 p-2 font-mono text-xs text-cyan-100/40">
                            {skill.externalCommand}
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
                          <span className="text-[11px] text-white/30">{skill.author || 'Lumi Marketplace'}</span>
                          <button
                            onClick={() => void handleAddExternalSkill(skill)}
                            disabled={isAdding}
                            className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-bold transition-colors ${
                              skill.installed
                                ? 'border border-green-300/15 bg-green-500/10 text-green-300 hover:bg-green-500/15'
                                : 'bg-cyan-300 text-slate-950 hover:bg-cyan-200'
                            } disabled:opacity-45`}
                          >
                            {isAdding ? <RefreshCw size={12} className="animate-spin" /> : skill.installed ? <CheckCircle2 size={12} /> : <ExternalLink size={12} />}
                            {skill.installed ? ui('已在 Team', 'In Team') : ui('加入 Team', 'Add to Team')}
                          </button>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Internal Agents */}
          {internalAgents.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-black uppercase tracking-widest text-white/50">{t?.internalAgents || 'Internal Agents'}</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <AnimatePresence>
                  {internalAgents.map((agent: any) => (
                    <motion.div
                      key={agent.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedAgentId(agent.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedAgentId(agent.id);
                        }
                      }}
                      className="lumi-panel cursor-pointer space-y-3 p-5 transition-colors hover:border-white/15 hover:bg-white/[0.06]"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-300/15 bg-cyan-500/10">
                            <Bot size={16} className="text-cyan-400" />
                          </div>
                          <div>
                            <h4 className="text-sm font-bold text-white">{agent.name}</h4>
                            <span className="text-[11px] text-white/40 uppercase">{agent.category || 'general'}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={(event) => { event.stopPropagation(); handleToggle(agent); }}
                            className={`rounded-lg p-1.5 transition-all ${agent.isFrozen ? 'bg-white/5 text-white/30 hover:text-white/50' : 'bg-green-500/10 text-green-400'}`}
                            title={agent.isFrozen ? (t?.activate || 'Activate') : (t?.freeze || 'Freeze')}
                          >
                            {agent.isFrozen ? <Power size={14} /> : <PowerOff size={14} />}
                          </button>
                          <button
                            onClick={(event) => { event.stopPropagation(); void handleDelete(agent.id, agent.name); }}
                            className="rounded-lg p-1.5 text-white/30 transition-all hover:bg-red-500/10 hover:text-red-400"
                            title={t?.remove || 'Remove'}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-white/40">
                        <span className={`w-1.5 h-1.5 rounded-full ${agent.isFrozen ? 'bg-white/20' : 'bg-green-400 animate-pulse'}`} />
                        {agent.isFrozen ? (t?.frozen || 'Frozen') : (t?.active || 'Active')}
                        {agent.memoryScope === 'private' && (
                          <span className="px-1.5 py-0.5 bg-purple-500/10 text-purple-400 rounded text-[10px]">{t?.sanctuary || 'Sanctuary'}</span>
                        )}
                      </div>
                      {(agent.skillTags || []).length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {agent.skillTags.map((t: string) => (
                            <span key={t} className="px-1.5 py-0.5 bg-white/5 rounded text-[10px] text-white/40 uppercase">{t}</span>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
                        <span className="text-[11px] font-bold text-white/28">
                          {agent.installedTemplateId ? ui('来自组织模板', 'From org template') : ui('可提交为组织模板', 'Can submit as org template')}
                        </span>
                        {!agent.installedTemplateId && (
                          <button
                            onClick={(event) => { event.stopPropagation(); void handleSubmitAgentTemplate(agent); }}
                            disabled={submittingTemplateIds.includes(agent.id)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-violet-300/15 bg-violet-500/10 px-3 text-xs font-bold text-violet-100/80 transition hover:bg-violet-500/18 disabled:opacity-45"
                          >
                            {submittingTemplateIds.includes(agent.id) ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                            {ui('提交审核', 'Submit')}
                          </button>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          )}

          {/* External Agents */}
          {externalAgents.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-black uppercase tracking-widest text-white/50">{t?.externalAgents || 'External Agents'}</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <AnimatePresence>
                  {externalAgents.map((agent: any) => (
                    <motion.div
                      key={agent.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedAgentId(agent.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedAgentId(agent.id);
                        }
                      }}
                      className="lumi-panel cursor-pointer space-y-3 border-cyan-500/15 bg-cyan-500/5 p-5 transition-colors hover:border-cyan-500/30"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-300/15 bg-cyan-500/10">
                            <ExternalLink size={16} className="text-cyan-400" />
                          </div>
                          <div>
                            <h4 className="text-sm font-bold text-white">{agent.name}</h4>
                            <span className="text-[11px] text-cyan-400/70">{agent.category || 'external'}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={(event) => { event.stopPropagation(); handleToggle(agent); }}
                            className={`rounded-lg p-1.5 transition-all ${agent.isFrozen ? 'bg-white/5 text-white/30 hover:text-white/50' : 'bg-green-500/10 text-green-400'}`}
                            title={agent.isFrozen ? (t?.activate || 'Activate') : (t?.freeze || 'Freeze')}
                          >
                            {agent.isFrozen ? <Power size={14} /> : <PowerOff size={14} />}
                          </button>
                          <button
                            onClick={(event) => { event.stopPropagation(); void handleTestConnection(agent); }}
                            disabled={testingIds.includes(agent.id)}
                            className="rounded-lg p-1.5 text-cyan-300/65 transition-all hover:bg-cyan-500/10 hover:text-cyan-100 disabled:opacity-30"
                            title={ui('测试连接', 'Test connection')}
                          >
                            <RefreshCw size={14} className={testingIds.includes(agent.id) ? 'animate-spin' : ''} />
                          </button>
                          <button
                            onClick={(event) => { event.stopPropagation(); void handleDelete(agent.id, agent.name); }}
                            className="rounded-lg p-1.5 text-white/30 transition-all hover:bg-red-500/10 hover:text-red-400"
                            title={t?.remove || 'Remove'}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {(() => {
                          const meta = healthMeta(agent);
                          return (
                            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-bold ${meta.className}`}>
                              {meta.icon}
                              {meta.label}
                            </span>
                          );
                        })()}
                        {agent.lastRunDurationMs != null && (
                          <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] font-mono text-white/35">
                            {agent.lastRunDurationMs}ms
                          </span>
                        )}
                        {agent.lastHealthCheckAt && (
                          <span className="text-[11px] text-white/30">
                            {formatTime(agent.lastHealthCheckAt)}
                          </span>
                        )}
                      </div>
                      {(agent.skillTags || []).length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {agent.skillTags.map((tag: string) => (
                            <span key={tag} className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] uppercase text-cyan-300/55">{tag}</span>
                          ))}
                        </div>
                      )}
                      {agent.healthStatus !== 'online' && (
                        <div className="rounded-lg border border-amber-300/10 bg-amber-500/5 px-3 py-2 text-xs text-amber-100/55">
                          {agent.healthStatus === 'error'
                            ? ui('上次测试失败。修复命令并重新测试前，不会参与调度。', 'Last test failed. It will not be scheduled until the command is fixed and tested again.')
                            : ui('尚未测试。测试通过后才会参与任务调度。', 'Untested. It will only join orchestration after a successful health test.')}
                        </div>
                      )}
                      {agent.externalCommand && (
                        <div className="p-2 bg-black/40 rounded-lg text-xs font-mono text-white/40 truncate">
                          {agent.externalCommand}
                        </div>
                      )}
                      {agent.lastRunOutput && (
                        <div className="max-h-20 overflow-hidden rounded-lg border border-white/[0.06] bg-black/25 p-2 text-xs leading-relaxed text-white/42">
                          {agent.lastRunOutput}
                        </div>
                      )}
                      <div className="text-[11px] font-bold text-cyan-100/30">{ui('点击查看连接详情与介绍', 'Click for connection details and profile')}</div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          )}
        </>
      )}

      <AnimatePresence>
        {selectedAgent && (
          <motion.div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelectedAgentId(null)}
          >
            <motion.div
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 18, scale: 0.98 }}
              className="lumi-panel max-h-[86vh] w-full max-w-3xl overflow-hidden border-white/10 bg-[#080d16]/95"
              onClick={(event) => event.stopPropagation()}
            >
              {(() => {
                const isExternal = selectedAgent.runtime === 'external';
                const meta = healthMeta(selectedAgent);
                const config = parseConfig(selectedAgent);
                const runtimeConfig = parseRuntimeConfig(selectedAgent);
                const tags = listFrom(selectedAgent.skillTags);
                const knowledgeDomains = listFrom(selectedAgent.knowledgeDomains).length > 0
                  ? listFrom(selectedAgent.knowledgeDomains)
                  : listFrom(config.knowledgeDomains);
                return (
                  <>
                    <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] p-5">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${isExternal ? 'border-cyan-300/15 bg-cyan-500/10 text-cyan-300' : 'border-white/10 bg-white/[0.04] text-white/65'}`}>
                          {isExternal ? <ExternalLink size={20} /> : <Bot size={20} />}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate text-lg font-black text-white/90">{selectedAgent.name}</h3>
                            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-white/45">
                              {isExternal ? ui('外部', 'External') : ui('内部', 'Internal')}
                            </span>
                            {selectedAgent.installedTemplateId && (
                              <span className="rounded-full border border-emerald-300/15 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-emerald-200/70">
                                {ui('组织安装', 'Org installed')}
                              </span>
                            )}
                            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-bold ${meta.className}`}>
                              {meta.icon}
                              {meta.label}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-white/40">{selectedAgent.category || 'general'} · {dispatchState(selectedAgent)}</p>
                        </div>
                      </div>
                      <button
                        onClick={() => setSelectedAgentId(null)}
                        className="lumi-icon-button h-8 w-8 rounded-lg"
                        title={ui('关闭', 'Close')}
                      >
                        <X size={15} />
                      </button>
                    </div>

                    <div className="custom-scrollbar max-h-[calc(86vh-88px)] space-y-4 overflow-y-auto p-5">
                      <section className="space-y-2">
                        <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-white/50">
                          <Info size={14} />
                          {ui('介绍', 'Profile')}
                        </div>
                        <p className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-3 text-sm leading-relaxed text-white/62">
                          {agentDescription(selectedAgent)}
                        </p>
                      </section>

                      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
                          <div className="text-[10px] font-black uppercase tracking-widest text-white/35">{ui('运行方式', 'Runtime')}</div>
                          <div className="mt-1 text-sm font-bold text-white/70">{isExternal ? 'CLI Bridge' : 'Lumi Worker'}</div>
                        </div>
                        <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
                          <div className="text-[10px] font-black uppercase tracking-widest text-white/35">{ui('记忆范围', 'Memory')}</div>
                          <div className="mt-1 text-sm font-bold text-white/70">{selectedAgent.memoryScope || 'shared'}</div>
                        </div>
                        <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
                          <div className="text-[10px] font-black uppercase tracking-widest text-white/35">{ui('自主等级', 'Autonomy')}</div>
                          <div className="mt-1 text-sm font-bold text-white/70">{selectedAgent.autonomyLevel || 'reactive'}</div>
                        </div>
                      </section>

                      <section className="space-y-2">
                        <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-white/50">
                          <Tags size={14} />
                          {ui('能力标签', 'Capabilities')}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {tags.length > 0 ? tags.map((tag: string) => (
                            <span key={tag} className="rounded-full border border-cyan-300/12 bg-cyan-500/10 px-2 py-1 text-[11px] font-bold uppercase text-cyan-200/65">{tag}</span>
                          )) : (
                            <span className="text-xs text-white/35">{ui('暂无能力标签', 'No skill tags yet')}</span>
                          )}
                          {knowledgeDomains.map((domain: string) => (
                            <span key={domain} className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] font-bold uppercase text-white/45">{domain}</span>
                          ))}
                        </div>
                      </section>

                      {isExternal && (
                        <section className="space-y-2">
                          <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-white/50">
                            <Terminal size={14} />
                            {ui('外部连接', 'External Connection')}
                          </div>
                          <div className="rounded-xl border border-cyan-300/10 bg-cyan-500/[0.04] p-3">
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                              <div>
                                <div className="text-[10px] font-black uppercase tracking-widest text-cyan-100/35">{ui('连接类型', 'Connection Type')}</div>
                                <div className="mt-1 text-sm text-cyan-100/70">{ui('本机命令模板', 'Local command template')}</div>
                              </div>
                              <div>
                                <div className="text-[10px] font-black uppercase tracking-widest text-cyan-100/35">{ui('工作目录', 'Working Directory')}</div>
                                <div className="mt-1 truncate text-sm text-cyan-100/70">{runtimeConfig.cwd || ui('默认服务目录', 'Default server directory')}</div>
                              </div>
                            </div>
                            <pre className="custom-scrollbar mt-3 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/45 p-3 text-xs text-white/45">{selectedAgent.externalCommand || ui('未配置命令', 'No command configured')}</pre>
                          </div>
                        </section>
                      )}

                      <section className="space-y-2">
                        <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-white/50">
                          <Activity size={14} />
                          {ui('最近运行', 'Recent Run')}
                        </div>
                        <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
                          <div className="flex flex-wrap gap-3 text-xs text-white/40">
                            <span>{ui('状态', 'Status')}: {selectedAgent.lastRunStatus || '-'}</span>
                            <span>{ui('耗时', 'Duration')}: {selectedAgent.lastRunDurationMs != null ? `${selectedAgent.lastRunDurationMs}ms` : '-'}</span>
                            <span>{ui('检查', 'Checked')}: {formatTime(selectedAgent.lastHealthCheckAt) || '-'}</span>
                          </div>
                          {selectedAgent.lastRunOutput && (
                            <div className="custom-scrollbar mt-3 max-h-32 overflow-auto rounded-lg bg-black/30 p-3 text-xs leading-relaxed text-white/48">
                              {selectedAgent.lastRunOutput}
                            </div>
                          )}
                        </div>
                      </section>

                      <div className="flex flex-wrap justify-end gap-2 border-t border-white/[0.06] pt-4">
                        {isExternal && (
                          <button
                            onClick={() => void handleTestConnection(selectedAgent)}
                            disabled={testingIds.includes(selectedAgent.id)}
                            className="lumi-button h-9 px-3 text-xs"
                          >
                            <RefreshCw size={13} className={testingIds.includes(selectedAgent.id) ? 'animate-spin' : ''} />
                            {ui('测试连接', 'Test Connection')}
                          </button>
                        )}
                        {!isExternal && !selectedAgent.installedTemplateId && (
                          <button
                            onClick={() => void handleSubmitAgentTemplate(selectedAgent)}
                            disabled={submittingTemplateIds.includes(selectedAgent.id)}
                            className="lumi-button h-9 border-violet-400/15 bg-violet-500/10 px-3 text-xs text-violet-100/80 hover:bg-violet-500/15 disabled:opacity-45"
                          >
                            {submittingTemplateIds.includes(selectedAgent.id) ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                            {ui('提交到组织审核', 'Submit to Org Review')}
                          </button>
                        )}
                        <button
                          onClick={() => handleToggle(selectedAgent)}
                          className="lumi-button h-9 px-3 text-xs"
                        >
                          {selectedAgent.isFrozen ? <Power size={13} /> : <PowerOff size={13} />}
                          {selectedAgent.isFrozen ? ui('启用', 'Activate') : ui('暂停', 'Pause')}
                        </button>
                        <button
                          onClick={() => void handleDelete(selectedAgent.id, selectedAgent.name)}
                          className="lumi-button h-9 border-red-400/15 bg-red-500/10 px-3 text-xs text-red-200/70 hover:bg-red-500/15"
                        >
                          <Trash2 size={13} />
                          {ui('移除', 'Remove')}
                        </button>
                      </div>
                    </div>
                  </>
                );
              })()}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
