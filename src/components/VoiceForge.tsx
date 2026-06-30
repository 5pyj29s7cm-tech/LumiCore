import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, Phone, Loader2, Volume2, Trash2, Plus, Sparkles, CheckCircle2, XCircle, History, Play, Pause, Cpu, Upload, FileAudio } from 'lucide-react';
import { useVoiceCloning } from '../hooks/useVoiceCloning';
import { deleteVoice, synthesizeSpeech } from '../services/voiceService';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { toast } from 'sonner';
import { useT } from '../lib/useT';

export function VoiceForge({ t, compact, onCloneSuccess }: { t: any; compact?: boolean; onCloneSuccess?: () => void }) {
  const {
    isRecording,
    audioLevel,
    recordingDuration,
    recordings,
    isUploading,
    isCloning,
    cloneProgress,
    cloneStatus,
    cloneError,
    voices,
    error,
    startRecording,
    stopRecording,
    removeRecording,
    clearRecordings,
    addFiles,
    uploadAndClone,
    refreshVoices,
    clearError
  } = useVoiceCloning();

  const [voiceName, setVoiceName] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prevRecordingCount = useRef(0);
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);

  useEffect(() => {
    refreshVoices();
  }, [refreshVoices]);

  useEffect(() => {
    if (error) {
      toast.error(error);
      clearError();
    }
  }, [error, clearError]);

  useEffect(() => {
    if (recordings.length > prevRecordingCount.current) {
      toast.success(t.recordingCaptured || `Recording captured (${(recordings[recordings.length - 1]?.size / 1024).toFixed(0)} KB)`);
    }
    prevRecordingCount.current = recordings.length;
  }, [recordings.length]);

  // Audio Visualizer
  useEffect(() => {
    if (!isRecording || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrame: number;
    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const radius = 40 + audioLevel * 40;

      // Draw rings
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius + i * 20 * audioLevel, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 204, 0, ${0.3 - i * 0.1})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Draw bars
      const barCount = 64;
      for (let i = 0; i < barCount; i++) {
        const angle = (i / barCount) * Math.PI * 2;
        const length = 20 + audioLevel * 60 * (0.5 + Math.random() * 0.5);
        const x1 = centerX + Math.cos(angle) * (radius - 5);
        const y1 = centerY + Math.sin(angle) * (radius - 5);
        const x2 = centerX + Math.cos(angle) * (radius + length);
        const y2 = centerY + Math.sin(angle) * (radius + length);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = `rgba(255, 204, 0, ${0.5 + audioLevel * 0.5})`;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      animationFrame = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrame);
  }, [isRecording, audioLevel]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      addFiles(files);
      toast.success(t.addedFiles || `Added ${files.length} file(s)`);
    }
    if (e.target) e.target.value = ''; // Reset so same file can be re-selected
  };

  const handleClone = async () => {
    console.log('[VoiceForge] handleClone called, voiceName:', voiceName, 'recordings:', recordings.length);
    if (!voiceName.trim()) {
      toast.error(t.enterVoiceName || "Please enter a name for your voice essence.");
      return;
    }
    try {
      const result = await uploadAndClone(voiceName);
      console.log('[VoiceForge] uploadAndClone result:', result);
      if (result) {
        toast.success(t.voiceClonedSuccess || "Voice successfully cloned!");
        setVoiceName('');
        onCloneSuccess?.();
        refreshVoices();
      }
    } catch (e: any) {
      console.error('[VoiceForge] handleClone error:', e);
      toast.error(e.message || 'Clone failed');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteVoice(id);
      toast.success(t.voiceDeletedSuccess || "Voice successfully deleted.");
      refreshVoices();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const clonedVoices = voices.filter(v => (v.category || 'cloned') === 'cloned');
  const premadeVoices = voices.filter(v => v.category === 'premade');

  return (
    <div className="space-y-8 h-full flex flex-col">
      {!compact && (
        <div className="lumi-panel flex items-start justify-between gap-4 p-5">
          <div>
             <h3 className="text-3xl font-black italic uppercase tracking-tighter text-glow mb-2">{t.voiceForge || ui('声音工坊', 'Voice Forge')}</h3>
             <p className="text-xs text-white/40 uppercase tracking-widest leading-relaxed max-w-lg">
               {t.voiceForgeDesc || ui('克隆你的声音，或从预设声音中选择。', 'Clone your digital essence or select from neural presets.')}
             </p>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-celestial-saturn/20 bg-celestial-saturn/10 p-4 shadow-xl">
             <Sparkles className="text-celestial-saturn animate-pulse" size={20} />
             <div className="text-xs font-black uppercase tracking-widest text-celestial-saturn">{t.neuralSynthesisActive || ui('语音合成已启用', 'Neural Synthesis Active')}</div>
          </div>
        </div>
      )}

      <div className={`${compact ? '' : 'grid grid-cols-1 lg:grid-cols-2 gap-8'} flex-1 overflow-hidden`}>
        {/* Recording & Cloning */}
        <div className={`space-y-6 overflow-y-auto ${compact ? '' : 'pr-4 custom-scrollbar'}`}>
           <div className="lumi-panel relative space-y-8 overflow-hidden p-8">
              <div className="text-center space-y-6 relative z-10">
                 <div className="text-xs font-black uppercase tracking-[0.4em] text-white/45">{t.audioVisualizer || ui('音频可视化', 'Neural Audio Visualizer')}</div>
                 
                 <div className="flex justify-center items-center h-48">
                    {!isRecording ? (
                      <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={startRecording}
                        className="w-32 h-32 rounded-full bg-white/5 border border-white/10 flex items-center justify-center group hover:bg-celestial-saturn/20 hover:border-celestial-saturn/40 transition-all shadow-2xl relative"
                      >
                         <div className="absolute inset-0 rounded-full bg-celestial-saturn/10 animate-ping opacity-20" />
                         <Mic size={48} className="text-white/45 group-hover:text-celestial-saturn transition-colors" />
                      </motion.button>
                    ) : (
                      <canvas 
                        ref={canvasRef} 
                        width={300} 
                        height={300} 
                        className="w-48 h-48"
                      />
                    )}
                 </div>

                 <div className="flex flex-col items-center gap-4">
                    <Button
                      onClick={isRecording ? stopRecording : startRecording}
                      className={`h-14 px-10 rounded-full font-black uppercase tracking-widest text-xs transition-all ${
                        isRecording
                          ? 'bg-celestial-mars text-white hover:bg-red-600 shadow-[0_0_30px_rgba(255,102,102,0.3)] animate-pulse'
                          : 'bg-white text-black hover:bg-celestial-saturn shadow-xl'
                      }`}
                    >
                      {isRecording ? (
                        <div className="flex items-center gap-3">
                           <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                           {t.stopRecording || 'Stop Recording'}
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                           <Mic size={16} />
                           {t.startRecording || 'Start Recording'}
                        </div>
                      )}
                    </Button>
                    <div className="flex flex-col items-center gap-1">
                       {isRecording && (
                         <div className="flex items-center gap-2">
                           <span className="text-sm font-mono font-bold text-celestial-saturn">
                             {recordingDuration}s
                           </span>
                           <span className="text-xs font-bold text-white/45">
                             {t.secRecommended || '/ 15-30s recommended'}
                           </span>
                           {recordingDuration >= 15 && (
                             <span className="text-xs font-black text-green-400 animate-pulse">{t.vfOptimal || 'OPTIMAL'}</span>
                           )}
                         </div>
                       )}
                       <p className="text-xs font-bold text-white/55 uppercase tracking-widest italic leading-relaxed">
                         {isRecording
                           ? recordingDuration < 5
                             ? (t.keepSpeaking || "Keep speaking — neural map needs more data")
                             : recordingDuration < 15
                               ? (t.goodMoreSeconds || "Good — a few more seconds for optimal capture")
                               : recordingDuration < 30
                                 ? (t.neuralPatternsCaptured || "Neural patterns captured — stop when ready")
                                 : (t.recordingComplete || "Excellent! Recording complete — stop to save")
                           : (t.speakNaturally || "Speak naturally for 15-30 seconds for optimal capture.")}
                       </p>
                    </div>

                    {/* File upload alternative */}
                    <div className="flex items-center gap-2 pt-2">
                      <div className="flex-1 h-px bg-white/5" />
                      <span className="text-xs text-white/40 uppercase tracking-widest">{t.orDivider || 'or'}</span>
                      <div className="flex-1 h-px bg-white/5" />
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="audio/*"
                      multiple
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                    <Button
                      onClick={() => fileInputRef.current?.click()}
                      className="lumi-button h-10 rounded-full px-6 text-xs"
                    >
                      <Upload size={14} className="mr-1" />
                      {t.uploadAudioFile || ui('上传音频文件', 'Upload Audio File')}
                    </Button>
                    <p className="text-[10px] text-white/25 font-mono mt-1">MP3, WAV, WebM, OGG, M4A &middot; &le;10 MB</p>
                 </div>
              </div>
           </div>

           {recordings.length > 0 && (
             <motion.div 
               initial={{ opacity: 0, y: 20 }}
               animate={{ opacity: 1, y: 0 }}
               className="lumi-panel space-y-6 p-8"
             >
                <div className="flex justify-between items-center">
                   <h4 className="text-xs font-black uppercase tracking-widest text-white/40 flex items-center gap-2">
                     <History size={14} />
                     {t.recordings || ui('录音样本', 'Recordings')} ({recordings.length})
                   </h4>
                   <button onClick={clearRecordings} className="text-[12px] font-bold text-red-400 uppercase tracking-widest hover:underline transition-all">{t.vfClearAll || 'Clear All'}</button>
                </div>

                <div className="grid grid-cols-1 gap-3">
                   {recordings.map((recording, i) => (
                     <div key={i} className="lumi-panel group flex items-center justify-between p-4 transition-colors hover:bg-white/10">
                        <div className="flex items-center gap-4">
                           <div className="w-10 h-10 rounded-xl bg-celestial-saturn/20 flex items-center justify-center text-celestial-saturn">
                              <Volume2 size={18} />
                           </div>
                           <div>
                              <div className="text-xs font-black text-white/80 uppercase">{t.sampleLabel || 'Sample'} {i + 1}</div>
                              <div className="text-xs text-white/45 uppercase font-black">{(recording.size / 1024).toFixed(1)} {t.kbWebMOpus || 'KB • WebM Opus'}</div>
                           </div>
                        </div>
                        <div className="flex items-center gap-2">
                           <button onClick={() => removeRecording(i)} className="p-2 text-white/45 hover:text-red-400 transition-colors">
                              <Trash2 size={16} />
                           </button>
                        </div>
                     </div>
                   ))}
                </div>

                <div className="pt-6 border-t border-white/5 space-y-4">
                   <div className="space-y-2">
                      <label className="text-xs font-black uppercase tracking-widest text-white/55 ml-2">{t.voiceName || ui('声音名称', 'Voice Name')}</label>
                      <Input
                        value={voiceName}
                        onChange={e => setVoiceName(e.target.value)}
                        placeholder="e.g. Master_Essence_v1"
                        className="lumi-field h-12 rounded-2xl focus-visible:ring-celestial-saturn/50"
                      />
                   </div>

                   {cloneStatus !== 'idle' && (
                     <motion.div
                       initial={{ opacity: 0, height: 0 }}
                       animate={{ opacity: 1, height: 'auto' }}
                       className={`p-4 rounded-2xl space-y-3 border ${
                         cloneStatus === 'error' ? 'bg-red-500/5 border-red-500/20' :
                         cloneStatus === 'success' ? 'bg-green-500/5 border-green-500/20' :
                         'bg-yellow-500/5 border-yellow-500/20'
                       }`}
                     >
                       <div className="flex items-center gap-3">
                         {cloneStatus === 'uploading' || cloneStatus === 'cloning' ? (
                           <Loader2 size={18} className="animate-spin text-yellow-400" />
                         ) : cloneStatus === 'success' ? (
                           <CheckCircle2 size={18} className="text-green-400" />
                         ) : (
                           <XCircle size={18} className="text-red-400" />
                         )}
                         <span className={`text-xs font-bold uppercase tracking-widest ${
                           cloneStatus === 'error' ? 'text-red-400' :
                           cloneStatus === 'success' ? 'text-green-400' :
                           'text-yellow-400'
                         }`}>
                           {cloneStatus === 'error' ? cloneError :
                            cloneStatus === 'success' ? (t.voiceClonedSuccessStatus || 'Voice cloned successfully!') :
                            cloneProgress}
                         </span>
                       </div>
                       {(cloneStatus === 'uploading' || cloneStatus === 'cloning') && (
                         <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                           <motion.div
                             className="h-full bg-gradient-to-r from-yellow-400 to-celestial-saturn"
                             initial={{ width: 0 }}
                             animate={{ width: cloneStatus === 'uploading' ? '40%' : '80%' }}
                             transition={{ duration: 0.5 }}
                           />
                         </div>
                       )}
                     </motion.div>
                   )}

                   <Button
                     onClick={handleClone}
                     disabled={cloneStatus === 'uploading' || cloneStatus === 'cloning' || !voiceName.trim()}
                     className="lumi-button-primary h-14 w-full rounded-2xl bg-celestial-saturn/15 text-celestial-saturn hover:bg-celestial-saturn/25"
                   >
                     {isUploading || isCloning ? (
                        <div className="flex items-center gap-3">
                           <Loader2 size={18} className="animate-spin" />
                           {cloneProgress || (t.cloningInProgress || 'Cloning in progress...')}
                        </div>
                     ) : (
                        <div className="flex items-center gap-3">
                           <Sparkles size={18} />
                           {t.cloneVoice || 'Clone Voice'}
                        </div>
                     )}
                   </Button>
                </div>
             </motion.div>
           )}
        </div>

        {/* Right Side: Voice Inventory — hidden in compact mode */}
        {!compact && <div className="overflow-y-auto pr-4 custom-scrollbar">
           <div className="space-y-8 pb-12">
              <section className="space-y-4">
                 <div className="flex items-center justify-between">
                    <h4 className="text-xs font-black uppercase tracking-[0.3em] text-white/40 italic">{t.clonedVoices || ui('克隆声音', 'Cloned Voices')}</h4>
                    <span className="text-xs font-mono text-celestial-saturn/40">{clonedVoices.length} {t.voicesLimit || '/ 10 limit'}</span>
                 </div>
                 
                 <div className="grid grid-cols-1 gap-4">
                    {clonedVoices.length > 0 ? clonedVoices.map((v, i) => (
                      <VoiceCard 
                        key={v.voiceId} 
                        voice={v} 
                        onDelete={() => handleDelete(v.voiceId)}
                        isCloned
                      />
                    )) : (
                      <div className="lumi-panel flex flex-col items-center justify-center space-y-4 border-dashed p-12 text-center">
                         <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center text-white/35">
                            <MicOff size={32} />
                         </div>
                         <p className="text-xs font-black uppercase tracking-widest text-white/45 italic">
                            {t.noRecordings || ui('还没有录音样本。录一段声音即可创建。', 'No recordings found. Speak to create one.')}
                         </p>
                      </div>
                    )}
                 </div>
              </section>

              <section className="space-y-4">
                 <div className="flex items-center justify-between">
                    <h4 className="text-xs font-black uppercase tracking-[0.3em] text-white/40 italic">{t.premadeVoices || ui('预设声音', 'Premade Voices')}</h4>
                 </div>
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {premadeVoices.map((v) => (
                      <VoiceCard key={v.voiceId} voice={v} />
                    ))}
                 </div>
              </section>
           </div>
        </div>
        }
      </div>
    </div>
  );
}

function VoiceCard({ voice, onDelete, isCloned = false }: { voice: any, onDelete?: () => void, isCloned?: boolean }) {
  const t = useT();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  const handlePlay = async () => {
    if (isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
      return;
    }
    setIsLoading(true);
    try {
      const buffer = await synthesizeSpeech('你好，这是我的声音样本。Hello, this is my voice sample.', voice.voiceId || voice.id, voice.provider, voice.model);
      const blob = new Blob([buffer], { type: 'audio/mp3' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { setIsPlaying(false); URL.revokeObjectURL(url); };
      audio.onerror = () => { setIsPlaying(false); URL.revokeObjectURL(url); toast.error(t.playbackFailed || 'Playback failed'); };
      await audio.play();
      setIsPlaying(true);
    } catch {
      toast.error(t.failedToPlaySample || 'Failed to play voice sample');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true }}
      className="lumi-panel group relative overflow-hidden p-6 transition-colors hover:border-white/20 hover:bg-white/10"
    >
       <div className="flex items-center justify-between relative z-10">
          <div className="flex items-center gap-4">
             <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg transition-transform group-hover:scale-110 ${
               isCloned ? 'bg-gradient-to-br from-celestial-saturn to-celestial-mars text-black' : 'bg-white/10 text-white/60'
             }`}>
                {isCloned ? <Sparkles size={24} /> : <Cpu size={24} />}
             </div>
             <div>
                <div className="text-sm font-black text-white tracking-tight">{voice.name}</div>
                <div className="flex items-center gap-2 mt-1">
                   {isCloned && <CheckCircle2 size={10} className="text-celestial-saturn" />}
                   <div className="text-xs font-black uppercase tracking-widest text-white/55">{voice.provider}</div>
                </div>
             </div>
          </div>

          <div className="flex items-center gap-2">
             <button
               onClick={handlePlay}
               disabled={isLoading}
               className="lumi-icon-button h-10 w-10"
             >
                {isLoading ? <Loader2 size={18} className="animate-spin" /> : isPlaying ? <Pause size={18} /> : <Play size={18} />}
             </button>
             {isCloned && onDelete && (
               <button 
                 onClick={onDelete}
                 className="lumi-icon-button h-10 w-10 border-red-500/20 bg-red-500/10 text-red-400 opacity-0 transition-all hover:bg-red-500/20 group-hover:opacity-100"
               >
                  <Trash2 size={18} />
               </button>
             )}
          </div>
       </div>

       {isCloned && (
         <div className="absolute top-0 right-0 p-4">
            <div className="w-1 h-1 rounded-full bg-celestial-saturn animate-ping" />
         </div>
       )}
    </motion.div>
  );
}
