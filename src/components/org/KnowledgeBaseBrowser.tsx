import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  Archive,
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Clock,
  Database,
  FileText,
  Filter,
  Hash,
  Layers,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Tag,
  Upload,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { useT } from '../../lib/useT';

type ArticleStatus = 'draft' | 'published' | 'archived' | string;

interface Article {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string | string[];
  authorId: string;
  status: ArticleStatus;
  viewCount?: number;
  createdAt: string;
  updatedAt?: string;
}

interface SearchResult {
  articleId: string;
  title: string;
  chunk: string;
  score: number;
  source?: 'semantic' | 'keyword';
  category?: string;
  status?: ArticleStatus;
  tags?: string[];
  updatedAt?: string;
}

interface UploadedKnowledgeFile {
  id?: string;
  name?: string;
  displayName?: string;
  orgArticleId?: string;
  ingested?: boolean;
  partial?: boolean;
  syncError?: string;
  extractionStatus?: 'indexed' | 'partial' | 'unsupported' | 'failed';
}

interface KnowledgeStats {
  totalArticles: number;
  publishedArticles: number;
  draftArticles: number;
  archivedArticles: number;
  totalChunks: number;
  indexedArticles: number;
  missingIndexArticles: number;
  staleArticles: number;
  categoryBreakdown: Array<{ category: string; count: number }>;
  statusBreakdown: Array<{ status: string; count: number }>;
  articleHealth: Array<{
    articleId: string;
    chunks: number;
    indexed: boolean;
    stale: boolean;
    updatedAt: string;
    lastIndexedAt: string | null;
  }>;
}

type SortMode = 'updated' | 'title' | 'health';

const CATEGORY_META: Record<string, { zh: string; en: string; className: string }> = {
  general: { zh: '通用', en: 'General', className: 'border-sky-400/20 bg-sky-400/10 text-sky-100' },
  policy: { zh: '制度', en: 'Policy', className: 'border-blue-400/20 bg-blue-400/10 text-blue-100' },
  sop: { zh: 'SOP', en: 'SOP', className: 'border-cyan-400/20 bg-cyan-400/10 text-cyan-100' },
  product: { zh: '产品', en: 'Product', className: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100' },
  culture: { zh: '文化', en: 'Culture', className: 'border-pink-400/20 bg-pink-400/10 text-pink-100' },
  files: { zh: '资料', en: 'Files', className: 'border-indigo-400/20 bg-indigo-400/10 text-indigo-100' },
  hr: { zh: 'HR', en: 'HR', className: 'border-violet-400/20 bg-violet-400/10 text-violet-100' },
  tech: { zh: '技术', en: 'Technical', className: 'border-teal-400/20 bg-teal-400/10 text-teal-100' },
  legal_statute: { zh: '法规', en: 'Statute', className: 'border-amber-400/20 bg-amber-400/10 text-amber-100' },
  legal_judgment: { zh: '判例', en: 'Judgment', className: 'border-orange-400/20 bg-orange-400/10 text-orange-100' },
  legal_contract: { zh: '合同', en: 'Contract', className: 'border-lime-400/20 bg-lime-400/10 text-lime-100' },
};

function parseTags(tags: Article['tags'] | undefined): string[] {
  if (Array.isArray(tags)) return tags.map(tag => String(tag).trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(tags || '[]');
    return Array.isArray(parsed) ? parsed.map(tag => String(tag).trim()).filter(Boolean) : [];
  } catch {
    return String(tags || '').split(',').map(tag => tag.trim()).filter(Boolean);
  }
}

function formatDate(value: string | undefined, isZh: boolean): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString(isZh ? 'zh-CN' : undefined, { month: 'short', day: '2-digit' });
}

