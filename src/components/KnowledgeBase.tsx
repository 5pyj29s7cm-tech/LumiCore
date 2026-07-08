import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, Search, Sparkles, TrendingUp, Network, GitMerge, Upload, ArrowRight, File, FileText, Trash2, Eye, ChevronRight, AlertCircle, CheckCircle2, Clock, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { useSocket } from '@/hooks/useSocket';
import { appConfirm } from '@/lib/appConfirm';
import { NodeDetailPanel } from './NodeDetailPanel';
import { MemoryTreeScene, layoutTree3D } from './MemoryTree';
import type { TreeNode3D, BranchCurve3D, MemoryNode as MemNode, FileEntry } from './MemoryTree';

interface MemoryTree { node: MemNode; children: MemoryTree[]; }

interface KnowledgeBaseProps {
  t?: any;
  isOpen: boolean;
  onClose: () => void;
  domain?: 'personal' | 'work';
}

const BROKEN_FILENAME_MARKERS = [
  '\u00c3',
  '\u00c2',
  '\ufffd',
  '\u951f',
  '\u93c2',
  '\u6d93',
  '\u7f01',
  '\u7015',
  '\u6fc2',
  '\u5a34',
  '\u6d7c',
  '\u5fe1',
  '\u9439',
  '\u9359',
];

function looksBrokenFilename(value: string): boolean {
  return /[\u0080-\u009f]/.test(value)
    || /[\u00c0-\u00ff][\u0080-\u00bf]/.test(value)
    || BROKEN_FILENAME_MARKERS.some(marker => value.includes(marker));
}

function scoreFilenameText(value: string): number {
  const replacement = (value.match(/\ufffd/g) || []).length;
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const ascii = (value.match(/[A-Za-z0-9._ -]/g) || []).length;
  const controls = (value.match(/[\u0080-\u009f]/g) || []).length;
  const brokenMarkers = BROKEN_FILENAME_MARKERS.reduce((sum, marker) => sum + (value.includes(marker) ? 1 : 0), 0);
  return cjk * 2 + ascii * 0.15 - replacement * 8 - controls * 6 - brokenMarkers * 2;
}

function repairKnowledgeFilename(value: string | undefined): string {
  const original = String(value || '').normalize('NFC');
  if (!original || !looksBrokenFilename(original)) return original;
  const candidates = new Set<string>([original]);
  try {
    const bytes = Uint8Array.from(Array.from(original, ch => ch.charCodeAt(0) & 0xff));
    candidates.add(new TextDecoder('utf-8', { fatal: false }).decode(bytes).normalize('NFC'));
  } catch {}
  return [...candidates].sort((a, b) => scoreFilenameText(b) - scoreFilenameText(a))[0] || original;
}

