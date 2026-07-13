import React, { useCallback, useState } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, ArrowLeft, CheckCircle, Loader2, Package, Send } from 'lucide-react';
import { useT } from '../../lib/useT';
import { formatUiMessage, uiMessage } from '../../i18n/uiMessages';

export function TemplateCreator() {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('productivity');
  const [icon, setIcon] = useState('Bot');
  const [configStr, setConfigStr] = useState(JSON.stringify({
    initialPrompt: '',
    personalityId: 'lumi',
    allowedTools: '*',
    memoryPolicy: { retrieveLimit: 10, autoExtract: true },
  }, null, 2));
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const goBack = () => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'templates' } }));

  const handleSubmit = async () => {
    if (!name.trim() || !description.trim()) {
      setError(t.templateRequiredFields || uiMessage('template-creator.name-and-description-are-required.eddc1f9c9f'));
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      let config: any;
      try {
        config = JSON.parse(configStr);
      } catch (err: any) {
        throw new Error(`${t.invalidJSON || uiMessage('template-creator.invalid-json.4a8f882b83')}: ${err.message}`);
      }

      const res = await fetch('/api/org/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), category, config, icon: icon.trim() || 'Bot' }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || formatUiMessage('template-creator.template-create-failed-value0.500c2e837c', { value0: res.status }));

      const submitRes = await fetch(`/api/org/templates/${data.id}/submit`, {
        method: 'POST',
        credentials: 'include',
      });
      const submitData = await submitRes.json().catch(() => ({}));
      if (!submitRes.ok) throw new Error(submitData.error || formatUiMessage('template-creator.template-submit-failed-value0.307766c0b4', { value0: submitRes.status }));
      setDone(true);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-white">
        <div className="w-full max-w-md rounded-lg border border-white/10 bg-white/[0.04] p-6 text-center">
          <motion.div initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
            <CheckCircle size={48} className="mx-auto text-emerald-300" />
          </motion.div>
          <h3 className="mt-4 text-xl font-semibold text-white">{t.templateSubmitted || uiMessage('template-creator.agent-template-submitted.5cf1d0ed15')}</h3>
          <p className="mt-2 text-sm leading-6 text-white/50">
            {t.templatePendingReview || uiMessage('template-creator.your-agent-template-is-pending.15a06f6890')}
          </p>
          <button
            onClick={goBack}
            className="mt-5 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            <ArrowLeft size={16} />
            {t.backToMarketplace || uiMessage('template-creator.back-to-agent-templates.0d44556c9d')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex items-start gap-3">
            <button
              onClick={goBack}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 transition hover:bg-white/10 hover:text-white"
              aria-label={uiMessage('template-creator.back.5db5cac55e')}
            >
              <ArrowLeft size={17} />
            </button>
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-violet-400/20 bg-violet-500/10 text-violet-300">
              <Package size={22} />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-white">{t.submitTemplate || uiMessage('template-creator.submit-agent-template.e19dabf8b3')}</h2>
              <p className="mt-1 text-sm text-white/50">
                {t.templateDesc || uiMessage('template-creator.submit-a-mature-agent-configuration.9f7618547d')}
              </p>
            </div>
          </div>
        </section>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="grid gap-4 md:grid-cols-[1fr_120px]">
            <label>
              <span className="mb-1 block text-xs text-white/50">{t.templateName || uiMessage('template-creator.template-name.343459b148')}</span>
              <input
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder={uiMessage('template-creator.e-g-contract-review-assistant.f73bf8fe28')}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/35 focus:border-violet-400/35"
              />
            </label>
            <label>
              <span className="mb-1 block text-xs text-white/50">{t.iconLabel || 'Icon'}</span>
              <input
                value={icon}
                onChange={event => setIcon(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-center text-sm text-white outline-none focus:border-violet-400/35"
              />
            </label>
          </div>

          <label className="mt-4 block">
            <span className="mb-1 block text-xs text-white/50">{t.briefDescription || uiMessage('template-creator.brief-description.305c599dd8')}</span>
            <input
              value={description}
              onChange={event => setDescription(event.target.value)}
              placeholder={uiMessage('template-creator.describe-what-this-agent-does.d482e85f3d')}
              className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/35 focus:border-violet-400/35"
            />
          </label>

          <label className="mt-4 block">
            <span className="mb-1 block text-xs text-white/50">{uiMessage('template-creator.category.6744e11866')}</span>
            <select
              value={category}
              onChange={event => setCategory(event.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/75 outline-none focus:border-violet-400/35"
            >
              <option value="productivity">{t.categoryProductivity || uiMessage('template-creator.productivity.4514e0830e')}</option>
              <option value="data-analysis">{t.categoryDataAnalysis || uiMessage('template-creator.data-analysis.7f93838089')}</option>
              <option value="customer-support">{t.categoryCustomerSupport || uiMessage('template-creator.customer-support.0fa655031e')}</option>
              <option value="engineering">{t.categoryEngineering || uiMessage('template-creator.engineering.d73b96c6c8')}</option>
              <option value="legal">{uiMessage('template-creator.legal.20218cb84a')}</option>
              <option value="design">{uiMessage('template-creator.design.6c5392efbf')}</option>
              <option value="finance">{uiMessage('template-creator.finance.e8c4c462f6')}</option>
              <option value="hr">{t.categoryHR || 'HR'}</option>
              <option value="sales">{t.categorySales || uiMessage('template-creator.sales.90e639dd41')}</option>
              <option value="creative">{t.categoryCreative || uiMessage('template-creator.creative.9195660fea')}</option>
              <option value="other">{t.categoryOther || uiMessage('template-creator.other.71e98789be')}</option>
            </select>
          </label>
        </section>

        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-white">{t.agentConfigJSON || uiMessage('template-creator.agent-configuration-json.dc265c3377')}</span>
            <span className="text-xs text-white/40">{uiMessage('template-creator.json-is-validated-before-submit.6bc3766995')}</span>
          </div>
          <textarea
            value={configStr}
            onChange={event => setConfigStr(event.target.value)}
            className="h-64 w-full resize-y rounded-lg border border-white/10 bg-black/25 px-3 py-2 font-mono text-xs leading-5 text-white/75 outline-none focus:border-violet-400/35"
          />
        </section>

        <button
          onClick={handleSubmit}
          disabled={submitting || !name.trim() || !description.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-violet-400/20 bg-violet-500/15 px-4 py-3 text-sm font-medium text-violet-100 transition hover:bg-violet-500/25 disabled:opacity-50"
        >
          {submitting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          {t.submitForReview || uiMessage('template-creator.submit-for-review.85f5979c1d')}
        </button>
      </div>
    </div>
  );
}