function excerpt(value: string, max = 150): string {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max).trim()}...`;
}

function categoryInfo(category: string | undefined, isZh: boolean) {
  const key = category || 'general';
  const meta = CATEGORY_META[key];
  if (meta) return { label: isZh ? meta.zh : meta.en, className: meta.className };
  return { label: key, className: 'border-white/10 bg-white/5 text-white/60' };
}

function statusInfo(status: ArticleStatus | undefined, isZh: boolean) {
  if (status === 'draft') return { label: isZh ? '草稿' : 'Draft', className: 'border-amber-400/20 bg-amber-400/10 text-amber-100' };
  if (status === 'archived') return { label: isZh ? '归档' : 'Archived', className: 'border-white/10 bg-white/5 text-white/50' };
  return { label: isZh ? '已发布' : 'Published', className: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100' };
}

function makeFallbackStats(articles: Article[]): KnowledgeStats {
  const categoryCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  for (const article of articles) {
    categoryCounts.set(article.category || 'general', (categoryCounts.get(article.category || 'general') || 0) + 1);
    statusCounts.set(article.status || 'published', (statusCounts.get(article.status || 'published') || 0) + 1);
  }
  return {
    totalArticles: articles.length,
    publishedArticles: statusCounts.get('published') || 0,
    draftArticles: statusCounts.get('draft') || 0,
    archivedArticles: statusCounts.get('archived') || 0,
    totalChunks: 0,
    indexedArticles: 0,
    missingIndexArticles: articles.length,
    staleArticles: 0,
    categoryBreakdown: [...categoryCounts.entries()].map(([category, count]) => ({ category, count })),
    statusBreakdown: [...statusCounts.entries()].map(([status, count]) => ({ status, count })),
    articleHealth: articles.map(article => ({
      articleId: article.id,
      chunks: 0,
      indexed: false,
      stale: false,
      updatedAt: article.updatedAt || article.createdAt,
      lastIndexedAt: null,
    })),
  };
}

export function KnowledgeBaseBrowser() {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);

  const [articles, setArticles] = useState<Article[]>([]);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortMode, setSortMode] = useState<SortMode>('updated');
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [indexingId, setIndexingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const loadKnowledgeBase = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [articlesRes, statsRes] = await Promise.all([
        fetch('/api/org/kb/articles', { credentials: 'include' }),
        fetch('/api/org/kb/stats', { credentials: 'include' }),
      ]);
      const articleData = await articlesRes.json().catch(() => []);
      if (!articlesRes.ok) throw new Error(articleData.error || ui(`文章加载失败（${articlesRes.status}）`, `Failed to load articles (${articlesRes.status})`));
      const list = Array.isArray(articleData) ? articleData : [];
      setArticles(list);
      setSelectedArticle(prev => {
        if (prev && list.some((item: Article) => item.id === prev.id)) {
          return list.find((item: Article) => item.id === prev.id) || prev;
        }
        return list[0] || null;
      });

      if (statsRes.ok) {
        setStats(await statsRes.json().catch(() => null));
      } else {
        setStats(null);
      }
    } catch (err: any) {
      setError(err.message || String(err));
      setArticles([]);
      setSelectedArticle(null);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [ui]);

  useEffect(() => {
    loadKnowledgeBase();
  }, [loadKnowledgeBase]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch('/api/org/kb/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            limit: 8,
            category: categoryFilter === 'all' ? undefined : categoryFilter,
            status: statusFilter === 'all' ? undefined : statusFilter,
          }),
          credentials: 'include',
          signal: controller.signal,
        });
        const data = await res.json().catch(() => []);
        if (!res.ok) throw new Error(data.error || ui(`搜索失败（${res.status}）`, `Search failed (${res.status})`));
        setSearchResults(Array.isArray(data) ? data : []);
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          setError(err.message || String(err));
          setSearchResults([]);
        }
      } finally {
        setSearching(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [categoryFilter, searchQuery, statusFilter, ui]);

  const effectiveStats = useMemo(() => stats || makeFallbackStats(articles), [articles, stats]);
  const healthById = useMemo(
    () => new Map(effectiveStats.articleHealth.map(item => [item.articleId, item])),
    [effectiveStats],
  );

  const categoryOptions = useMemo(() => {
    const categories = new Set<string>(articles.map(article => article.category || 'general'));
    for (const item of effectiveStats.categoryBreakdown) categories.add(item.category);
    return [...categories].sort((a, b) => {
      const aCount = effectiveStats.categoryBreakdown.find(item => item.category === a)?.count || 0;
      const bCount = effectiveStats.categoryBreakdown.find(item => item.category === b)?.count || 0;
      return bCount - aCount || a.localeCompare(b);
    });
  }, [articles, effectiveStats]);

  const visibleArticles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const hitIds = new Set(searchResults.map(result => result.articleId));
    const filtered = articles.filter(article => {
      if (categoryFilter !== 'all' && article.category !== categoryFilter) return false;
      if (statusFilter !== 'all' && article.status !== statusFilter) return false;
      if (query.length < 2) return true;
      return hitIds.has(article.id)
        || article.title.toLowerCase().includes(query)
        || article.content.toLowerCase().includes(query)
        || article.category.toLowerCase().includes(query)
        || parseTags(article.tags).some(tag => tag.toLowerCase().includes(query));
    });

    return filtered.sort((a, b) => {
      if (sortMode === 'title') return a.title.localeCompare(b.title);
      if (sortMode === 'health') {
        const ah = healthById.get(a.id);
        const bh = healthById.get(b.id);
        const aScore = !ah?.indexed ? 2 : ah.stale ? 1 : 0;
        const bScore = !bh?.indexed ? 2 : bh.stale ? 1 : 0;
        if (aScore !== bScore) return bScore - aScore;
      }
      return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
    });
  }, [articles, categoryFilter, healthById, searchQuery, searchResults, sortMode, statusFilter]);

  const selectedHealth = selectedArticle ? healthById.get(selectedArticle.id) : null;
  const selectedTags = selectedArticle ? parseTags(selectedArticle.tags) : [];
  const maintenanceQueue = useMemo(() => {
    return articles
      .filter(article => {
        const health = healthById.get(article.id);
        return !health?.indexed || health.stale;
      })
      .slice(0, 5);
  }, [articles, healthById]);

  const goNew = () => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'kb-edit' } }));
  const goEdit = (articleId: string) => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'kb-edit', articleId } }));

  const handleImportFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length === 0) return;

    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      selectedFiles.forEach(file => formData.append('files', file));

      const res = await fetch('/api/files/upload?domain=work', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || ui(`导入失败（${res.status}）`, `Import failed (${res.status})`));
      }

      const uploadedFiles = Array.isArray(data.files) ? data.files as UploadedKnowledgeFile[] : [];
      const syncedCount = uploadedFiles.filter(file => file.ingested || file.orgArticleId).length;
      const partialCount = uploadedFiles.filter(file => file.partial || file.extractionStatus === 'partial').length;
      const failedCount = uploadedFiles.filter(file => file.syncError).length;
      const totalCount = uploadedFiles.length || selectedFiles.length;

      toast.success(ui(
        `已导入 ${totalCount} 个文件${syncedCount ? `，同步 ${syncedCount} 篇知识` : ''}${partialCount ? `，部分吸收 ${partialCount} 个` : ''}${failedCount ? `，${failedCount} 个待处理` : ''}`,
        `Imported ${totalCount} file(s)${syncedCount ? `, synced ${syncedCount} article(s)` : ''}${partialCount ? `, ${partialCount} partial` : ''}${failedCount ? `, ${failedCount} pending` : ''}`,
      ));
      window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', {
        detail: {
          domain: 'work',
          files: uploadedFiles.map(file => ({ id: file.id, name: file.name, displayName: file.displayName })),
        },
      }));
      window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));

      await loadKnowledgeBase();
      const firstArticleId = uploadedFiles.find(file => file.orgArticleId)?.orgArticleId;
      if (firstArticleId) {
        const articleRes = await fetch(`/api/org/kb/articles/${firstArticleId}`, { credentials: 'include' });
        if (articleRes.ok) {
          setSelectedArticle(await articleRes.json());
        }
      }
    } catch (err: any) {
      const message = err.message || String(err);
      setError(message);
      toast.error(message || ui('导入失败', 'Import failed'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleReindex = async (articleId: string) => {
    setIndexingId(articleId);
    try {
      const res = await fetch(`/api/org/kb/articles/${articleId}/index`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui('索引失败', 'Indexing failed'));
      toast.success(ui(`已更新索引：${data.indexedChunks || 0} 个分块`, `Index updated: ${data.indexedChunks || 0} chunks`));
      await loadKnowledgeBase();
    } catch (err: any) {
      toast.error(err.message || ui('索引失败', 'Indexing failed'));
    } finally {
      setIndexingId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-5 text-white">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <BookOpen size={21} className="text-blue-300" />
            {t.orgKB || ui('组织知识库', 'Knowledge Base')}
          </h2>
          <p className="mt-1 text-sm text-white/50">
            {ui('集中管理制度、项目资料、上传文件和团队经验，供组织 Lumi 检索调用。', 'Manage policies, project files, uploads, and team knowledge for organization Lumi.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleImportFiles}
            className="hidden"
          />
          <button
            onClick={loadKnowledgeBase}
            disabled={loading}
            className="lumi-icon-button"
            title={ui('刷新', 'Refresh')}
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="lumi-button border-emerald-400/20 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20"
          >
            {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
            {ui('导入资料', 'Import Files')}
          </button>
          <button
            onClick={goNew}
            className="lumi-button-primary border-blue-400/25 bg-blue-500/15 text-blue-100 hover:bg-blue-500/25"
          >
            <Plus size={15} />
            {ui('新建文章', 'New Article')}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric icon={<FileText size={16} />} label={ui('文章', 'Articles')} value={effectiveStats.totalArticles} tone="text-blue-200" />
        <Metric icon={<Database size={16} />} label={ui('索引分块', 'Indexed Chunks')} value={effectiveStats.totalChunks} tone="text-emerald-200" />
        <Metric icon={<CheckCircle2 size={16} />} label={ui('已发布', 'Published')} value={effectiveStats.publishedArticles} tone="text-cyan-200" />
        <Metric icon={<AlertCircle size={16} />} label={ui('待维护', 'Needs Care')} value={effectiveStats.missingIndexArticles + effectiveStats.staleArticles} tone="text-amber-200" />
      </div>

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[380px_minmax(0,1fr)_280px]">
        <section className="lumi-panel flex min-h-[420px] flex-col overflow-hidden rounded-lg">
          <div className="space-y-3 border-b border-white/[0.08] p-3">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/45" />
              <input
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder={ui('搜索标题、标签、正文...', 'Search title, tags, content...')}
                className="w-full rounded-lg border border-white/10 bg-black/20 py-2 pl-9 pr-9 text-sm text-white outline-none placeholder:text-white/35 focus:border-blue-400/35"
              />
              {searching && <Loader2 size={15} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-white/50" />}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <select
                value={categoryFilter}
                onChange={event => setCategoryFilter(event.target.value)}
                className="lumi-field h-9 rounded-lg py-0 text-xs"
              >
                <option value="all">{ui('全部分类', 'All Categories')}</option>
                {categoryOptions.map(category => (
                  <option key={category} value={category}>{categoryInfo(category, isZh).label}</option>
                ))}
              </select>
              <select
                value={statusFilter}
                onChange={event => setStatusFilter(event.target.value)}
                className="lumi-field h-9 rounded-lg py-0 text-xs"
              >
                <option value="all">{ui('全部状态', 'All Status')}</option>
                <option value="published">{ui('已发布', 'Published')}</option>
                <option value="draft">{ui('草稿', 'Draft')}</option>
                <option value="archived">{ui('归档', 'Archived')}</option>
              </select>
              <select
                value={sortMode}
                onChange={event => setSortMode(event.target.value as SortMode)}
                className="lumi-field h-9 rounded-lg py-0 text-xs"
              >
                <option value="updated">{ui('最近更新', 'Recent')}</option>
                <option value="health">{ui('维护优先', 'Care First')}</option>
                <option value="title">{ui('标题排序', 'Title')}</option>
              </select>
            </div>
          </div>

          <AnimatePresence>
            {searchResults.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="border-b border-blue-400/10 bg-blue-500/5"
              >
                <div className="space-y-1 p-3">
                  <p className="flex items-center gap-1.5 text-xs text-blue-100/70">
                    <Zap size={12} />
                    {ui('检索命中', 'Search Matches')}
                  </p>
                  {searchResults.slice(0, 3).map((result, index) => (
                    <button
                      key={`${result.articleId}-${index}`}
                      onClick={() => {
                        const article = articles.find(item => item.id === result.articleId);
                        if (article) setSelectedArticle(article);
                      }}
                      className="w-full rounded-lg px-2 py-2 text-left transition hover:bg-white/5"
                    >
                      <span className="flex items-center gap-2 truncate text-xs font-medium text-white/85">
                        {result.title}
                        <span className="shrink-0 rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] text-white/40">
                          {result.source === 'semantic' ? ui('语义', 'Semantic') : ui('关键词', 'Keyword')}
                        </span>
                      </span>
                      <span className="mt-1 line-clamp-2 block text-xs leading-5 text-white/45">{result.chunk}</span>
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
            {loading ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-white/50">
                <Loader2 size={22} className="animate-spin" />
                <span>{ui('正在加载文章...', 'Loading articles...')}</span>
              </div>
            ) : visibleArticles.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-white/45">
                <FileText size={30} className="text-white/20" />
                <span>{ui('没有符合条件的组织资料', 'No matching organization knowledge')}</span>
              </div>
            ) : (
              visibleArticles.map(article => {
                const active = selectedArticle?.id === article.id;
                const health = healthById.get(article.id);
                const category = categoryInfo(article.category, isZh);
                const status = statusInfo(article.status, isZh);
                return (
                  <button
                    key={article.id}
                    onClick={() => setSelectedArticle(article)}
                    className={`mb-2 w-full rounded-lg border p-3 text-left transition ${
                      active
                        ? 'border-blue-400/30 bg-blue-500/10'
                        : 'border-white/5 bg-white/[0.03] hover:border-white/10 hover:bg-white/[0.06]'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">{article.title}</p>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/45">{excerpt(article.content, 110)}</p>
                      </div>
                      <ChevronRight size={14} className="mt-1 shrink-0 text-white/35" />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className={`rounded-md border px-2 py-1 text-xs ${category.className}`}>{category.label}</span>
                      <span className={`rounded-md border px-2 py-1 text-xs ${status.className}`}>{status.label}</span>
                      <HealthBadge health={health} isZh={isZh} />
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <section className="lumi-panel min-h-0 overflow-hidden rounded-lg">
          {selectedArticle ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.08] p-5">
                <div className="min-w-0 flex-1">
                  <h3 className="text-lg font-semibold leading-7 text-white">{selectedArticle.title}</h3>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-white/45">
                    <span className={`rounded-md border px-2 py-1 ${categoryInfo(selectedArticle.category, isZh).className}`}>
                      {categoryInfo(selectedArticle.category, isZh).label}
                    </span>
                    <span className={`rounded-md border px-2 py-1 ${statusInfo(selectedArticle.status, isZh).className}`}>
                      {statusInfo(selectedArticle.status, isZh).label}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock size={12} />
                      {formatDate(selectedArticle.updatedAt || selectedArticle.createdAt, isZh)}
                    </span>
                    {selectedHealth && (
                      <span className="inline-flex items-center gap-1">
                        <Database size={12} />
                        {selectedHealth.chunks} {ui('分块', 'chunks')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => handleReindex(selectedArticle.id)}
                    disabled={indexingId === selectedArticle.id}
                    className="lumi-button"
                  >
                    {indexingId === selectedArticle.id ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    {ui('重建索引', 'Reindex')}
                  </button>
                  <button
                    onClick={() => goEdit(selectedArticle.id)}
                    className="lumi-button"
                  >
                    <Pencil size={14} />
                    {ui('编辑', 'Edit')}
                  </button>
                </div>
              </div>

              <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
                <div className="mb-4 flex flex-wrap gap-2">
                  {selectedTags.length > 0 ? selectedTags.map(tag => (
                    <span key={tag} className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/55">
                      <Tag size={10} />
                      {tag}
                    </span>
                  )) : (
                    <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/35">
                      <Hash size={10} />
                      {ui('无标签', 'No tags')}
                    </span>
                  )}
                </div>
                <article className="whitespace-pre-wrap text-sm leading-7 text-white/75">
                  {selectedArticle.content}
                </article>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-white/45">
              <BookOpen size={34} className="text-white/20" />
              <p className="text-sm">{ui('选择一篇文章查看详情，或新建组织知识。', 'Select an article to view details, or create organization knowledge.')}</p>
              <button
                onClick={goNew}
                className="lumi-button-primary border-blue-400/25 bg-blue-500/15 text-blue-100 hover:bg-blue-500/25"
              >
                <Plus size={15} />
                {ui('新建文章', 'New Article')}
              </button>
            </div>
          )}
        </section>

        <aside className="hidden min-h-0 flex-col gap-4 xl:flex">
          <section className="lumi-panel rounded-lg p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white/85">
              <BarChart3 size={16} className="text-cyan-300" />
              {ui('知识体系', 'Knowledge System')}
            </h3>
            <div className="mt-4 space-y-3">
              {effectiveStats.categoryBreakdown.length === 0 ? (
                <p className="text-xs text-white/35">{ui('暂无分类', 'No categories')}</p>
              ) : effectiveStats.categoryBreakdown.slice(0, 8).map(item => {
                const info = categoryInfo(item.category, isZh);
                return (
                  <div key={item.category} className="flex items-center justify-between gap-3 text-xs">
                    <span className={`inline-flex min-w-0 items-center gap-1 rounded-md border px-2 py-1 ${info.className}`}>
                      <Layers size={10} />
                      <span className="truncate">{info.label}</span>
                    </span>
                    <span className="text-white/45">{item.count}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="lumi-panel rounded-lg p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white/85">
              <Filter size={16} className="text-emerald-300" />
              {ui('状态分布', 'Status')}
            </h3>
            <div className="mt-4 grid gap-2">
              <StatusLine icon={<CheckCircle2 size={13} />} label={ui('已发布', 'Published')} value={effectiveStats.publishedArticles} />
              <StatusLine icon={<FileText size={13} />} label={ui('草稿', 'Draft')} value={effectiveStats.draftArticles} />
              <StatusLine icon={<Archive size={13} />} label={ui('归档', 'Archived')} value={effectiveStats.archivedArticles} />
            </div>
          </section>

          <section className="lumi-panel min-h-0 rounded-lg p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white/85">
              <AlertCircle size={16} className="text-amber-300" />
              {ui('维护队列', 'Care Queue')}
            </h3>
            <div className="custom-scrollbar mt-4 max-h-[260px] space-y-2 overflow-y-auto pr-1">
              {maintenanceQueue.length === 0 ? (
                <div className="rounded-lg border border-emerald-400/15 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-100/75">
                  {ui('索引状态良好', 'Index health is good')}
                </div>
              ) : maintenanceQueue.map(article => {
                const health = healthById.get(article.id);
                return (
                  <button
                    key={article.id}
                    onClick={() => setSelectedArticle(article)}
                    className="w-full rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-left transition hover:bg-white/[0.06]"
                  >
                    <span className="line-clamp-1 text-xs font-medium text-white/75">{article.title}</span>
                    <span className="mt-1 block text-[11px] text-amber-100/60">
                      {!health?.indexed ? ui('待索引', 'Needs index') : ui('索引过期', 'Stale index')}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Metric({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: string }) {
  return (
    <div className="lumi-panel rounded-lg px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 ${tone}`}>
          {icon}
        </span>
        <span className="text-2xl font-semibold text-white">{value}</span>
      </div>
      <p className="mt-2 text-xs text-white/45">{label}</p>
    </div>
  );
}

function HealthBadge({ health, isZh }: { health?: KnowledgeStats['articleHealth'][number]; isZh: boolean }) {
  if (!health?.indexed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-xs text-amber-100">
        <AlertCircle size={10} />
        {isZh ? '待索引' : 'Needs index'}
      </span>
    );
  }
  if (health.stale) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-orange-400/20 bg-orange-400/10 px-2 py-1 text-xs text-orange-100">
        <RefreshCw size={10} />
        {isZh ? '需更新' : 'Stale'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-xs text-emerald-100">
      <CheckCircle2 size={10} />
      {health.chunks} {isZh ? '分块' : 'chunks'}
    </span>
  );
}

function StatusLine({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs">
      <span className="flex min-w-0 items-center gap-2 text-white/60">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="font-medium text-white/80">{value}</span>
    </div>
  );
}
