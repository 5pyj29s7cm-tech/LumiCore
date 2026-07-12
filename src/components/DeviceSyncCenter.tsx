import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Wifi,
  Smartphone,
  Monitor,
  RefreshCcw,
  ShieldCheck,
  Zap,
  MapPin,
  Move3d,
  Lock,
  Search,
  CheckCircle2,
  Glasses,
  Box,
  HardDrive
} from 'lucide-react';
import { toast } from 'sonner';
import { usePlatform } from '@/hooks/usePlatform';
import { useSocket } from '@/hooks/useSocket';
import { GlassCard } from './SharedUI';
import { RemoteMCPSettings } from './RemoteMCPSettings';

const DEVICE_ICONS: Record<string, React.ReactNode> = {
  desktop: <Monitor size={20} />,
  mobile: <Smartphone size={20} />,
  ar_glasses: <Glasses size={20} />,
  holographic_prototype: <Box size={20} />,
  web: <Monitor size={20} />,
};

const DEVICE_LABELS: Record<string, string> = {
  desktop: 'Desktop',
  mobile: 'Mobile',
  ar_glasses: 'AR Glasses',
  holographic_prototype: 'Holographic',
  web: 'Browser',
};

function getDeviceLabel(type: string, t: any): string {
  const labels: Record<string, string> = {
    desktop: t.desktopLabel || 'Desktop',
    mobile: t.mobileLabel || 'Mobile',
    ar_glasses: t.arGlassesLabel || 'AR Glasses',
    holographic_prototype: t.holographicLabel || 'Holographic',
    web: t.browserLabel || 'Browser',
  };
  return labels[type] || type;
}

