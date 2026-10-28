import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Wifi,
  Smartphone,
  Monitor,
  RefreshCcw,
  Zap,
  Search,
  Glasses,
  Box,
  HardDrive,
} from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';
import { GlassCard } from './SharedUI';
import { ExternalDeviceCenter } from './ExternalDeviceCenter';
import { XiaozhiLocalDevices } from './XiaozhiLocalDevices';
import { apiJson } from '@/services/apiClient';
import { useApp } from '@/contexts/AppContext';
import { getDomainReconciliation } from '@/lib/domainSession';
import type { deviceRegistry, projectPublicDevice } from '../../server/devices';

interface DeviceSnapshot {
  devices: ReturnType<typeof projectPublicDevice>[];
  sensoryContext: ReturnType<typeof deviceRegistry.getSensoryContext> | null;
}

const DEVICE_TYPES = {
  desktop: { Icon: Monitor, label: 'desktopLabel', fallback: 'Desktop' },
  mobile: { Icon: Smartphone, label: 'mobileLabel', fallback: 'Mobile' },
  ar_glasses: { Icon: Glasses, label: 'arGlassesLabel', fallback: 'AR Glasses' },
  holographic_prototype: { Icon: Box, label: 'holographicLabel', fallback: 'Holographic' },
  web: { Icon: Monitor, label: 'browserLabel', fallback: 'Browser' },
};

export function DeviceSyncCenter({ t }: { t: any }) {
  const { user, workDomain, orgConnection } = useApp();
  if (!user || getDomainReconciliation(workDomain, (user as any).orgId, orgConnection?.orgId) !== 'none') return null;
  const scope = JSON.stringify([user.uid, user.role, workDomain, (user as any).orgId, orgConnection?.orgId]);
  return <DeviceSyncView key={scope} scope={scope} t={t} />;
}

function DeviceSyncView({ t, scope }: { t: any; scope: string }) {
  const socket = useSocket();
  const [isSearching, setIsSearching] = useState(true);
  const [snapshot, setSnapshot] = useState<DeviceSnapshot>({ devices: [], sensoryContext: null });
  const { devices: discoveredDevices, sensoryContext: sensoryCtx } = snapshot;
  const [loadError, setLoadError] = useState('');
  const requests = useRef({ owner: null as AbortController | null, revision: 0 });
  const [lastSync, setLastSync] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    const signal = requests.current.owner?.signal;
    if (!signal || signal.aborted) return;
    const revision = ++requests.current.revision;
    setIsSearching(true);
    setLoadError('');
    try {
      const data = await apiJson<DeviceSnapshot>('/api/devices', { signal });
      if (signal.aborted || revision !== requests.current.revision) return;
      if (!Array.isArray(data?.devices)) throw new Error('Invalid device snapshot');
      setSnapshot(data);
    } catch (err: any) {
      if (!signal.aborted && revision === requests.current.revision) setLoadError(err?.message || 'Failed to fetch devices');
    } finally {
      if (!signal.aborted && revision === requests.current.revision) setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    const owner = new AbortController();
    requests.current.owner = owner;
    let refreshTimer: ReturnType<typeof setTimeout>, syncTimer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      if (owner.signal.aborted) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void fetchDevices(), 160);
    };
    const onSync = (data: { timestamp: string }) => {
      if (owner.signal.aborted) return;
      clearTimeout(syncTimer);
      setLastSync(data.timestamp);
      syncTimer = setTimeout(() => setLastSync(null), 5000);
    };
    const events = ['connect', 'device:registered', 'devices:update', 'device:removed'];
    for (const event of events) socket?.on(event, refresh);
    socket?.on('memories:changed', onSync);
    void fetchDevices();
    return () => {
      owner.abort(); clearTimeout(refreshTimer); clearTimeout(syncTimer);
      for (const event of events) socket?.off(event, refresh);
      socket?.off('memories:changed', onSync);
    };
  }, [socket, fetchDevices]);

  return (
    <div className="space-y-6">
      <ExternalDeviceCenter scope={scope} lang={t.langCode === 'zh' ? 'zh' : 'en'} />
      <XiaozhiLocalDevices scope={scope} lang={t.langCode === 'zh' ? 'zh' : 'en'} />
      <GlassCard className="p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold flex items-center gap-2">
              <Wifi size={16} className="text-celestial-saturn" />
              {t.lumiClients || 'Lumi clients'}
            </h3>
            <p className="text-xs text-white/40">
              {sensoryCtx
                ? `${sensoryCtx.deviceCount} ${t.sensorCtxOnline || 'online'}`
                : t.lumiClientsDesc || 'Lumi client registrations and their current connection state.'}
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

        {loadError && <p role="alert" className="text-sm text-red-400">{loadError}</p>}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <AnimatePresence>
            {discoveredDevices.map((device, idx) => {
              const type = Object.hasOwn(DEVICE_TYPES, device.type) ? DEVICE_TYPES[device.type] : { Icon: HardDrive, label: '', fallback: device.type };
              return (
              <motion.div
                key={device.id}
                initial={{ opacity: 0, scale: 0.9, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ delay: idx * 0.1 }}
                className={`p-3 rounded-xl border transition-all group ${
                  device.status === 'online'
                    ? 'bg-white/5 border-white/10 hover:border-celestial-saturn/30'
                    : 'bg-white/5 border-white/5 opacity-50'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-white/60">
                    <type.Icon size={16} />
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
                  {t[type.label] || type.fallback}
                  {device.osInfo ? ` · ${device.osInfo}` : ''}
                </div>
              </motion.div>
            ); })}
          </AnimatePresence>
          {!isSearching && !loadError && discoveredDevices.length === 0 && (
            <div className="col-span-full py-8 text-center space-y-2 border-2 border-dashed border-white/5 rounded-3xl">
              <Zap size={32} className="mx-auto text-white/35" />
              <p className="text-sm text-white/45">{t.noDevicesConnected || 'No devices connected. Open the app on another device to see it here.'}</p>
            </div>
          )}
        </div>
      </GlassCard>

    </div>
  );
}
