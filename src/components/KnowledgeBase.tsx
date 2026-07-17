import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, Search, Upload, ArrowRight, File, FileText, Trash2, Eye, ChevronRight, AlertCircle, CheckCircle2, Clock, FolderOpen, BookOpen, RefreshCw, Link2 } from 'lucide-react';
import { toast } from 'sonner';
import { useSocket } from '@/hooks/useSocket';
import { appConfirm } from '@/lib/appConfirm';
import { NodeDetailPanel } from './NodeDetailPanel';
import { MemoryTreeScene, layoutTree3D } from './MemoryTree';
import type { TreeNode3D, BranchCurve3D, MemoryNode as MemNode, FileEntry } from './MemoryTree';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import { CN_BROKEN_TEXT_MARKERS } from '../i18n/regions/cn/recognition';
import type { ChatAttachmentRequest } from '@/lib/chatAttachmentReferences';

interface MemoryTree { node: MemNode; children: MemoryTree[]; }

interface KnowledgeBaseProps {
  t?: any;
  isOpen: boolean;
  onClose: () => void;
  domain?: 'personal' | 'work';
}

interface ObsidianVault {
  id: string;
  name: string;
  path: string;
  enabled?: boolean;
  isObsidianVault?: boolean;
  exists?: boolean;
  noteCount?: number;
  lastSyncAt?: string;
  lastSyncResult?: {
    synced: number;
    skipped: number;
    failed: number;
    noteCount: number;
  };
}

