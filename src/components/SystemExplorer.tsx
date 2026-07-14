import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Cpu,
  Database,
  HardDrive,
  Loader2,
  Mic,
  Monitor,
  RefreshCw,
  Shield,
  Sparkles,
  Wrench,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { usePlatform } from '@/hooks/usePlatform';
import { getSensorPermissionSnapshot, SENSOR_PERMISSIONS_CHANGED } from '@/services/sensorPermissionService';
import {
  COMMON_APP_MATCHERS,
  getSystemAppMatches,
  isSystemAppDetected,
} from '../../shared/system_apps';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import { systemExplorerCopy } from '../i18n/locales/systemExplorer';

interface DiskInfo {
  name: string;
  totalGB: number;
  freeGB: number;
  fsType?: string;
}

interface SystemSnapshot {
  id?: string;
  timestamp?: string;
  type?: 'first_boot' | 'daily_scan';
  computerScope?: 'lumi_server_host';
  hardware?: {
    platform?: string;
    arch?: string;
    hostname?: string;
    cpus?: { model?: string; cores?: number; threads?: number };
    totalMemoryGB?: number;
    gpus?: string[];
    disks?: DiskInfo[];
  };
  software?: {
    osVersion?: string;
    installedApps?: string[];
    appDiscovery?: {
      registryEntries?: number;
      startMenuShortcuts?: number;
      desktopShortcuts?: number;
      commonFolderEntries?: number;
      pathExecutables?: number;
      scannedRoots?: string[];
      limitReached?: boolean;
    };
    startupPrograms?: string[];
    nodeVersion?: string;
    pythonVersion?: string;
    runningServices?: string[];
  };
  filesystem?: {
    homeDir?: string;
    desktopFiles?: number;
    documentsFiles?: number;
    downloadsFiles?: number;
    totalUserFiles?: number;
    largeDirs?: { path: string; sizeMB: number }[];
    fileCountScope?: 'desktop_documents_downloads';
    fileCountMaxDepth?: number;
  };
  network?: {
    hostname?: string;
    interfaces?: string[];
    ipAddresses?: string[];
  };
  changeSummary?: string;
}

interface ProfessionProfile {
  profession: string;
  confidence?: number | string;
  score?: number;
}

interface EcosystemStats {
  skillCount?: number;
  enabledSkillCount?: number;
  connectedSkillCount?: number;
  toolCount?: number;
  agentCount?: number;
}

interface ProviderStatus {
  available: boolean;
  model?: string;
}

type PermissionStateValue = 'granted' | 'denied' | 'prompt' | 'unknown' | 'available' | 'unavailable';

interface AdaptationReport {
  status: 'ready' | 'partial' | 'needs_setup';
  readyCount: number;
  totalCount: number;
  capabilities: CapabilityItem[];
  suggestions: SetupSuggestion[];
}

interface CapabilityItem {
  id: string;
  label: string;
  status: 'ready' | 'partial' | 'missing';
  detail: string;
  actionLabel?: string;
  actionSection?: string;
}

