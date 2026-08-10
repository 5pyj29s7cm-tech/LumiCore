import { useCallback, useEffect, useMemo, useState } from 'react';
import { Mic, RefreshCw, Volume2 } from 'lucide-react';
import { uiMessage } from '@/i18n/uiMessages';
import {
  getPreferredVoiceInputDeviceId,
  getPreferredVoiceOutputDeviceId,
  setVoiceDevicePreference,
} from '@/lib/voiceDevicePreferences';

export function VoiceDeviceSelector() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [inputId, setInputId] = useState(() => getPreferredVoiceInputDeviceId());
  const [outputId, setOutputId] = useState(() => getPreferredVoiceOutputDeviceId());
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setUnavailable(true);
      return;
    }
    setLoading(true);
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, [refresh]);

  const inputs = useMemo(() => devices.filter(device => device.kind === 'audioinput'), [devices]);
  const outputs = useMemo(() => devices.filter(device => device.kind === 'audiooutput'), [devices]);
  const selectClass = 'w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/75 outline-none focus:border-celestial-saturn/50';

  const deviceLabel = (device: MediaDeviceInfo, index: number, type: 'input' | 'output') => (
    device.label || `${type === 'input'
      ? uiMessage('settings.microphone-input.6f0b4220dd')
      : uiMessage('settings.speaker-output.3ce99de026')} ${index + 1}`
  );

  return (
    <div className="rounded-2xl border border-white/5 bg-white/5 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-white/80">{uiMessage('settings.voice-devices.ef50d7638a')}</p>
          <p className="mt-0.5 text-xs text-white/45">{uiMessage('settings.voice-devices-description.56ca042951')}</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-lg border border-white/10 p-2 text-white/50 transition-colors hover:bg-white/5 hover:text-white"
          aria-label={uiMessage('settings.refresh.cba212b169')}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-white/55">
            <Mic size={13} /> {uiMessage('settings.microphone-input.6f0b4220dd')}
          </span>
          <select
            value={inputId}
            onChange={event => {
              const next = event.target.value;
              setInputId(next);
              setVoiceDevicePreference('input', next);
            }}
            className={selectClass}
          >
            <option value="">{uiMessage('settings.system-default-device.0e427a5690')}</option>
            {inputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, index, 'input')}</option>)}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-white/55">
            <Volume2 size={13} /> {uiMessage('settings.speaker-output.3ce99de026')}
          </span>
          <select
            value={outputId}
            onChange={event => {
              const next = event.target.value;
              setOutputId(next);
              setVoiceDevicePreference('output', next);
            }}
            className={selectClass}
            disabled={outputs.length === 0}
          >
            <option value="">{uiMessage('settings.system-default-device.0e427a5690')}</option>
            {outputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, index, 'output')}</option>)}
          </select>
        </label>
      </div>
      {unavailable && <p className="mt-3 text-xs text-amber-300/75">{uiMessage('settings.audio-device-list-unavailable.a063f48e43')}</p>}
    </div>
  );
}