export function DeviceSyncCenter({ t }: { t: any }) {
  const { platform, isDesktop, sensors, startSensorSync, isSyncing } = usePlatform();
  const socket = useSocket();
  const [isSearching, setIsSearching] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState<any[]>([]);
  const [pairedDevices, setPairedDevices] = useState<string[]>([]);
  const [pairBusyIds, setPairBusyIds] = useState<string[]>([]);
  const sensorCleanupRef = useRef<(() => void) | null>(null);
  const [fileAccessInfo, setFileAccessInfo] = useState<any>(null);
  const [fileAccessError, setFileAccessError] = useState<string | null>(null);
  const [sensoryCtx, setSensoryCtx] = useState<any>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    setIsSearching(true);
    try {
      const res = await fetch('/api/devices', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch devices');
      const data = await res.json();
      setDiscoveredDevices(data.devices || []);
      setPairedDevices(data.pairedDeviceIds || (data.devices || []).filter((d: any) => d.paired).map((d: any) => d.id));
      setSensoryCtx(data.sensoryContext || null);
    } catch (err: any) {
      console.error('[DeviceSync] Fetch error:', err.message);
      toast.error(err?.message || (t.deviceFetchFailed || 'Failed to fetch devices'));
    } finally {
      setIsSearching(false);
    }
  }, [t]);

  // Load devices on mount
  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  // Listen for real-time device updates via socket
  useEffect(() => {
    if (!socket) return;
    const handler = (device: any) => {
      setDiscoveredDevices(prev => {
        const idx = prev.findIndex(d => d.id === device.id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = device;
          return updated;
        }
        return [...prev, device];
      });
    };
    socket.on('devices:update', handler);
    return () => { socket.off('devices:update', handler); };
  }, [socket]);

  // Listen for stale device cleanup (reconnect dedup)
  useEffect(() => {
    if (!socket) return;
    const handler = (data: { id: string }) => {
      setDiscoveredDevices(prev => prev.filter(d => d.id !== data.id));
    };
    socket.on('device:removed', handler);
    return () => { socket.off('device:removed', handler); };
  }, [socket]);

  // Listen for cross-device memory sync events
  useEffect(() => {
    if (!socket) return;
    const handler = (data: any) => {
      setLastSync(data.timestamp);
      // Auto-clear after 5 seconds
      setTimeout(() => setLastSync(null), 5000);
    };
    socket.on('memories:changed', handler);
    return () => { socket.off('memories:changed', handler); };
  }, [socket]);

  const pairDevice = async (id: string) => {
    const isPaired = pairedDevices.includes(id);
    setPairBusyIds(prev => prev.includes(id) ? prev : [...prev, id]);
    try {
      const res = await fetch(isPaired ? `/api/devices/pair/${encodeURIComponent(id)}` : '/api/devices/pair', {
        method: isPaired ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: isPaired ? undefined : JSON.stringify({ deviceId: id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || (isPaired ? 'Failed to unpair device' : 'Failed to pair device'));
      setPairedDevices(data.pairedDeviceIds || (isPaired ? pairedDevices.filter(d => d !== id) : [...new Set([...pairedDevices, id])]));
      toast.success(isPaired ? (t.deviceUnpaired || 'Device unpaired') : (t.devicePaired || 'Device paired'));
    } catch (err: any) {
      toast.error(err?.message || (isPaired ? (t.deviceUnpairFailed || 'Failed to unpair device') : (t.devicePairFailed || 'Failed to pair device')));
    } finally {
      setPairBusyIds(prev => prev.filter(deviceId => deviceId !== id));
    }
  };

  const handleFileAccess = async () => {
    setFileAccessError(null);
    setFileAccessInfo(null);

    if (isDesktop) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const info = await invoke('get_system_info');
        setFileAccessInfo({
          path: (info as any).home_dir || '/',
          size: `${(((info as any).total_memory || 0) / (1024 * 1024 * 1024)).toFixed(1)}GB RAM`,
          os: (info as any).platform || navigator.platform,
        });
      } catch (err: any) {
        setFileAccessError(err.message || String(err));
      }
    } else {
      setFileAccessInfo({
        path: 'session://web/vault',
        size: 'N/A (browser sandbox)',
        os: navigator.platform,
      });
    }
  };

  return (
    <div className="space-y-8">
      {/* Device Discovery Section */}
      <GlassCard className="p-8 space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h3 className="text-xl font-bold flex items-center gap-2">
              <Wifi size={20} className="text-celestial-saturn" />
              {t.deviceMeshNetwork || 'Device Mesh Network'}
            </h3>
            <p className="text-xs text-white/40">
              {sensoryCtx
                ? `${sensoryCtx.deviceCount} ${t.sensorCtxOnline || 'online'} · ${t.sensorCtxAudio || 'Audio'}: ${sensoryCtx.hasAudio ? (t.sensorCtxYes || 'yes') : (t.sensorCtxNo || 'no')} · ${t.sensorCtxVideo || 'Video'}: ${sensoryCtx.hasVideo ? (t.sensorCtxYes || 'yes') : (t.sensorCtxNo || 'no')}`
                : t.sensorPerceptionDesc || 'Real-time device discovery and synchronization.'}
              {lastSync && (
                <span className="text-celestial-saturn text-xs font-mono ml-2">
                  {t.syncedAt || 'Synced'} {new Date(lastSync).toLocaleTimeString()}
                </span>
              )}
            </p>
          </div>
          <button
            onClick={fetchDevices}
            disabled={isSearching}
            className="px-4 py-2 bg-celestial-saturn/10 border border-celestial-saturn/30 text-celestial-saturn rounded-xl text-xs font-bold hover:bg-celestial-saturn/20 transition-all flex items-center gap-2 disabled:opacity-50"
          >
            {isSearching ? <RefreshCcw size={14} className="animate-spin" /> : <Search size={14} />}
            {isSearching ? (t.scanningBtn || 'Scanning...') : (t.refreshBtn || 'Refresh')}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <AnimatePresence>
            {discoveredDevices.map((device, idx) => (
              <motion.div
                key={device.id}
                initial={{ opacity: 0, scale: 0.9, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ delay: idx * 0.1 }}
                className={`p-4 rounded-2xl border transition-all group ${
                  device.status === 'online'
                    ? 'bg-white/5 border-white/10 hover:border-celestial-saturn/30'
                    : 'bg-white/5 border-white/5 opacity-50'
                }`}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-white/60">
                    {DEVICE_ICONS[device.type] || <HardDrive size={20} />}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className={`w-2 h-2 rounded-full ${device.status === 'online' ? 'bg-green-500' : 'bg-white/20'}`} />
                    <span className="text-xs font-mono text-white/40">
                      {device.status === 'online' ? (t.syncOnline || 'ONLINE') : (t.syncOffline || 'OFFLINE')}
                    </span>
                  </div>
                </div>
                <h4 className="text-sm font-bold truncate">{device.name}</h4>
                <div className="text-xs text-white/55 mt-0.5">
                  {getDeviceLabel(device.type, t)}
                  {device.osInfo ? ` · ${device.osInfo}` : ''}
                </div>
                <div className="mt-4">
                  {pairedDevices.includes(device.id) ? (
                    <button
                      onClick={() => pairDevice(device.id)}
                      disabled={pairBusyIds.includes(device.id)}
                      className="w-full py-2 bg-green-500/10 border border-green-400/20 rounded-lg text-xs font-bold text-green-400 hover:bg-green-500/15 transition-all disabled:opacity-30"
                    >
                      <span className="inline-flex items-center justify-center gap-2">
                        <CheckCircle2 size={12} />
                        {pairBusyIds.includes(device.id) ? (t.saving || 'Saving...') : (t.pairedDevice || 'PAIRED')}
                      </span>
                    </button>
                  ) : (
                    <button
                      onClick={() => pairDevice(device.id)}
                      disabled={device.status !== 'online' || pairBusyIds.includes(device.id)}
                      className="w-full py-2 bg-white/10 rounded-lg text-xs font-bold hover:bg-celestial-saturn hover:text-black transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      {pairBusyIds.includes(device.id) ? (t.saving || 'Saving...') : (t.pairDevice || 'PAIR')}
                    </button>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {!isSearching && discoveredDevices.length === 0 && (
            <div className="col-span-3 py-12 text-center space-y-2 border-2 border-dashed border-white/5 rounded-3xl">
              <Zap size={32} className="mx-auto text-white/35" />
              <p className="text-sm text-white/45">{t.noDevicesConnected || 'No devices connected. Open the app on another device to see it here.'}</p>
            </div>
          )}
        </div>
      </GlassCard>

      <div className="grid md:grid-cols-2 gap-8">
        {/* Mobile Perception */}
        <GlassCard className="p-8 space-y-6 border-t-2 border-t-celestial-nebula">
          <div className="flex items-center gap-3">
            <Smartphone className="text-celestial-nebula" />
            <div>
              <h3 className="text-lg font-bold">{t.mobileSensors || 'Mobile Sensors'}</h3>
              <p className="text-xs text-white/40">{t.sensorPerceptionDesc || 'Real-time perception data from device sensors.'}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className={`p-4 rounded-2xl border transition-all ${isSyncing ? 'bg-celestial-nebula/10 border-celestial-nebula/30' : 'bg-white/5 border-white/10'}`}>
              <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
                <MapPin size={12} />
                <span>{t.location || 'Location'}</span>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-mono">{sensors.latitude?.toFixed(4) || '--'}° N</div>
                <div className="text-xs font-mono">{sensors.longitude?.toFixed(4) || '--'}° E</div>
              </div>
            </div>

            <div className={`p-4 rounded-2xl border transition-all ${isSyncing ? 'bg-celestial-nebula/10 border-celestial-nebula/30' : 'bg-white/5 border-white/10'}`}>
              <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
                <Move3d size={12} />
                <span>{t.motion || 'Motion'}</span>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-mono">X: {sensors.acceleration?.x.toFixed(2) || '0.00'}</div>
                <div className="text-xs font-mono">Y: {sensors.acceleration?.y.toFixed(2) || '0.00'}</div>
              </div>
            </div>
          </div>

          <div className="p-4 rounded-2xl bg-white/5 border border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full ${isSyncing ? 'bg-celestial-nebula animate-pulse' : 'bg-white/20'}`} />
              <span className="text-xs font-bold uppercase tracking-widest text-white/60">
                {isSyncing ? (t.liveStreamActive || 'Live Stream Active') : (t.sensorsStandby || 'Sensors Standby')}
              </span>
            </div>
            <button
              onClick={() => {
                if (isSyncing && sensorCleanupRef.current) {
                  sensorCleanupRef.current();
                  sensorCleanupRef.current = null;
                } else {
                  sensorCleanupRef.current = startSensorSync();
                }
              }}
              className={`text-xs font-bold hover:underline ${isSyncing ? 'text-red-400' : 'text-celestial-nebula'}`}
            >
              {isSyncing ? (t.stopBtn || 'STOP') : (t.enableBtn || 'ENABLE')}
            </button>
          </div>
        </GlassCard>

        {/* Desktop System Access */}
        <GlassCard className="p-8 space-y-6 border-t-2 border-t-celestial-jupiter">
          <div className="flex items-center gap-3">
            <Monitor className="text-celestial-jupiter" />
            <div>
              <h3 className="text-lg font-bold">{t.systemAccess || 'System Access'}</h3>
              <p className="text-xs text-white/40">
                {isDesktop ? (t.systemAccessLocal || 'Local system information via Tauri IPC.') : (t.systemAccessWeb || 'System access requires the desktop app.')}
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="p-6 bg-black/40 rounded-2xl border border-white/10 font-mono text-xs space-y-3">
              <div className="flex items-center gap-2 text-celestial-jupiter">
                <Lock size={12} />
                <span>{t.vaultLabel || 'VAULT'}: {isDesktop ? (t.vaultUnlocked || 'UNLOCKED') : (t.vaultWebMode || 'WEB_MODE')}</span>
              </div>
              {fileAccessError ? (
                <div className="text-red-400">{'>'} ERROR: {fileAccessError}</div>
              ) : fileAccessInfo ? (
                <div className="space-y-1 text-white/60">
                  <div className="text-green-500">{'>'} {t.connectedLabel || 'CONNECTED'}</div>
                  <div>{'>'} {t.pathLabel || 'PATH'}: {fileAccessInfo.path}</div>
                  <div>{'>'} {t.memLabel || 'MEM'}: {fileAccessInfo.size}</div>
                  <div>{'>'} {t.osLabel || 'OS'}: {fileAccessInfo.os}</div>
                </div>
              ) : (
                <div className="text-white/45 italic">{'>'} {t.readyClickQuery || 'Ready — click below to query system info.'}</div>
              )}
            </div>

            <button
              onClick={handleFileAccess}
              className="w-full py-4 rounded-2xl bg-celestial-jupiter text-black font-bold text-sm hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-2"
            >
              <Zap size={16} />
              {isDesktop ? (t.querySystemInfo || 'Query System Info') : (t.openWebVault || 'Open Web Vault')}
            </button>
          </div>
        </GlassCard>
      </div>

      {/* Remote MCP Endpoints */}
      <GlassCard className="p-8 space-y-6">
        <RemoteMCPSettings t={t} />
      </GlassCard>
    </div>
  );
}