export function KnowledgeBase({ t, isOpen, onClose, domain = 'personal' }: KnowledgeBaseProps) {
  const socket = useSocket();
  const isZh = t?.langCode !== 'en';

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [memories, setMemories] = useState<MemNode[]>([]);
  const [treeNodes, setTreeNodes] = useState<TreeNode3D[]>([]);
  const [branchCurves, setBranchCurves] = useState<BranchCurve3D[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [cardPos, setCardPos] = useState<{ x: number; y: number } | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [reflecting, setReflecting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [bulkIngesting, setBulkIngesting] = useState(false);
  const [ingestingFiles, setIngestingFiles] = useState<Set<string>>(() => new Set());
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const lastLoadErrorRef = React.useRef<string | null>(null);

  const reportLoadError = useCallback((message: string) => {
    setLoadError(message);
    if (lastLoadErrorRef.current !== message) {
      toast.error(message);
      lastLoadErrorRef.current = message;
    }
  }, []);

  const scopedMemoryUrl = useCallback((path: string) => {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}domain=${encodeURIComponent(domain)}`;
  }, [domain]);

  const scopedFileUrl = useCallback((path: string) => {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}domain=${encodeURIComponent(domain)}`;
  }, [domain]);
  const notifyKnowledgeUpdated = useCallback((files?: Array<{ id?: string; name?: string; displayName?: string }>) => {
    window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', { detail: { domain, files } }));
    window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
  }, [domain]);

  // Fetch data — parallel, no dependency between files and memory tree
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [filesRes, treeRes] = await Promise.allSettled([
      fetch(scopedFileUrl('/api/files/list'), { credentials: 'include' }),
      fetch(scopedMemoryUrl('/api/memory/tree')),
    ]);
    const errors: string[] = [];

    if (filesRes.status === 'fulfilled' && filesRes.value.ok) {
      try {
        const d = await filesRes.value.json();
        setFiles((d.files || []).map((file: FileEntry) => {
          const readableName = repairKnowledgeFilename(file.displayName || file.name || file.id);
          return {
            ...file,
            name: readableName,
            displayName: readableName,
            domain: file.domain || domain,
          };
        }));
      } catch {}
    } else {
      const status = filesRes.status === 'fulfilled' ? filesRes.value.status : 'network';
      errors.push(`${t.kbFilesLoadFailed || 'Files failed to load'} (${status})`);
    }

    if (treeRes.status === 'fulfilled' && treeRes.value.ok) {
      try {
        const d = await treeRes.value.json();
        const flat: MemNode[] = [];
        const walk = (nodes: MemoryTree[]) => {
          for (const n of nodes) { flat.push(n.node); walk(n.children); }
        };
        walk(d.tree || []);
        setMemories(flat);
      } catch {}
    } else {
      const status = treeRes.status === 'fulfilled' ? treeRes.value.status : 'network';
      errors.push(`${t.kbMemoriesLoadFailed || 'Memories failed to load'} (${status})`);
    }

    if (errors.length > 0) {
      reportLoadError(errors.join(' / '));
    } else {
      lastLoadErrorRef.current = null;
    }
    setLoading(false);
  }, [domain, reportLoadError, scopedFileUrl, scopedMemoryUrl, t.kbFilesLoadFailed, t.kbMemoriesLoadFailed]);

  useEffect(() => { if (isOpen) fetchAll(); }, [isOpen, fetchAll]);

  // Socket
  useEffect(() => {
    if (!socket || !isOpen) return;
    socket.on('memories:changed', fetchAll);
    return () => { socket.off('memories:changed', fetchAll); };
  }, [socket, isOpen, fetchAll]);

  // Build tree
  useEffect(() => {
    if (!isOpen) return;
    const { nodes, curves } = layoutTree3D(memories, files);
    setTreeNodes(nodes);
    setBranchCurves(curves);
  }, [memories, files, isOpen]);

  // Find selected node data
  const selectedNode = selectedId ? treeNodes.find(n => n.id === selectedId) : null;
  const selectedFileData = selectedId ? files.find(f => f.id === selectedId) : undefined;
  const selectedMemoryData = selectedId ? memories.find(m => m.id === selectedId) : undefined;

  // Search: text results from memories
  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    return memories
      .filter(m => m.nodeType !== 'branch' && m.content.toLowerCase().includes(q))
      .slice(0, 5);
  }, [memories, search]);

  const targetAgentId = domain === 'work' ? 'org-kb' : 'lumi';
  const fileIsAbsorbed = useCallback((file: FileEntry) => {
    if (file.agentIds?.includes(targetAgentId)) return true;
    return domain === 'work' && file.status === 'indexed';
  }, [domain, targetAgentId]);

  const visibleFiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...files].sort((a, b) => {
      const aAbsorbed = fileIsAbsorbed(a) ? 1 : 0;
      const bAbsorbed = fileIsAbsorbed(b) ? 1 : 0;
      if (aAbsorbed !== bAbsorbed) return aAbsorbed - bAbsorbed;
      return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    });
    if (!q) return sorted;
    return sorted.filter(file => [
      file.displayName || file.name,
      file.name,
      file.source || '',
      file.status || '',
      ...(file.agentIds || []),
    ].some(value => String(value || '').toLowerCase().includes(q)));
  }, [fileIsAbsorbed, files, search]);

  const absorbedFileCount = useMemo(() => files.filter(fileIsAbsorbed).length, [fileIsAbsorbed, files]);
  const partialFileCount = useMemo(() => files.filter(file => (file.extractionStatus || file.status) === 'partial').length, [files]);
  const needsAttentionFileCount = useMemo(() => files.filter(file => ['failed', 'unsupported'].includes(String(file.extractionStatus || file.status || ''))).length, [files]);
  const pendingFileCount = useMemo(() => files.filter(file => {
    const status = String(file.extractionStatus || file.status || '');
    return !fileIsAbsorbed(file) && !['failed', 'unsupported'].includes(status);
  }).length, [fileIsAbsorbed, files]);
  const ingestableFiles = useMemo(() => files.filter(file => {
    const status = String(file.extractionStatus || file.status || '');
    if (status === 'unsupported') return false;
    return !fileIsAbsorbed(file) || status === 'partial' || status === 'failed';
  }), [fileIsAbsorbed, files]);
  const fileSearchResults = search.trim() ? visibleFiles.slice(0, 5) : [];

  // Actions
  const handleDelete = async (id: string) => {
    const n = treeNodes.find(nd => nd.id === id);
    if (!n) return;
    const ok = await appConfirm({
      title: t.kbDeleteConfirm || 'Delete',
      message: `${t.kbDeleteConfirm || 'Delete'} "${n.title}"?`,
      confirmText: t.delete || 'Delete',
      cancelText: t.cancel || 'Cancel',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const endpoint = n.type === 'file' ? scopedFileUrl(`/api/files/delete/${encodeURIComponent(id)}`) : scopedMemoryUrl(`/api/memories/${id}`);
      const res = await fetch(endpoint, { method: 'DELETE', credentials: 'include' });
      if (res.ok) { toast.success(t.kbDeleted || 'Deleted'); fetchAll(); setSelectedId(null); }
      else toast.error(t.kbDeleteFailed || 'Delete failed');
    } catch { toast.error(t.kbDeleteFailed || 'Delete failed'); }
  };

  const handleIngest = async (id: string) => {
    const agentId = targetAgentId;
    setIngestingFiles(prev => new Set(prev).add(id));
    try {
      const res = await fetch(scopedFileUrl('/api/files/ingest'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ fileId: id, agentId, domain }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const count = data.chunkCount || data.memoryIds?.length || 0;
        toast.success(domain === 'work'
          ? (t.kbIngested || 'Synced to organization knowledge')
          : `${t.kbIngested || 'Absorbed into Lumi'}${count ? ` | ${count} chunks` : ''}`);
        notifyKnowledgeUpdated([{ id }]);
        fetchAll();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t.kbIngestFailed || 'Ingest failed');
      }
    } catch {
      toast.error(t.kbIngestFailed || 'Ingest failed');
    } finally {
      setIngestingFiles(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleIngestAll = async () => {
    const targets = ingestableFiles;
    if (targets.length === 0) {
      toast.info(t.kbNothingToIngest || (isZh ? '没有需要吸收的文件' : 'No files need absorption'));
      return;
    }

    const agentId = targetAgentId;
    setBulkIngesting(true);
    let absorbed = 0;
    let failed = 0;
    try {
      for (const file of targets) {
        setIngestingFiles(prev => new Set(prev).add(file.id));
        try {
          const res = await fetch(scopedFileUrl('/api/files/ingest'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ fileId: file.id, agentId, domain }),
          });
          if (res.ok) absorbed++;
          else failed++;
        } catch {
          failed++;
        } finally {
          setIngestingFiles(prev => {
            const next = new Set(prev);
            next.delete(file.id);
            return next;
          });
        }
      }
      await fetchAll();
      notifyKnowledgeUpdated(targets.map(file => ({ id: file.id, name: file.name, displayName: file.displayName })));
      if (failed > 0) {
        toast.warning(isZh ? `已吸收 ${absorbed} 个，${failed} 个需要检查` : `${absorbed} absorbed, ${failed} need review`);
      } else {
        toast.success(`${t.kbIngested || (isZh ? '已吸收' : 'Absorbed')}: ${absorbed}`);
      }
    } finally {
      setBulkIngesting(false);
    }
  };

  const handleToggleProtect = async (id: string) => {
    try {
      const res = await fetch(scopedMemoryUrl(`/api/memory/${id}/protect`), { method: 'PUT' });
      const d = await res.json();
      toast.success(d.protected ? (t.kbProtected || 'Protected') : (t.kbUnprotected || 'Unprotected'));
      fetchAll();
    } catch { toast.error(t.kbProtectFailed || 'Protect failed'); }
  };

  const handleChangeTier = async (id: string, tier: string, confirmed = false) => {
    try {
      const res = await fetch(scopedMemoryUrl(`/api/memory/${id}/tier`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, confirmed }),
      });
      if (!res.ok) {
        const d = await res.json();
        if (d.error?.includes('confirmed')) {
          const ok = await appConfirm({
            title: t.kbPromoteConfirm || 'Promote to Core Identity?',
            message: t.kbPromoteConfirm || 'Promote to Core Identity?',
            confirmText: t.confirm || 'Confirm',
            cancelText: t.cancel || 'Cancel',
          });
          if (ok) return handleChangeTier(id, tier, true);
          return;
        }
        throw new Error(d.error);
      }
      toast.success(t.kbTierChanged || 'Tier changed'); fetchAll();
    } catch (err: any) { toast.error(err.message); }
  };

  const handleEdit = async (id: string, content: string) => {
    try {
      const res = await fetch(scopedMemoryUrl(`/api/memories/${id}`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.ok) { toast.success(t.kbUpdated || 'Updated'); fetchAll(); }
      else toast.error(t.kbUpdateFailed || 'Update failed');
    } catch { toast.error(t.kbUpdateFailed || 'Update failed'); }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      for (let i = 0; i < files.length; i++) formData.append('files', files[i]);
      const res = await fetch(scopedFileUrl('/api/files/upload'), { method: 'POST', body: formData, credentials: 'include' });
      if (res.ok) {
        const d = await res.json();
        const uploaded = d.files?.length || files.length;
        const absorbed = (d.files || []).filter((file: any) => file.ingested).length;
        const partial = (d.files || []).filter((file: any) => file.partial || file.extractionStatus === 'partial').length;
        const needsAttention = (d.files || []).filter((file: any) => file.syncError || ['failed', 'unsupported'].includes(String(file.extractionStatus || ''))).length;
        toast.success(`${t.kbUploadedFiles || 'Uploaded'}: ${uploaded}${absorbed ? ` | ${t.kbIngested || 'Absorbed'}: ${absorbed}` : ''}${partial ? ` | Partial: ${partial}` : ''}${needsAttention ? ` | Needs review: ${needsAttention}` : ''}`);
        notifyKnowledgeUpdated((d.files || []).map((file: any) => ({ id: file.id, name: file.name, displayName: file.displayName })));
        fetchAll();
      } else toast.error(t.kbUploadFailed || 'Upload failed');
    } catch { toast.error(t.kbUploadFailed || 'Upload failed'); }
    finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleOpenKnowledgeFolder = async () => {
    try {
      const res = await fetch(scopedFileUrl('/api/files/open-folder'), { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Open knowledge folder failed');
      toast.success(isZh ? `已打开知识库文件夹：${data.path}` : `Opened knowledge folder: ${data.path}`);
    } catch (err: any) {
      toast.error(err?.message || (isZh ? '打开知识库文件夹失败' : 'Open knowledge folder failed'));
    }
  };

  const handleAutoOrganize = async () => {
    setOrganizing(true);
    try {
      const res = await fetch(scopedMemoryUrl('/api/memory/auto-organize'), { method: 'POST' });
      const d = await res.json();
      if (d.success) { toast.success(`Organized: ${d.branchesCreated} branches, ${d.memoriesAssigned} memories`); fetchAll(); }
      else toast.info(d.reason || (t.kbNotEnoughMemories || 'Not enough unorganized memories'));
    } catch { toast.error(t.kbOrganizationFailed || 'Organization failed'); }
    finally { setOrganizing(false); }
  };

  const handleConsolidate = async () => {
    setConsolidating(true);
    try {
      const res = await fetch(scopedMemoryUrl('/api/memory/consolidate'), { method: 'POST' });
      const d = await res.json();
      if (d.success) { toast.success(t.kbConsolidated || 'Consolidated'); fetchAll(); }
      else toast.info(d.reason || `${t.kbNeedMemories || 'Need'} ${d.threshold || 10} ${t.kbMem || 'memories'}`);
    } catch { toast.error(t.kbConsolidationFailed || 'Consolidation failed'); }
    finally { setConsolidating(false); }
  };

  const handleSelfReflect = async () => {
    setReflecting(true);
    try {
      const res = await fetch(scopedMemoryUrl('/api/memory/self-reflect'), { method: 'POST' });
      const d = await res.json();
      if (d.success) { toast.success(t.kbReflectionComplete || 'Reflection complete'); fetchAll(); }
      else toast.info(d.reason || 'Nothing to reflect on');
    } catch { toast.error(t.kbReflectionFailed || 'Reflection failed'); }
    finally { setReflecting(false); }
  };

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      const res = await fetch(scopedMemoryUrl('/api/memory/analyze-behavior'), { method: 'POST' });
      const d = await res.json();
      if (d.patternsFound > 0) { toast.success(`${t.kbPatternsFound || 'Found'} ${d.patternsFound} ${t.kbPatterns || 'patterns'}`); fetchAll(); }
      else toast.info(t.kbNoNewPatterns || 'No new patterns');
    } catch { toast.error(t.kbAnalysisFailed || 'Analysis failed'); }
    finally { setAnalyzing(false); }
  };

  // ESC to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && isOpen && !selectedId) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, selectedId]);

  const totalFiles = files.length;
  const totalMemories = memories.filter(m => m.nodeType !== 'branch').length;
  const totalBranches = memories.filter(m => m.nodeType === 'branch').length;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ clipPath: 'circle(0% at 50% 95%)', opacity: 0 }}
          animate={{ clipPath: 'circle(150% at 50% 95%)', opacity: 1 }}
          exit={{ clipPath: 'circle(0% at 50% 95%)', opacity: 0 }}
          transition={{ duration: 0.75, ease: [0.25, 0.1, 0.25, 1] }}
          className="fixed inset-0 z-[200]"
          style={{
            background: 'radial-gradient(ellipse at 50% 30%, #0f0f23 0%, #080812 40%, #020205 100%)',
          }}
        >
          {/* 3D Memory Tree Scene */}
          <MemoryTreeScene
            nodes={treeNodes}
            curves={branchCurves}
            searchQuery={search}
            highlightedNodeId={selectedId}
            onNodeClick={(id, sx, sy) => {
              if (!id) { setSelectedId(null); setCardPos(null); return; }
              setSelectedId(prev => prev === id ? null : id);
              setCardPos(prev => prev ? null : { x: sx, y: sy });
            }}
            onNodeDoubleClick={(id) => setSelectedId(id)}
          />

          {/* Loading overlay */}
          <AnimatePresence>
            {loading && (
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 flex items-center justify-center bg-black/40 z-10"
              >
                <div className="flex flex-col items-center gap-4">
                  <Loader2 size={40} className="animate-spin text-amber-400" />
                  <span className="text-xs font-black uppercase tracking-[0.3em] text-white/55">{t.awakening || 'Awakening...'}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {loadError && !loading && (
            <div className="absolute top-20 left-1/2 -translate-x-1/2 z-30 flex max-w-[520px] items-center gap-2 rounded-xl border border-red-400/20 bg-red-950/70 px-4 py-2 text-xs text-red-100 shadow-2xl backdrop-blur-xl">
              <AlertCircle size={14} className="shrink-0 text-red-300" />
              <span className="truncate">{loadError}</span>
            </div>
          )}

          {/* Left: File browser */}
          <div className="absolute left-6 top-32 bottom-20 z-20 flex flex-col">
            <div className="bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl overflow-hidden flex-1 flex flex-col w-64 min-h-0">
              <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
                <span className="text-xs font-bold text-white/45 uppercase tracking-widest flex items-center gap-2">
                  <File size={12} className="text-blue-400/60" />
                  {t.kbFiles || 'Files'} ({visibleFiles.length}/{totalFiles})
                </span>
                <span className="text-[10px] font-black uppercase tracking-[0.14em] text-emerald-300/65">
                  {absorbedFileCount} {t.kbIngested || 'absorbed'}
                </span>
              </div>
              {pendingFileCount > 0 && (
                <div className="border-b border-amber-400/10 bg-amber-400/[0.055] px-4 py-2 text-[11px] font-bold leading-5 text-amber-100/68">
                  {pendingFileCount} {t.kbPendingIngest || (isZh ? '个文件等待 Lumi 吸收' : 'file(s) waiting to be absorbed by Lumi')}
                </div>
              )}
              {partialFileCount > 0 && (
                <div className="border-b border-blue-400/10 bg-blue-400/[0.055] px-4 py-2 text-[11px] font-bold leading-5 text-blue-100/68">
                  {isZh ? `${partialFileCount} 个文件只完成了部分吸收。配置视觉模型后可重新读取图片内容。` : `${partialFileCount} partially absorbed file(s). Configure a vision model for full image reading.`}
                </div>
              )}
              {needsAttentionFileCount > 0 && (
                <div className="border-b border-red-400/10 bg-red-400/[0.055] px-4 py-2 text-[11px] font-bold leading-5 text-red-100/70">
                  {isZh ? `${needsAttentionFileCount} 个文件需要检查后 Lumi 才能使用。` : `${needsAttentionFileCount} file(s) need review before Lumi can use them.`}
                </div>
              )}
              <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                {files.length === 0 ? (
                  <div className="text-xs text-white/25 text-center py-8">{t.noFilesYet || 'No files yet'}</div>
                ) : (
                  visibleFiles.map(f => {
                    const absorbed = fileIsAbsorbed(f);
                    const ingesting = ingestingFiles.has(f.id);
                    const knowledgeStatus = f.extractionStatus || f.status;
                    const partial = knowledgeStatus === 'partial';
                    const failed = knowledgeStatus === 'failed';
                    const unsupported = knowledgeStatus === 'unsupported';
                    const audioTranscript = f.extractionMethod === 'audio-transcript';
                    const needsReview = failed || unsupported;
                    const statusLabel = unsupported
                      ? (isZh ? '不支持' : 'unsupported')
                      : failed
                      ? (audioTranscript ? (isZh ? '转写失败' : 'transcribe failed') : (isZh ? '需检查' : 'needs review'))
                      : partial
                        ? (isZh ? '部分吸收' : 'partial')
                        : absorbed
                          ? (t.kbIngested || (isZh ? '已吸收' : 'absorbed'))
                          : (t.kbReadyToIngest || (isZh ? '待吸收' : 'pending'));
                    return (
                    <div
                      key={f.id}
                      onClick={() => { setSelectedId(f.id); setCardPos(null); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-all group cursor-pointer ${
                        selectedId === f.id
                          ? 'bg-white/10 border border-white/15 shadow-[0_0_20px_rgba(59,130,246,0.08)]'
                          : 'hover:bg-white/5 border border-transparent'
                      }`}
                    >
                      {f.name.match(/\.(pdf|docx?|xlsx?|pptx?)$/i) ? (
                        <FileText size={13} className="text-amber-400/60 shrink-0" />
                      ) : f.name.match(/\.(mp3|wav|m4a|ogg|flac)$/i) ? (
                        <File size={13} className="text-purple-400/60 shrink-0" />
                      ) : f.name.match(/\.(mp4|mov|avi|mkv|webm)$/i) ? (
                        <File size={13} className="text-red-400/60 shrink-0" />
                      ) : (
                        <File size={13} className="text-blue-400/60 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <span className="text-xs text-white/70 truncate block">{f.name}</span>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {f.source && (
                            <span className="text-[10px] font-black uppercase tracking-[0.12em] text-white/25">{f.source}</span>
                          )}
                          <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.08em] ${
                            needsReview
                              ? 'border-red-400/18 bg-red-400/10 text-red-200/75'
                              : partial
                                ? 'border-blue-400/18 bg-blue-400/10 text-blue-200/75'
                              : absorbed
                              ? 'border-emerald-400/18 bg-emerald-400/10 text-emerald-200/75'
                              : 'border-amber-400/18 bg-amber-400/10 text-amber-200/75'
                          }`}>
                            {absorbed && !partial && !needsReview ? <CheckCircle2 size={9} /> : ingesting ? <Loader2 size={9} className="animate-spin" /> : needsReview ? <AlertCircle size={9} /> : <Clock size={9} />}
                            {statusLabel}
                          </span>
                        </div>
                      </div>
                      {(!unsupported && (!absorbed || partial || failed)) && (
                        <button
                          type="button"
                          disabled={ingesting}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleIngest(f.id);
                          }}
                          className="shrink-0 rounded-lg border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-amber-100 transition-colors hover:bg-amber-400/16 disabled:pointer-events-none disabled:opacity-60"
                        >
                          {ingesting
                            ? (t.loading || (isZh ? '读取中' : 'Loading'))
                            : audioTranscript && failed
                              ? (isZh ? '重试转写' : 'Retry')
                              : partial
                                ? (isZh ? '重读' : 'Re-read')
                                : (t.kbIngest || (isZh ? '吸收' : 'Absorb'))}
                        </button>
                      )}
                      <ChevronRight size={12} className="text-white/20 shrink-0 group-hover:text-white/40 transition-colors" />
                    </div>
                  );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Top bar — controls */}
          <div className="absolute top-6 left-6 right-6 z-20 pointer-events-none">
            <div className="flex items-center gap-3 justify-between pointer-events-auto">
              {/* Left: title */}
              <div className="flex items-center gap-3 bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2">
                <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.5)]" />
                <span className="text-xs font-black text-white/50 uppercase tracking-[0.2em]">{t.knowledgeBase || 'Knowledge Base'}</span>
              </div>

              {/* Search */}
              <div className="relative flex items-center gap-2 bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2 flex-1 max-w-[320px]">
                <Search size={13} className="text-white/45 shrink-0" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={t.searchMemories || 'Search memories...'}
                  className="bg-transparent text-xs text-white/70 placeholder:text-white/45 outline-none flex-1 min-w-0"
                />
                <AnimatePresence>
                  {search.trim() && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      className="absolute top-full left-0 right-0 mt-2 bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-xl overflow-hidden shadow-2xl"
                    >
                      {fileSearchResults.length === 0 && searchResults.length === 0 ? (
                        <div className="px-4 py-3 text-xs text-white/55">{t.noMatchesFound || 'No matches found'}</div>
                      ) : (
                        <>
                        {fileSearchResults.map(f => (
                          <button
                            key={`file-${f.id}`}
                            onClick={() => setSelectedId(f.id)}
                            className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-white/5 transition-colors group"
                          >
                            <File size={12} className="text-blue-400/50 shrink-0 group-hover:text-blue-300 transition-colors" />
                            <span className="text-xs text-white/60 group-hover:text-white/80 transition-colors truncate">
                              {f.displayName || f.name}
                            </span>
                            <span className="ml-auto text-[10px] font-black uppercase tracking-[0.12em] text-white/24">{t.kbFiles || 'file'}</span>
                          </button>
                        ))}
                        {searchResults.map(m => (
                          <button
                            key={m.id}
                            onClick={() => setSelectedId(m.id)}
                            className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-white/5 transition-colors group"
                          >
                            <ArrowRight size={12} className="text-amber-400/50 shrink-0 group-hover:text-amber-400 transition-colors" />
                            <span className="text-xs text-white/60 group-hover:text-white/80 transition-colors truncate">
                              {m.content.slice(0, 60)}
                            </span>
                          </button>
                        ))}
                        </>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Center: actions */}
              <div className="flex items-center gap-2">
                {/* Hidden file input */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={handleUpload}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1.5 bg-black/40 backdrop-blur-xl border border-green-500/20 rounded-xl px-3 py-2 text-xs font-bold text-green-400/70 hover:text-green-300 hover:border-green-400/40 transition-all"
                >
                  {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                  {t.kbImport || 'Import'}
                </button>
                <button
                  onClick={() => void handleOpenKnowledgeFolder()}
                  className="flex items-center gap-1.5 bg-black/40 backdrop-blur-xl border border-white/10 rounded-xl px-3 py-2 text-xs font-bold text-white/55 hover:text-white/80 hover:border-white/20 transition-all"
                  title={isZh ? '打开本地知识库文件夹' : 'Open local knowledge folder'}
                  aria-label={isZh ? '打开本地知识库文件夹' : 'Open local knowledge folder'}
                >
                  <FolderOpen size={13} />
                  {isZh ? '文件夹' : 'Folder'}
                </button>
                {ingestableFiles.length > 0 && (
                  <button
                    onClick={() => void handleIngestAll()}
                    disabled={bulkIngesting}
                    className="flex items-center gap-1.5 bg-black/40 backdrop-blur-xl border border-amber-500/20 rounded-xl px-3 py-2 text-xs font-bold text-amber-300/75 hover:text-amber-200 hover:border-amber-300/40 transition-all disabled:pointer-events-none disabled:opacity-60"
                  >
                    {bulkIngesting ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                    {bulkIngesting ? (t.loading || (isZh ? '读取中' : 'Loading')) : `${t.kbIngestAll || (isZh ? '全部吸收' : 'Absorb all')} (${ingestableFiles.length})`}
                  </button>
                )}
                <button
                  onClick={handleAutoOrganize}
                  disabled={organizing}
                  className="flex items-center gap-1.5 bg-black/40 backdrop-blur-xl border border-cyan-500/20 rounded-xl px-3 py-2 text-xs font-bold text-cyan-400/70 hover:text-cyan-300 hover:border-cyan-400/40 transition-all"
                >
                  {organizing ? <Loader2 size={13} className="animate-spin" /> : <Network size={13} />}
                  {t.kbOrganize || 'Organize'}
                </button>
                <button
                  onClick={handleConsolidate}
                  disabled={consolidating}
                  className="flex items-center gap-1.5 bg-black/40 backdrop-blur-xl border border-emerald-500/20 rounded-xl px-3 py-2 text-xs font-bold text-emerald-400/70 hover:text-emerald-300 hover:border-emerald-400/40 transition-all"
                >
                  {consolidating ? <Loader2 size={13} className="animate-spin" /> : <GitMerge size={13} />}
                  {t.kbMerge || 'Merge'}
                </button>
                <button
                  onClick={handleSelfReflect}
                  disabled={reflecting}
                  className="flex items-center gap-1.5 bg-black/40 backdrop-blur-xl border border-violet-500/20 rounded-xl px-3 py-2 text-xs font-bold text-violet-400/70 hover:text-violet-300 hover:border-violet-400/40 transition-all"
                >
                  {reflecting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  {t.kbReflect || 'Reflect'}
                </button>
                <button
                  onClick={handleAnalyze}
                  disabled={analyzing}
                  className="flex items-center gap-1.5 bg-black/40 backdrop-blur-xl border border-amber-500/20 rounded-xl px-3 py-2 text-xs font-bold text-amber-400/70 hover:text-amber-300 hover:border-amber-400/40 transition-all"
                >
                  {analyzing ? <Loader2 size={13} className="animate-spin" /> : <TrendingUp size={13} />}
                  {t.kbPatterns || 'Patterns'}
                </button>
              </div>

              {/* Right: close + stats */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-3 bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2">
                  <span className="text-[12px] font-bold text-blue-400/60">{totalFiles} {t.kbFiles || 'files'}</span>
                  <span className="w-px h-3 bg-white/[0.08]" />
                  <span className="text-[12px] font-bold text-emerald-400/60">{absorbedFileCount} {t.kbIngested || 'absorbed'}</span>
                  <span className="w-px h-3 bg-white/[0.08]" />
                  <span className="text-[12px] font-bold text-amber-400/60">{totalMemories} {t.kbMem || 'mem'}</span>
                  <span className="w-px h-3 bg-white/[0.08]" />
                  <span className="text-[12px] font-bold text-cyan-400/60">{totalBranches} {t.kbBranches || 'branches'}</span>
                </div>
                <button
                  onClick={onClose}
                  className="w-10 h-10 flex items-center justify-center bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl text-white/40 hover:text-white hover:border-white/20 transition-all"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
          </div>

          {/* Floating detail card */}
          <NodeDetailPanel
            node={selectedNode ? {
              id: selectedNode.id,
              type: selectedNode.type as 'file' | 'memory' | 'branch' | 'conversation',
              title: selectedNode.title,
              hue: selectedNode.hue,
              fileData: selectedFileData,
              memoryData: selectedMemoryData,
              isCore: selectedNode.tier === 'core_identity',
              isBranch: selectedNode.type === 'branch',
            } : null}
            position={cardPos}
            onClose={() => { setSelectedId(null); setCardPos(null); }}
            onDelete={handleDelete}
            onIngest={handleIngest}
            onToggleProtect={handleToggleProtect}
            onChangeTier={handleChangeTier}
            onEdit={handleEdit}
          />

          {/* Bottom hint */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
            <span className="text-[12px] font-bold text-white/40 uppercase tracking-[0.15em] bg-black/30 px-4 py-1.5 rounded-full border border-white/[0.04]">
              {t.kbEscHint || 'ESC to close · Click nodes to inspect · Drag to rotate'}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export { layoutTree3D };
