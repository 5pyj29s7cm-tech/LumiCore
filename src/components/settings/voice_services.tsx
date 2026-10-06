import { lazy } from "react";
import { Music } from "lucide-react";
import { VoiceProviderSwitch } from "../VoiceProviderSwitch";
import { VoiceDeviceSelector } from "../VoiceDeviceSelector";
import { uiMessage } from "../../i18n/uiMessages";
import { SettingsSection } from './components';
import { LumiOfficialCapabilityBadge } from './official_models';
import { VoicePreferenceToggle } from './vision_voice_preferences';

export const VoiceForge = lazy(() => import("../VoiceForge").then(m => ({ default: m.VoiceForge })));

export function VoiceServicesPage({ t }: { t: any }) {
  return (
    <div className="space-y-8">
      <SettingsSection title={t.audioOutput || uiMessage('settings.audio-voice-output.e1f3dc4c32')} icon={<Music size={18} className="text-celestial-saturn" />}>
        <div className="space-y-4 mb-6">
          <div className="p-4 rounded-2xl bg-white/5 border border-white/5 space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold text-white/80">{t.ttsEngine || uiMessage('settings.tts-engine.a69f1a5e70')}</span>
            </div>
            <p className="text-xs text-white/40">{t.ttsEngineDesc || uiMessage('settings.local-tts-local-cosyvoice-gpt.ec3eae7527')}</p>
          </div>
          <div className="p-4 rounded-2xl bg-white/5 border border-white/5 space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold text-white/80">{t.sttEngine || uiMessage('settings.stt-engine.3e8df8d9d4')}</span>
            </div>
            <p className="text-xs text-white/40">{t.sttEngineDesc || uiMessage('settings.local-whisper-openai-whisper-doubao.ff3da59708')}</p>
          </div>
          <VoiceProviderSwitch t={t} />
          <VoiceDeviceSelector />
        </div>
        <LumiOfficialCapabilityBadge t={t} supported={true} capabilityKey="settings.capability-speech-recognition-synthesis.c5d6e7f8a9" />
        <p className="text-sm text-white/40 max-w-xl mb-6">
          {t.voiceServicesDesc || uiMessage('settings.speech-recognition-asr-and-speech.4d604985a1')}
        </p>
        <div className="mt-6 space-y-3 p-4 bg-white/5 rounded-xl border border-white/10">
          {[
            { key: 'lumi_allow_proactive_voice', label: t.proactiveVoiceGreeting, description: t.proactiveVoiceGreetingDesc },
            { key: 'lumi_wake_word_enabled', label: t.wakeWordLabel, description: t.wakeWordDesc },
            { key: 'lumi_always_on_voice', label: t.alwaysOnVoiceLabel, description: t.alwaysOnVoiceDesc },
          ].map(({ key, label, description }) => (
            <div key={key} className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold text-white/80">{label}</p>
                <p className="text-xs text-white/55 mt-0.5">{description}</p>
              </div>
              <VoicePreferenceToggle storageKey={key} label={label} />
            </div>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
