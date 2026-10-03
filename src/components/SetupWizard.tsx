// First-launch setup wizard — detects local Ollama, guides API key setup, voice test
import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Cpu, Mic, Loader2, ArrowRight, Download, Key, Volume2, Sparkles } from 'lucide-react';
import { useLocale } from '../lib/useT';
import { toast } from 'sonner';
import { saveServerKeys } from '../services/settingsKeys';
import { synthesizeSpeech } from '../services/voiceService';
import { useApp } from '../contexts/AppContext';
import { uiMessage } from '../i18n/uiMessages';
import { useLocalModelConfig } from '../hooks/useLocalModelConfig';

type Step = 'detect' | 'api-setup' | 'voice-test' | 'done';
const localProviders = [
  { id: 'ollama', name: 'Ollama', defaultUrl: 'http://127.0.0.1:11434', inputClass: 'focus:border-emerald-500/50', buttonClass: 'bg-emerald-600 hover:bg-emerald-500' },
  { id: 'lmstudio', name: 'LM Studio', defaultUrl: 'http://127.0.0.1:1234', inputClass: 'focus:border-amber-500/50', buttonClass: 'bg-amber-600 hover:bg-amber-500' },
] as const;

interface Props {
  onFinish: () => void;
}

export function SetupWizard({ onFinish }: Props) {
  const { aiConfig, updateAIConfig, reloadModelPreferences } = useApp();
  useLocale();
  const [step, setStep] = useState<Step>('detect');
  const local = {
    ollama: useLocalModelConfig('ollama', localProviders[0].defaultUrl, true),
    lmstudio: useLocalModelConfig('lmstudio', localProviders[1].defaultUrl, true),
  };
  const lifetime = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const [apiKey, setApiKey] = useState('');
  const [apiProvider, setApiProvider] = useState('deepseek');
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'testing' | 'ok' | 'failed'>('idle');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const owner = new AbortController();
    lifetime.current = owner;
    return () => owner.abort();
  }, []);
  useEffect(() => {
    if (step !== 'done') return;
    const timer = setTimeout(onFinish, 1000);
    return () => clearTimeout(timer);
  }, [step, onFinish]);

  const readyProvider = localProviders.find(provider => local[provider.id].status === 'available');
  const localAIReady = Boolean(readyProvider);
  const checking = Object.values(local).some(config => config.status === 'checking');
  const localAINotDetected = !checking && !localAIReady;
  const saveModel = async (provider: string, model?: string, key?: string) => {
    const owner = lifetime.current;
    if (savingRef.current || !owner || owner.signal.aborted) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (key) {
        const keyMap: Record<string, string> = { deepseek: 'DEEPSEEK_API_KEY', qwen: 'DASHSCOPE_API_KEY', openai: 'OPENAI_API_KEY' };
        await saveServerKeys({ [keyMap[provider]]: key });
      }
      if (owner.signal.aborted) return;
      const saved = await updateAIConfig({ provider, ...(model ? { model } : {}) });
      if (saved && !owner.signal.aborted) setStep('voice-test');
    } catch (err: any) {
      if (!owner.signal.aborted) toast.error(err.message || uiMessage('setup-wizard.api-key-save-failed.fafbabe3c7'));
    } finally {
      savingRef.current = false;
      if (!owner.signal.aborted) setSaving(false);
    }
  };

  const handleVoiceTest = () => {
    const owner = lifetime.current;
    setVoiceStatus('testing');
    synthesizeSpeech('Hello. Your LumiCore is ready.', 'default')
      .then(() => { if (!owner?.signal.aborted) setVoiceStatus('ok'); })
      .catch(() => { if (!owner?.signal.aborted) setVoiceStatus('failed'); });
  };

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={step}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        className="mx-auto w-full max-w-md py-3"
      >
        {aiConfig?.ready === false && <div role="status" className="mb-4 text-sm text-amber-200">
          {aiConfig.loadError ? <><p role="alert">{aiConfig.loadError}</p><button type="button" onClick={() => void reloadModelPreferences('llm')}>{uiMessage('knowledge-base.retry.9db2a8180b')}</button></> : <Loader2 className="animate-spin" />}
        </div>}
        {/* Step: Detection */}
        {step === 'detect' && (
          <div className="text-center space-y-6">
            <div className="flex justify-center">
              <div className="relative">
                <Cpu size={64} className="text-blue-400" />
                {checking && (
                  <Loader2 size={24} className="absolute -bottom-1 -right-1 animate-spin text-blue-400" />
                )}
              </div>
            </div>
            <h2 className="text-2xl font-bold text-white">
              {checking
                ? uiMessage('setup-wizard.detecting-local-ai.602d16929a')
                : localAIReady
                ? uiMessage('setup-wizard.local-ai-found.3453ef19a1')
                : uiMessage('setup-wizard.no-local-ai-detected.7023a416ab')}
            </h2>
            <p className="text-white/40 text-sm">
              {localAIReady
                ? uiMessage('setup-wizard.local-llm-detected-your-conversations.bca559f19e')
                : (localAINotDetected
                  ? uiMessage('setup-wizard.no-local-model-found-you.2a55745fc0')
                  : '')
              }
            </p>

            {localProviders.map(({ id, name }) => (
              <div key={id} className="flex items-center justify-center gap-2 text-sm">
                <span className={`w-2 h-2 rounded-full ${local[id].status === 'available' ? 'bg-green-400' : local[id].status === 'checking' ? 'bg-amber-400 animate-pulse' : 'bg-red-400'}`} />
                <span className="text-white/50">{name}</span>
                {local[id].status === 'available' && (
                  <span className="text-white/40 text-xs">({local[id].models.length} {uiMessage('setup-wizard.models.88ac61293d')})</span>
                )}
              </div>
            ))}

            {localAINotDetected && (
              <div className="space-y-3">
                {localProviders.map(({ id, name, defaultUrl, inputClass, buttonClass }) => (
                  <div key={id} className="flex gap-2">
                    <input
                      type="text"
                      value={local[id].url}
                      onChange={e => local[id].setUrl(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && local[id].detect()}
                      placeholder={`${name}: ${defaultUrl}`}
                      className={`flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white font-mono text-sm focus:outline-none ${inputClass}`}
                    />
                    <button
                      onClick={() => local[id].detect()}
                      className={`px-4 py-3 ${buttonClass} rounded-xl text-white text-sm font-medium transition-colors`}
                    >
                      {uiMessage('setup-wizard.check.aefe7855d9')}
                    </button>
                  </div>
                ))}
                <a
                  href="https://ollama.com/download"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-6 py-3 bg-white/10 hover:bg-white/20 rounded-xl text-white text-sm transition-colors"
                >
                  <Download size={16} />
                  {uiMessage('setup-wizard.install-ollama-free.db52b0b411')}
                </a>
              </div>
            )}
            {!checking && (
              <button
                disabled={saving}
                onClick={() => readyProvider ? saveModel(readyProvider.id, local[readyProvider.id].models[0]) : setStep('api-setup')}
                className="w-full flex items-center justify-center gap-2 px-6 py-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 rounded-2xl text-white font-semibold transition-all"
              >
                {localAIReady ? uiMessage('setup-wizard.start-using-lumi.041d2e5b6e') : uiMessage('setup-wizard.set-up-cloud-api-key.93ca8dcef6')}
                <ArrowRight size={18} />
              </button>
            )}
            {localAIReady && (
              <button disabled={saving} onClick={() => setStep('api-setup')} className="w-full text-white/55 text-sm hover:text-white/50 py-2">
                {uiMessage('setup-wizard.also-configure-a-cloud-api.5550553e4e')}
              </button>
            )}
          </div>
        )}

        {/* Step: API Key Setup */}
        {step === 'api-setup' && (
          <div className="space-y-5">
            <h2 className="text-xl font-bold text-white text-center">{uiMessage('setup-wizard.cloud-api-setup.c1f9d6e0a8')}</h2>
            <p className="text-white/40 text-sm text-center">
              {uiMessage('setup-wizard.pick-a-provider-and-enter.9100890463')}
            </p>
            <div className="grid grid-cols-3 gap-2">
              {['deepseek', 'qwen', 'openai'].map(p => (
                <button
                  key={p}
                  disabled={saving}
                  onClick={() => setApiProvider(p)}
                  className={`px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${
                    apiProvider === p ? 'bg-blue-600 border-blue-500 text-white' : 'bg-white/5 border-white/10 text-white/50 hover:border-white/20'
                  }`}
                >
                  {p === 'deepseek' ? 'DeepSeek' : p === 'qwen' ? 'Qwen' : 'OpenAI'}
                </button>
              ))}
            </div>
            <input
              type="password"
              disabled={saving}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={`${apiProvider} API key...`}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder:text-white/45 focus:outline-none focus:border-blue-500/50 font-mono text-sm"
            />
            <button
              onClick={() => apiKey.trim() && saveModel(apiProvider, undefined, apiKey.trim())}
              disabled={!apiKey.trim() || saving}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed rounded-xl text-white font-medium transition-colors"
            >
              {saving ? <Loader2 size={18} className="animate-spin" /> : <Key size={18} />}
              {uiMessage('setup-wizard.save-continue.b954571b0b')}
            </button>
            <button disabled={saving} onClick={() => setStep('voice-test')} className="w-full text-white/55 text-sm hover:text-white/50 py-2">
              {uiMessage('setup-wizard.skip-for-now.aa17771d23')}
            </button>
          </div>
        )}

        {/* Step: Voice Test */}
        {step === 'voice-test' && (
          <div className="text-center space-y-6">
            <Mic size={64} className={`mx-auto ${voiceStatus === 'ok' ? 'text-green-400' : voiceStatus === 'failed' ? 'text-red-400' : 'text-blue-400'}`} />
            <h2 className="text-2xl font-bold text-white">{uiMessage('setup-wizard.voice-check.b7976f3351')}</h2>
            <p className="text-white/40 text-sm">
              {voiceStatus === 'idle' && uiMessage('setup-wizard.let-s-make-sure-voice.6fe49778fb')}
              {voiceStatus === 'testing' && uiMessage('setup-wizard.playing-test-audio.3676fd7240')}
              {voiceStatus === 'ok' && uiMessage('setup-wizard.voice-is-working-perfectly.05e61e2cc0')}
              {voiceStatus === 'failed' && uiMessage('setup-wizard.voice-needs-configuration-you-can.8df8a50b27')}
            </p>
            {voiceStatus === 'idle' && (
              <button onClick={handleVoiceTest} className="px-6 py-3 bg-purple-600 hover:bg-purple-500 rounded-xl text-white font-medium transition-colors">
                {uiMessage('setup-wizard.play-test-audio.21442f181f')} <Volume2 size={18} className="inline ml-2" />
              </button>
            )}
            <button
              onClick={() => setStep('done')}
              className="w-full flex items-center justify-center gap-2 px-6 py-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 rounded-2xl text-white font-semibold transition-all"
            >
              <Sparkles size={18} />
              {uiMessage('setup-wizard.launch-lumi.575da2f948')}
            </button>
          </div>
        )}

        {/* Step: Done */}
        {step === 'done' && (
          <div className="text-center space-y-6">
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200 }}>
              <Sparkles size={64} className="mx-auto text-celestial-saturn" />
            </motion.div>
            <h2 className="text-2xl font-bold text-white">{uiMessage('setup-wizard.lumi-is-ready.6c3e0f7cda')}</h2>
            <p className="text-white/40 text-sm">{uiMessage('setup-wizard.your-personal-ai-is-live.93671d768f')}</p>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
