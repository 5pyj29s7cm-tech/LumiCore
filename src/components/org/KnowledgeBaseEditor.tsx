import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  CheckCircle,
  FileText,
  Hash,
  Loader2,
  Save,
  Tag,
} from 'lucide-react';
import { toast } from 'sonner';
import { useT } from '../../lib/useT';
import { formatUiMessage, uiMessage } from '../../i18n/uiMessages';
import { knowledgeCategoryLabels } from '../../i18n/locales/knowledgeCategories';

interface Props {
  articleId?: string;
  onSaved?: () => void;
}

type ArticleStatus = 'draft' | 'published' | 'archived';
type EditorMode = 'write' | 'preview';

const CATEGORY_OPTIONS = ['general', 'policy', 'sop', 'product', 'culture', 'hr', 'tech', 'legal_statute', 'legal_judgment', 'legal_contract'] as const;

function parseTags(tags: unknown): string {
  if (Array.isArray(tags)) return tags.map(tag => String(tag).trim()).filter(Boolean).join(', ');
  if (typeof tags !== 'string') return '';
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.map(tag => String(tag).trim()).filter(Boolean).join(', ') : '';
  } catch {
    return tags;
  }
}

function normalizeTags(tags: string): string[] {
  return [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))].slice(0, 20);
}