interface SetupSuggestion {
  id: string;
  text: string;
  actionLabel?: string;
  actionSection?: string;
  priority: 'high' | 'medium' | 'low';
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function ui(isZh: boolean, zh: string, en: string) {
  return isZh ? zh : en;
}

function formatTime(value?: string, isZh = false) {
  if (!value) return uiMessage('system-explorer.never.7aaabcc4ec', (isZh) ? 'zh' : 'en');
  try { return new Date(value).toLocaleString(isZh ? 'zh-CN' : undefined); } catch { return value; }
}

function statusColor(status: CapabilityItem['status'] | AdaptationReport['status']) {
  if (status === 'ready') return 'text-emerald-300 bg-emerald-400/10 border-emerald-400/20';
  if (status === 'partial') return 'text-amber-300 bg-amber-400/10 border-amber-400/20';
  return 'text-red-300 bg-red-400/10 border-red-400/20';
}

function StatusIcon({ status }: { status: CapabilityItem['status'] }) {
  if (status === 'ready') return <CheckCircle2 size={16} className="text-emerald-300" />;
  if (status === 'partial') return <AlertCircle size={16} className="text-amber-300" />;
  return <XCircle size={16} className="text-red-300" />;
}

function getPermissionLabel(value?: PermissionStateValue, isZh = false) {
  if (!value || value === 'unknown') return uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en');
  if (value === 'granted') return uiMessage('system-explorer.granted.cfc584d5d6', (isZh) ? 'zh' : 'en');
  if (value === 'denied') return uiMessage('system-explorer.denied.004ef4d1ef', (isZh) ? 'zh' : 'en');
  if (value === 'prompt') return uiMessage('system-explorer.not-requested.9cc3d19cba', (isZh) ? 'zh' : 'en');
  if (value === 'available') return uiMessage('system-explorer.available.a4637fcb01', (isZh) ? 'zh' : 'en');
  return uiMessage('system-explorer.unavailable.a19c84a34b', (isZh) ? 'zh' : 'en');
}

function getAppGroupLabel(id: string, fallback: string, isZh: boolean) {
  const labels = systemExplorerCopy(isZh ? 'zh' : 'en').appGroups as Record<string, string>;
  return labels[id] || fallback;
}

function getPermissionName(key: string, isZh: boolean) {
  const labels = systemExplorerCopy(isZh ? 'zh' : 'en').permissions as Record<string, string>;
  return labels[key] || key;
}

function buildReport(
  latest: SystemSnapshot | null,
  permissions: Record<string, PermissionStateValue>,
  ecosystem: EcosystemStats | null,
  providers: Record<string, ProviderStatus>,
  isDesktop: boolean,
  isZh: boolean,
): AdaptationReport {
  const apps = latest?.software?.installedApps || [];
  const detectedApps = COMMON_APP_MATCHERS.filter(item => isSystemAppDetected(apps, item));
  const llmReady = Object.values(providers).filter(p => p.available).length;
  const nodeReady = Boolean(latest?.software?.nodeVersion) || detectedApps.some(a => a.id === 'node');
  const pythonReady = Boolean(latest?.software?.pythonVersion) || detectedApps.some(a => a.id === 'python');
  const hasOffice = detectedApps.some(a => a.id === 'wps');
  const commApps = getSystemAppMatches(apps, 'wechat', 4);
  const cadApps = getSystemAppMatches(apps, 'cad', 4);
  const aiApps = getSystemAppMatches(apps, 'ai_apps', 4);
  const musicApps = getSystemAppMatches(apps, 'netease', 4);
  const hasComms = commApps.length > 0;
  const hasCad = cadApps.length > 0;
  const hasAiApps = aiApps.length > 0;
  const hasMusic = musicApps.length > 0;

  const capabilities: CapabilityItem[] = [
    {
      id: 'desktop_shell',
      label: uiMessage('system-explorer.desktop-shell.634c816416', (isZh) ? 'zh' : 'en'),
      status: isDesktop ? 'ready' : 'missing',
      detail: isDesktop ? uiMessage('system-explorer.native-desktop-automation-bridge-is.9925e11c0b', (isZh) ? 'zh' : 'en') : uiMessage('system-explorer.desktop-automation-requires-the-tauri.150793d6f4', (isZh) ? 'zh' : 'en'),
    },
    {
      id: 'local_runtime',
      label: uiMessage('system-explorer.local-runtime.530d5e4cb8', (isZh) ? 'zh' : 'en'),
      status: nodeReady && pythonReady ? 'ready' : nodeReady || pythonReady ? 'partial' : 'missing',
      detail: `Node ${latest?.software?.nodeVersion || uiMessage('system-explorer.not-detected.5ca0f4dc91', (isZh) ? 'zh' : 'en')} / Python ${latest?.software?.pythonVersion || uiMessage('system-explorer.not-detected.5ca0f4dc91', (isZh) ? 'zh' : 'en')}`,
      actionLabel: nodeReady && pythonReady ? undefined : uiMessage('system-explorer.review-mcp.e42e25bdaf', (isZh) ? 'zh' : 'en'),
      actionSection: nodeReady && pythonReady ? undefined : 'tools',
    },
    {
      id: 'llm',
      label: uiMessage('system-explorer.ai-providers.727eb47f14', (isZh) ? 'zh' : 'en'),
      status: llmReady > 0 ? 'ready' : 'partial',
      detail: llmReady > 0 ? formatUiMessage('system-explorer.value0-provider-s-configured.79482e6f0f', { value0: llmReady }, (isZh) ? 'zh' : 'en') : uiMessage('system-explorer.no-provider-key-detected-yet.4d8c977571', (isZh) ? 'zh' : 'en'),
      actionLabel: llmReady > 0 ? undefined : uiMessage('system-explorer.add-provider.bf4c973279', (isZh) ? 'zh' : 'en'),
      actionSection: llmReady > 0 ? undefined : 'ai-providers',
    },
    {
      id: 'mcp',
      label: uiMessage('system-explorer.mcp-and-skills.0bbce8b9ac', (isZh) ? 'zh' : 'en'),
      status: (ecosystem?.enabledSkillCount || 0) > 0 ? 'ready' : (ecosystem?.skillCount || 0) > 0 ? 'partial' : 'missing',
      detail: formatUiMessage('system-explorer.value0-value1-skills-enabled-value2.1c3d9e8c13', { value0: ecosystem?.enabledSkillCount || 0, value1: ecosystem?.skillCount || 0, value2: ecosystem?.toolCount || 0 }, (isZh) ? 'zh' : 'en'),
      actionLabel: (ecosystem?.enabledSkillCount || 0) > 0 ? undefined : uiMessage('system-explorer.open-mcp.6aac86b030', (isZh) ? 'zh' : 'en'),
      actionSection: (ecosystem?.enabledSkillCount || 0) > 0 ? undefined : 'tools',
    },
    {
      id: 'knowledge_files',
      label: uiMessage('system-explorer.knowledge-files.166a683950', (isZh) ? 'zh' : 'en'),
      status: 'ready',
      detail: uiMessage('system-explorer.files-live-in-lumi-knowledge.1153562b59', (isZh) ? 'zh' : 'en'),
    },
    {
      id: 'sensors',
      label: uiMessage('system-explorer.mic-and-camera.8be2fe4a27', (isZh) ? 'zh' : 'en'),
      status: permissions.microphone === 'granted' || permissions.camera === 'granted'
        ? 'ready'
        : permissions.microphone === 'denied' || permissions.camera === 'denied'
          ? 'missing'
          : 'partial',
      detail: formatUiMessage('system-explorer.mic-value0-camera-value1.efb8a36889', { value0: { en: getPermissionLabel(permissions.microphone), zh: getPermissionLabel(permissions.microphone, isZh) }, value1: { en: getPermissionLabel(permissions.camera), zh: getPermissionLabel(permissions.camera, isZh) } }, (isZh) ? 'zh' : 'en'),
      actionLabel: permissions.microphone === 'granted' && permissions.camera === 'granted' ? undefined : uiMessage('system-explorer.open-hardware.25065f0afd', (isZh) ? 'zh' : 'en'),
      actionSection: permissions.microphone === 'granted' && permissions.camera === 'granted' ? undefined : 'hardware',
    },
    {
      id: 'office',
      label: uiMessage('system-explorer.office-and-documents.ba756146d4', (isZh) ? 'zh' : 'en'),
      status: hasOffice ? 'ready' : 'partial',
      detail: hasOffice ? uiMessage('system-explorer.office-wps-app-detected.cb2369717e', (isZh) ? 'zh' : 'en') : uiMessage('system-explorer.no-wps-office-app-detected.c057ff3540', (isZh) ? 'zh' : 'en'),
    },
    {
      id: 'messaging',
      label: uiMessage('system-explorer.messaging-apps.e93f9a0875', (isZh) ? 'zh' : 'en'),
      status: hasComms ? 'ready' : 'partial',
      detail: hasComms
        ? formatUiMessage('system-explorer.detected-value0-environment-detection-is.0752b3466b', { value0: { en: commApps.join(', '), zh: commApps.join('、') } }, (isZh) ? 'zh' : 'en')
        : uiMessage('system-explorer.messaging-app-not-detected-yet.fb220aa845', (isZh) ? 'zh' : 'en'),
    },
    {
      id: 'cad',
      label: uiMessage('system-explorer.cad-drafting.d30b4baac6', (isZh) ? 'zh' : 'en'),
      status: hasCad ? 'ready' : 'partial',
      detail: hasCad
        ? formatUiMessage('system-explorer.detected-value0-the-environment-is.10ede6869e', { value0: { en: cadApps.join(', '), zh: cadApps.join('、') } }, (isZh) ? 'zh' : 'en')
        : uiMessage('system-explorer.no-cad-app-detected-lumi.6a7f1c3d05', (isZh) ? 'zh' : 'en'),
    },
    {
      id: 'external_ai',
      label: uiMessage('system-explorer.external-ai-apps.1a49be2730', (isZh) ? 'zh' : 'en'),
      status: hasAiApps ? 'ready' : 'partial',
      detail: hasAiApps
        ? formatUiMessage('system-explorer.detected-value0-app-login-prompting.e38b6b2de7', { value0: { en: aiApps.join(', '), zh: aiApps.join('、') } }, (isZh) ? 'zh' : 'en')
        : uiMessage('system-explorer.no-local-ai-app-detected.f9839a0523', (isZh) ? 'zh' : 'en'),
    },
    {
      id: 'music',
      label: uiMessage('system-explorer.music-workflow.98c227d998', (isZh) ? 'zh' : 'en'),
      status: hasMusic ? 'ready' : 'partial',
      detail: hasMusic
        ? formatUiMessage('system-explorer.detected-value0-playback-and-controls.41f179030b', { value0: { en: musicApps.join(', '), zh: musicApps.join('、') } }, (isZh) ? 'zh' : 'en')
        : uiMessage('system-explorer.music-app-not-detected-lumi.82c5d4e6ab', (isZh) ? 'zh' : 'en'),
    },
  ];

  const readyCount = capabilities.filter(c => c.status === 'ready').length;
  const partialCount = capabilities.filter(c => c.status === 'partial').length;
  const totalCount = capabilities.length;
  const status: AdaptationReport['status'] =
    readyCount >= totalCount - 1 ? 'ready' :
    readyCount + partialCount >= Math.ceil(totalCount * 0.7) ? 'partial' :
    'needs_setup';

  const suggestions: SetupSuggestion[] = [];
  if (!isDesktop) suggestions.push({
    id: 'desktop',
    text: uiMessage('system-explorer.install-or-launch-the-desktop.2894f8e31a', (isZh) ? 'zh' : 'en'),
    priority: 'high',
  });
  if (!nodeReady) suggestions.push({
    id: 'node',
    text: uiMessage('system-explorer.install-node-js-if-you.b5276aecd6', (isZh) ? 'zh' : 'en'),
    actionLabel: uiMessage('system-explorer.open-mcp.6aac86b030', (isZh) ? 'zh' : 'en'),
    actionSection: 'tools',
    priority: 'medium',
  });
  if (!pythonReady) suggestions.push({
    id: 'python',
    text: uiMessage('system-explorer.install-python-if-you-want.226d7d6c6d', (isZh) ? 'zh' : 'en'),
    actionLabel: uiMessage('system-explorer.open-mcp.6aac86b030', (isZh) ? 'zh' : 'en'),
    actionSection: 'tools',
    priority: 'medium',
  });
  if (llmReady === 0) suggestions.push({
    id: 'llm',
    text: uiMessage('system-explorer.add-at-least-one-api.9d438f82d8', (isZh) ? 'zh' : 'en'),
    actionLabel: uiMessage('system-explorer.add-provider.bf4c973279', (isZh) ? 'zh' : 'en'),
    actionSection: 'ai-providers',
    priority: 'high',
  });
  if ((ecosystem?.enabledSkillCount || 0) === 0) suggestions.push({
    id: 'mcp',
    text: uiMessage('system-explorer.enable-at-least-one-mcp.1bccc5f0e7', (isZh) ? 'zh' : 'en'),
    actionLabel: uiMessage('system-explorer.open-mcp.6aac86b030', (isZh) ? 'zh' : 'en'),
    actionSection: 'tools',
    priority: 'medium',
  });
  if (permissions.microphone !== 'granted') suggestions.push({
    id: 'microphone',
    text: uiMessage('system-explorer.grant-microphone-access-when-you.fa5ae7c9ea', (isZh) ? 'zh' : 'en'),
    actionLabel: uiMessage('system-explorer.open-hardware.25065f0afd', (isZh) ? 'zh' : 'en'),
    actionSection: 'hardware',
    priority: 'medium',
  });
  if (permissions.camera !== 'granted') suggestions.push({
    id: 'camera',
    text: uiMessage('system-explorer.grant-camera-access-only-when.5b546a63f7', (isZh) ? 'zh' : 'en'),
    actionLabel: uiMessage('system-explorer.open-hardware.25065f0afd', (isZh) ? 'zh' : 'en'),
    actionSection: 'hardware',
    priority: 'low',
  });
  if (!hasOffice) suggestions.push({
    id: 'office',
    text: uiMessage('system-explorer.install-or-connect-your-preferred.aff851b466', (isZh) ? 'zh' : 'en'),
    priority: 'low',
  });

  return { status, readyCount, totalCount, capabilities, suggestions };
}

export function SystemExplorer({ t, onSectionChange }: { t?: any; onSectionChange?: (section: string) => void }) {
  const { isDesktop, isTauri } = usePlatform();
  const isZh = t?.langCode !== 'en';
  const [latest, setLatest] = useState<SystemSnapshot | null>(null);
  const [history, setHistory] = useState<SystemSnapshot[]>([]);
  const [profiles, setProfiles] = useState<ProfessionProfile[]>([]);
  const [ecosystem, setEcosystem] = useState<EcosystemStats | null>(null);
  const [providers, setProviders] = useState<Record<string, ProviderStatus>>({});
  const [permissions, setPermissions] = useState<Record<string, PermissionStateValue>>({});
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const loadPermissions = useCallback(async () => {
    const snapshot = await getSensorPermissionSnapshot({
      desktopAutomation: isTauri ? 'available' : 'unavailable',
    });
    setPermissions({
      microphone: snapshot.microphone as PermissionStateValue,
      camera: snapshot.camera as PermissionStateValue,
      notifications: snapshot.notifications as PermissionStateValue,
      desktopAutomation: snapshot.desktopAutomation || 'unknown',
    });
  }, [isTauri]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, historyRes, profRes, ecoRes, providerRes] = await Promise.all([
        fetch('/api/explore/status', { credentials: 'include' }),
        fetch('/api/explore/history', { credentials: 'include' }),
        fetch('/api/explore/profession', { credentials: 'include' }),
        fetch('/api/ecosystem/stats', { credentials: 'include' }),
        fetch('/api/llm/providers', { credentials: 'include' }),
        loadPermissions(),
      ]);
      const status = await statusRes.json().catch(() => ({}));
      const historyData = await historyRes.json().catch(() => ({}));
      const professionData = await profRes.json().catch(() => ({}));
      const ecosystemData = await ecoRes.json().catch(() => ({}));
      const providerData = await providerRes.json().catch(() => ({}));
      setLatest(status.latest || null);
      setHistory(historyData.snapshots || []);
      setProfiles(professionData.profiles || []);
      setEcosystem(ecosystemData || null);
      setProviders(providerData.providers || {});
    } catch (err: any) {
      toast.error(err?.message || uiMessage('system-explorer.failed-to-load-adaptation-report.15e33730d2', (isZh) ? 'zh' : 'en'));
    } finally {
      setLoading(false);
    }
  }, [loadPermissions]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const refresh = () => void loadPermissions();
    window.addEventListener(SENSOR_PERMISSIONS_CHANGED, refresh);
    window.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener(SENSOR_PERMISSIONS_CHANGED, refresh);
      window.removeEventListener('visibilitychange', refresh);
    };
  }, [loadPermissions]);

  const runScan = async () => {
    setScanning(true);
    try {
      const res = await fetch('/api/explore/scan', { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('system-explorer.computer-scan-failed.fa6815bf84', (isZh) ? 'zh' : 'en'));
      if (data.snapshot) {
        setLatest(data.snapshot);
        setHistory(prev => [data.snapshot, ...prev.filter(item => item.id !== data.snapshot.id)]);
      }
      toast.success(uiMessage('system-explorer.computer-adaptation-report-refreshed.afbd63dcf6', (isZh) ? 'zh' : 'en'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('system-explorer.computer-scan-failed.fa6815bf84', (isZh) ? 'zh' : 'en'));
    } finally {
      setScanning(false);
    }
  };

  const installProfessionAgents = async () => {
    try {
      const res = await fetch('/api/explore/profession/install', { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('system-explorer.failed-to-install-profession-agents.781aeed1b4', (isZh) ? 'zh' : 'en'));
      setProfiles(data.profiles || profiles);
      toast.success(formatUiMessage('system-explorer.installed-value0-profession-agent-s.d405e4517e', { value0: data.installed || 0 }, (isZh) ? 'zh' : 'en'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('system-explorer.failed-to-install-profession-agents.781aeed1b4', (isZh) ? 'zh' : 'en'));
    }
  };

  const report = useMemo(
    () => buildReport(latest, permissions, ecosystem, providers, isDesktop, isZh),
    [ecosystem, isDesktop, isZh, latest, permissions, providers],
  );

  const apps = latest?.software?.installedApps || [];
  const discovery = latest?.software?.appDiscovery;
  const detectedAppGroups = COMMON_APP_MATCHERS
    .map(item => ({
      ...item,
      matches: getSystemAppMatches(apps, item, 4),
    }))
    .filter(item => item.matches.length > 0);

  const copyReport = async () => {
    const lines = [
      uiMessage('system-explorer.lumi-computer-adaptation-report.c4d06d37ba', (isZh) ? 'zh' : 'en'),
      '',
      `${uiMessage('system-explorer.status.b8f1474d96', (isZh) ? 'zh' : 'en')}: ${report.status}`,
      `${uiMessage('system-explorer.score.6944d91537', (isZh) ? 'zh' : 'en')}: ${report.readyCount}/${report.totalCount} ${uiMessage('system-explorer.ready.d472b01242', (isZh) ? 'zh' : 'en')}`,
      `${uiMessage('system-explorer.host.e732aabf49', (isZh) ? 'zh' : 'en')}: ${latest?.hardware?.hostname || latest?.network?.hostname || uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en')}`,
      `${uiMessage('system-explorer.computer-scope.8cdbdb0aac', (isZh) ? 'zh' : 'en')}: ${uiMessage('system-explorer.lumi-server-host.88940fdc68', (isZh) ? 'zh' : 'en')}`,
      `OS: ${latest?.software?.osVersion || latest?.hardware?.platform || uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en')}`,
      `CPU: ${latest?.hardware?.cpus?.model || uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en')}`,
      `${uiMessage('system-explorer.memory.2c8fd6fe1f', (isZh) ? 'zh' : 'en')}: ${latest?.hardware?.totalMemoryGB || uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en')} GB`,
      `${uiMessage('system-explorer.last-scan.9d09d06882', (isZh) ? 'zh' : 'en')}: ${formatTime(latest?.timestamp, isZh)}`,
      '',
      uiMessage('system-explorer.capabilities.52852006c2', (isZh) ? 'zh' : 'en'),
      ...report.capabilities.map(item => `- ${item.label}: ${item.status} — ${item.detail}`),
      '',
      uiMessage('system-explorer.suggestions.cebe6b0764', (isZh) ? 'zh' : 'en'),
      ...(report.suggestions.length > 0 ? report.suggestions.map(item => `- [${item.priority}] ${item.text}`) : [uiMessage('system-explorer.no-setup-suggestions.21457e2ca4', (isZh) ? 'zh' : 'en')]),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success(uiMessage('system-explorer.adaptation-report-copied.af31c4ce36', (isZh) ? 'zh' : 'en'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('system-explorer.failed-to-copy-report.a19a8f9f8c', (isZh) ? 'zh' : 'en'));
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center text-white/45">
        <Loader2 size={18} className="mr-2 animate-spin" />
        {uiMessage('system-explorer.loading-computer-adaptation-report.098017d6ec', (isZh) ? 'zh' : 'en')}
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Monitor size={20} className="text-cyan-300" />
            <h3 className="text-xl font-bold uppercase tracking-normal text-white/90">
              {t?.computerAdaptation || uiMessage('system-explorer.computer-adaptation.6112f821aa', (isZh) ? 'zh' : 'en')}
            </h3>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/45">
            {uiMessage('system-explorer.this-report-describes-the-machine.9c6fdca89b', (isZh) ? 'zh' : 'en')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={copyReport}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-xs font-black uppercase tracking-widest text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            <Copy size={14} />
            {uiMessage('system-explorer.copy-report.33a25a2283', (isZh) ? 'zh' : 'en')}
          </button>
          <button
            onClick={runScan}
            disabled={scanning}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-cyan-300/25 bg-cyan-300/10 px-4 text-xs font-black uppercase tracking-widest text-cyan-100 transition-colors hover:bg-cyan-300/16 disabled:opacity-40"
          >
            <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
            {scanning ? uiMessage('system-explorer.scanning.2f595960f6', (isZh) ? 'zh' : 'en') : uiMessage('system-explorer.refresh-report.5e25a812a7', (isZh) ? 'zh' : 'en')}
          </button>
        </div>
      </div>

      <section className={`rounded-2xl border p-5 ${statusColor(report.status)}`}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-xs font-black uppercase tracking-[0.18em] opacity-70">{uiMessage('system-explorer.adaptation-score.52be51a16a', (isZh) ? 'zh' : 'en')}</div>
            <div className="mt-1 text-3xl font-black text-white">
              {report.readyCount}/{report.totalCount} {uiMessage('system-explorer.ready.d472b01242', (isZh) ? 'zh' : 'en')}
            </div>
          </div>
          <div className="text-sm leading-relaxed text-white/65 md:max-w-md">
             {report.status === 'ready'
               ? uiMessage('system-explorer.this-computer-environment-has-been.34067648b5', (isZh) ? 'zh' : 'en')
               : report.status === 'partial'
                 ? uiMessage('system-explorer.part-of-the-environment-is.af1add6d3e', (isZh) ? 'zh' : 'en')
                 : uiMessage('system-explorer.key-adaptation-prerequisites-are-still.9ee73a72cb', (isZh) ? 'zh' : 'en')}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <InfoPanel
          icon={<Cpu size={17} />}
          title={uiMessage('system-explorer.system.bd68977ed1', (isZh) ? 'zh' : 'en')}
          rows={[
            [uiMessage('system-explorer.host.e732aabf49', (isZh) ? 'zh' : 'en'), latest?.hardware?.hostname || latest?.network?.hostname || uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en')],
            ['OS', latest?.software?.osVersion || `${latest?.hardware?.platform || uiMessage('system-explorer.unknown.82d553bbee', (isZh) ? 'zh' : 'en')} ${latest?.hardware?.arch || ''}`],
            ['CPU', latest?.hardware?.cpus?.model || uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en')],
            [uiMessage('system-explorer.cores-threads.fdc5cb6e3d', (isZh) ? 'zh' : 'en'), latest?.hardware?.cpus ? `${latest.hardware.cpus.cores ?? '?'} / ${latest.hardware.cpus.threads ?? '?'}` : uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en')],
            [uiMessage('system-explorer.memory.2c8fd6fe1f', (isZh) ? 'zh' : 'en'), latest?.hardware?.totalMemoryGB ? `${latest.hardware.totalMemoryGB} GB` : uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en')],
          ]}
        />
        <InfoPanel
          icon={<HardDrive size={17} />}
          title={uiMessage('system-explorer.storage.2bcf954da9', (isZh) ? 'zh' : 'en')}
          rows={[
            [uiMessage('system-explorer.home.a65d5fe17a', (isZh) ? 'zh' : 'en'), latest?.filesystem?.homeDir || uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en')],
            [uiMessage('system-explorer.desktop-items.0ae932d238', (isZh) ? 'zh' : 'en'), String(latest?.filesystem?.desktopFiles ?? uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en'))],
            [uiMessage('system-explorer.documents-items.8463ae5248', (isZh) ? 'zh' : 'en'), String(latest?.filesystem?.documentsFiles ?? uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en'))],
            [uiMessage('system-explorer.downloads-items.f28a912a40', (isZh) ? 'zh' : 'en'), String(latest?.filesystem?.downloadsFiles ?? uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en'))],
            [uiMessage('system-explorer.counted-files.75688f91fb', (isZh) ? 'zh' : 'en'), String(latest?.filesystem?.totalUserFiles ?? uiMessage('system-explorer.unknown.d748bba592', (isZh) ? 'zh' : 'en'))],
          ]}
        />
        <InfoPanel
          icon={<Database size={17} />}
          title={uiMessage('system-explorer.lumi-runtime.f49ff341a2', (isZh) ? 'zh' : 'en')}
          rows={[
            [uiMessage('system-explorer.skills.2a98e03d13', (isZh) ? 'zh' : 'en'), formatUiMessage('system-explorer.value0-value1-enabled.39a43397ce', { value0: ecosystem?.enabledSkillCount || 0, value1: ecosystem?.skillCount || 0 }, (isZh) ? 'zh' : 'en')],
            [uiMessage('system-explorer.tools.f622b4dd19', (isZh) ? 'zh' : 'en'), String(ecosystem?.toolCount || 0)],
            [uiMessage('system-explorer.agents.8039b1040e', (isZh) ? 'zh' : 'en'), String(ecosystem?.agentCount || 0)],
            [uiMessage('system-explorer.last-scan.9d09d06882', (isZh) ? 'zh' : 'en'), formatTime(latest?.timestamp, isZh)],
          ]}
        />
      </div>

      <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
        <div className="mb-4 flex items-center gap-2">
          <Shield size={17} className="text-white/55" />
          <h4 className="text-sm font-black uppercase tracking-widest text-white/70">{uiMessage('system-explorer.capability-map.0c9a92f070', (isZh) ? 'zh' : 'en')}</h4>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {report.capabilities.map(item => (
            <div key={item.id} className="rounded-xl border border-white/8 bg-black/20 p-4">
              <div className="flex items-start gap-3">
                <StatusIcon status={item.status} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-white/82">{item.label}</div>
                  <div className="mt-1 text-xs leading-relaxed text-white/42">{item.detail}</div>
                </div>
                {item.actionSection && onSectionChange && (
                  <button
                    onClick={() => onSectionChange(item.actionSection!)}
                    className="shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] font-black uppercase tracking-widest text-white/45 hover:bg-white/[0.08] hover:text-white"
                  >
                    {item.actionLabel || uiMessage('system-explorer.open.0dbeeb1a9f', (isZh) ? 'zh' : 'en')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center gap-2">
            <Wrench size={17} className="text-white/55" />
            <h4 className="text-sm font-black uppercase tracking-widest text-white/70">{uiMessage('system-explorer.detected-apps.d95d3e891e', (isZh) ? 'zh' : 'en')}</h4>
          </div>
          {detectedAppGroups.length > 0 ? (
            <div className="space-y-3">
              {detectedAppGroups.map(group => (
                <div key={group.id} className="rounded-xl bg-black/18 px-3 py-2">
                  <div className="text-xs font-black uppercase tracking-widest text-white/55">{getAppGroupLabel(group.id, group.label, isZh)}</div>
                  <div className="mt-1 text-xs leading-relaxed text-white/38">
                    {group.matches.join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-white/40">{uiMessage('system-explorer.no-common-apps-were-matched.a312cd221a', (isZh) ? 'zh' : 'en')}</p>
          )}
          <div className="mt-4 text-xs text-white/30">
            {formatUiMessage('system-explorer.latest-scan-saw-value0-installed.11bfc73e38', { value0: apps.length }, (isZh) ? 'zh' : 'en')}
          </div>
          {discovery && (
            <div className="mt-2 text-xs leading-relaxed text-white/28">
              {formatUiMessage('system-explorer.sources-registry-value0-start-menu.a60f269dc0', { value0: discovery.registryEntries || 0, value1: discovery.startMenuShortcuts || 0, value2: discovery.desktopShortcuts || 0, value3: discovery.commonFolderEntries || 0, value4: discovery.pathExecutables || 0, value5: discovery.scannedRoots?.length || 0, value6: discovery.limitReached ? systemExplorerCopy(isZh ? 'zh' : 'en').limitReachedSuffix : '' }, (isZh) ? 'zh' : 'en')}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center gap-2">
            <Mic size={17} className="text-white/55" />
            <h4 className="text-sm font-black uppercase tracking-widest text-white/70">{uiMessage('system-explorer.permissions.be9338af25', (isZh) ? 'zh' : 'en')}</h4>
          </div>
          <div className="space-y-2">
            {Object.entries(permissions).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between rounded-xl bg-black/18 px-3 py-2 text-xs">
                <span className="font-bold capitalize text-white/55">{getPermissionName(key, isZh)}</span>
                <span className="text-white/40">{getPermissionLabel(value, isZh)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {profiles.length > 0 && (
        <section className="rounded-2xl border border-amber-300/12 bg-amber-300/[0.04] p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Sparkles size={17} className="text-amber-200" />
                <h4 className="text-sm font-black uppercase tracking-widest text-white/75">{uiMessage('system-explorer.work-profile.e7297e9c26', (isZh) ? 'zh' : 'en')}</h4>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {profiles.map(profile => {
                  const confidence = Number(profile.confidence ?? profile.score ?? 0);
                  return (
                    <span key={profile.profession} className="rounded-full border border-amber-300/16 bg-amber-300/8 px-3 py-1 text-xs font-bold text-amber-100/80">
                      {profile.profession} {confidence ? percent(confidence) : ''}
                    </span>
                  );
                })}
              </div>
            </div>
            <button
              onClick={installProfessionAgents}
              className="h-10 rounded-xl border border-amber-300/25 bg-amber-300/10 px-4 text-xs font-black uppercase tracking-widest text-amber-100 transition-colors hover:bg-amber-300/16"
            >
              {uiMessage('system-explorer.install-agents.1f1acb3e5d', (isZh) ? 'zh' : 'en')}
            </button>
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
        <div className="mb-4 text-sm font-black uppercase tracking-widest text-white/70">{uiMessage('system-explorer.workflow-environment.42bfbf30f2', (isZh) ? 'zh' : 'en')}</div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <WorkflowTile
            title={uiMessage('system-explorer.knowledge-files.166a683950', (isZh) ? 'zh' : 'en')}
            detail={uiMessage('system-explorer.uploaded-knowledge-files-are-absorbed.ab7be47a64', (isZh) ? 'zh' : 'en')}
            ready={true}
          />
          <WorkflowTile
            title={uiMessage('system-explorer.voice-and-meetings.20076dcba8', (isZh) ? 'zh' : 'en')}
            detail={permissions.microphone === 'granted' ? uiMessage('system-explorer.meeting-mode-and-speech-interaction.c5070e78fa', (isZh) ? 'zh' : 'en') : uiMessage('system-explorer.grant-microphone-only-when-you.668cbf7c0f', (isZh) ? 'zh' : 'en')}
            ready={permissions.microphone === 'granted'}
          />
          <WorkflowTile
            title={uiMessage('system-explorer.generated-skills.5ff448f10c', (isZh) ? 'zh' : 'en')}
            detail={(ecosystem?.enabledSkillCount || 0) > 0 ? uiMessage('system-explorer.mcp-skills-are-enabled-and.a8b5eed7ba', (isZh) ? 'zh' : 'en') : uiMessage('system-explorer.enable-mcp-skills-before-relying.89c4f5a7c4', (isZh) ? 'zh' : 'en')}
            ready={(ecosystem?.enabledSkillCount || 0) > 0}
          />
          <WorkflowTile
            title={uiMessage('system-explorer.document-work.cffa7bf266', (isZh) ? 'zh' : 'en')}
            detail={detectedAppGroups.some(group => group.id === 'wps') ? uiMessage('system-explorer.office-wps-was-detected-actual.8c7ca6f2bf', (isZh) ? 'zh' : 'en') : uiMessage('system-explorer.no-office-wps-app-was.46f876d440', (isZh) ? 'zh' : 'en')}
            ready={detectedAppGroups.some(group => group.id === 'wps')}
          />
          <WorkflowTile
            title={uiMessage('system-explorer.developer-work.7250e012e2', (isZh) ? 'zh' : 'en')}
            detail={detectedAppGroups.some(group => group.id === 'vscode' || group.id === 'git') ? uiMessage('system-explorer.developer-tools-were-detected.2dab9ce534', (isZh) ? 'zh' : 'en') : uiMessage('system-explorer.install-vs-code-git-node.d97529992b', (isZh) ? 'zh' : 'en')}
            ready={detectedAppGroups.some(group => group.id === 'vscode' || group.id === 'git')}
          />
          <WorkflowTile
            title={uiMessage('system-explorer.external-apps.fb16db7b2f', (isZh) ? 'zh' : 'en')}
            detail={detectedAppGroups.some(group => group.id === 'wechat' || group.id === 'cad' || group.id === 'ai_apps') ? uiMessage('system-explorer.messaging-cad-ai-app-handoff.741c6f0f06', (isZh) ? 'zh' : 'en') : uiMessage('system-explorer.lumi-can-still-prepare-drafts.5469f876b7', (isZh) ? 'zh' : 'en')}
            ready={detectedAppGroups.some(group => group.id === 'wechat' || group.id === 'cad' || group.id === 'ai_apps')}
          />
          <WorkflowTile
            title={uiMessage('system-explorer.music-playback.eb88681e22', (isZh) ? 'zh' : 'en')}
            detail={detectedAppGroups.some(group => group.id === 'netease') ? uiMessage('system-explorer.a-music-app-was-detected.c7933a87a2', (isZh) ? 'zh' : 'en') : uiMessage('system-explorer.no-local-music-app-was.e2f05f03f0', (isZh) ? 'zh' : 'en')}
            ready={detectedAppGroups.some(group => group.id === 'netease')}
          />
        </div>
      </section>

      <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
        <div className="mb-4 text-sm font-black uppercase tracking-widest text-white/70">{uiMessage('system-explorer.recommended-setup.065ab674e2', (isZh) ? 'zh' : 'en')}</div>
        {report.suggestions.length > 0 ? (
          <div className="space-y-2">
            {report.suggestions.map(item => (
              <div key={item.id} className="flex flex-col gap-3 rounded-xl bg-black/18 px-3 py-3 text-sm leading-relaxed text-white/52 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex gap-3">
                  <AlertCircle size={15} className={`mt-0.5 shrink-0 ${
                    item.priority === 'high' ? 'text-red-200/75' : item.priority === 'medium' ? 'text-amber-200/75' : 'text-cyan-200/70'
                  }`} />
                  <span>{item.text}</span>
                </div>
                {item.actionSection && onSectionChange && (
                  <button
                    onClick={() => onSectionChange(item.actionSection!)}
                    className="shrink-0 self-start rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-white/45 hover:bg-white/[0.08] hover:text-white sm:self-center"
                  >
                    {item.actionLabel || uiMessage('system-explorer.open.0dbeeb1a9f', (isZh) ? 'zh' : 'en')}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex gap-3 rounded-xl bg-emerald-300/8 px-3 py-2 text-sm text-emerald-100/70">
            <CheckCircle2 size={15} />
            {uiMessage('system-explorer.this-computer-looks-ready-for.c2544a5c0b', (isZh) ? 'zh' : 'en')}
          </div>
        )}
      </section>

      {latest?.hardware?.disks && latest.hardware.disks.length > 0 && (
        <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 text-sm font-black uppercase tracking-widest text-white/70">{uiMessage('system-explorer.disks.edbc3837ac', (isZh) ? 'zh' : 'en')}</div>
          <div className="space-y-2">
            {latest.hardware.disks.map(disk => (
              <div key={disk.name} className="rounded-xl bg-black/18 p-3">
                <div className="flex items-center justify-between text-xs text-white/52">
                  <span className="font-bold">{disk.name}{disk.fsType ? ` · ${disk.fsType}` : ''}</span>
                  <span>{formatUiMessage('system-explorer.value0-gb-free-value1-gb.8f4d25e84b', { value0: disk.freeGB, value1: disk.totalGB }, (isZh) ? 'zh' : 'en')}</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
                  <div
                    className="h-full rounded-full bg-cyan-300/65"
                    style={{ width: `${Math.max(4, Math.min(100, ((disk.totalGB - disk.freeGB) / Math.max(1, disk.totalGB)) * 100))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {history.length > 0 && (
        <div className="text-xs text-white/30">
          {formatUiMessage('system-explorer.scan-history-value0-snapshot-s.87dc26fe22', { value0: history.length, value1: latest?.type || systemExplorerCopy(isZh ? 'zh' : 'en').unknown }, (isZh) ? 'zh' : 'en')}
        </div>
      )}
    </div>
  );
}

function WorkflowTile({ title, detail, ready }: { title: string; detail: string; ready: boolean }) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/20 p-4">
      <div className="flex items-center gap-2">
        {ready ? <CheckCircle2 size={16} className="text-emerald-300" /> : <AlertCircle size={16} className="text-amber-300" />}
        <div className="text-sm font-bold text-white/78">{title}</div>
      </div>
      <div className="mt-2 text-xs leading-relaxed text-white/38">{detail}</div>
    </div>
  );
}

function InfoPanel({ icon, title, rows }: { icon: React.ReactNode; title: string; rows: Array<[string, string]> }) {
  return (
    <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="text-white/55">{icon}</span>
        <h4 className="text-sm font-black uppercase tracking-widest text-white/70">{title}</h4>
      </div>
      <div className="space-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-start justify-between gap-3 text-xs">
            <span className="shrink-0 text-white/35">{label}</span>
            <span className="min-w-0 truncate text-right font-mono text-white/58" title={value}>{value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
