// First-launch setup wizard — detects local Ollama, guides API key setup, voice test
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Cpu, Cloud, Mic, CheckCircle, Loader2, ArrowRight, Download, Key, Volume2, Sparkles } from 'lucide-react';
import { useT } from '../lib/useT';
import { toast } from 'sonner';
import { saveServerKeys } from '../services/settingsKeys';
import { synthesizeSpeech } from '../services/voiceService';
import { useApp } from '../contexts/AppContext';
import { uiMessage } from '../i18n/uiMessages';

type Step = 'detect' | 'local-ready' | 'api-setup' | 'voice-test' | 'done';

interface Props {
  onFinish: () => void;
}

export function SetupWizard({ onFinish }: Props) {
  const { updateAIConfig } = useApp();
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [step, setStep] = useState<Step>('detect');
  const [ollamaStatus, setOllamaStatus] = useState<'checking' | 'available' | 'not-found'>('checking');
  const [ollamaUrl, setOllamaUrl] = useState(() => {
    try { return localStorage.getItem('lumi_ollama_url') || 'http://127.0.0.1:11434'; } catch { return 'http://127.0.0.1:11434'; }
  });
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [lmstudioStatus, setLmstudioStatus] = useState<'checking' | 'available' | 'not-found'>('checking');
  const [lmstudioUrl, setLmstudioUrl] = useState(() => {
    try { return localStorage.getItem('lumi_lmstudio_url') || 'http://127.0.0.1:1234'; } catch { return 'http://127.0.0.1:1234'; }
  });
  const [lmstudioModels, setLmstudioModels] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [apiProvider, setApiProvider] = useState('deepseek');
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'testing' | 'ok' | 'failed'>('idle');
  const [saving, setSaving] = useState(false);

  const detectOllama = async (url: string) => {
    setOllamaStatus('checking');
    try {
      const resp = await fetch('/api/ollama/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ baseUrl: url }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const models = Array.isArray(data.models) ? data.models : [];
        setOllamaUrl(data.baseUrl || url);
        setOllamaModels(models);
        setOllamaStatus(data.detected ? 'available' : 'not-found');
      } else {
        setOllamaStatus('not-found');
      }
    } catch {
      setOllamaStatus('not-found');
    }
  };

  const detectLmstudio = async (url: string) => {
    setLmstudioStatus('checking');
    try {
      const resp = await fetch('/api/lmstudio/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ baseUrl: url }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const models = Array.isArray(data.models) ? data.models : [];
        setLmstudioUrl(data.baseUrl || url);
        setLmstudioModels(models);
        setLmstudioStatus(data.detected ? 'available' : 'not-found');
      } else {
        setLmstudioStatus('not-found');
      }
    } catch {
      setLmstudioStatus('not-found');
    }
  };

  useEffect(() => {
    detectOllama(ollamaUrl);
    detectLmstudio(lmstudioUrl);
  }, []);

  const handleOllamaUrlChange = (url: string) => {
    setOllamaUrl(url);
    localStorage.setItem('lumi_ollama_url', url);
    void detectOllama(url);
  };

  const handleLmstudioUrlChange = (url: string) => {
    setLmstudioUrl(url);
    localStorage.setItem('lumi_lmstudio_url', url);
    void detectLmstudio(url);
  };

  const localAIReady = ollamaStatus === 'available' || lmstudioStatus === 'available';
  const localAINotDetected = ollamaStatus !== 'checking' && lmstudioStatus !== 'checking' && !localAIReady;

  const activateLocalAI = () => {
    const ollamaModel = ollamaModels.find(model => !/(?:embed|whisper|rerank)/i.test(model));
    const lmstudioModel = lmstudioModels.find(model => !/(?:embed|whisper|rerank)/i.test(model));
    if (ollamaStatus === 'available' && ollamaModel) {
      updateAIConfig({ provider: 'ollama', model: ollamaModel });
    } else if (lmstudioStatus === 'available' && lmstudioModel) {
      updateAIConfig({ provider: 'lmstudio', model: lmstudioModel });
    }
    setStep('voice-test');
  };

  const handleSaveApiKey = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    const keyMap: Record<string, string> = {
      deepseek: 'DEEPSEEK_API_KEY',
      qwen: 'DASHSCOPE_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GEMINI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
    };
    try {
      await saveServerKeys({ [keyMap[apiProvider]]: apiKey.trim() });
      updateAIConfig({ provider: apiProvider });
      setStep('voice-test');
    } catch (err: any) {
      toast.error(err.message || uiMessage('setup-wizard.api-key-save-failed.fafbabe3c7'));
    } finally {
      setSaving(false);
    }
  };

  const handleVoiceTest = () => {
    setVoiceStatus('testing');
    synthesizeSpeech('Hello. Your LumiCore is ready.', 'default')
      .then(() => setVoiceStatus('ok'))
      .catch(() => setVoiceStatus('failed'));
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
        {/* Step: Detection */}
        {step === 'detect' && (
          <div className="text-center space-y-6">
            <div className="flex justify-center">
              <div className="relative">
                <Cpu size={64} className="text-blue-400" />
                {(ollamaStatus === 'checking' || lmstudioStatus === 'checking') && (
                  <Loader2 size={24} className="absolute -bottom-1 -right-1 animate-spin text-blue-400" />
                )}
              </div>
            </div>
            <h2 className="text-2xl font-bold text-white">
              {ollamaStatus === 'checking' || lmstudioStatus === 'checking'
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

            {/* Ollama status line */}
            <div className="flex items-center justify-center gap-2 text-sm">
              <span className={`w-2 h-2 rounded-full ${ollamaStatus === 'available' ? 'bg-green-400' : ollamaStatus === 'checking' ? 'bg-amber-400 animate-pulse' : 'bg-red-400'}`} />
              <span className="text-white/50">Ollama</span>
              {ollamaStatus === 'available' && ollamaModels.length > 0 && (
                <span className="text-white/40 text-xs">
                  ({ollamaModels.filter(m => !m.includes('embed') && !m.includes('whisper')).length} {uiMessage('setup-wizard.models.88ac61293d')})
                </span>
              )}
            </div>

            {/* LM Studio status line */}
            <div className="flex items-center justify-center gap-2 text-sm">
              <span className={`w-2 h-2 rounded-full ${lmstudioStatus === 'available' ? 'bg-green-400' : lmstudioStatus === 'checking' ? 'bg-amber-400 animate-pulse' : 'bg-red-400'}`} />
              <span className="text-white/50">LM Studio</span>
              {lmstudioStatus === 'available' && lmstudioModels.length > 0 && (
                <span className="text-white/40 text-xs">({lmstudioModels.length} {uiMessage('setup-wizard.models.88ac61293d')})</span>
              )}
            </div>

            {localAINotDetected && (
              <div className="space-y-3">
                {/* Ollama URL */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={ollamaUrl}
                    onChange={e => setOllamaUrl(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleOllamaUrlChange(ollamaUrl)}
                    placeholder="Ollama: http://127.0.0.1:11434"
                    className="flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white font-mono text-sm focus:outline-none focus:border-emerald-500/50"
                  />
                  <button
                    onClick={() => handleOllamaUrlChange(ollamaUrl)}
                    className="px-4 py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white text-sm font-medium transition-colors"
                  >
                    {uiMessage('setup-wizard.check.aefe7855d9')}
                  </button>
                </div>
                {/* LM Studio URL */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={lmstudioUrl}
                    onChange={e => setLmstudioUrl(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleLmstudioUrlChange(lmstudioUrl)}
                    placeholder="LM Studio: http://127.0.0.1:1234"
                    className="flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white font-mono text-sm focus:outline-none focus:border-amber-500/50"
                  />
                  <button
                    onClick={() => handleLmstudioUrlChange(lmstudioUrl)}
                    className="px-4 py-3 bg-amber-600 hover:bg-amber-500 rounded-xl text-white text-sm font-medium transition-colors"
                  >
                    {uiMessage('setup-wizard.check.aefe7855d9')}
                  </button>
                </div>
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
            {(ollamaStatus !== 'checking' || lmstudioStatus !== 'checking') && (
              <button
                onClick={() => localAIReady ? activateLocalAI() : setStep('api-setup')}
                className="w-full flex items-center justify-center gap-2 px-6 py-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 rounded-2xl text-white font-semibold transition-all"
              >
                {localAIReady ? uiMessage('setup-wizard.start-using-lumi.041d2e5b6e') : uiMessage('setup-wizard.set-up-cloud-api-key.93ca8dcef6')}
                <ArrowRight size={18} />
              </button>
            )}
            {localAIReady && (
              <button onClick={() => setStep('api-setup')} className="w-full text-white/55 text-sm hover:text-white/50 py-2">
                {uiMessage('setup-wizard.also-configure-a-cloud-api.5550553e4e')}
              </button>
            )}
          </div>
        )}

        {/* Step: Local Ready */}
        {step === 'local-ready' && (
          <div className="text-center space-y-6">
            <CheckCircle size={64} className="mx-auto text-green-400" />
            <h2 className="text-2xl font-bold text-white">{uiMessage('setup-wizard.you-re-all-set.9a7beff5d2')}</h2>
            <p className="text-white/40 text-sm">
              {uiMessage('setup-wizard.lumi-will-use-your-local.41a9c8a5bd')}
            </p>
            <button onClick={() => setStep('voice-test')} className="w-full px-6 py-4 bg-green-600 hover:bg-green-500 rounded-2xl text-white font-semibold transition-colors">
              {uiMessage('setup-wizard.test-voice.4ff1c4863a')} <Volume2 size={18} className="inline ml-2" />
            </button>
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
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={`${apiProvider} API key...`}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder:text-white/45 focus:outline-none focus:border-blue-500/50 font-mono text-sm"
            />
            <button
              onClick={handleSaveApiKey}
              disabled={!apiKey.trim() || saving}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed rounded-xl text-white font-medium transition-colors"
            >
              {saving ? <Loader2 size={18} className="animate-spin" /> : <Key size={18} />}
              {uiMessage('setup-wizard.save-continue.b954571b0b')}
            </button>
            <button onClick={() => setStep('voice-test')} className="w-full text-white/55 text-sm hover:text-white/50 py-2">
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
              onClick={() => {
                setStep('done');
                setTimeout(onFinish, 1000);
              }}
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
