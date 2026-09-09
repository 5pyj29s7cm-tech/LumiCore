import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Monitor, Smartphone, Cpu, Radio } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import { useApp } from '@/contexts/AppContext';
import { apiFetch } from '@/services/apiClient';
import { deviceWidgetCopy } from '@/i18n/locales/deviceWidget';

type DevicePreview = { id: string; name: string; type: string; status: string };

export function DesktopDeviceWidget({ lang, socket, onOpen }: {
  lang: 'zh' | 'en'; socket: Socket | null; onOpen: () => void;
}) {
  const { user, workDomain, orgConnection } = useApp();
  const copy = deviceWidgetCopy(lang);
  const scope = `${user?.uid || ''}:${workDomain}:${orgConnection?.orgId || ''}`;
  const [snapshot, setSnapshot] = useState<{ scope: string; devices: DevicePreview[]; failed: boolean } | null>(null);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (document.hidden || !user?.uid) return;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), 10000);
      try {
        const response = await apiFetch('/api/devices', { signal: request.signal });
        if (!response.ok) throw new Error('Device status unavailable');
        const body = await response.json();
        if (!Array.isArray(body.devices)) throw new Error('Invalid device list');
        if (!disposed && controller === request) setSnapshot({ scope, devices: body.devices, failed: false });
      } catch {
        if (!disposed && controller === request) setSnapshot({ scope, devices: [], failed: true });
      } finally {
        clearTimeout(timeout);
      }
    };
    // Read the existing scoped API; socket payloads only invalidate the summary.
    const schedule = () => {
      clearTimeout(pending);
      pending = setTimeout(() => { void refresh(); }, 250);
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30000);
    const events = ['connect', 'disconnect', 'devices:update', 'device:removed'];
    events.forEach(event => socket?.on(event, schedule));
    document.addEventListener('visibilitychange', schedule);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(pending);
      clearInterval(timer);
      events.forEach(event => socket?.off(event, schedule));
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [socket, scope, user?.uid]);

  const current = snapshot?.scope === scope ? snapshot : null;
  const devices = current?.devices || [];
  const available = Boolean(current && !current.failed);
  const online = devices.filter(device => device.status === 'online').length;
  const preview = [...devices].sort((a, b) => Number(b.status === 'online') - Number(a.status === 'online')).slice(0, 2);

  return (
    <button type="button" data-lumi-target="devices" onClick={onOpen}
      className="lumi-panel lumi-device-widget" aria-label={copy.manage}>
      <span className="lumi-device-heading">
        <span><span className="lumi-device-title">{copy.title}</span><span className="lumi-device-subtitle">{copy.subtitle}</span></span>
        <span className="lumi-device-open"><ArrowUpRight size={19} /></span>
      </span>
      <span className="lumi-device-overview">
        <span className="lumi-device-art" aria-hidden="true">
          <span className="lumi-device-orbit" />
          <span className="lumi-device-monitor"><Monitor size={38} strokeWidth={1.4} /></span>
          <span className="lumi-device-satellite"><Smartphone size={17} strokeWidth={1.6} /></span>
          <span className="lumi-device-signal"><Radio size={15} /></span>
        </span>
        <span className="lumi-device-counts">
          <span><strong>{available ? online : '—'}</strong><span>{copy.online}</span></span>
          <span><strong>{available ? devices.length : '—'}</strong><span>{copy.registered}</span></span>
        </span>
      </span>
      <span className="lumi-device-preview">
        {preview.length ? preview.map(device => {
          const Icon = device.type === 'mobile' ? Smartphone : ['desktop', 'web'].includes(device.type) ? Monitor : Cpu;
          return <span className="lumi-device-row" key={device.id}>
            <Icon size={16} aria-hidden="true" />
            <span className="lumi-device-name">{device.name || device.type}</span>
            <span className="lumi-device-status" data-online={device.status === 'online'}>
              <i />{device.status === 'online' ? copy.online : device.status === 'pairing' ? copy.pairing : copy.offline}
            </span>
          </span>;
        }) : <span className="lumi-device-empty">{!current ? copy.loading : current.failed ? copy.unavailable : copy.empty}</span>}
      </span>
      <span className="lumi-device-footer">{copy.manage}<ArrowUpRight size={14} /></span>
    </button>
  );
}
