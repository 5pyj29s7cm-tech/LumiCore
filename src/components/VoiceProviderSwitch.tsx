// STT / TTS provider switch — Local ←→ Cloud
import { useState, useEffect } from 'react';
import { Cpu, Cloud } from 'lucide-react';
import { apiFetch } from '@/services/apiClient';

export function VoiceProviderSwitch({ t }: { t?: any }) {
  const [pref, setPref] = useState<{ stt: string; tts: string }>({ stt: 'auto', tts: 'auto' });
  const [active, setActive] = useState<{ stt: string; streamingStt?: string; tts: string }>({ stt: '?', streamingStt: '?', tts: '?' });
  const localTtsProviders = new Set(['local-cosyvoice', 'gptsovits']);

  const load = () => {
    apiFetch('/api/voice/active-provider')
      .then(r => r.json())
      .then(d => { setPref(d.pref); setActive(d.active); })
      .catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const save = async (stt: string, tts: string) => {
    await apiFetch('/api/voice/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stt, tts }),
    });
    load();
  };

  const sttOpts = [
    { value: 'auto', label: t?.auto || 'Auto' },
    { value: 'local-whisper', label: t?.local || 'Local' },
    { value: 'ark', label: 'Doubao' },
    { value: 'qwen', label: 'Qwen ASR' },
    { value: 'whisper', label: 'Whisper' },
  ];

  const ttsOpts = [
    { value: 'auto', label: t?.auto || 'Auto' },
    { value: 'local-cosyvoice', label: 'Local CosyVoice' },
    { value: 'gptsovits', label: 'GPT-SoVITS' },
    { value: 'ark', label: 'Doubao' },
    { value: 'cosyvoice', label: 'DashScope CosyVoice' },
  ];
  const providerLabel = (value: string, options: Array<{ value: string; label: string }>) =>
    options.find(o => o.value === value)?.label || value;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-black uppercase tracking-widest text-white/40">{t?.sttProvider || 'STT'}</span>
        <div className="flex items-center gap-1">
          {(active.streamingStt || active.stt) === 'local-whisper' ? <Cpu size={12} className="text-emerald-400" /> : <Cloud size={12} className={(active.streamingStt || active.stt) === 'ark' ? 'text-cyan-400' : 'text-blue-400'} />}
          <span className="text-[12px] font-mono text-white/55">{active.streamingStt || active.stt}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {sttOpts.map(o => (
          <button
            key={o.value}
            onClick={() => save(o.value, pref.tts)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              pref.stt === o.value
                ? 'bg-celestial-saturn text-black'
                : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >{o.label}</button>
        ))}
      </div>

      <div className="flex items-center justify-between mt-4">
        <span className="text-xs font-black uppercase tracking-widest text-white/40">{t?.ttsProvider || 'TTS'}</span>
        <div className="flex items-center gap-1">
          {localTtsProviders.has(active.tts) ? <Cpu size={12} className="text-emerald-400" /> : <Cloud size={12} className={active.tts === 'ark' ? 'text-cyan-400' : 'text-blue-400'} />}
          <span className="text-[12px] font-mono text-white/55">{providerLabel(active.tts, ttsOpts)}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {ttsOpts.map(o => (
          <button
            key={o.value}
            onClick={() => save(pref.stt, o.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              pref.tts === o.value
                ? 'bg-celestial-saturn text-black'
                : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >{o.label}</button>
        ))}
      </div>
    </div>
  );
}
