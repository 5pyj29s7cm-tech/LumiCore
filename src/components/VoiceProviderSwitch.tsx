// STT / TTS provider switch — Local ←→ Cloud
import { useCallback, useState, useEffect } from 'react';
import { Cpu, Cloud } from 'lucide-react';
import { apiFetch } from '@/services/apiClient';
import { VOICE_PROVIDER_CHANGED_EVENT } from '@/services/voiceService';
import { useApp } from '@/contexts/AppContext';
import { uiMessage } from '../i18n/uiMessages';

type VoicePreferenceState = {
  stt: string;
  tts: string;
  sttModel?: string;
  ttsModel?: string;
};

type OfficialVoiceCatalog = {
  byRole?: {
    speech_recognition?: string[];
    speech_synthesis?: string[];
  };
};

export function VoiceProviderSwitch({ t }: { t?: any }) {
  const { user } = useApp();
  const [pref, setPref] = useState<VoicePreferenceState>({ stt: 'auto', tts: 'auto' });
  const [active, setActive] = useState<{ stt: string | null; streamingStt?: string | null; tts: string | null; sttModel?: string; ttsModel?: string }>({ stt: null, streamingStt: null, tts: null });
  const [officialCatalog, setOfficialCatalog] = useState<OfficialVoiceCatalog | null>(null);
  const [error, setError] = useState('');
  const [access, setAccess] = useState<'loading' | 'allowed' | 'restricted' | 'unavailable'>('loading');
  const localTtsProviders = new Set(['local-cosyvoice', 'gptsovits']);
  const isAdmin = user?.role === 'admin';

  const load = useCallback(async () => {
    if (!isAdmin) {
      setAccess('restricted');
      setError('');
      return null;
    }
    try {
      const response = await apiFetch('/api/voice/active-provider');
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) {
        setAccess('restricted');
        setError('');
        return null;
      }
      if (!response.ok) throw new Error(data.error || `Voice status failed (${response.status})`);
      setPref(data.pref);
      setActive(data.active);
      try {
        const catalogResponse = await apiFetch('/api/preferences/official/models');
        const catalogBody = await catalogResponse.json().catch(() => ({}));
        if (catalogResponse.ok && catalogBody.ok === true) setOfficialCatalog(catalogBody);
      } catch {
        // The provider status remains useful when the optional live catalog
        // probe is temporarily unavailable; the adapter still has a default.
        setOfficialCatalog(null);
      }
      setAccess('allowed');
      setError('');
      return data;
    } catch (caught: any) {
      setAccess('unavailable');
      setError(caught?.message || 'Voice status is unavailable');
    }
    return null;
  }, [isAdmin]);
  useEffect(() => { void load(); }, [load]);

  const save = async (stt: string, tts: string, models: Partial<Pick<VoicePreferenceState, 'sttModel' | 'ttsModel'>> = {}) => {
    if (access !== 'allowed') return;
    setError('');
    try {
      const response = await apiFetch('/api/voice/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stt, tts, ...models }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) setAccess('restricted');
      if (!response.ok) throw new Error(data.error || `Voice provider update failed (${response.status})`);
      const status = await load();
      window.dispatchEvent(new CustomEvent(VOICE_PROVIDER_CHANGED_EVENT, {
        detail: status || { pref: { stt, tts, ...models } },
      }));
    } catch (caught: any) {
      setError(caught?.message || 'Voice provider update failed');
    }
  };

  const locale = t?.langCode === 'en' ? 'en' : 'zh';
  const officialLabel = uiMessage('settings.lumi-official-api-label.a1b2c3d4e5', locale);
  const officialVoiceNote = uiMessage('settings.lumi-official-speech-unavailable.d4e5f6a7b8', locale);
  const sttOpts = [
    { value: 'auto', label: t?.auto || 'Auto' },
    { value: 'local-whisper', label: t?.local || 'Local' },
    { value: 'ark', label: 'Doubao' },
    { value: 'qwen', label: 'Qwen ASR' },
    { value: 'whisper', label: 'Whisper' },
    { value: 'relay', label: officialLabel, disabled: false },
  ];

  const ttsOpts = [
    { value: 'auto', label: t?.auto || 'Auto' },
    { value: 'local-cosyvoice', label: 'Local CosyVoice' },
    { value: 'gptsovits', label: 'GPT-SoVITS' },
    { value: 'ark', label: 'Doubao' },
    { value: 'cosyvoice', label: 'Qwen / DashScope CosyVoice' },
    { value: 'relay', label: officialLabel, disabled: false },
  ];
  const providerLabel = (value: string, options: Array<{ value: string; label: string; disabled?: boolean }>) =>
    options.find(o => o.value === value)?.label || value;
  const restrictionLabel = t?.adminOnly || 'Local administrator access required';
  const sttActive = active.streamingStt || active.stt;
  const sttModels = officialCatalog?.byRole?.speech_recognition || (pref.sttModel ? [pref.sttModel] : []);
  const ttsModels = officialCatalog?.byRole?.speech_synthesis || (pref.ttsModel ? [pref.ttsModel] : []);
  const saveSttModel = (model: string) => { void save(pref.stt, pref.tts, { sttModel: model, ttsModel: pref.ttsModel }); };
  const saveTtsModel = (model: string) => { void save(pref.stt, pref.tts, { sttModel: pref.sttModel, ttsModel: model }); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-black uppercase tracking-widest text-white/40">{t?.sttProvider || 'STT'}</span>
        <div className="flex items-center gap-1">
          {sttActive === 'local-whisper' ? <Cpu size={12} className="text-emerald-400" /> : sttActive ? <Cloud size={12} className={sttActive === 'ark' ? 'text-cyan-400' : 'text-blue-400'} /> : null}
          <span className="text-[12px] font-mono text-white/55">{access === 'restricted' ? restrictionLabel : sttActive || (t?.unavailable || 'Unavailable')}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {sttOpts.map(o => (
          <button
            key={o.value}
            onClick={() => save(o.value, pref.tts, {
              sttModel: o.value === 'relay' ? pref.sttModel || sttModels[0] : undefined,
              ttsModel: pref.tts === 'relay' ? pref.ttsModel : undefined,
            })}
            disabled={access !== 'allowed' || o.disabled}
            title={o.disabled ? officialVoiceNote : access === 'restricted' ? restrictionLabel : undefined}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              pref.stt === o.value
                ? 'bg-celestial-saturn text-black'
                : 'bg-white/5 text-white/40 hover:bg-white/10'
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >{o.label}</button>
        ))}
      </div>
      {pref.stt === 'relay' && sttModels.length > 0 && (
        <label className="flex flex-col gap-1 text-[11px] text-white/45">
          <span>Official STT model</span>
          <select
            value={pref.sttModel || sttModels[0]}
            onChange={event => saveSttModel(event.target.value)}
            disabled={access !== 'allowed'}
            className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] text-white outline-none focus:border-celestial-saturn/45 disabled:opacity-40"
          >
            {sttModels.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
      )}

      <div className="flex items-center justify-between mt-4">
        <span className="text-xs font-black uppercase tracking-widest text-white/40">{t?.ttsProvider || 'TTS'}</span>
        <div className="flex items-center gap-1">
          {active.tts && localTtsProviders.has(active.tts) ? <Cpu size={12} className="text-emerald-400" /> : active.tts ? <Cloud size={12} className={active.tts === 'ark' ? 'text-cyan-400' : 'text-blue-400'} /> : null}
          <span className="text-[12px] font-mono text-white/55">{access === 'restricted' ? restrictionLabel : active.tts ? providerLabel(active.tts, ttsOpts) : (t?.unavailable || 'Unavailable')}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {ttsOpts.map(o => (
          <button
            key={o.value}
            onClick={() => save(pref.stt, o.value, {
              sttModel: pref.stt === 'relay' ? pref.sttModel : undefined,
              ttsModel: o.value === 'relay' ? pref.ttsModel || ttsModels[0] : undefined,
            })}
            disabled={access !== 'allowed' || o.disabled}
            title={o.disabled ? officialVoiceNote : access === 'restricted' ? restrictionLabel : undefined}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              pref.tts === o.value
                ? 'bg-celestial-saturn text-black'
                : 'bg-white/5 text-white/40 hover:bg-white/10'
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >{o.label}</button>
        ))}
      </div>
      {pref.tts === 'relay' && ttsModels.length > 0 && (
        <label className="flex flex-col gap-1 text-[11px] text-white/45">
          <span>Official TTS model</span>
          <select
            value={pref.ttsModel || ttsModels[0]}
            onChange={event => saveTtsModel(event.target.value)}
            disabled={access !== 'allowed'}
            className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] text-white outline-none focus:border-celestial-saturn/45 disabled:opacity-40"
          >
            {ttsModels.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
      )}
      {access === 'restricted' && <p className="text-xs text-amber-200/70">{restrictionLabel}</p>}
      <p className="text-xs text-white/35">{officialVoiceNote}</p>
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
