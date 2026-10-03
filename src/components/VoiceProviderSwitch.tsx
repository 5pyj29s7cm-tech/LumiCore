import { useState, useEffect, useRef } from 'react';
import { Cpu, Cloud } from 'lucide-react';
import { apiFetch } from '@/services/apiClient';
import { VOICE_PROVIDER_CHANGED_EVENT } from '@/services/voiceService';
import { useApp } from '@/contexts/AppContext';
import { useLumiOfficialCatalog } from '../hooks/useLumiOfficialCatalog';
import { uiMessage } from '../i18n/uiMessages';

type VoicePreferenceState = { stt: string; tts: string; sttModel?: string; ttsModel?: string };
type VoiceStatus = { pref: VoicePreferenceState; active: Pick<VoicePreferenceState, 'sttModel' | 'ttsModel'> & { stt: string | null; streamingStt?: string | null; tts: string | null } };

export function VoiceProviderSwitch({ t }: { t?: any }) {
  const { user, workDomain, orgConnection } = useApp();
  return user?.role === 'admin'
    ? <VoiceProviderEditor key={`${user.uid}:${user.role}:${workDomain}:${orgConnection?.orgId ?? ''}`} t={t} />
    : <p className="text-xs text-amber-200/70">{t?.adminOnly || 'Local administrator access required'}</p>;
}

function VoiceProviderEditor({ t }: { t?: any }) {
  const [state, setState] = useState({ data: null as VoiceStatus | null, busy: true, error: '' });
  const lifetime = useRef<AbortController | null>(null), pending = useRef<AbortSignal | null>(null);
  const officialCatalog = useLumiOfficialCatalog();
  const sync = async (next?: Partial<VoicePreferenceState>) => {
    const owner = lifetime.current;
    if (!owner || owner.signal.aborted || (next && !state.data) || (pending.current && !pending.current.aborted)) return;
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(15_000)]);
    pending.current = signal; setState(current => ({ ...current, busy: true, error: '' }));
    try {
      const response = await apiFetch(next ? '/api/voice/provider' : '/api/voice/active-provider', {
        signal, ...(next ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) } : {}),
      });
      const data = await response.json().catch(() => null);
      signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) {
        setState({ data: null, busy: false, error: t?.adminOnly || 'Local administrator access required' }); return;
      }
      if (!response.ok || data?.success === false) throw new Error(data?.error || `HTTP ${response.status}`);
      if ((next && data?.success !== true) || !data?.pref || !data.active
        || (data.active.streamingStt != null && typeof data.active.streamingStt !== 'string')
        || ['stt', 'tts'].some(role => typeof data.pref[role] !== 'string' || !Object.hasOwn(data.active, role) || (data.active[role] !== null && typeof data.active[role] !== 'string'))
        || ['sttModel', 'ttsModel'].some(field => [data.pref[field], data.active[field]].some(model => model !== undefined && typeof model !== 'string'))) throw new Error('Voice status confirmation missing or invalid');
      setState({ data, busy: false, error: '' });
      if (next) window.dispatchEvent(new CustomEvent(VOICE_PROVIDER_CHANGED_EVENT, { detail: data }));
    } catch (error) {
      if (!owner.signal.aborted && pending.current === signal) setState(current => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (pending.current === signal) {
        pending.current = null;
        if (!owner.signal.aborted) setState(current => ({ ...current, busy: false }));
      }
    }
  };
  useEffect(() => {
    const owner = new AbortController(); lifetime.current = owner;
    void sync(); return () => owner.abort();
  }, []);

  const locale = t?.langCode === 'en' ? 'en' : 'zh';
  const officialLabel = uiMessage('settings.lumi-official-api-label.a1b2c3d4e5', locale);
  const officialVoiceNote = uiMessage('settings.lumi-official-speech-unavailable.d4e5f6a7b8', locale);
  const pref = state.data?.pref, active = state.data?.active;
  const groups = [
    { role: 'stt' as const, label: t?.sttProvider || 'STT', active: active?.streamingStt || active?.stt, models: officialCatalog?.byRole.speech_recognition,
      options: [['auto', t?.auto || 'Auto'], ['local-whisper', t?.local || 'Local'], ['ark', 'Doubao'], ['qwen', 'Qwen ASR'], ['whisper', 'Whisper'], ['relay', officialLabel]] },
    { role: 'tts' as const, label: t?.ttsProvider || 'TTS', active: active?.tts, models: officialCatalog?.byRole.speech_synthesis,
      options: [['auto', t?.auto || 'Auto'], ['local-cosyvoice', 'Local CosyVoice'], ['gptsovits', 'GPT-SoVITS'], ['ark', 'Doubao'], ['cosyvoice', 'Qwen / DashScope CosyVoice'], ['relay', officialLabel]] },
  ];
  return (
    <div className="space-y-4">
      {groups.map(group => {
        const modelField = `${group.role}Model` as const;
        const selected = pref?.[modelField] || active?.[modelField];
        const models = [...new Set([selected, ...(group.models ?? [])].filter((model): model is string => Boolean(model)))];
        const local = group.active?.startsWith('local-') || group.active === 'gptsovits';
        return <fieldset key={group.role} disabled={state.busy || !pref} className="space-y-3">
          <legend className="sr-only">{group.label}</legend>
          <div className="flex items-center justify-between">
            <span className="text-xs font-black uppercase tracking-widest text-white/40">{group.label}</span>
            <div className="flex items-center gap-1">
              {group.active && (local ? <Cpu size={12} className="text-emerald-400" /> : <Cloud size={12} className="text-blue-400" />)}
              <span className="text-[12px] font-mono text-white/55">{group.options.find(([value]) => value === group.active)?.[1] || group.active || t?.unavailable || 'Unavailable'}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {group.options.map(([value, label]) => <button key={value} onClick={() => void sync({ [group.role]: value })}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${pref?.[group.role] === value ? 'bg-celestial-saturn text-black' : 'bg-white/5 text-white/40 hover:bg-white/10'} disabled:cursor-not-allowed disabled:opacity-40`}>{label}</button>)}
          </div>
          {pref?.[group.role] === 'relay' && models.length > 0 && <label className="flex flex-col gap-1 text-[11px] text-white/45">
            <span>Official {group.role.toUpperCase()} model</span>
            <select value={selected || models[0]} onChange={event => void sync({ [modelField]: event.target.value })}
              className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] text-white outline-none focus:border-celestial-saturn/45 disabled:opacity-40">
              {models.map(model => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>}
        </fieldset>;
      })}
      <p className="text-xs text-white/35">{officialVoiceNote}</p>
      {state.error && <div role="alert" className="text-xs text-red-300">{state.error}<button disabled={state.busy} onClick={() => void sync()} className="ml-3 underline">{uiMessage('knowledge-base.retry.9db2a8180b')}</button></div>}
    </div>
  );
}
