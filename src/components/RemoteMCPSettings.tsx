import React, { useState, useEffect } from 'react';
import { Satellite, Plus, Trash2, Save, Globe, ExternalLink } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { toast } from 'sonner';
import { apiJson } from '../services/apiClient';

interface RemoteDevice {
  name: string;
  url: string;
}

export function RemoteMCPSettings({ t = {} }: { t?: any }) {
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchDevices = async () => {
    try {
      const data = await apiJson('/api/remote-devices');
      const map = data.devices || {};
      setDevices(Object.entries(map).map(([name, url]) => ({ name, url: url as string })));
    } catch (error: any) {
      toast.error(error?.message || 'Remote devices could not be loaded');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchDevices(); }, []);

  const saveDevices = async (list: RemoteDevice[]) => {
    if (saving) return;
    setSaving(true);
    const map: Record<string, string> = {};
    for (const d of list) {
      if (d.name.trim() && d.url.trim()) {
        map[d.name.trim()] = d.url.trim();
      }
    }
    try {
      await apiJson('/api/remote-devices', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devices: map }),
      });
      setDevices(list.filter(d => d.name.trim() && d.url.trim()));
      setEditing(false);
      toast.success(t.remoteDeviceEndpointsSaved || 'Remote device endpoints saved');
    } catch (err: any) {
      toast.error(`${t.failedToSaveEndpoints || 'Failed to save'}: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const addRow = () => {
    setEditing(true);
    setDevices(prev => [...prev, { name: '', url: 'wss://' }]);
  };

  const removeRow = (idx: number) => {
    setEditing(true);
    setDevices(prev => prev.filter((_, i) => i !== idx));
  };

  const updateRow = (idx: number, field: 'name' | 'url', value: string) => {
    setEditing(true);
    setDevices(prev => prev.map((d, i) => i === idx ? { ...d, [field]: value } : d));
  };

  if (loading) {
    return (
      <div className="space-y-8 animate-in fade-in duration-500">
        <div className="flex items-center gap-3">
          <Satellite className="text-celestial-saturn" />
          <h3 className="text-xl font-bold uppercase tracking-tighter text-white/90">{t.remoteMCPDevices || 'Remote MCP Devices'}</h3>
        </div>
        <p className="text-white/40 text-sm">{t.loadingRemoteConfig || 'Loading remote device configuration...'}</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center gap-3">
        <Satellite className="text-celestial-saturn" />
        <h3 className="text-xl font-bold uppercase tracking-tighter text-white/90">{t.remoteMCPDevices || 'Remote MCP Devices'}</h3>
      </div>

      <p className="text-sm text-white/40 max-w-xl">
        {t.remoteMCPDesc || 'Configure remote devices (e.g. XiaoZhi, smart speakers) that connect to Lumi via MCP over WebSocket. Changes take effect on server restart.'}
      </p>

      {devices.length === 0 || (!editing && devices.length === 0) ? (
        <div className="p-10 bg-white/5 rounded-[2rem] border border-white/5 text-center">
          <Satellite size={32} className="text-white/45 mx-auto mb-4" />
          <p className="text-white/40 font-bold uppercase tracking-widest text-sm">{t.noRemoteDevices || 'No remote devices configured'}</p>
          <p className="text-white/45 text-xs mt-2">{t.addRemoteDeviceHint || 'Add a device to let it call Lumi tools via MCP'}</p>
          <Button disabled={saving} onClick={addRow} className="mt-6 bg-celestial-saturn text-black rounded-full px-6 py-3 font-bold text-sm hover:scale-105 transition-transform">
            <Plus size={16} className="mr-1" /> {t.addDevice || 'Add Device'}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {devices.map((device, i) => (
            <div
              key={i}
              className="p-6 bg-white/5 rounded-3xl border border-white/5 space-y-4 hover:border-white/10 transition-all"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-celestial-saturn/10 flex items-center justify-center">
                      <Globe size={20} className="text-celestial-saturn" />
                    </div>
                    {editing ? (
                      <Input
                        disabled={saving}
                        value={device.name}
                        onChange={e => updateRow(i, 'name', e.target.value)}
                        placeholder={t.deviceNamePlaceholder || 'Device name (e.g. xiaozhi)'}
                        className="bg-white/5 border-white/10 rounded-xl py-2 text-sm font-bold"
                      />
                    ) : (
                      <h4 className="font-bold text-white text-sm uppercase tracking-tight">{device.name}</h4>
                    )}
                  </div>
                  {editing ? (
                      <Input
                        disabled={saving}
                      value={device.url}
                      onChange={e => updateRow(i, 'url', e.target.value)}
                      placeholder={t.deviceURLPlaceholder || 'wss://device-url/mcp/?token=...'}
                      className="bg-white/5 border-white/10 rounded-xl py-2 text-xs font-mono"
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-white/55 font-mono truncate max-w-md">{device.url}</p>
                      <a
                        href={device.url.replace(/^ws(s?):\/\//, 'http$1://')}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-white/45 hover:text-white/60 flex-shrink-0"
                      >
                        <ExternalLink size={12} />
                      </a>
                    </div>
                  )}
                </div>

                <Button
                  disabled={saving}
                  onClick={() => removeRow(i)}
                  className="bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 text-xs font-bold uppercase tracking-widest px-3 h-9 rounded-xl flex-shrink-0"
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
          ))}

          <div className="flex items-center gap-3">
            <Button
              disabled={saving}
              onClick={addRow}
              className="bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-black uppercase tracking-widest px-4 h-9 rounded-xl"
            >
              <Plus size={14} className="mr-1" /> {t.addDevice || 'Add Device'}
            </Button>
          </div>
        </div>
      )}

      {editing && (
        <Button disabled={saving} onClick={() => saveDevices(devices)} className="bg-celestial-saturn text-black font-bold text-xs px-6 h-9 rounded-xl">
          <Save size={14} className="mr-1" /> {t.saveChanges || 'Save Changes'}
        </Button>
      )}

      <div className="p-6 glass-dark rounded-[2rem] border border-white/5 space-y-4">
        <div className="flex items-center gap-3">
          <Satellite className="text-celestial-saturn" size={18} />
          <h4 className="text-sm font-bold uppercase tracking-tight text-white">{t.howItWorks || 'How It Works'}</h4>
        </div>
        <p className="text-xs text-white/55 leading-relaxed">
          {t.remoteMCPHowItWorks || 'Remote devices connect as MCP clients to Lumi\'s MCP server via WebSocket. Lumi initiates the WebSocket connection, the device sends an MCP initialize request, and Lumi responds as the server — exposing tools like lumi_chat, lumi_memory_search, and lumi_tool_execute that the device can invoke via voice or other input.'}
        </p>
      </div>
    </div>
  );
}