const BROKEN_FILENAME_MARKERS = [
  '\u00c3',
  '\u00c2',
  '\ufffd',
  ...CN_BROKEN_TEXT_MARKERS,
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
  const [uploading, setUploading] = useState(false);
  const [bulkIngesting, setBulkIngesting] = useState(false);
  const [ingestingFiles, setIngestingFiles] = useState<Set<string>>(() => new Set());
  const [obsidianOpen, setObsidianOpen] = useState(false);
  const [obsidianPath, setObsidianPath] = useState('');
  const [obsidianVaults, setObsidianVaults] = useState<ObsidianVault[]>([]);
  const [obsidianSyncing, setObsidianSyncing] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const lastLoadErrorRef = React.useRef<string | null>(null);

  const reportLoadError = useCallback((message: string) => {
    setLoadError(message);
    lastLoadErrorRef.current = message;
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
  const referenceKnowledgeFileInChat = useCallback((fileId: string) => {
    const file = files.find(item => item.id === fileId);
    if (!file) return;
    const detail: ChatAttachmentRequest = {
      requestId: `knowledge-reference-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      domain: file.domain || domain,
      orgId: file.orgId,
      fileId: file.id,
      fileName: file.displayName || file.name || file.id,
      path: file.path,
      rawSize: file.rawSize,
      kind: 'file',
    };
    window.dispatchEvent(new CustomEvent<ChatAttachmentRequest>('lumi:reference-file-in-chat', { detail }));
  }, [domain, files]);

  const fetchObsidianStatus = useCallback(async () => {
    try {
      const res = await fetch(scopedFileUrl('/api/files/obsidian/status'), { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setObsidianVaults(Array.isArray(data.vaults) ? data.vaults : []);
    } catch {
      // Keep the knowledge base usable even if the optional Obsidian bridge is unavailable.
    }
  }, [scopedFileUrl]);

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
  useEffect(() => { if (isOpen) void fetchObsidianStatus(); }, [isOpen, fetchObsidianStatus]);

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
      toast.info(t.kbNothingToIngest || (uiMessage('knowledge-base.no-files-need-absorption.959ba34929', (isZh) ? 'zh' : 'en')));
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
        toast.warning(formatUiMessage('knowledge-base.value0-absorbed-value1-need-review.a1f2a8c2b4', { value0: absorbed, value1: failed }, (isZh) ? 'zh' : 'en'));
      } else {
        toast.success(`${t.kbIngested || (uiMessage('knowledge-base.absorbed.524e3e7736', (isZh) ? 'zh' : 'en'))}: ${absorbed}`);
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
      toast.success(formatUiMessage('knowledge-base.opened-knowledge-folder-value0.3731b41015', { value0: data.path }, (isZh) ? 'zh' : 'en'));
    } catch (err: any) {
      toast.error(err?.message || (uiMessage('knowledge-base.open-knowledge-folder-failed.2988dd36f8', (isZh) ? 'zh' : 'en')));
    }
  };

  const syncObsidianVault = useCallback(async (vaultId?: string) => {
    setObsidianSyncing(true);
    try {
      const res = await fetch(scopedFileUrl('/api/files/obsidian/sync'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultId, maxFiles: 500 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || (uiMessage('knowledge-base.obsidian-sync-failed.e8f4e30681', (isZh) ? 'zh' : 'en')));

      const synced = Number(data.synced || 0);
      const skipped = Number(data.skipped || 0);
      const failed = Number(data.failed || 0);
      const syncedFiles = Array.isArray(data.files) ? data.files : [];
      notifyKnowledgeUpdated(syncedFiles.map((file: any) => ({
        id: file.id,
        name: file.name,
        displayName: file.displayName,
      })));
      await fetchAll();
      await fetchObsidianStatus();

      const message = formatUiMessage('knowledge-base.obsidian-sync-complete-value0-updated.8f3a5865cb', { value0: synced, value1: skipped, value2: { en: failed ? `, ${failed} failed` : '', zh: failed ? `，${failed} 失败` : '' } }, (isZh) ? 'zh' : 'en');
      if (failed > 0) toast.warning(message);
      else toast.success(message);
      return true;
    } catch (err: any) {
      toast.error(err?.message || (uiMessage('knowledge-base.obsidian-sync-failed.e8f4e30681', (isZh) ? 'zh' : 'en')));
      return false;
    } finally {
      setObsidianSyncing(false);
    }
  }, [fetchAll, fetchObsidianStatus, isZh, notifyKnowledgeUpdated, scopedFileUrl]);

  const handleObsidianConnect = useCallback(async () => {
    const vaultPath = obsidianPath.trim();
    if (!vaultPath) {
      toast.info(uiMessage('knowledge-base.enter-an-obsidian-vault-folder.838b353be5', (isZh) ? 'zh' : 'en'));
      return;
    }
    setObsidianSyncing(true);
    let connectedVaultId = '';
    try {
      const res = await fetch(scopedFileUrl('/api/files/obsidian/connect'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultPath, maxFiles: 500 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || (uiMessage('knowledge-base.failed-to-connect-obsidian.93c27e8310', (isZh) ? 'zh' : 'en')));
      connectedVaultId = data?.vault?.id || '';
      setObsidianPath('');
      if (data.warning) toast.warning(isZh ? t.obsidianMarkdownConnected : data.warning);
      else toast.success(uiMessage('knowledge-base.obsidian-connected-syncing-now.29e8968ce9', (isZh) ? 'zh' : 'en'));
      await fetchObsidianStatus();
    } catch (err: any) {
      toast.error(err?.message || (uiMessage('knowledge-base.failed-to-connect-obsidian.93c27e8310', (isZh) ? 'zh' : 'en')));
    } finally {
      setObsidianSyncing(false);
    }
    if (connectedVaultId) void syncObsidianVault(connectedVaultId);
  }, [fetchObsidianStatus, isZh, obsidianPath, scopedFileUrl, syncObsidianVault]);

  const handleObsidianDisconnect = useCallback(async (vault: ObsidianVault) => {
    const ok = await appConfirm({
      title: uiMessage('knowledge-base.disconnect-obsidian.c61334f08a', (isZh) ? 'zh' : 'en'),
      message: formatUiMessage('knowledge-base.this-removes-the-connection-for.afd2eb3dd6', { value0: vault.name }, (isZh) ? 'zh' : 'en'),
      confirmText: uiMessage('knowledge-base.disconnect.4fdb1669e6', (isZh) ? 'zh' : 'en'),
      cancelText: t.cancel || 'Cancel',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const res = await fetch(scopedFileUrl(`/api/files/obsidian/${encodeURIComponent(vault.id)}`), {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || (uiMessage('knowledge-base.disconnect-failed.17c673b887', (isZh) ? 'zh' : 'en')));
      toast.success(uiMessage('knowledge-base.obsidian-disconnected.d7f9e3c17b', (isZh) ? 'zh' : 'en'));
      await fetchObsidianStatus();
    } catch (err: any) {
      toast.error(err?.message || (uiMessage('knowledge-base.disconnect-failed.17c673b887', (isZh) ? 'zh' : 'en')));
    }
  }, [fetchObsidianStatus, isZh, scopedFileUrl, t.cancel]);

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
          data-theme-scope="dark"
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
                  {pendingFileCount} {t.kbPendingIngest || (uiMessage('knowledge-base.file-s-waiting-to-be.72c858685e', (isZh) ? 'zh' : 'en'))}
                </div>
              )}
              {partialFileCount > 0 && (
                <div className="border-b border-blue-400/10 bg-blue-400/[0.055] px-4 py-2 text-[11px] font-bold leading-5 text-blue-100/68">
                  {formatUiMessage('knowledge-base.value0-partially-absorbed-file-s.edac928d34', { value0: partialFileCount }, (isZh) ? 'zh' : 'en')}
                </div>
              )}
              {needsAttentionFileCount > 0 && (
                <div className="border-b border-red-400/10 bg-red-400/[0.055] px-4 py-2 text-[11px] font-bold leading-5 text-red-100/70">
                  {formatUiMessage('knowledge-base.value0-file-s-need-review.153783066b', { value0: needsAttentionFileCount }, (isZh) ? 'zh' : 'en')}
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
                      ? (uiMessage('knowledge-base.unsupported.9701270725', (isZh) ? 'zh' : 'en'))
                      : failed
                      ? (audioTranscript ? (uiMessage('knowledge-base.transcribe-failed.52d9f86ff4', (isZh) ? 'zh' : 'en')) : (uiMessage('knowledge-base.needs-review.17cbe2789f', (isZh) ? 'zh' : 'en')))
                      : partial
                        ? (uiMessage('knowledge-base.partial.3b5874104b', (isZh) ? 'zh' : 'en'))
                        : absorbed
                          ? (t.kbIngested || (uiMessage('knowledge-base.absorbed.591f4b1184', (isZh) ? 'zh' : 'en')))
                          : (t.kbReadyToIngest || (uiMessage('knowledge-base.pending.2a0c37279f', (isZh) ? 'zh' : 'en')));
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
                            ? (t.loading || (uiMessage('knowledge-base.loading.4874ccc6e7', (isZh) ? 'zh' : 'en')))
                            : audioTranscript && failed
                              ? (uiMessage('knowledge-base.retry.9db2a8180b', (isZh) ? 'zh' : 'en'))
                              : partial
                                ? (uiMessage('knowledge-base.re-read.5074afc504', (isZh) ? 'zh' : 'en'))
                                : (t.kbIngest || (uiMessage('knowledge-base.absorb.7c2e41285d', (isZh) ? 'zh' : 'en')))}
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
            <div className="flex items-start gap-3 justify-between pointer-events-auto">
              {/* Left: title */}
              <div className="flex items-center gap-3 bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2">
                <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.5)]" />
                <span className="text-xs font-black text-white/50 uppercase tracking-[0.2em]">{t.knowledgeBase || 'Knowledge Base'}</span>
              </div>

              {/* Search */}
              <div className="relative flex min-w-[220px] max-w-[320px] flex-1 items-center gap-2 rounded-2xl border border-white/[0.08] bg-black/40 px-4 py-2 backdrop-blur-xl">
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
              <div className="flex max-w-[620px] items-center justify-end">
                {/* Hidden file input */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={handleUpload}
                  className="hidden"
                />
                <div className="flex items-center gap-1 rounded-2xl border border-white/[0.08] bg-black/35 p-1 shadow-[0_18px_45px_rgba(0,0,0,0.28)] backdrop-blur-xl">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    title={t.kbImport || (uiMessage('knowledge-base.import-files.dbcb99aedf', (isZh) ? 'zh' : 'en'))}
                    aria-label={t.kbImport || (uiMessage('knowledge-base.import-files.dbcb99aedf', (isZh) ? 'zh' : 'en'))}
                    className="group flex h-9 min-w-9 items-center justify-center gap-2 rounded-xl px-2.5 text-[11px] font-bold text-emerald-100/72 transition-all hover:bg-emerald-300/10 hover:text-emerald-100 disabled:pointer-events-none disabled:opacity-60 xl:px-3"
                  >
                    <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-emerald-300/12 text-emerald-100/80 transition-colors group-hover:bg-emerald-300/18">
                      {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                    </span>
                    <span className="hidden xl:inline">{t.kbImport || (uiMessage('knowledge-base.import.1a200b31b1', (isZh) ? 'zh' : 'en'))}</span>
                  </button>
                  <button
                    onClick={() => void handleOpenKnowledgeFolder()}
                    className="group flex h-9 min-w-9 items-center justify-center gap-2 rounded-xl px-2.5 text-[11px] font-bold text-white/62 transition-all hover:bg-white/[0.07] hover:text-white/88 xl:px-3"
                    title={uiMessage('knowledge-base.open-local-knowledge-folder.a2bec6274e', (isZh) ? 'zh' : 'en')}
                    aria-label={uiMessage('knowledge-base.open-local-knowledge-folder.a2bec6274e', (isZh) ? 'zh' : 'en')}
                  >
                    <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-white/[0.06] text-white/68 transition-colors group-hover:bg-white/[0.1] group-hover:text-white/88">
                      <FolderOpen size={13} />
                    </span>
                    <span className="hidden xl:inline">{uiMessage('knowledge-base.folder.b0d14417ff', (isZh) ? 'zh' : 'en')}</span>
                  </button>
                  <button
                    onClick={() => setObsidianOpen(value => !value)}
                    className={`group flex h-9 min-w-9 items-center justify-center gap-2 rounded-xl px-2.5 text-[11px] font-bold transition-all xl:px-3 ${
                      obsidianOpen || obsidianVaults.length > 0
                        ? 'bg-indigo-300/12 text-indigo-50/86 shadow-[inset_0_0_0_1px_rgba(165,180,252,0.18)] hover:bg-indigo-300/16'
                        : 'text-white/62 hover:bg-white/[0.07] hover:text-white/88'
                    }`}
                    title={uiMessage('knowledge-base.connect-obsidian-vault.07949d5768', (isZh) ? 'zh' : 'en')}
                    aria-label={uiMessage('knowledge-base.connect-obsidian-vault.07949d5768', (isZh) ? 'zh' : 'en')}
                  >
                    <span className={`flex h-5 w-5 items-center justify-center rounded-lg transition-colors ${
                      obsidianOpen || obsidianVaults.length > 0
                        ? 'bg-indigo-300/18 text-indigo-100'
                        : 'bg-white/[0.06] text-white/68 group-hover:bg-white/[0.1] group-hover:text-white/88'
                    }`}>
                      <BookOpen size={13} />
                    </span>
                    <span className="hidden xl:inline">Obsidian</span>
                  </button>
                  {ingestableFiles.length > 0 && (
                    <button
                      onClick={() => void handleIngestAll()}
                      disabled={bulkIngesting}
                      title={`${t.kbIngestAll || (uiMessage('knowledge-base.absorb-all.c6a483611c', (isZh) ? 'zh' : 'en'))} (${ingestableFiles.length})`}
                      aria-label={`${t.kbIngestAll || (uiMessage('knowledge-base.absorb-all.c6a483611c', (isZh) ? 'zh' : 'en'))} (${ingestableFiles.length})`}
                      className="group flex h-9 min-w-9 items-center justify-center gap-2 rounded-xl bg-amber-300/10 px-2.5 text-[11px] font-bold text-amber-100/84 shadow-[inset_0_0_0_1px_rgba(252,211,77,0.13)] transition-all hover:bg-amber-300/15 hover:text-amber-50 disabled:pointer-events-none disabled:opacity-60 xl:px-3"
                    >
                      <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-amber-300/15 text-amber-100 transition-colors group-hover:bg-amber-300/22">
                        {bulkIngesting ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                      </span>
                      <span className="hidden xl:inline">
                        {bulkIngesting ? (t.loading || (uiMessage('knowledge-base.loading.4874ccc6e7', (isZh) ? 'zh' : 'en'))) : `${t.kbIngestAll || (uiMessage('knowledge-base.absorb.7c2e41285d', (isZh) ? 'zh' : 'en'))} ${ingestableFiles.length}`}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              {/* Right: close + stats */}
              <div className="flex items-center gap-3">
                <div className="hidden items-center gap-3 rounded-2xl border border-white/[0.08] bg-black/40 px-4 py-2 backdrop-blur-xl xl:flex">
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

          {obsidianOpen && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              className="absolute right-6 top-20 z-30 w-[420px] max-w-[calc(100vw-3rem)] rounded-2xl border border-indigo-300/14 bg-zinc-950/92 p-4 shadow-2xl backdrop-blur-2xl"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-black text-white/82">
                    <BookOpen size={15} className="text-indigo-200/75" />
                    <span>Obsidian</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-white/45">
                    {uiMessage('knowledge-base.sync-local-vault-markdown-tags.af2710e156', (isZh) ? 'zh' : 'en')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void fetchObsidianStatus()}
                  disabled={obsidianSyncing}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/55 transition-colors hover:text-white disabled:pointer-events-none disabled:opacity-50"
                  title={uiMessage('knowledge-base.refresh-status.251b4754a3', (isZh) ? 'zh' : 'en')}
                  aria-label={uiMessage('knowledge-base.refresh-status.251b4754a3', (isZh) ? 'zh' : 'en')}
                >
                  <RefreshCw size={13} className={obsidianSyncing ? 'animate-spin' : ''} />
                </button>
              </div>

              <div className="mt-4 flex gap-2">
                <input
                  value={obsidianPath}
                  onChange={event => setObsidianPath(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void handleObsidianConnect();
                  }}
                  placeholder={uiMessage('knowledge-base.vault-folder-path-e-g.5a7a017974', (isZh) ? 'zh' : 'en')}
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-xs text-white/75 outline-none placeholder:text-white/28 focus:border-indigo-300/35"
                />
                <button
                  type="button"
                  onClick={() => void handleObsidianConnect()}
                  disabled={obsidianSyncing}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl border border-indigo-300/25 bg-indigo-300/10 px-3 py-2 text-xs font-bold text-indigo-100/80 transition-colors hover:bg-indigo-300/16 disabled:pointer-events-none disabled:opacity-55"
                >
                  {obsidianSyncing ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
                  {uiMessage('knowledge-base.connect.b3b35de2b3', (isZh) ? 'zh' : 'en')}
                </button>
              </div>

              <div className="mt-4 space-y-2">
                {obsidianVaults.length === 0 ? (
                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.035] px-3 py-4 text-center text-xs text-white/38">
                    {uiMessage('knowledge-base.no-obsidian-vault-connected-yet.125b265b01', (isZh) ? 'zh' : 'en')}
                  </div>
                ) : (
                  obsidianVaults.map(vault => {
                    const lastSync = vault.lastSyncAt ? new Date(vault.lastSyncAt).toLocaleString() : (uiMessage('knowledge-base.not-synced.74d82b0bf1', (isZh) ? 'zh' : 'en'));
                    const noteCount = Number(vault.noteCount || vault.lastSyncResult?.noteCount || 0);
                    return (
                      <div key={vault.id} className="rounded-xl border border-white/[0.07] bg-white/[0.04] p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-xs font-bold text-white/78">{vault.name}</span>
                              {!vault.exists && (
                                <span className="shrink-0 rounded-full border border-red-300/20 bg-red-300/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.08em] text-red-100/75">
                                  {uiMessage('knowledge-base.missing.1551891723', (isZh) ? 'zh' : 'en')}
                                </span>
                              )}
                              {vault.exists && !vault.isObsidianVault && (
                                <span className="shrink-0 rounded-full border border-amber-300/20 bg-amber-300/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.08em] text-amber-100/75">
                                  Markdown
                                </span>
                              )}
                            </div>
                            <p className="mt-1 truncate text-[11px] text-white/36">{vault.path}</p>
                            <p className="mt-2 text-[11px] text-white/42">
                              {formatUiMessage('knowledge-base.value0-notes-last-sync-value1.7ae09a37dc', { value0: noteCount, value1: lastSync }, (isZh) ? 'zh' : 'en')}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => void syncObsidianVault(vault.id)}
                              disabled={obsidianSyncing || vault.exists === false}
                              className="flex h-8 w-8 items-center justify-center rounded-xl border border-emerald-300/18 bg-emerald-300/10 text-emerald-100/72 transition-colors hover:bg-emerald-300/16 disabled:pointer-events-none disabled:opacity-45"
                              title={uiMessage('knowledge-base.sync-this-vault.88fee4dc09', (isZh) ? 'zh' : 'en')}
                              aria-label={uiMessage('knowledge-base.sync-this-vault.88fee4dc09', (isZh) ? 'zh' : 'en')}
                            >
                              <RefreshCw size={13} className={obsidianSyncing ? 'animate-spin' : ''} />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleObsidianDisconnect(vault)}
                              disabled={obsidianSyncing}
                              className="flex h-8 w-8 items-center justify-center rounded-xl border border-red-300/14 bg-red-300/8 text-red-100/58 transition-colors hover:bg-red-300/14 hover:text-red-100 disabled:pointer-events-none disabled:opacity-45"
                              title={uiMessage('knowledge-base.disconnect.e11e7dc3dc', (isZh) ? 'zh' : 'en')}
                              aria-label={uiMessage('knowledge-base.disconnect.e11e7dc3dc', (isZh) ? 'zh' : 'en')}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.div>
          )}

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
            onReferenceInChat={referenceKnowledgeFileInChat}
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
