import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useT } from '../lib/useT';
import { X, Trash2, Edit3, Brain, Shield, ShieldOff, File, Clock, Layers, Sparkles, CheckCircle2, Loader2, MessageSquare, Eye, EyeOff, FileText, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';

interface FileEntry {
  id: string;
  name: string;
  displayName?: string;
  path?: string;
  domain?: 'personal' | 'work';
  orgId?: string;
  size?: string;
  rawSize?: number;
  source?: 'upload' | 'generated' | 'ingested' | 'obsidian';
  agentIds?: string[];
  status?: 'ready' | 'indexing' | 'indexed' | 'partial' | 'unsupported' | 'failed';
  extractionStatus?: 'indexed' | 'partial' | 'unsupported' | 'failed';
  extractionMethod?: string;
  extractionWarning?: string;
  extractionError?: string;
  extractionProvider?: string;
  extractionModel?: string;
  contentChars?: number;
  sourceTitle?: string;
  sourceAliases?: string[];
  sourceTags?: string[];
  sourceLinks?: string[];
  sourceBacklinks?: string[];
  sourceProperties?: Record<string, unknown>;
  obsidianVaultId?: string;
  obsidianVaultName?: string;
  obsidianVaultPath?: string;
  obsidianRelativePath?: string;
  obsidianSourcePath?: string;
  updatedAt?: string;
  createdAt?: string;
}

interface Memory {
  id: string;
  userId?: string;
  type?: 'preference' | 'fact' | 'habit' | 'knowledge';
  content: string;
  keywords?: string[];
  confidence?: number;
  tier?: 'episodic' | 'internalized' | 'growth' | 'core_identity';
  perspective?: string;
  importance?: number;
  nodeType?: 'branch' | 'leaf';
  createdAt?: string;
  updatedAt?: string;
  lastRetrievedAt?: string | null;
  retrieveCount?: number;
  parentId?: string | null;
}

interface ConversationData {
  id: string;
  title: string;
  status: string;
  summary: string;
  messageCount: number;
  lastActiveAt: string;
  createdAt: string;
}

interface NodeDetailPanelProps {
  node: {
    id: string;
    type: 'file' | 'memory' | 'branch' | 'conversation';
    title: string;
    hue: number;
    fileData?: FileEntry;
    memoryData?: Memory;
    conversationData?: ConversationData;
    isCore?: boolean;
    isBranch?: boolean;
  } | null;
  position?: { x: number; y: number } | null;
  onClose: () => void;
  onDelete: (id: string) => void;
  onIngest?: (id: string) => void;
  onToggleProtect?: (id: string) => void;
  onChangeTier?: (id: string, tier: string, confirmed?: boolean) => void;
  onEdit?: (id: string, content: string) => void;
}

const TIER_LABELS: Record<string, string> = {
  core_identity: 'Core Identity',
  growth: 'Growth',
  internalized: 'Internalized',
  episodic: 'Episodic',
};

const TIER_HUES: Record<string, number> = {
  core_identity: 42,
  growth: 150,
  internalized: 195,
  episodic: 260,
};

export function NodeDetailPanel({
  node,
  position,
  onClose,
  onDelete,
  onIngest,
  onToggleProtect,
  onChangeTier,
  onEdit,
}: NodeDetailPanelProps) {
  const t = useT();
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewMediaUrl, setPreviewMediaUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const fileName = node?.type === 'file' ? node.fileData?.displayName || node.fileData?.name || node.title : '';
  const imageExts = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
  const audioExts = /\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i;
  const videoExts = /\.(mp4|mov|avi|webm|mkv)$/i;
  const pdfExts = /\.pdf$/i;
  const textFileExts = /\.(txt|md|json|csv|log|xml|yaml|yml|ts|tsx|js|jsx|py|html|css|env|toml|ini|cfg)$/i;

  const isImageFile = imageExts.test(fileName);
  const isAudioFile = audioExts.test(fileName);
  const isVideoFile = videoExts.test(fileName);
  const isPdfFile = pdfExts.test(fileName);
  const isTextFile = textFileExts.test(fileName);
  const isPreviewable = isImageFile || isAudioFile || isVideoFile || isPdfFile || isTextFile;

  const fileUrl = (path: string, extraQuery = '') => {
    const domain = node?.fileData?.domain || 'personal';
    const params = new URLSearchParams();
    params.set('domain', domain);
    if (domain === 'work' && node?.fileData?.orgId) params.set('orgId', node.fileData.orgId);
    if (extraQuery) {
      const extra = new URLSearchParams(extraQuery.replace(/^\?/, ''));
      extra.forEach((value, key) => params.set(key, value));
    }
    return `${path}?${params.toString()}`;
  };

  const handleTogglePreview = async () => {
    if (!node || node.type !== 'file') return;
    if (previewContent || previewMediaUrl) {
      if (previewMediaUrl) URL.revokeObjectURL(previewMediaUrl);
      setPreviewContent(null); setPreviewMediaUrl(null);
      return;
    }
    setPreviewLoading(true);
    try {
      const res = await fetch(fileUrl(`/api/files/download/${encodeURIComponent(node.id)}`), { credentials: 'include' });
      if (!res.ok) throw new Error('');
      if (isImageFile || isAudioFile || isVideoFile) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setPreviewMediaUrl(url);
      } else {
        const text = await res.text();
        setPreviewContent(text.slice(0, 20000));
      }
    } catch {
      setPreviewContent('Failed to load preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleOpenFile = async () => {
    if (!node || node.type !== 'file') return;
    try {
      const res = await fetch(fileUrl('/api/files/open'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: node.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Open file failed');
      toast.success(`Opened: ${data.path || node.title}`);
    } catch (err: any) {
      toast.error(err?.message || 'Open file failed');
    }
  };

  const handleOpenFolder = async () => {
    if (!node || node.type !== 'file') return;
    try {
      const res = await fetch(fileUrl(`/api/files/open-folder/${encodeURIComponent(node.id)}`), { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Open folder failed');
      toast.success(`Opened folder: ${data.path || node.title}`);
    } catch (err: any) {
      toast.error(err?.message || 'Open folder failed');
    }
  };

  return (
    <AnimatePresence>
      {node && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/20 backdrop-blur-sm z-30"
            onClick={onClose}
          />

          {/* Floating card — positioned near node or centered */}
          <motion.div
            initial={{ opacity: 0, scale: 0.85, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.85, y: 20 }}
            transition={{ type: 'spring', stiffness: 350, damping: 25 }}
            className="fixed z-40 w-[380px] max-h-[80vh] overflow-hidden rounded-[2rem] border shadow-2xl"
            style={{
              ...(position ? {
                left: `${Math.min(position.x, window.innerWidth - 400)}px`,
                top: `${Math.max(10, position.y - 200)}px`,
              } : {
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
              }),
              background: `radial-gradient(ellipse at 50% 0%, hsla(${node.hue}, 50%, 25%, 0.35), hsla(240, 30%, 5%, 0.95) 60%)`,
              borderColor: `hsla(${node.hue}, 40%, 40%, 0.25)`,
              boxShadow: `0 0 80px hsla(${node.hue}, 50%, 30%, 0.15), 0 30px 60px rgba(0,0,0,0.6)`,
            }}
          >
            {/* Glow accent at top */}
            <div
              className="absolute top-0 left-4 right-4 h-px"
              style={{ background: `linear-gradient(90deg, transparent, hsla(${node.hue}, 70%, 60%, 0.5), transparent)` }}
            />

            {/* Header */}
            <div className="p-5 flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: `hsla(${node.hue}, 50%, 40%, 0.2)`, border: `1px solid hsla(${node.hue}, 40%, 40%, 0.3)` }}
              >
                {node.type === 'file' ? (
                  <File size={18} className="text-white/80" />
                ) : node.type === 'conversation' ? (
                  <MessageSquare size={18} className="text-white/80" />
                ) : node.isBranch ? (
                  <Layers size={18} className="text-white/80" />
                ) : (
                  <Brain size={18} className="text-white/80" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-bold text-white/90 truncate">{node.title}</h3>
                <span className="text-[12px] text-white/55 uppercase tracking-wider">
                  {node.type === 'file' ? 'File' : node.type === 'conversation' ? 'Conversation' : node.isBranch ? 'Branch' : 'Memory'} · {node.id.slice(0, 8)}
                </span>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 hover:bg-white/10 rounded-xl text-white/55 hover:text-white transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Content */}
            <div className="px-5 pb-5 space-y-4 max-h-[50vh] overflow-y-auto custom-scrollbar">
              {/* File content */}
              {node.type === 'file' && node.fileData && (
                <>
                  {node.fileData.size && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-white/45 uppercase tracking-widest">Size</label>
                      <p className="text-sm text-white/60">{node.fileData.size}</p>
                    </div>
                  )}
                  {node.fileData.source && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-white/45 uppercase tracking-widest">Source</label>
                      <span className="inline-block px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[12px] font-bold text-white/50 uppercase">
                        {node.fileData.source}
                      </span>
                    </div>
                  )}
                  {node.fileData.source === 'obsidian' && (node.fileData.obsidianVaultName || node.fileData.obsidianRelativePath) && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-white/45 uppercase tracking-widest">Obsidian</label>
                      <div className="rounded-xl border border-indigo-300/12 bg-indigo-300/[0.06] p-3 text-xs leading-5 text-white/58">
                        {node.fileData.obsidianVaultName && <p className="truncate text-indigo-100/72">Vault: {node.fileData.obsidianVaultName}</p>}
                        {node.fileData.obsidianRelativePath && <p className="truncate">Note: {node.fileData.obsidianRelativePath}</p>}
                        {node.fileData.obsidianSourcePath && <p className="truncate text-white/34">Path: {node.fileData.obsidianSourcePath}</p>}
                      </div>
                    </div>
                  )}
                  {node.fileData.status && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-white/45 uppercase tracking-widest">Status</label>
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[12px] font-bold uppercase ${
                        node.fileData.status === 'indexed'
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                          : node.fileData.status === 'partial'
                            ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                          : node.fileData.status === 'failed' || node.fileData.status === 'unsupported'
                            ? 'bg-red-500/10 border-red-500/30 text-red-300'
                          : node.fileData.status === 'indexing'
                            ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                            : 'bg-white/5 border-white/10 text-white/40'
                      }`}>
                        {node.fileData.status === 'indexed' ? <CheckCircle2 size={9} /> : node.fileData.status === 'indexing' ? <Loader2 size={9} className="animate-spin" /> : <Clock size={9} />}
                        {node.fileData.status}
                      </span>
                    </div>
                  )}
                  {(node.fileData.extractionMethod || node.fileData.extractionWarning || node.fileData.extractionError || node.fileData.extractionProvider || node.fileData.extractionModel) && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-white/45 uppercase tracking-widest">Extraction</label>
                      <div className="rounded-xl border border-white/[0.06] bg-white/[0.04] p-3 text-xs leading-5 text-white/58">
                        {node.fileData.extractionMethod && <p>Method: {node.fileData.extractionMethod}</p>}
                        {(node.fileData.extractionProvider || node.fileData.extractionModel) && (
                          <p>Provider: {[node.fileData.extractionProvider, node.fileData.extractionModel].filter(Boolean).join(' / ')}</p>
                        )}
                        {node.fileData.contentChars ? <p>Indexed text: {node.fileData.contentChars.toLocaleString()} chars</p> : null}
                        {node.fileData.extractionWarning && <p className="text-amber-200/75">{node.fileData.extractionWarning}</p>}
                        {node.fileData.extractionError && <p className="text-red-200/75">{node.fileData.extractionError}</p>}
                      </div>
                    </div>
                  )}
                  {(node.fileData.sourceTitle || node.fileData.sourceTags?.length || node.fileData.sourceAliases?.length || node.fileData.sourceLinks?.length || node.fileData.sourceBacklinks?.length) && (
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-white/45 uppercase tracking-widest">Source Map</label>
                      <div className="rounded-xl border border-white/[0.06] bg-white/[0.04] p-3 text-xs leading-5 text-white/58 space-y-2">
                        {node.fileData.sourceTitle && (
                          <p className="text-white/70">Title: {node.fileData.sourceTitle}</p>
                        )}
                        {node.fileData.sourceAliases && node.fileData.sourceAliases.length > 0 && (
                          <div>
                            <span className="text-white/40">Aliases</span>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {node.fileData.sourceAliases.slice(0, 12).map(alias => (
                                <span key={alias} className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-white/58">{alias}</span>
                              ))}
                            </div>
                          </div>
                        )}
                        {node.fileData.sourceTags && node.fileData.sourceTags.length > 0 && (
                          <div>
                            <span className="text-white/40">Tags</span>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {node.fileData.sourceTags.slice(0, 16).map(tag => (
                                <span key={tag} className="rounded-full border border-cyan-400/15 bg-cyan-400/10 px-2 py-0.5 text-[11px] text-cyan-200/70">#{tag}</span>
                              ))}
                            </div>
                          </div>
                        )}
                        {node.fileData.sourceLinks && node.fileData.sourceLinks.length > 0 && (
                          <div>
                            <span className="text-white/40">Links</span>
                            <div className="mt-1 space-y-0.5">
                              {node.fileData.sourceLinks.slice(0, 8).map(link => (
                                <p key={link} className="truncate text-white/58">{link}</p>
                              ))}
                            </div>
                          </div>
                        )}
                        {node.fileData.sourceBacklinks && node.fileData.sourceBacklinks.length > 0 && (
                          <div>
                            <span className="text-white/40">Backlinks</span>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {node.fileData.sourceBacklinks.slice(0, 10).map(link => (
                                <span key={link} className="rounded-full border border-amber-400/15 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-200/70">{link}</span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {node.fileData.agentIds && node.fileData.agentIds.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-white/45 uppercase tracking-widest">Agents</label>
                      <div className="flex flex-wrap gap-1">
                        {node.fileData.agentIds.map((aid: string) => (
                          <span key={aid} className="px-2 py-0.5 bg-emerald-500/5 border border-emerald-500/20 rounded-full text-xs font-bold text-emerald-400/60 uppercase">{aid.slice(0, 8)}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {isPreviewable && (
                    <div className="space-y-2">
                      <button
                        onClick={handleTogglePreview}
                        disabled={previewLoading}
                        className="flex items-center gap-1.5 px-3 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-bold text-white/60 transition-colors"
                      >
                        {previewLoading ? <Loader2 size={12} className="animate-spin" /> : (previewContent || previewMediaUrl) ? <EyeOff size={12} /> : <Eye size={12} />}
                        {(previewContent || previewMediaUrl) ? 'Hide Preview' : 'Preview'}
                      </button>

                      {/* Image preview */}
                      {previewMediaUrl && isImageFile && (
                        <div className="bg-white/[0.03] rounded-xl overflow-hidden border border-white/[0.06]">
                          <img src={previewMediaUrl} alt={fileName} className="w-full max-h-64 object-contain" />
                        </div>
                      )}

                      {/* Audio preview */}
                      {previewMediaUrl && isAudioFile && (
                        <div className="bg-white/[0.04] rounded-xl p-3 border border-white/[0.06]">
                          <audio controls className="w-full h-10" src={previewMediaUrl}>
                            Your browser does not support the audio element.
                          </audio>
                        </div>
                      )}

                      {/* Video preview */}
                      {previewMediaUrl && isVideoFile && (
                        <div className="bg-white/[0.03] rounded-xl overflow-hidden border border-white/[0.06]">
                          <video controls className="w-full max-h-56" src={previewMediaUrl}>
                            Your browser does not support the video element.
                          </video>
                        </div>
                      )}

                      {/* PDF preview — open in new tab */}
                      {isPdfFile && (
                        <div className="bg-white/[0.04] rounded-xl p-3 border border-white/[0.06] flex items-center gap-3">
                          <FileText size={28} className="text-red-400/70" />
                          <div className="flex-1">
                            <p className="text-sm text-white/70">{t.pdfPreviewHint || 'Open this PDF directly in the browser'}</p>
                          </div>
                          <button
                            onClick={() => {
                              const url = fileUrl(`/api/files/download/${encodeURIComponent(node.id)}`, 'inline=1');
                              window.open(url, '_blank');
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg text-xs font-bold text-red-400 transition-colors"
                          >
                            <Eye size={12} /> Open
                          </button>
                        </div>
                      )}

                      {/* Text file preview */}
                      {previewContent && isTextFile && (
                        <div className="bg-white/[0.04] rounded-xl p-3 border border-white/[0.06] max-h-48 overflow-y-auto custom-scrollbar">
                          <pre className="text-xs text-white/65 leading-relaxed whitespace-pre-wrap font-mono">{previewContent}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Memory / Branch content */}
              {(node.type === 'memory' || node.type === 'branch') && node.memoryData && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-white/45 uppercase tracking-widest">Content</label>
                    <p className="text-sm text-white/75 leading-relaxed bg-white/[0.04] rounded-xl p-3 border border-white/[0.06]">
                      {node.memoryData.content}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-3 bg-white/[0.04] rounded-xl border border-white/[0.06]">
                      <label className="text-xs font-bold text-white/40 uppercase tracking-widest">Tier</label>
                      <p className="text-xs font-bold text-white/65 mt-0.5">{TIER_LABELS[node.memoryData.tier || 'episodic'] || node.memoryData.tier}</p>
                    </div>
                    <div className="p-3 bg-white/[0.04] rounded-xl border border-white/[0.06]">
                      <label className="text-xs font-bold text-white/40 uppercase tracking-widest">Type</label>
                      <p className="text-xs font-bold text-white/65 mt-0.5 capitalize">{node.memoryData.type || 'unknown'}</p>
                    </div>
                    <div className="p-3 bg-white/[0.04] rounded-xl border border-white/[0.06]">
                      <label className="text-xs font-bold text-white/40 uppercase tracking-widest">Confidence</label>
                      <p className="text-xs font-bold text-white/65 mt-0.5">{((node.memoryData.confidence || 0) * 100).toFixed(0)}%</p>
                    </div>
                    <div className="p-3 bg-white/[0.04] rounded-xl border border-white/[0.06]">
                      <label className="text-xs font-bold text-white/40 uppercase tracking-widest">Importance</label>
                      <p className="text-xs font-bold text-white/65 mt-0.5">{((node.memoryData.importance || 0) * 100).toFixed(0)}%</p>
                    </div>
                  </div>
                  {node.memoryData.keywords && node.memoryData.keywords.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-white/45 uppercase tracking-widest">Keywords</label>
                      <div className="flex flex-wrap gap-1">
                        {node.memoryData.keywords.map((kw: string) => (
                          <span key={kw} className="px-2 py-0.5 bg-white/5 rounded-full text-xs text-white/55">{kw}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Conversation content */}
              {node.type === 'conversation' && node.conversationData && (
                <>
                  {node.conversationData.summary && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-white/45 uppercase tracking-widest">Summary</label>
                      <p className="text-sm text-white/75 leading-relaxed bg-white/[0.04] rounded-xl p-3 border border-white/[0.06]">
                        {node.conversationData.summary}
                      </p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-3 bg-white/[0.04] rounded-xl border border-white/[0.06]">
                      <label className="text-xs font-bold text-white/40 uppercase tracking-widest">Messages</label>
                      <p className="text-xs font-bold text-white/65 mt-0.5">{node.conversationData.messageCount || 0}</p>
                    </div>
                    <div className="p-3 bg-white/[0.04] rounded-xl border border-white/[0.06]">
                      <label className="text-xs font-bold text-white/40 uppercase tracking-widest">Status</label>
                      <p className="text-xs font-bold text-white/65 mt-0.5 capitalize">{node.conversationData.status || 'unknown'}</p>
                    </div>
                    <div className="p-3 bg-white/[0.04] rounded-xl border border-white/[0.06]">
                      <label className="text-xs font-bold text-white/40 uppercase tracking-widest">Last Active</label>
                      <p className="text-xs font-bold text-white/65 mt-0.5">
                        {node.conversationData.lastActiveAt
                          ? new Date(node.conversationData.lastActiveAt).toLocaleDateString()
                          : '-'}
                      </p>
                    </div>
                    <div className="p-3 bg-white/[0.04] rounded-xl border border-white/[0.06]">
                      <label className="text-xs font-bold text-white/40 uppercase tracking-widest">Created</label>
                      <p className="text-xs font-bold text-white/65 mt-0.5">
                        {node.conversationData.createdAt
                          ? new Date(node.conversationData.createdAt).toLocaleDateString()
                          : '-'}
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Actions */}
            <div className="px-5 pb-5 flex items-center gap-2 flex-wrap">
              {node.type === 'file' && (
                <>
                  <button
                    onClick={handleOpenFile}
                    className="flex items-center gap-1.5 px-3 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-bold text-white/60 transition-colors"
                  >
                    <FileText size={13} /> Open File
                  </button>
                  <button
                    onClick={handleOpenFolder}
                    className="flex items-center gap-1.5 px-3 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-bold text-white/60 transition-colors"
                  >
                    <FolderOpen size={13} /> Show in Folder
                  </button>
                  {onIngest && (
                    <button onClick={() => onIngest(node.id)} className="flex items-center gap-1.5 px-3 py-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 rounded-xl text-xs font-bold text-amber-400 transition-colors">
                      <Brain size={13} /> Ingest
                    </button>
                  )}
                </>
              )}
              {(node.type === 'memory' || node.type === 'branch') && (
                <>
                  {onEdit && (
                    <button onClick={() => {
                      const content = prompt(t.editContentPrompt || 'Edit content:', node.memoryData?.content || '');
                      if (content) onEdit(node.id, content);
                    }} className="flex items-center gap-1.5 px-3 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-bold text-white/60 transition-colors">
                      <Edit3 size={13} /> Edit
                    </button>
                  )}
                  {onToggleProtect && (
                    <button onClick={() => onToggleProtect(node.id)} className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-colors ${
                      node.isCore ? 'bg-amber-500/10 border border-amber-500/20 text-amber-400' : 'bg-white/5 hover:bg-white/10 text-white/60'
                    }`}>
                      {node.isCore ? <Shield size={13} /> : <ShieldOff size={13} />}
                      {node.isCore ? 'Protected' : 'Protect'}
                    </button>
                  )}
                  {onChangeTier && (
                    <select
                      value={node.memoryData?.tier || 'episodic'}
                      onChange={e => onChangeTier(node.id, e.target.value)}
                      className="bg-white/5 border border-white/10 rounded-xl px-2 py-2 text-xs font-bold uppercase appearance-none cursor-pointer text-white/50"
                    >
                      {Object.entries(TIER_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  )}
                </>
              )}
              <div className="flex-1" />
              <button onClick={() => onDelete(node.id)} className="flex items-center gap-1.5 px-3 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-xl text-xs font-bold text-red-400 transition-colors">
                <Trash2 size={13} /> Delete
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
