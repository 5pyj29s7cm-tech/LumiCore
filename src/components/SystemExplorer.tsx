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

const COMMON_APP_MATCHERS = [
  { id: 'browser', label: 'Browser', patterns: [/chrome/i, /edge/i, /firefox/i, /brave/i] },
  { id: 'vscode', label: 'VS Code', patterns: [/visual studio code/i, /\bvs code\b/i] },
  { id: 'git', label: 'Git', patterns: [/\bgit\b/i] },
  { id: 'node', label: 'Node.js', patterns: [/node\.js/i] },
  { id: 'python', label: 'Python', patterns: [/python/i] },
  { id: 'wps', label: 'WPS / Office', patterns: [/wps/i, /microsoft office/i, /word/i, /powerpoint/i, /excel/i] },
  { id: 'wechat', label: 'WeChat', patterns: [/wechat/i, /weixin/i, /wechat work/i] },
  { id: 'cad', label: 'CAD', patterns: [/autocad/i, /\bcad\b/i, /zwcad/i, /gstarcad/i, /浩辰/i, /中望/i, /天正/i, /solidworks/i, /revit/i, /rhino/i] },
  {
    id: 'ai_apps',
    label: 'Local AI Apps',
    patterns: [
      /workbuddy/i, /codex/i, /chatgpt/i, /claude/i, /gemini/i, /deepseek/i,
      /kimi/i, /豆包/i, /doubao/i, /通义/i, /千问/i, /qwen/i, /文心/i,
      /ernie/i, /copilot/i, /cursor/i, /cherry studio/i, /ollama/i,
      /lm studio/i, /anythingllm/i,
    ],
  },
  { id: 'netease', label: 'NetEase Music', patterns: [/netease/i, /cloud music/i, /music\.163/i] },
];

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function ui(isZh: boolean, zh: string, en: string) {
  return isZh ? zh : en;
}

