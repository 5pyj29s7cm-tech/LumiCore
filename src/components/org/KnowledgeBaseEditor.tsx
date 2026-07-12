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

interface Props {
  articleId?: string;
  onSaved?: () => void;
}

type ArticleStatus = 'draft' | 'published' | 'archived';
type EditorMode = 'write' | 'preview';

const CATEGORY_OPTIONS = [
  { value: 'general', zh: '通用', en: 'General' },
  { value: 'policy', zh: '制度', en: 'Policy' },
  { value: 'sop', zh: 'SOP', en: 'SOP' },
  { value: 'product', zh: '产品', en: 'Product' },
  { value: 'culture', zh: '文化', en: 'Culture' },
  { value: 'hr', zh: 'HR', en: 'HR' },
  { value: 'tech', zh: '技术', en: 'Technical' },
  { value: 'legal_statute', zh: '法规', en: 'Statute' },
  { value: 'legal_judgment', zh: '判例', en: 'Judgment' },
  { value: 'legal_contract', zh: '合同', en: 'Contract' },
];

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
        if (!response.ok) throw new Error(data.error || ui(`文章加载失败（${response.status}）`, `Failed to load article (${response.status})`));
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
      setError(t.articleRequiredFields || ui('标题和正文不能为空', 'Title and content are required'));
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
      if (!res.ok) throw new Error(data.error || ui(`保存失败（${res.status}）`, `Save failed (${res.status})`));

      const message = articleId ? ui('文章已更新', 'Article updated') : ui('文章已创建', 'Article created');
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
          <span className="text-sm">{ui('正在加载文章...', 'Loading article...')}</span>
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
            {articleId ? (t.editArticle || ui('编辑文章', 'Edit Article')) : (t.newArticle || ui('新建文章', 'New Article'))}
          </h2>
          <p className="mt-1 text-sm text-white/50">
            {ui('用结构化元数据让资料更容易被检索、引用和维护。', 'Use structured metadata so knowledge is easier to retrieve, cite, and maintain.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={goBack} className="lumi-button">
            <ArrowLeft size={15} />
            {t.backToKB || ui('返回知识库', 'Back to KB')}
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="lumi-button-primary border-blue-400/25 bg-blue-500/15 text-blue-100 hover:bg-blue-500/25"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {articleId ? (t.updateArticle || ui('更新文章', 'Update Article')) : (t.createArticle || ui('创建文章', 'Create Article'))}
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
              placeholder={t.articleTitle || ui('文章标题...', 'Article title...')}
              className="lumi-field min-w-0 rounded-lg focus:border-blue-500/40"
            />
            <select
              value={category}
              onChange={event => setCategory(event.target.value)}
              className="lumi-field rounded-lg text-sm text-white/70"
            >
              {CATEGORY_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{isZh ? option.zh : option.en}</option>
              ))}
            </select>
            <select
              value={status}
              onChange={event => setStatus(event.target.value as ArticleStatus)}
              className="lumi-field rounded-lg text-sm text-white/70"
            >
              <option value="draft">{t.draftStatus || ui('草稿', 'Draft')}</option>
              <option value="published">{t.publishedStatus || ui('已发布', 'Published')}</option>
              <option value="archived">{ui('归档', 'Archived')}</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.08] p-4">
            <Tag size={14} className="text-white/55" />
            <input
              value={tags}
              onChange={event => setTags(event.target.value)}
              placeholder={t.tagsCommaSeparated || ui('标签，用逗号分隔', 'Tags, comma separated')}
              className="lumi-field min-w-[220px] flex-1 rounded-lg text-sm focus:border-blue-500/40"
            />
            <div className="flex rounded-lg border border-white/10 bg-black/20 p-1">
              <button
                type="button"
                onClick={() => setMode('write')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${mode === 'write' ? 'bg-blue-500/20 text-blue-100' : 'text-white/45 hover:text-white/70'}`}
              >
                {ui('编写', 'Write')}
              </button>
              <button
                type="button"
                onClick={() => setMode('preview')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${mode === 'preview' ? 'bg-blue-500/20 text-blue-100' : 'text-white/45 hover:text-white/70'}`}
              >
                {ui('预览', 'Preview')}
              </button>
            </div>
          </div>

          <div className="p-4">
            {mode === 'write' ? (
              <textarea
                value={content}
                onChange={event => setContent(event.target.value)}
                placeholder={t.writeArticleContent || ui('在这里编写文章内容，支持 Markdown。', 'Write your article content here. Markdown is supported.')}
                className="lumi-field h-[460px] w-full resize-y rounded-lg font-mono text-sm leading-6 focus:border-blue-500/40"
              />
            ) : (
              <article className="custom-scrollbar h-[460px] overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-4 text-sm leading-7 text-white/75 whitespace-pre-wrap">
                {content.trim() || ui('暂无内容', 'No content yet')}
              </article>
            )}
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <section className="lumi-panel rounded-lg p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white/85">
              <Hash size={16} className="text-cyan-300" />
              {ui('元数据', 'Metadata')}
            </h3>
            <div className="mt-4 grid gap-2 text-xs">
              <MetaLine label={ui('字符', 'Characters')} value={contentStats.chars} />
              <MetaLine label={ui('行数', 'Lines')} value={contentStats.lines} />
              <MetaLine label={ui('标签', 'Tags')} value={contentStats.tags} />
            </div>
          </section>

          <section className="lumi-panel rounded-lg p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white/85">
              <BookOpen size={16} className="text-emerald-300" />
              {ui('发布检查', 'Publish Check')}
            </h3>
            <div className="mt-4 space-y-2">
              <CheckLine ok={title.trim().length > 0} label={ui('标题已填写', 'Title present')} />
              <CheckLine ok={content.trim().length > 0} label={ui('正文已填写', 'Content present')} />
              <CheckLine ok={category.trim().length > 0} label={ui('分类已选择', 'Category selected')} />
              <CheckLine ok={tagArr.length > 0} label={ui('至少一个标签', 'At least one tag')} />
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
