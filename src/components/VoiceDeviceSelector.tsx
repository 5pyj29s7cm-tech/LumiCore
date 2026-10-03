import { useEffect, useReducer, useState } from 'react';
import { Mic, RefreshCw, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { uiMessage } from '@/i18n/uiMessages';
import {
  getPreferredVoiceInputDeviceId,
  getPreferredVoiceOutputDeviceId,
  setVoiceDevicePreference,
  VOICE_DEVICE_PREFERENCE_CHANGED,
} from '@/lib/voiceDevicePreferences';

const readSelection = () => ({ input: getPreferredVoiceInputDeviceId(), output: getPreferredVoiceOutputDeviceId() });

export function VoiceDeviceSelector() {
  const [selection, setSelection] = useState(readSelection);
  const [revision, refresh] = useReducer(value => value + 1, 0);
  const [{ devices, loading, unavailable }, setDevices] = useState({ devices: [] as MediaDeviceInfo[], loading: true, unavailable: false });

  useEffect(() => {
    const media = navigator.mediaDevices, sync = () => setSelection(readSelection());
    media?.addEventListener?.('devicechange', refresh);
    window.addEventListener(VOICE_DEVICE_PREFERENCE_CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => {
      media?.removeEventListener?.('devicechange', refresh);
      window.removeEventListener(VOICE_DEVICE_PREFERENCE_CHANGED, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  useEffect(() => {
    let current = true;
    setDevices({ devices: [], loading: true, unavailable: false });
    void (async () => {
      try {
        const next = await navigator.mediaDevices.enumerateDevices();
        if (current) setDevices({ devices: next, loading: false, unavailable: false });
      } catch {
        if (current) setDevices({ devices: [], loading: false, unavailable: true });
      }
    })();
    return () => { current = false; };
  }, [revision]);

  return (
    <div className="rounded-2xl border border-white/5 bg-white/5 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-white/80">{uiMessage('settings.voice-devices.ef50d7638a')}</p>
          <p className="mt-0.5 text-xs text-white/45">{uiMessage('settings.voice-devices-description.56ca042951')}</p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="rounded-lg border border-white/10 p-2 text-white/50 transition-colors hover:bg-white/5 hover:text-white"
          aria-label={uiMessage('settings.refresh.cba212b169')}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {(['input', 'output'] as const).map(kind => {
          const available = devices.filter(device => device.kind === `audio${kind}`);
          const label = uiMessage(kind === 'input' ? 'settings.microphone-input.6f0b4220dd' : 'settings.speaker-output.3ce99de026');
          const Icon = kind === 'input' ? Mic : Volume2, value = selection[kind];
          return <label key={kind} className="space-y-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-white/55"><Icon size={13} /> {label}</span>
            <select value={value} onChange={event => {
              if (!setVoiceDevicePreference(kind, event.target.value)) toast.error(uiMessage('settings.failed-to-save.465b88f9c0'));
            }} className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/75 outline-none focus:border-celestial-saturn/50">
              <option value="">{uiMessage('settings.system-default-device.0e427a5690')}</option>
              {value && !available.some(device => device.deviceId === value) && <option value={value}>{value} · {uiMessage('settings.unavailable.a19c84a34b')}</option>}
              {available.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `${label} ${index + 1}`}</option>)}
            </select>
          </label>;
        })}
      </div>
      {unavailable && <p className="mt-3 text-xs text-amber-300/75">{uiMessage('settings.audio-device-list-unavailable.a063f48e43')}</p>}
    </div>
  );
}