export function KnowledgeBaseEditor({ articleId, onSaved }: Props) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const categoryLabels = knowledgeCategoryLabels(isZh ? 'zh' : 'en');

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('general');
  const [tags, setTags] = useState('');
  const [status, setStatus] = useState<ArticleStatus>('draft');
  const [mode, setMode] = useState<EditorMode>('write');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError('');
    setSuccess('');
    setMode('write');

    if (!articleId) {
      setTitle('');
      setContent('');
      setCategory('general');
      setTags('');
      setStatus('draft');
      return;
    }

    setLoading(true);
    fetch(`/api/org/kb/articles/${articleId}`, { credentials: 'include' })
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || formatUiMessage('knowledge-base-editor.failed-to-load-article-value0.3e0ca7ca0a', { value0: response.status }));
        return data;
      })
      .then(article => {
        if (cancelled) return;
        setTitle(article.title || '');
        setContent(article.content || '');
        setCategory(article.category || 'general');
        setStatus(article.status || 'draft');
        setTags(parseTags(article.tags));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err.message || String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [articleId]);

  const tagArr = useMemo(() => normalizeTags(tags), [tags]);
  const contentStats = useMemo(() => {
    const compact = content.trim();
    return {
      chars: compact.length,
      lines: compact ? compact.split(/\r?\n/).length : 0,
      tags: tagArr.length,
    };
  }, [content, tagArr.length]);

  const canSave = title.trim().length > 0 && content.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!title.trim() || !content.trim()) {
      setError(t.articleRequiredFields || uiMessage('knowledge-base-editor.title-and-content-are-required.1d77215b5b'));
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const url = articleId
        ? `/api/org/kb/articles/${articleId}`
        : '/api/org/kb/articles';
      const method = articleId ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          content: content.trim(),
          category,
          tags: tagArr,
          status,
        }),
        credentials: 'include',
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || formatUiMessage('knowledge-base-editor.save-failed-value0.5559bb34d3', { value0: res.status }));

      const message = articleId ? uiMessage('knowledge-base-editor.article-updated.5819b5763c') : uiMessage('knowledge-base-editor.article-created.2296ddaedd');
      setSuccess(message);
      toast.success(message);
      window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', {
        detail: { domain: 'work', source: 'organization-knowledge-editor', articleId: data?.id || articleId || '' },
      }));
      if (!articleId) {
        setTitle('');
        setContent('');
        setTags('');
        setStatus('draft');
      }
      window.setTimeout(() => onSaved?.(), 350);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const goBack = () => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'kb' } }));

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-white/55">
        <div className="flex items-center gap-2">
          <Loader2 size={22} className="animate-spin" />
          <span className="text-sm">{uiMessage('knowledge-base-editor.loading-article.8737ceeadf')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-5 text-white">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <FileText size={21} className="text-blue-300" />
            {articleId ? (t.editArticle || uiMessage('knowledge-base-editor.edit-article.01a78fcb76')) : (t.newArticle || uiMessage('knowledge-base-editor.new-article.0cbe692130'))}
          </h2>
          <p className="mt-1 text-sm text-white/50">
            {uiMessage('knowledge-base-editor.use-structured-metadata-so-knowledge.192e0c582d')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={goBack} className="lumi-button">
            <ArrowLeft size={15} />
            {t.backToKB || uiMessage('knowledge-base-editor.back-to-kb.0b5bd55d07')}
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="lumi-button-primary border-blue-400/25 bg-blue-500/15 text-blue-100 hover:bg-blue-500/25"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {articleId ? (t.updateArticle || uiMessage('knowledge-base-editor.update-article.59aaca729e')) : (t.createArticle || uiMessage('knowledge-base-editor.create-article.1a1ccbb8b7'))}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          <CheckCircle size={16} className="mt-0.5 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="lumi-panel overflow-hidden rounded-lg">
          <div className="grid gap-3 border-b border-white/[0.08] p-4 lg:grid-cols-[minmax(0,1fr)_180px_160px]">
            <input
              value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder={t.articleTitle || uiMessage('knowledge-base-editor.article-title.1ea50f4916')}
              className="lumi-field min-w-0 rounded-lg focus:border-blue-500/40"
            />
            <select
              value={category}
              onChange={event => setCategory(event.target.value)}
              className="lumi-field rounded-lg text-sm text-white/70"
            >
              {CATEGORY_OPTIONS.map(option => (
                <option key={option} value={option}>{categoryLabels[option]}</option>
              ))}
            </select>
            <select
              value={status}
              onChange={event => setStatus(event.target.value as ArticleStatus)}
              className="lumi-field rounded-lg text-sm text-white/70"
            >
              <option value="draft">{t.draftStatus || uiMessage('knowledge-base-editor.draft.ce895273c0')}</option>
              <option value="published">{t.publishedStatus || uiMessage('knowledge-base-editor.published.e9a862a45d')}</option>
              <option value="archived">{uiMessage('knowledge-base-editor.archived.fafdfe8103')}</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.08] p-4">
            <Tag size={14} className="text-white/55" />
            <input
              value={tags}
              onChange={event => setTags(event.target.value)}
              placeholder={t.tagsCommaSeparated || uiMessage('knowledge-base-editor.tags-comma-separated.e09c0eadb6')}
              className="lumi-field min-w-[220px] flex-1 rounded-lg text-sm focus:border-blue-500/40"
            />
            <div className="flex rounded-lg border border-white/10 bg-black/20 p-1">
              <button
                type="button"
                onClick={() => setMode('write')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${mode === 'write' ? 'bg-blue-500/20 text-blue-100' : 'text-white/45 hover:text-white/70'}`}
              >
                {uiMessage('knowledge-base-editor.write.fff77046e9')}
              </button>
              <button
                type="button"
                onClick={() => setMode('preview')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${mode === 'preview' ? 'bg-blue-500/20 text-blue-100' : 'text-white/45 hover:text-white/70'}`}
              >
                {uiMessage('knowledge-base-editor.preview.68dd3b5daf')}
              </button>
            </div>
          </div>

          <div className="p-4">
            {mode === 'write' ? (
              <textarea
                value={content}
                onChange={event => setContent(event.target.value)}
                placeholder={t.writeArticleContent || uiMessage('knowledge-base-editor.write-your-article-content-here.d0a41d63d6')}
                className="lumi-field h-[460px] w-full resize-y rounded-lg font-mono text-sm leading-6 focus:border-blue-500/40"
              />
            ) : (
              <article className="custom-scrollbar h-[460px] overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-4 text-sm leading-7 text-white/75 whitespace-pre-wrap">
                {content.trim() || uiMessage('knowledge-base-editor.no-content-yet.e1ece23432')}
              </article>
            )}
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <section className="lumi-panel rounded-lg p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white/85">
              <Hash size={16} className="text-cyan-300" />
              {uiMessage('knowledge-base-editor.metadata.63f8e535e5')}
            </h3>
            <div className="mt-4 grid gap-2 text-xs">
              <MetaLine label={uiMessage('knowledge-base-editor.characters.e408251069')} value={contentStats.chars} />
              <MetaLine label={uiMessage('knowledge-base-editor.lines.e439eb5cc8')} value={contentStats.lines} />
              <MetaLine label={uiMessage('knowledge-base-editor.tags.33e9c4d112')} value={contentStats.tags} />
            </div>
          </section>

          <section className="lumi-panel rounded-lg p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white/85">
              <BookOpen size={16} className="text-emerald-300" />
              {uiMessage('knowledge-base-editor.publish-check.b76f55a2a5')}
            </h3>
            <div className="mt-4 space-y-2">
              <CheckLine ok={title.trim().length > 0} label={uiMessage('knowledge-base-editor.title-present.0bd1a78233')} />
              <CheckLine ok={content.trim().length > 0} label={uiMessage('knowledge-base-editor.content-present.bd51bc55a9')} />
              <CheckLine ok={category.trim().length > 0} label={uiMessage('knowledge-base-editor.category-selected.a8ceaa38d6')} />
              <CheckLine ok={tagArr.length > 0} label={uiMessage('knowledge-base-editor.at-least-one-tag.e5b670d3d1')} />
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function MetaLine({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2">
      <span className="text-white/45">{label}</span>
      <span className="font-medium text-white/80">{value}</span>
    </div>
  );
}

function CheckLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs">
      {ok ? <CheckCircle size={14} className="text-emerald-300" /> : <AlertCircle size={14} className="text-amber-300" />}
      <span className={ok ? 'text-white/70' : 'text-white/45'}>{label}</span>
    </div>
  );
}
