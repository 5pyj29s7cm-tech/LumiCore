import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Wifi,
  Smartphone,
  Monitor,
  RefreshCcw,
  Zap,
  MapPin,
  Move3d,
  Search,
  CheckCircle2,
  Glasses,
  Box,
  HardDrive,
} from 'lucide-react';
import { toast } from 'sonner';
import { usePlatform } from '@/hooks/usePlatform';
import { useSocket } from '@/hooks/useSocket';
import { GlassCard } from './SharedUI';
import { RemoteMCPSettings } from './RemoteMCPSettings';
import { apiJson } from '@/services/apiClient';
import { useApp } from '@/contexts/AppContext';
import { getDomainReconciliation } from '@/lib/domainSession';
import type { deviceRegistry, projectPublicDevice } from '../../server/devices';

interface DeviceSnapshot {
  devices: ReturnType<typeof projectPublicDevice>[];
  pairedDeviceIds: string[];
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
  return <DeviceSyncView key={JSON.stringify([user.uid, user.role, workDomain, (user as any).orgId])} t={t} />;
}

function DeviceSyncView({ t }: { t: any }) {
  const { sensors, setSensorSyncEnabled, isSyncing } = usePlatform();
  const socket = useSocket();
  const [isSearching, setIsSearching] = useState(true);
  const [snapshot, setSnapshot] = useState<DeviceSnapshot>({ devices: [], pairedDeviceIds: [], sensoryContext: null });
  const { devices: discoveredDevices, pairedDeviceIds: pairedDevices, sensoryContext: sensoryCtx } = snapshot;
  const [pairing, setPairing] = useState('');
  const [loadError, setLoadError] = useState('');
  const requests = useRef({ owner: null as AbortController | null, revision: 0, pairing: '' });
  const [lastSync, setLastSync] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    const signal = requests.current.owner?.signal;
    if (!signal || signal.aborted || requests.current.pairing) return;
    const revision = ++requests.current.revision;
    setIsSearching(true);
    setLoadError('');
    try {
      const data = await apiJson<DeviceSnapshot>('/api/devices', { signal });
      if (signal.aborted || revision !== requests.current.revision) return;
      if (!Array.isArray(data?.devices) || !Array.isArray(data?.pairedDeviceIds)) throw new Error('Invalid device snapshot');
      setSnapshot(data);
    } catch (err: any) {
      if (!signal.aborted && revision === requests.current.revision) setLoadError(err?.message || 'Failed to fetch devices');
    } finally {
      if (!signal.aborted && revision === requests.current.revision) setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    if (!socket) return;
    const owner = new AbortController();
    requests.current.owner = owner;
    requests.current.pairing = '';
    setPairing('');
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
    const events = ['connect', 'devices:update', 'device:removed'];
    for (const event of events) socket?.on(event, refresh);
    socket?.on('memories:changed', onSync);
    void fetchDevices();
    return () => {
      owner.abort(); clearTimeout(refreshTimer); clearTimeout(syncTimer);
      for (const event of events) socket?.off(event, refresh);
      socket?.off('memories:changed', onSync);
    };
  }, [socket, fetchDevices]);

  const pairDevice = async (id: string) => {
    const signal = requests.current.owner?.signal;
    if (!signal || signal.aborted || requests.current.pairing) return;
    const isPaired = pairedDevices.includes(id);
    requests.current.pairing = id; requests.current.revision++;
    setPairing(id);
    try {
      const data = await apiJson(isPaired ? `/api/devices/pair/${encodeURIComponent(id)}` : '/api/devices/pair', {
        signal,
        method: isPaired ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: isPaired ? undefined : JSON.stringify({ deviceId: id }),
      });
      if (signal.aborted) return;
      if (!Array.isArray(data?.pairedDeviceIds) || data.pairedDeviceIds.includes(id) === isPaired) throw new Error('Device pairing was not confirmed');
      setSnapshot(current => ({ ...current, pairedDeviceIds: data.pairedDeviceIds }));
      toast.success(isPaired ? (t.deviceUnpaired || 'Device unpaired') : (t.devicePaired || 'Device paired'));
    } catch (err: any) {
      if (!signal.aborted) toast.error(err?.message || 'Device pairing failed');
    } finally {
      if (!signal.aborted) { requests.current.pairing = ''; setPairing(''); void fetchDevices(); }
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
            disabled={isSearching || Boolean(pairing)}
            className="px-4 py-2 bg-celestial-saturn/10 border border-celestial-saturn/30 text-celestial-saturn rounded-xl text-xs font-bold hover:bg-celestial-saturn/20 transition-all flex items-center gap-2 disabled:opacity-50"
          >
            {isSearching ? <RefreshCcw size={14} className="animate-spin" /> : <Search size={14} />}
            {isSearching ? (t.scanningBtn || 'Scanning...') : (t.refreshBtn || 'Refresh')}
          </button>
        </div>

        {loadError && <p role="alert" className="text-sm text-red-400">{loadError}</p>}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <AnimatePresence>
            {discoveredDevices.map((device, idx) => {
              const type = Object.hasOwn(DEVICE_TYPES, device.type) ? DEVICE_TYPES[device.type] : { Icon: HardDrive, label: '', fallback: device.type };
              const paired = pairedDevices.includes(device.id);
              return (
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
                    <type.Icon size={20} />
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
                <div className="mt-4">
                  <button
                    onClick={() => pairDevice(device.id)}
                    disabled={isSearching || Boolean(pairing) || (device.status !== 'online' && !paired)}
                    className={`w-full py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed ${paired
                      ? 'bg-green-500/10 border border-green-400/20 text-green-400 hover:bg-green-500/15'
                      : 'bg-white/10 hover:bg-celestial-saturn hover:text-black'}`}
                  >
                    <span className="inline-flex items-center justify-center gap-2">
                      {paired && <CheckCircle2 size={12} />}
                      {pairing === device.id ? (t.saving || 'Saving...') : paired ? (t.pairedDevice || 'PAIRED') : (t.pairDevice || 'PAIR')}
                    </span>
                  </button>
                </div>
              </motion.div>
            ); })}
          </AnimatePresence>
          {!isSearching && !loadError && discoveredDevices.length === 0 && (
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
              onClick={() => setSensorSyncEnabled(enabled => !enabled)}
              className={`text-xs font-bold hover:underline ${isSyncing ? 'text-red-400' : 'text-celestial-nebula'}`}
            >
              {isSyncing ? (t.stopBtn || 'STOP') : (t.enableBtn || 'ENABLE')}
            </button>
          </div>
        </GlassCard>

        <GlassCard className="p-8 space-y-6 border-t-2 border-t-celestial-jupiter">
          <div className="flex items-center gap-3">
            <Monitor className="text-celestial-jupiter" />
            <div>
              <h3 className="text-lg font-bold">{t.kernelMonitor || 'Kernel Monitor'}</h3>
              <p className="text-xs text-white/40">{t.kernelExploreMergedDesc || 'Runtime monitor and computer exploration are merged into this single kernel view.'}</p>
            </div>
          </div>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('lumi:client-action', { detail: { action: 'open_computer_adaptation' } }))}
            className="w-full py-4 rounded-2xl bg-celestial-jupiter text-black font-bold text-sm hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-2"
          >
            <Monitor size={16} />
            {t.kernelMonitor || 'Kernel Monitor'}
          </button>
        </GlassCard>
      </div>

      {/* Remote MCP Endpoints */}
      <GlassCard className="p-8 space-y-6">
        <RemoteMCPSettings t={t} />
      </GlassCard>
    </div>
  );
}