function formatTime(value?: string, isZh = false) {
  if (!value) return ui(isZh, '从未', 'Never');
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

function isAppDetected(apps: string[], matcher: (typeof COMMON_APP_MATCHERS)[number]) {
  return apps.some(app => matcher.patterns.some(pattern => pattern.test(app)));
}

function getPermissionLabel(value?: PermissionStateValue, isZh = false) {
  if (!value || value === 'unknown') return ui(isZh, '未知', 'Unknown');
  if (value === 'granted') return ui(isZh, '已授权', 'Granted');
  if (value === 'denied') return ui(isZh, '已拒绝', 'Denied');
  if (value === 'prompt') return ui(isZh, '未请求', 'Not requested');
  if (value === 'available') return ui(isZh, '可用', 'Available');
  return ui(isZh, '不可用', 'Unavailable');
}

function getAppGroupLabel(id: string, fallback: string, isZh: boolean) {
  if (!isZh) return fallback;
  const labels: Record<string, string> = {
    browser: '浏览器',
    vscode: 'VS Code',
    git: 'Git',
    node: 'Node.js',
    python: 'Python',
    wps: 'WPS / Office',
    wechat: '微信 / 企业通讯',
    cad: 'CAD',
    ai_apps: '本地 AI 应用',
    netease: '网易云音乐',
  };
  return labels[id] || fallback;
}

function getPermissionName(key: string, isZh: boolean) {
  if (!isZh) return key.replace(/([A-Z])/g, ' $1');
  const labels: Record<string, string> = {
    microphone: '麦克风',
    camera: '摄像头',
    notifications: '通知',
    desktopAutomation: '桌面控制',
  };
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
  const detectedApps = COMMON_APP_MATCHERS.filter(item => isAppDetected(apps, item));
  const llmReady = Object.values(providers).filter(p => p.available).length;
  const nodeReady = Boolean(latest?.software?.nodeVersion) || detectedApps.some(a => a.id === 'node');
  const pythonReady = Boolean(latest?.software?.pythonVersion) || detectedApps.some(a => a.id === 'python');
  const hasOffice = detectedApps.some(a => a.id === 'wps');
  const hasComms = detectedApps.some(a => a.id === 'wechat');
  const hasCad = detectedApps.some(a => a.id === 'cad');
  const hasAiApps = detectedApps.some(a => a.id === 'ai_apps');
  const hasMusic = detectedApps.some(a => a.id === 'netease');

  const capabilities: CapabilityItem[] = [
    {
      id: 'desktop_shell',
      label: ui(isZh, '桌面壳能力', 'Desktop shell'),
      status: isDesktop ? 'ready' : 'missing',
      detail: isDesktop ? ui(isZh, '原生桌面自动化桥接可用。', 'Native desktop automation bridge is available.') : ui(isZh, '桌面自动化需要 Tauri 客户端。', 'Desktop automation requires the Tauri client.'),
    },
    {
      id: 'local_runtime',
      label: ui(isZh, '本地运行环境', 'Local runtime'),
      status: nodeReady && pythonReady ? 'ready' : nodeReady || pythonReady ? 'partial' : 'missing',
      detail: `Node ${latest?.software?.nodeVersion || ui(isZh, '未检测到', 'not detected')} / Python ${latest?.software?.pythonVersion || ui(isZh, '未检测到', 'not detected')}`,
      actionLabel: nodeReady && pythonReady ? undefined : ui(isZh, '查看 MCP', 'Review MCP'),
      actionSection: nodeReady && pythonReady ? undefined : 'mcp',
    },
    {
      id: 'llm',
      label: ui(isZh, 'AI 服务商', 'AI providers'),
      status: llmReady > 0 ? 'ready' : 'partial',
      detail: llmReady > 0 ? ui(isZh, `已配置 ${llmReady} 个服务商。`, `${llmReady} provider(s) configured.`) : ui(isZh, '尚未检测到服务商密钥。', 'No provider key detected yet.'),
      actionLabel: llmReady > 0 ? undefined : ui(isZh, '添加服务商', 'Add provider'),
      actionSection: llmReady > 0 ? undefined : 'llm-providers',
    },
    {
      id: 'mcp',
      label: ui(isZh, 'MCP 与技能', 'MCP and skills'),
      status: (ecosystem?.enabledSkillCount || 0) > 0 ? 'ready' : (ecosystem?.skillCount || 0) > 0 ? 'partial' : 'missing',
      detail: ui(isZh, `已启用 ${ecosystem?.enabledSkillCount || 0}/${ecosystem?.skillCount || 0} 个技能，已注册 ${ecosystem?.toolCount || 0} 个工具。`, `${ecosystem?.enabledSkillCount || 0}/${ecosystem?.skillCount || 0} skills enabled, ${ecosystem?.toolCount || 0} tools registered.`),
      actionLabel: (ecosystem?.enabledSkillCount || 0) > 0 ? undefined : ui(isZh, '打开 MCP', 'Open MCP'),
      actionSection: (ecosystem?.enabledSkillCount || 0) > 0 ? undefined : 'mcp',
    },
    {
      id: 'knowledge_files',
      label: ui(isZh, '知识库文件', 'Knowledge files'),
      status: 'ready',
      detail: ui(isZh, '文件会进入 Lumi 知识库，并由知识库负责浏览、吸收和检索。', 'Files live in Lumi Knowledge Base, where they can be browsed, absorbed, and retrieved.'),
    },
    {
      id: 'sensors',
      label: ui(isZh, '麦克风与摄像头', 'Mic and camera'),
      status: permissions.microphone === 'granted' || permissions.camera === 'granted'
        ? 'ready'
        : permissions.microphone === 'denied' || permissions.camera === 'denied'
          ? 'missing'
          : 'partial',
      detail: ui(isZh, `麦克风 ${getPermissionLabel(permissions.microphone, isZh)}，摄像头 ${getPermissionLabel(permissions.camera, isZh)}`, `Mic ${getPermissionLabel(permissions.microphone)}, Camera ${getPermissionLabel(permissions.camera)}`),
      actionLabel: permissions.microphone === 'granted' && permissions.camera === 'granted' ? undefined : ui(isZh, '打开硬件设置', 'Open hardware'),
      actionSection: permissions.microphone === 'granted' && permissions.camera === 'granted' ? undefined : 'hardware',
    },
    {
      id: 'office',
      label: ui(isZh, '办公与文档', 'Office and documents'),
      status: hasOffice ? 'ready' : 'partial',
      detail: hasOffice ? ui(isZh, '已检测到 Office/WPS 应用。', 'Office/WPS app detected.') : ui(isZh, '最近扫描未检测到 WPS/Office 应用。', 'No WPS/Office app detected in the latest scan.'),
    },
    {
      id: 'messaging',
      label: ui(isZh, '通讯应用', 'Messaging apps'),
      status: hasComms ? 'ready' : 'partial',
      detail: hasComms ? ui(isZh, '已检测到微信/企业通讯应用。', 'WeChat/enterprise messaging app detected.') : ui(isZh, '尚未检测到通讯应用。', 'Messaging app not detected yet.'),
    },
    {
      id: 'cad',
      label: ui(isZh, 'CAD 制图', 'CAD drafting'),
      status: hasCad ? 'ready' : 'partial',
      detail: hasCad ? ui(isZh, '已检测到 CAD 应用。Lumi 可以生成 DXF 草图供你检查。', 'CAD app detected. Lumi can generate DXF drafts for review.') : ui(isZh, '未检测到 CAD 应用；Lumi 仍可生成 DXF 草稿文件。', 'No CAD app detected; Lumi can still generate DXF draft files.'),
    },
    {
      id: 'external_ai',
      label: ui(isZh, '外部 AI 应用', 'External AI apps'),
      status: hasAiApps ? 'ready' : 'partial',
      detail: hasAiApps ? ui(isZh, '已检测到本地 AI 应用。优先通过 MCP、文件或浏览器交接，再使用视觉控制。', 'Local AI app detected. Prefer MCP/file/browser handoff before visual control.') : ui(isZh, '未检测到本地 AI 应用；Lumi 仍可通过浏览器和 MCP 协同。', 'No local AI app detected; Lumi can still coordinate through browser and MCP.'),
    },
    {
      id: 'music',
      label: ui(isZh, '音乐工作流', 'Music workflow'),
      status: hasMusic ? 'ready' : 'partial',
      detail: hasMusic ? ui(isZh, '已检测到网易云/音乐应用。', 'NetEase/Cloud Music app detected.') : ui(isZh, '未检测到音乐应用；Lumi 音乐能力仍可使用已配置服务。', 'Music app not detected; Lumi music playback can still use configured services.'),
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
    text: ui(isZh, '安装或启动桌面客户端，才能启用知识库导入和桌面控制。', 'Install or launch the desktop client to enable desktop control and knowledge import.'),
    priority: 'high',
  });
  if (!nodeReady) suggestions.push({
    id: 'node',
    text: ui(isZh, '如果要让本地 MCP 工具和生成技能稳定运行，建议安装 Node.js。', 'Install Node.js if you want local MCP tools and generated skills to run smoothly.'),
    actionLabel: ui(isZh, '打开 MCP', 'Open MCP'),
    actionSection: 'mcp',
    priority: 'medium',
  });
  if (!pythonReady) suggestions.push({
    id: 'python',
    text: ui(isZh, '如果要使用依赖 Python 的文档、图像、视频或自动化技能，建议安装 Python。', 'Install Python if you want document, image, video, or automation skills that depend on Python.'),
    actionLabel: ui(isZh, '打开 MCP', 'Open MCP'),
    actionSection: 'mcp',
    priority: 'medium',
  });
  if (llmReady === 0) suggestions.push({
    id: 'llm',
    text: ui(isZh, '请在“设置 > LLM 服务商”里至少添加一个 API Key。', 'Add at least one API key in Settings > LLM Providers.'),
    actionLabel: ui(isZh, '添加服务商', 'Add provider'),
    actionSection: 'llm-providers',
    priority: 'high',
  });
  if ((ecosystem?.enabledSkillCount || 0) === 0) suggestions.push({
    id: 'mcp',
    text: ui(isZh, '请在技能大厅或 MCP 设置里至少启用一个 MCP 技能。', 'Enable at least one MCP skill from Skill Center or MCP Settings.'),
    actionLabel: ui(isZh, '打开 MCP', 'Open MCP'),
    actionSection: 'mcp',
    priority: 'medium',
  });
  if (permissions.microphone !== 'granted') suggestions.push({
    id: 'microphone',
    text: ui(isZh, '需要语音、会议、唤醒词或声纹时，再授权麦克风。', 'Grant microphone access when you want voice, meetings, wake word, or voiceprint.'),
    actionLabel: ui(isZh, '打开硬件设置', 'Open hardware'),
    actionSection: 'hardware',
    priority: 'medium',
  });
  if (permissions.camera !== 'granted') suggestions.push({
    id: 'camera',
    text: ui(isZh, '需要在场感知、人脸识别或手势能力时，再授权摄像头。', 'Grant camera access only when you want presence, face recognition, or gesture features.'),
    actionLabel: ui(isZh, '打开硬件设置', 'Open hardware'),
    actionSection: 'hardware',
    priority: 'low',
  });
  if (!hasOffice) suggestions.push({
    id: 'office',
    text: ui(isZh, '如果希望 Lumi 操作 Office/WPS 工作流，请安装或连接你常用的文档套件。', 'Install or connect your preferred document suite if Lumi should operate Office/WPS workflows.'),
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
      toast.error(err?.message || ui(isZh, '电脑适配报告加载失败', 'Failed to load adaptation report'));
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
      if (!res.ok) throw new Error(data.error || ui(isZh, '电脑扫描失败', 'Computer scan failed'));
      if (data.snapshot) {
        setLatest(data.snapshot);
        setHistory(prev => [data.snapshot, ...prev.filter(item => item.id !== data.snapshot.id)]);
      }
      toast.success(ui(isZh, '电脑适配报告已刷新', 'Computer adaptation report refreshed'));
    } catch (err: any) {
      toast.error(err?.message || ui(isZh, '电脑扫描失败', 'Computer scan failed'));
    } finally {
      setScanning(false);
    }
  };

  const installProfessionAgents = async () => {
    try {
      const res = await fetch('/api/explore/profession/install', { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui(isZh, '职业智能体安装失败', 'Failed to install profession agents'));
      setProfiles(data.profiles || profiles);
      toast.success(ui(isZh, `已安装 ${data.installed || 0} 个职业智能体`, `Installed ${data.installed || 0} profession agent(s)`));
    } catch (err: any) {
      toast.error(err?.message || ui(isZh, '职业智能体安装失败', 'Failed to install profession agents'));
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
      matches: apps.filter(app => item.patterns.some(pattern => pattern.test(app))).slice(0, 4),
    }))
    .filter(item => item.matches.length > 0);

  const copyReport = async () => {
    const lines = [
      ui(isZh, '# Lumi 电脑适配报告', '# Lumi Computer Adaptation Report'),
      '',
      `${ui(isZh, '状态', 'Status')}: ${report.status}`,
      `${ui(isZh, '分数', 'Score')}: ${report.readyCount}/${report.totalCount} ${ui(isZh, '就绪', 'ready')}`,
      `${ui(isZh, '主机', 'Host')}: ${latest?.hardware?.hostname || latest?.network?.hostname || ui(isZh, '未知', 'Unknown')}`,
      `${ui(isZh, '采集范围', 'Computer scope')}: ${ui(isZh, 'Lumi 服务运行本机', 'Lumi server host')}`,
      `OS: ${latest?.software?.osVersion || latest?.hardware?.platform || ui(isZh, '未知', 'Unknown')}`,
      `CPU: ${latest?.hardware?.cpus?.model || ui(isZh, '未知', 'Unknown')}`,
      `${ui(isZh, '内存', 'Memory')}: ${latest?.hardware?.totalMemoryGB || ui(isZh, '未知', 'Unknown')} GB`,
      `${ui(isZh, '最近扫描', 'Last scan')}: ${formatTime(latest?.timestamp, isZh)}`,
      '',
      ui(isZh, '## 能力', '## Capabilities'),
      ...report.capabilities.map(item => `- ${item.label}: ${item.status} — ${item.detail}`),
      '',
      ui(isZh, '## 建议', '## Suggestions'),
      ...(report.suggestions.length > 0 ? report.suggestions.map(item => `- [${item.priority}] ${item.text}`) : [ui(isZh, '- 暂无设置建议。', '- No setup suggestions.')]),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success(ui(isZh, '适配报告已复制', 'Adaptation report copied'));
    } catch (err: any) {
      toast.error(err?.message || ui(isZh, '复制报告失败', 'Failed to copy report'));
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center text-white/45">
        <Loader2 size={18} className="mr-2 animate-spin" />
        {ui(isZh, '正在加载电脑适配报告...', 'Loading computer adaptation report...')}
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
              {t?.computerAdaptation || ui(isZh, '电脑适配', 'Computer Adaptation')}
            </h3>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/45">
            {ui(isZh, '这里检查的是运行 Lumi 服务的本机，不是组织网页访问者的电脑。文件统计只覆盖桌面、文档和下载目录的有限深度，不会索引全盘，也不会主动请求传感器权限。', 'This report describes the machine running the Lumi service, not an organization web visitor\'s computer. File counts use bounded scans of Desktop, Documents, and Downloads; this page does not index the full disk or request sensor access.')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={copyReport}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-xs font-black uppercase tracking-widest text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            <Copy size={14} />
            {ui(isZh, '复制报告', 'Copy Report')}
          </button>
          <button
            onClick={runScan}
            disabled={scanning}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-cyan-300/25 bg-cyan-300/10 px-4 text-xs font-black uppercase tracking-widest text-cyan-100 transition-colors hover:bg-cyan-300/16 disabled:opacity-40"
          >
            <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
            {scanning ? ui(isZh, '扫描中', 'Scanning') : ui(isZh, '刷新报告', 'Refresh Report')}
          </button>
        </div>
      </div>

      <section className={`rounded-2xl border p-5 ${statusColor(report.status)}`}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-xs font-black uppercase tracking-[0.18em] opacity-70">{ui(isZh, '适配评分', 'Adaptation Score')}</div>
            <div className="mt-1 text-3xl font-black text-white">
              {report.readyCount}/{report.totalCount} {ui(isZh, '就绪', 'ready')}
            </div>
          </div>
          <div className="text-sm leading-relaxed text-white/65 md:max-w-md">
            {report.status === 'ready'
              ? ui(isZh, 'Lumi 已经比较了解这台电脑，可以更稳地调度大多数桌面工作流。', 'Lumi has a strong map of this computer and can route most desktop workflows safely.')
              : report.status === 'partial'
                ? ui(isZh, 'Lumi 可以在这里工作，但补齐少量权限或本地工具后会更顺手。', 'Lumi can work here, but a few permissions or local tools would make the client smoother.')
                : ui(isZh, '这台电脑还需要完成几项设置，Lumi 才能真正适配。', 'Lumi needs a few setup steps before this computer feels fully adapted.')}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <InfoPanel
          icon={<Cpu size={17} />}
          title={ui(isZh, '系统', 'System')}
          rows={[
            [ui(isZh, '主机', 'Host'), latest?.hardware?.hostname || latest?.network?.hostname || ui(isZh, '未知', 'Unknown')],
            ['OS', latest?.software?.osVersion || `${latest?.hardware?.platform || ui(isZh, '未知', 'unknown')} ${latest?.hardware?.arch || ''}`],
            ['CPU', latest?.hardware?.cpus?.model || ui(isZh, '未知', 'Unknown')],
            [ui(isZh, '核心 / 线程', 'Cores / threads'), latest?.hardware?.cpus ? `${latest.hardware.cpus.cores ?? '?'} / ${latest.hardware.cpus.threads ?? '?'}` : ui(isZh, '未知', 'Unknown')],
            [ui(isZh, '内存', 'Memory'), latest?.hardware?.totalMemoryGB ? `${latest.hardware.totalMemoryGB} GB` : ui(isZh, '未知', 'Unknown')],
          ]}
        />
        <InfoPanel
          icon={<HardDrive size={17} />}
          title={ui(isZh, '存储', 'Storage')}
          rows={[
            [ui(isZh, '用户目录', 'Home'), latest?.filesystem?.homeDir || ui(isZh, '未知', 'Unknown')],
            [ui(isZh, '桌面项目', 'Desktop items'), String(latest?.filesystem?.desktopFiles ?? ui(isZh, '未知', 'Unknown'))],
            [ui(isZh, '文档项目', 'Documents items'), String(latest?.filesystem?.documentsFiles ?? ui(isZh, '未知', 'Unknown'))],
            [ui(isZh, '下载项目', 'Downloads items'), String(latest?.filesystem?.downloadsFiles ?? ui(isZh, '未知', 'Unknown'))],
            [ui(isZh, '已统计文件', 'Counted files'), String(latest?.filesystem?.totalUserFiles ?? ui(isZh, '未知', 'Unknown'))],
          ]}
        />
        <InfoPanel
          icon={<Database size={17} />}
          title={ui(isZh, 'Lumi 运行时', 'Lumi Runtime')}
          rows={[
            [ui(isZh, '技能', 'Skills'), ui(isZh, `${ecosystem?.enabledSkillCount || 0}/${ecosystem?.skillCount || 0} 已启用`, `${ecosystem?.enabledSkillCount || 0}/${ecosystem?.skillCount || 0} enabled`)],
            [ui(isZh, '工具', 'Tools'), String(ecosystem?.toolCount || 0)],
            [ui(isZh, '智能体', 'Agents'), String(ecosystem?.agentCount || 0)],
            [ui(isZh, '最近扫描', 'Last scan'), formatTime(latest?.timestamp, isZh)],
          ]}
        />
      </div>

      <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
        <div className="mb-4 flex items-center gap-2">
          <Shield size={17} className="text-white/55" />
          <h4 className="text-sm font-black uppercase tracking-widest text-white/70">{ui(isZh, '能力地图', 'Capability Map')}</h4>
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
                    {item.actionLabel || ui(isZh, '打开', 'Open')}
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
            <h4 className="text-sm font-black uppercase tracking-widest text-white/70">{ui(isZh, '已检测应用', 'Detected Apps')}</h4>
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
            <p className="text-sm text-white/40">{ui(isZh, '最近扫描未匹配到常用应用。', 'No common apps were matched in the latest scan.')}</p>
          )}
          <div className="mt-4 text-xs text-white/30">
            {ui(isZh, `最近扫描看到 ${apps.length} 条已安装应用记录。`, `Latest scan saw ${apps.length} installed app entries.`)}
          </div>
          {discovery && (
            <div className="mt-2 text-xs leading-relaxed text-white/28">
              {ui(
                isZh,
                `来源：注册表 ${discovery.registryEntries || 0}，开始菜单 ${discovery.startMenuShortcuts || 0}，桌面快捷方式 ${discovery.desktopShortcuts || 0}，应用目录可执行文件 ${discovery.commonFolderEntries || 0}，PATH ${discovery.pathExecutables || 0}。扫描根目录 ${discovery.scannedRoots?.length || 0} 个${discovery.limitReached ? '，已达到上限' : ''}。`,
                `Sources: registry ${discovery.registryEntries || 0}, Start Menu ${discovery.startMenuShortcuts || 0}, Desktop shortcuts ${discovery.desktopShortcuts || 0}, app-folder executables ${discovery.commonFolderEntries || 0}, PATH ${discovery.pathExecutables || 0}. Scanned ${discovery.scannedRoots?.length || 0} roots${discovery.limitReached ? ', limit reached' : ''}.`,
              )}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center gap-2">
            <Mic size={17} className="text-white/55" />
            <h4 className="text-sm font-black uppercase tracking-widest text-white/70">{ui(isZh, '权限', 'Permissions')}</h4>
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
                <h4 className="text-sm font-black uppercase tracking-widest text-white/75">{ui(isZh, '工作画像', 'Work Profile')}</h4>
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
              {ui(isZh, '安装智能体', 'Install Agents')}
            </button>
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
        <div className="mb-4 text-sm font-black uppercase tracking-widest text-white/70">{ui(isZh, '可用工作流', 'Ready Workflows')}</div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <WorkflowTile
            title={ui(isZh, '知识库文件', 'Knowledge files')}
            detail={ui(isZh, '上传到知识库的文件会自动吸收，未吸收的文件也可以在知识库里一键补吸收。', 'Uploaded knowledge files are absorbed automatically, and any pending file can be absorbed from Knowledge Base.')}
            ready={true}
          />
          <WorkflowTile
            title={ui(isZh, '语音与会议', 'Voice and meetings')}
            detail={permissions.microphone === 'granted' ? ui(isZh, '会议模式和语音交互可以使用麦克风。', 'Meeting mode and speech interaction can use the microphone.') : ui(isZh, '需要语音或会议时再授权麦克风。', 'Grant microphone only when you want voice or meetings.')}
            ready={permissions.microphone === 'granted'}
          />
          <WorkflowTile
            title={ui(isZh, '生成技能', 'Generated skills')}
            detail={(ecosystem?.enabledSkillCount || 0) > 0 ? ui(isZh, 'MCP 技能已启用，Lumi 可以看到。', 'MCP skills are enabled and visible to Lumi.') : ui(isZh, '依赖生成工具工作流前，请先启用 MCP 技能。', 'Enable MCP skills before relying on generated tool workflows.')}
            ready={(ecosystem?.enabledSkillCount || 0) > 0}
          />
          <WorkflowTile
            title={ui(isZh, '文档工作', 'Document work')}
            detail={detectedAppGroups.some(group => group.id === 'wps') ? ui(isZh, 'Office/WPS 工作流大概率可用。', 'Office/WPS workflow is likely available.') : ui(isZh, '最近扫描未检测到 Office/WPS 应用。', 'No Office/WPS app was detected in the latest scan.')}
            ready={detectedAppGroups.some(group => group.id === 'wps')}
          />
          <WorkflowTile
            title={ui(isZh, '开发工作', 'Developer work')}
            detail={detectedAppGroups.some(group => group.id === 'vscode' || group.id === 'git') ? ui(isZh, '已检测到开发工具。', 'Developer tools were detected.') : ui(isZh, '安装 VS Code/Git/Node 后，本地开发工作流会更完整。', 'Install VS Code/Git/Node for stronger local dev workflows.')}
            ready={detectedAppGroups.some(group => group.id === 'vscode' || group.id === 'git')}
          />
          <WorkflowTile
            title={ui(isZh, '外部应用', 'External apps')}
            detail={detectedAppGroups.some(group => group.id === 'wechat' || group.id === 'cad' || group.id === 'ai_apps') ? ui(isZh, '通讯/CAD/AI 应用交接已出现在适配地图中。', 'Messaging/CAD/AI app handoff is visible in the adapter map.') : ui(isZh, '即使未启用外部应用控制，Lumi 仍可先准备草稿和文件。', 'Lumi can still prepare drafts and files before external app control is enabled.')}
            ready={detectedAppGroups.some(group => group.id === 'wechat' || group.id === 'cad' || group.id === 'ai_apps')}
          />
          <WorkflowTile
            title={ui(isZh, '音乐能力', 'Music playback')}
            detail={detectedAppGroups.some(group => group.id === 'netease') ? ui(isZh, '已检测到音乐应用；Lumi 可以协同播放。', 'Music app detected; Lumi can coordinate playback.') : ui(isZh, '音乐能力仍可通过已配置的音乐服务工作。', 'Music playback can still work through configured music services.')}
            ready={detectedAppGroups.some(group => group.id === 'netease')}
          />
        </div>
      </section>

      <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
        <div className="mb-4 text-sm font-black uppercase tracking-widest text-white/70">{ui(isZh, '推荐设置', 'Recommended Setup')}</div>
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
                    {item.actionLabel || ui(isZh, '打开', 'Open')}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex gap-3 rounded-xl bg-emerald-300/8 px-3 py-2 text-sm text-emerald-100/70">
            <CheckCircle2 size={15} />
            {ui(isZh, '这台电脑看起来已经适合运行 Lumi 桌面工作流。', 'This computer looks ready for Lumi desktop workflows.')}
          </div>
        )}
      </section>

      {latest?.hardware?.disks && latest.hardware.disks.length > 0 && (
        <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 text-sm font-black uppercase tracking-widest text-white/70">{ui(isZh, '磁盘', 'Disks')}</div>
          <div className="space-y-2">
            {latest.hardware.disks.map(disk => (
              <div key={disk.name} className="rounded-xl bg-black/18 p-3">
                <div className="flex items-center justify-between text-xs text-white/52">
                  <span className="font-bold">{disk.name}{disk.fsType ? ` · ${disk.fsType}` : ''}</span>
                  <span>{ui(isZh, `可用 ${disk.freeGB} GB / 共 ${disk.totalGB} GB`, `${disk.freeGB} GB free / ${disk.totalGB} GB`)}</span>
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
          {ui(isZh, `扫描历史：${history.length} 个快照。最近类型：${latest?.type || '未知'}。`, `Scan history: ${history.length} snapshot(s). Latest type: ${latest?.type || 'unknown'}.`)}
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
