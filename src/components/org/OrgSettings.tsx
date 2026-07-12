import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  BrainCircuit,
  Building2,
  CheckCircle,
  Copy,
  KeyRound,
  Link,
  Loader2,
  Save,
  Settings,
  Trash2,
} from 'lucide-react';
import { useT } from '../../lib/useT';
import { useApp } from '../../contexts/AppContext';
import { appConfirm } from '../../lib/appConfirm';

type Feedback = { type: 'success' | 'error'; text: string };

const LLM_PROVIDER_OPTIONS = [
  { id: 'deepseek', label: 'DeepSeek', models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'] },
  { id: 'qwen', label: 'Qwen / DashScope', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  { id: 'openai', label: 'OpenAI', models: ['gpt-4o', 'gpt-4.1', 'o3'] },
  { id: 'gemini', label: 'Gemini', models: ['gemini-2.0-flash', 'gemini-1.5-pro'] },
  { id: 'anthropic', label: 'Anthropic', models: ['claude-sonnet-4-6', 'claude-3-5-sonnet-latest'] },
  { id: 'ark', label: 'Volcengine Ark', models: ['doubao-seed-2-0-lite-260215', 'doubao-1-5-pro-32k'] },
  { id: 'kimi', label: 'Kimi', models: ['moonshot-v1-8k', 'moonshot-v1-32k'] },
  { id: 'glm', label: 'GLM', models: ['glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4-plus'] },
  { id: 'relay', label: 'Relay', models: ['gpt-4o'] },
  { id: 'ollama', label: 'Ollama', models: ['qwen2.5:7b', 'llama3.2'] },
  { id: 'lmstudio', label: 'LM Studio', models: ['local-model'] },
] as const;

export function OrgSettings() {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);
  const { orgConnection, switchDomain } = useApp();
  const [org, setOrg] = useState<any>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [invitationCode, setInvitationCode] = useState('');
  const [invitationRole, setInvitationRole] = useState('member');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmProvider, setLlmProvider] = useState('deepseek');
  const [llmModels, setLlmModels] = useState<Record<string, string>>({});

  const loadOrg = useCallback(async () => {
    setLoading(true);
    setFeedback(null);
    try {
      let orgId = orgConnection?.orgId || '';
      if (!orgId) {
        const orgsRes = await fetch('/api/org/org', { credentials: 'include' });
        const orgs = await orgsRes.json().catch(() => []);
        if (!orgsRes.ok) throw new Error((orgs as any).error || ui(`组织列表加载失败（${orgsRes.status}）`, `Failed to load organizations (${orgsRes.status})`));
        if (!Array.isArray(orgs) || orgs.length === 0) throw new Error(ui('未找到组织', 'No organization found'));
        orgId = orgs[0].id || orgs[0].orgId;
      }

      const orgDetailRes = await fetch(`/api/org/org/${orgId}`, { credentials: 'include' });
      const orgData = await orgDetailRes.json().catch(() => ({}));
      if (!orgDetailRes.ok) throw new Error(orgData.error || ui(`组织加载失败（${orgDetailRes.status}）`, `Failed to load organization (${orgDetailRes.status})`));
      setOrg(orgData);
      setName(orgData.name || '');
    } catch (err: any) {
      setOrg(null);
      setFeedback({ type: 'error', text: err.message || String(err) });
    } finally {
      setLoading(false);
    }
  }, [orgConnection?.orgId, ui]);

  const loadOrgLlmPrefs = useCallback(async () => {
    setLlmLoading(true);
    try {
      const res = await fetch('/api/preferences/org-llm', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui(`大模型策略加载失败（${res.status}）`, `Failed to load LLM policy (${res.status})`));
      setLlmProvider(data.provider || 'deepseek');
      setLlmModels(data.models && typeof data.models === 'object' ? data.models : {});
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
    } finally {
      setLlmLoading(false);
    }
  }, [ui]);

  useEffect(() => {
    void loadOrg();
  }, [loadOrg]);

  useEffect(() => {
    void loadOrgLlmPrefs();
  }, [loadOrgLlmPrefs]);

  const handleSave = async () => {
    if (!org || !name.trim()) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/org/org/${org.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui(`保存失败（${res.status}）`, `Save failed (${res.status})`));
      setOrg(data);
      setName(data.name || name.trim());
      setFeedback({ type: 'success', text: t.orgSettingsSaved || ui('组织设置已保存', 'Organization settings saved') });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
    } finally {
      setSaving(false);
    }
  };

  const selectedProviderOption = LLM_PROVIDER_OPTIONS.find(option => option.id === llmProvider) || LLM_PROVIDER_OPTIONS[0];
  const selectedModel = llmModels[llmProvider] || selectedProviderOption.models[0] || '';

  const updateLlmModel = (model: string) => {
    setLlmModels(prev => ({ ...prev, [llmProvider]: model }));
  };

  const handleSaveOrgLlm = async () => {
    setLlmSaving(true);
    setFeedback(null);
    try {
      const nextModels = { ...llmModels, [llmProvider]: selectedModel };
      const res = await fetch('/api/preferences/org-llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inheritPersonal: false,
          provider: llmProvider,
          models: nextModels,
        }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui(`大模型策略保存失败（${res.status}）`, `Failed to save LLM policy (${res.status})`));
      setLlmProvider(data.provider || llmProvider);
      setLlmModels(data.models && typeof data.models === 'object' ? data.models : nextModels);
      setFeedback({ type: 'success', text: ui('公司 Lumi 大模型策略已保存', 'Company Lumi model policy saved') });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
    } finally {
      setLlmSaving(false);
    }
  };

  const handleCreateInvitation = async () => {
    if (!org) return;
    setGenerating(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/org/org/${org.id}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: invitationRole, maxUses: 0 }),
        credentials: 'include',
      });
      const inv = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(inv.error || ui(`邀请码创建失败（${res.status}）`, `Invitation creation failed (${res.status})`));
      setInvitationCode(inv.code || '');
      setFeedback({ type: 'success', text: t.invitationCreated || ui('邀请码已创建', 'Invitation code created') });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
    } finally {
      setGenerating(false);
    }
  };

  const copyCode = async () => {
    if (!invitationCode) return;
    await navigator.clipboard.writeText(invitationCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDelete = async () => {
    if (!org) return;
    const ok = await appConfirm({
      title: ui('删除组织', 'Delete Organization'),
      message: ui('这个操作不可恢复。删除后组织知识库、模板、成员数据都会被移除。确定继续吗？', 'This cannot be undone. Organization knowledge, templates, and member data will be removed. Continue?'),
      confirmText: ui('删除', 'Delete'),
      cancelText: ui('取消', 'Cancel'),
      tone: 'danger',
    });
    if (!ok) return;

    setFeedback(null);
    try {
      const res = await fetch(`/api/org/org/${org.id}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui(`删除失败（${res.status}）`, `Delete failed (${res.status})`));
      setFeedback({ type: 'success', text: t.organizationDeleted || ui('组织已删除', 'Organization deleted') });
      setOrg(null);
      void switchDomain('personal').finally(() => {
        window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'home' } }));
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-white/55">
        <Loader2 size={24} className="animate-spin" />
      </div>
    );
  }

  if (!org) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center text-white/55">
        {feedback && <FeedbackBanner feedback={feedback} />}
        <Building2 size={34} className="text-white/25" />
        <div>{ui('未找到组织，请先创建或切换到工作域。', 'No organization found. Create one or switch to a work domain first.')}</div>
        <button onClick={loadOrg} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/70 hover:bg-white/10">
          {ui('重新加载', 'Reload')}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/65">
              <Settings size={21} />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-white">{t.orgSettings || ui('组织设置', 'Organization Settings')}</h2>
              <p className="mt-1 text-sm text-white/50">
                {ui('管理组织基本信息、成员加入方式和危险操作。', 'Manage organization profile, invitation flow, and destructive actions.')}
              </p>
            </div>
          </div>
        </section>

        {feedback && <FeedbackBanner feedback={feedback} />}

        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="mb-4 flex items-center gap-2">
            <Building2 size={17} className="text-blue-300" />
            <h3 className="text-sm font-medium text-white">{ui('基础信息', 'General')}</h3>
          </div>
          <div className="grid gap-4 md:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="mb-1 block text-xs text-white/50">{ui('组织名称', 'Organization Name')}</span>
              <input
                value={name}
                onChange={event => setName(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-blue-400/40"
              />
            </label>
            <button
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="self-end inline-flex items-center justify-center gap-2 rounded-lg border border-blue-400/20 bg-blue-500/15 px-4 py-2 text-sm font-medium text-blue-100 transition hover:bg-blue-500/25 disabled:opacity-50"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              {ui('保存修改', 'Save Changes')}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-white/45">
            <span className="rounded-md bg-white/5 px-2 py-1">Slug: {org.slug}</span>
            <span className="rounded-md bg-white/5 px-2 py-1">ID: {org.id}</span>
          </div>
        </section>

        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="mb-4 flex items-center gap-2">
            <KeyRound size={17} className="text-emerald-300" />
            <h3 className="text-sm font-medium text-white">{ui('邀请码', 'Invitation Codes')}</h3>
          </div>
          <p className="hidden">
            {ui('生成一个成员加入码，发给需要加入组织的人。当前邀请码不限使用次数。', 'Generate a join code for new members. The current code has unlimited uses.')}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label>
              <span className="mb-1 block text-xs text-white/50">{ui('默认角色', 'Default Role')}</span>
              <select
                value={invitationRole}
                onChange={event => setInvitationRole(event.target.value)}
                className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/75 outline-none"
              >
                <option value="member">{t.orgRoleMember || ui('成员', 'Member')}</option>
                <option value="admin">{t.orgRoleAdmin || ui('管理员', 'Admin')}</option>
                <option value="viewer">{t.orgRoleViewer || ui('查看者', 'Viewer')}</option>
              </select>
            </label>
            <button
              onClick={handleCreateInvitation}
              disabled={generating}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-50"
            >
              {generating ? <Loader2 size={15} className="animate-spin" /> : <Link size={15} />}
              {ui('生成邀请码', 'Generate Code')}
            </button>
          </div>

          {invitationCode && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-400/20 bg-emerald-500/10 p-4"
            >
              <div>
                <p className="text-xs text-white/50">{ui('邀请码', 'Invitation Code')}</p>
                <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.18em] text-emerald-200">{invitationCode}</p>
              </div>
              <button
                onClick={copyCode}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/70 transition hover:bg-white/10"
              >
                {copied ? <CheckCircle size={15} className="text-emerald-300" /> : <Copy size={15} />}
                {copied ? ui('已复制', 'Copied') : ui('复制', 'Copy')}
              </button>
            </motion.div>
          )}
        </section>

        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="mb-4 flex items-center gap-2">
            <BrainCircuit size={17} className="text-blue-300" />
            <h3 className="text-sm font-medium text-white">{ui('公司 Lumi 大模型', 'Company Lumi Model')}</h3>
          </div>
          <p className="mb-4 text-sm leading-6 text-white/50">
            {ui('组织域聊天、语音和子 agent 编排统一使用公司 Lumi 的独立模型策略，不读取任何成员的个人模型偏好。', 'Work-domain chat, voice, and agent orchestration use one independent company policy and never read a member\'s personal model preference.')}
          </p>

          <div className="grid gap-4 md:grid-cols-[220px_1fr_auto]">
            <label className="block">
              <span className="mb-1 block text-xs text-white/50">Provider</span>
              <select
                value={llmProvider}
                onChange={event => {
                  const nextProvider = event.target.value;
                  const option = LLM_PROVIDER_OPTIONS.find(item => item.id === nextProvider) || LLM_PROVIDER_OPTIONS[0];
                  setLlmProvider(nextProvider);
                  setLlmModels(prev => ({ ...prev, [nextProvider]: prev[nextProvider] || option.models[0] || '' }));
                }}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/75 outline-none disabled:cursor-not-allowed"
              >
                {LLM_PROVIDER_OPTIONS.map(option => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-white/50">Model</span>
              <input
                value={selectedModel}
                list="org-llm-models"
                onChange={event => updateLlmModel(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-blue-400/40 disabled:cursor-not-allowed"
              />
              <datalist id="org-llm-models">
                {selectedProviderOption.models.map(model => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </label>
            <button
              onClick={handleSaveOrgLlm}
              disabled={llmSaving || llmLoading}
              className="self-end inline-flex items-center justify-center gap-2 rounded-lg border border-blue-400/20 bg-blue-500/15 px-4 py-2 text-sm font-medium text-blue-100 transition hover:bg-blue-500/25 disabled:opacity-50"
            >
              {llmSaving || llmLoading ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              {ui('保存策略', 'Save Policy')}
            </button>
          </div>
        </section>

        <section className="rounded-lg border border-red-400/15 bg-red-500/5 p-5">
          <div className="mb-3 flex items-center gap-2 text-red-300">
            <Trash2 size={17} />
            <h3 className="text-sm font-medium">{ui('危险操作', 'Danger Zone')}</h3>
          </div>
          <p className="mb-4 text-sm leading-6 text-white/50">
            {ui('删除组织不可恢复。只有明确确认后才会执行。', 'Deleting an organization is irreversible and requires explicit confirmation.')}
          </p>
          <button
            onClick={handleDelete}
            className="rounded-lg border border-red-400/25 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-200 transition hover:bg-red-500/20"
          >
            {ui('删除组织', 'Delete Organization')}
          </button>
        </section>
      </div>
    </div>
  );
}

function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
      feedback.type === 'success'
        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
        : 'border-red-500/20 bg-red-500/10 text-red-200'
    }`}>
      {feedback.type === 'success' ? <CheckCircle size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
      <span>{feedback.text}</span>
    </div>
  );
}
