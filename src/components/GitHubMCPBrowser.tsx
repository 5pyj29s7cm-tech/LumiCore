import { useState } from 'react';
import { motion } from 'motion/react';
import { Search, Github, Star, ExternalLink, Loader2, Package, Globe, Wrench } from 'lucide-react';

interface MCPSearchResult {
  id: number | string;
  name: string;
  description: string;
  stars: number;
  url: string;
  topics: string[];
  language: string;
  updatedAt: string;
}

type SearchSource = 'github' | 'npm';

const LANGUAGES = ['TypeScript', 'Python', 'JavaScript', 'Go', 'Rust', 'Java'];

export function GitHubMCPBrowser({ t, embedded = false }: { t?: any; embedded?: boolean }) {
  const [source, setSource] = useState<SearchSource>('github');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MCPSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [langFilter, setLangFilter] = useState('');
  const [sortBy, setSortBy] = useState<'stars' | 'relevance'>('stars');

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const endpoint = source === 'github'
        ? `/api/mcp/github/search?q=${encodeURIComponent(query.trim())}`
        : `/api/mcp/npm/search?q=${encodeURIComponent(query.trim())}`;
      const res = await fetch(endpoint);
      const data = await res.json();
      setResults(data.results || []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const changeSource = (s: SearchSource) => {
    setSource(s);
    setResults([]);
    setSearched(false);
    setLangFilter('');
  };

  const filtered = langFilter
    ? results.filter(r => r.language && r.language.toLowerCase() === langFilter.toLowerCase())
    : results;

  const sorted = sortBy === 'stars'
    ? [...filtered].sort((a, b) => b.stars - a.stars)
    : filtered;

  return (
    <div className={`${embedded ? 'min-h-[620px]' : 'h-full bg-zinc-950/60 backdrop-blur-xl'} flex flex-col text-white overflow-y-auto`}>
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-white/5">
        <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center">
          {source === 'github' ? (
            <Github size={20} className="text-purple-400" />
          ) : (
            <Globe size={20} className="text-purple-400" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-white/90">{t?.mcpBrowserTitle || 'MCP Browser'}</h2>
          <p className="text-xs text-white/55">{t?.mcpBrowserDesc || 'Discover external MCP projects for review'}</p>
        </div>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('lumi:client-action', {
            detail: { action: 'open_settings', section: 'mcp' },
          }))}
          className="inline-flex items-center gap-2 rounded-xl border border-purple-400/20 bg-purple-500/10 px-3 py-2 text-xs font-bold text-purple-200 transition-colors hover:bg-purple-500/20"
        >
          <Wrench size={13} />
          {t?.mcpOpenSettings || 'Open MCP Settings'}
        </button>
      </div>

      <div className="flex-1 p-6 space-y-4">
        <div className="rounded-xl border border-amber-400/15 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-100/75">
          {t?.mcpInstallNotice || 'Discovery is read-only. Review the source and permissions, then connect an approved MCP endpoint in Settings or use a curated Lumi candidate; search results are never executed directly.'}
        </div>
        {/* Source tabs */}
        <div className="flex gap-1 p-1 rounded-xl bg-white/5 border border-white/5">
          <button
            onClick={() => changeSource('github')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
              source === 'github'
                ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                : 'text-white/55 hover:text-white/50'
            }`}
          >
            <Github size={12} />
            {t?.mcpSourceGitHub || 'GitHub'}
          </button>
          <button
            onClick={() => changeSource('npm')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
              source === 'npm'
                ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                : 'text-white/55 hover:text-white/50'
            }`}
          >
            <Package size={12} />
            {t?.mcpSourceNpm || 'npm'}
          </button>
        </div>

        {/* Search bar */}
        <div className="flex gap-2">
          <div className="flex-1 flex items-center gap-2 px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl">
            <Search size={14} className="text-white/55" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder={
                source === 'github'
                  ? (t?.mcpSearchGitHub || 'Search GitHub for MCP servers...')
                  : (t?.mcpSearchNpm || 'Search npm for MCP packages...')
              }
              className="flex-1 bg-transparent text-white/80 text-sm outline-none placeholder:text-white/55"
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={loading}
            className="px-4 py-2.5 rounded-xl bg-purple-500/20 border border-purple-500/30 text-purple-300 text-xs font-bold uppercase tracking-wider hover:bg-purple-500/30 transition-all disabled:opacity-40"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : (t?.mcpSearchBtn || 'Search')}
          </button>
        </div>

        {/* Filters — only show when results exist */}
        {searched && results.length > 0 && (
          <div className="flex items-center gap-3">
            {/* Sort toggle */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/45 uppercase tracking-wider">{t?.sortBy || 'Sort'}</span>
              <button
                onClick={() => setSortBy(sortBy === 'stars' ? 'relevance' : 'stars')}
                className="text-xs px-2 py-1 rounded-md bg-white/5 text-white/50 font-bold uppercase hover:bg-white/10 transition-all"
              >
                {sortBy === 'stars' ? (t?.mcpSortStars || 'Stars') : (t?.mcpSortRelevance || 'Relevance')}
              </button>
            </div>

            {/* Language filter — GitHub only */}
            {source === 'github' && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-white/45 uppercase tracking-wider">{t?.mcpFilterLanguage || 'Lang'}</span>
                <select
                  value={langFilter}
                  onChange={e => setLangFilter(e.target.value)}
                  className="text-xs px-2 py-1 rounded-md bg-white/5 text-white/50 font-bold uppercase border border-white/5 outline-none cursor-pointer hover:bg-white/10 transition-all"
                >
                  <option value="">{t?.mcpFilterAllLanguages || 'All'}</option>
                  {LANGUAGES.map(l => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {/* Results */}
        <div className="space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-white/55">
              <Loader2 size={24} className="animate-spin mr-2" /> {t?.mcpSearching || 'Searching...'}
            </div>
          ) : searched && results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-white/45">
              <Package size={40} className="mb-3 opacity-30" />
              <span className="text-xs font-bold uppercase tracking-widest">{t?.mcpNoServersFound || 'No MCP servers found'}</span>
            </div>
          ) : (
            sorted.map(repo => (
              <motion.div
                key={String(repo.id)}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-start gap-3 p-4 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-all"
              >
                <div className="flex-shrink-0 mt-0.5">
                  {source === 'github' ? (
                    <Github size={18} className="text-white/40" />
                  ) : (
                    <Package size={18} className="text-white/40" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-white/80 truncate">{String(repo.name)}</span>
                    {repo.stars > 0 && (
                      <div className="flex items-center gap-1 text-amber-400">
                        <Star size={12} fill="currentColor" />
                        <span className="text-xs font-bold">{repo.stars}</span>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-white/40 mt-1 line-clamp-2">
                    {repo.description || t?.mcpNoDescription || 'No description'}
                  </p>
                  <div className="flex items-center gap-2 mt-2">
                    {repo.language && (
                      <span className="text-xs px-1.5 py-0.5 rounded-md bg-blue-500/10 text-blue-400 font-bold uppercase">
                        {repo.language}
                      </span>
                    )}
                    {repo.topics.slice(0, 3).map(topic => (
                      <span key={topic} className="text-xs px-1.5 py-0.5 rounded-md bg-white/5 text-white/55 font-bold uppercase">
                        {topic}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <a
                    href={repo.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t?.mcpViewOn ? `${t.mcpViewOn} ${source === 'github' ? 'GitHub' : 'npm'}` : `View on ${source}`}
                    className="p-2 rounded-lg text-white/55 hover:text-white/60 hover:bg-white/10 transition-all"
                  >
                    <ExternalLink size={14} />
                  </a>
                </div>
              </motion.div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
