import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  X, 
  Upload, 
  Settings2, 
  Mic, 
  CheckCircle2, 
  Loader2, 
  FileAudio,
  Plus,
  Trash2,
  Sparkles
} from 'lucide-react';
import { uploadSamples, cloneVoice } from '@/services/voiceService';
import { toast } from 'sonner';
import { useT } from '../lib/useT';

interface VoiceTrainingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function VoiceTrainingDialog({ isOpen, onClose, onSuccess }: VoiceTrainingDialogProps) {
  const t = useT();
  const [step, setStep] = useState<'upload' | 'naming' | 'cloning' | 'success'>('upload');
  const [files, setFiles] = useState<File[]>([]);
  const [voiceName, setVoiceName] = useState('');
  const [provider, setProvider] = useState<'cosyvoice'>('cosyvoice');
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploadedUrls, setUploadedUrls] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selected = Array.from(e.target.files);
      setFiles(prev => [...prev, ...selected]);
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const startUpload = async () => {
    if (files.length === 0) {
      toast.error(t.selectAudioSample || 'Please select at least one audio sample');
      return;
    }

    setIsProcessing(true);
    try {
      const { urls } = await uploadSamples(files);
      setUploadedUrls(urls);
      setStep('naming');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const startClone = async () => {
    if (!voiceName.trim()) {
      toast.error(t.enterVoiceNameRequired || 'Please enter a voice name');
      return;
    }

    setIsProcessing(true);
    setStep('cloning');
    try {
      await cloneVoice(uploadedUrls, voiceName, provider);
      setStep('success');
      setTimeout(() => {
        onSuccess();
        onClose();
        reset();
      }, 2000);
    } catch (err) {
      setStep('naming');
      toast.error(err instanceof Error ? err.message : 'Cloning failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const reset = () => {
    setStep('upload');
    setFiles([]);
    setVoiceName('');
    setIsProcessing(false);
    setUploadedUrls([]);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-auto">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
          />
          
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="relative w-full max-w-xl bg-celestial-deep border border-white/10 rounded-[2.5rem] overflow-hidden shadow-2xl"
          >
            {/* Header */}
            <div className="p-8 border-b border-white/5 flex justify-between items-center bg-white/2">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-celestial-saturn/10 flex items-center justify-center text-celestial-saturn">
                  <Mic size={24} />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">Voice Lab</h3>
                  <p className="text-xs font-black uppercase tracking-widest text-white/55">Clone & Train Neural Voices</p>
                </div>
              </div>
              <button 
                onClick={onClose}
                className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-white/40 hover:bg-white/10 hover:text-white transition-all shadow-lg"
              >
                <X size={20} />
              </button>
            </div>

            {/* Content */}
            <div className="p-8">
              {step === 'upload' && (
                <div className="space-y-6">
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={(e) => {
                      e.preventDefault(); e.stopPropagation();
                      if (e.dataTransfer.files) {
                        const dropped = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('audio/'));
                        if (dropped.length === 0) toast.error(t.onlyAudioFilesAccepted || 'Only audio files are accepted');
                        else setFiles(prev => [...prev, ...dropped]);
                      }
                    }}
                    className="group relative h-48 rounded-[2rem] border-2 border-dashed border-white/10 flex flex-col items-center justify-center gap-4 cursor-pointer hover:border-celestial-saturn/50 hover:bg-celestial-saturn/5 transition-all overflow-hidden"
                  >
                    <input 
                      type="file" 
                      ref={fileInputRef} 
                      className="hidden" 
                      multiple 
                      accept="audio/*" 
                      onChange={handleFileSelect}
                    />
                    <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center text-white/40 group-hover:scale-110 group-hover:bg-celestial-saturn/20 group-hover:text-celestial-saturn transition-all shadow-xl">
                      <Upload size={32} />
                    </div>
                    <div className="text-center">
                      <p className="text-white font-bold">Drop Audio Samples Here</p>
                      <p className="text-xs font-medium text-white/40 uppercase tracking-widest mt-1">Click or drag — WAV, MP3, OGG</p>
                    </div>
                  </div>

                  <div className="space-y-3 max-h-48 overflow-y-auto custom-scrollbar pr-2">
                    {files.map((file, i) => (
                      <div key={i} className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5 group hover:bg-white/10 transition-all shadow-md">
                        <div className="flex items-center gap-3">
                          <FileAudio size={18} className="text-celestial-saturn" />
                          <div className="w-48">
                            <p className="text-sm font-bold text-white truncate">{file.name}</p>
                            <p className="text-xs font-black text-white/55 uppercase">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                          </div>
                        </div>
                        <button 
                          onClick={() => removeFile(i)}
                          className="w-8 h-8 rounded-lg bg-red-500/10 text-red-400 opacity-0 group-hover:opacity-100 transition-all hover:bg-red-500 hover:text-white shadow-lg"
                        >
                          <Trash2 size={14} className="mx-auto" />
                        </button>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={startUpload}
                    disabled={files.length === 0 || isProcessing}
                    className={`w-full py-5 rounded-[1.5rem] font-black uppercase tracking-[0.2em] transition-all flex items-center justify-center gap-3 shadow-xl ${
                      files.length > 0 && !isProcessing
                        ? 'bg-celestial-saturn text-black hover:scale-[1.02] active:scale-[0.98]'
                        : 'bg-white/5 text-white/45 cursor-not-allowed'
                    }`}
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 size={20} className="animate-spin" />
                        Analyzing Samples...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={20} />
                        Next: Define Character
                      </>
                    )}
                  </button>
                </div>
              )}

              {step === 'naming' && (
                <div className="space-y-8">
                  <div className="space-y-4">
                    <label className="text-xs font-black text-white/40 uppercase tracking-[0.3em]">Identity Designation</label>
                    <input 
                      type="text" 
                      value={voiceName}
                      onChange={(e) => setVoiceName(e.target.value)}
                      placeholder="e.g., Nova-Zero"
                      className="w-full h-16 bg-white/5 border border-white/10 rounded-2xl px-6 text-white font-bold focus:outline-none focus:border-celestial-saturn transition-all shadow-inner"
                    />
                  </div>

                  <div className="space-y-4">
                    <label className="text-xs font-black text-white/40 uppercase tracking-[0.3em]">Engine Architecture</label>
                    <p className="text-[12px] text-white/45 leading-relaxed">DashScope CosyVoice is the supported cloning engine for custom voices. Add a DashScope key in Voice Services before cloning.</p>
                    <div className="grid grid-cols-2 gap-4">
                      {(['cosyvoice'] as const).map((p) => (
                        <button
                          key={p}
                          onClick={() => setProvider(p)}
                          className={`p-4 rounded-2xl border transition-all text-center group relative overflow-hidden ${
                            provider === p 
                              ? 'bg-celestial-saturn/10 border-celestial-saturn text-celestial-saturn shadow-lg shadow-celestial-saturn/20' 
                              : 'bg-white/5 border-white/5 text-white/40 hover:bg-white/10'
                          }`}
                        >
                          {provider === p && (
                            <motion.div layoutId="provider-bg" className="absolute inset-0 bg-celestial-saturn/5" />
                          )}
                          <p className="text-xs font-black uppercase tracking-widest relative z-10">DashScope CosyVoice</p>
                          <p className="text-xs font-medium opacity-60 mt-1 relative z-10">DashScope clone</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={startClone}
                    disabled={!voiceName.trim() || isProcessing}
                    className="w-full py-5 bg-celestial-saturn text-black rounded-[1.5rem] font-black uppercase tracking-[0.2em] hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-3 shadow-xl"
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 size={20} className="animate-spin" />
                        Cloning Archetype...
                      </>
                    ) : (
                      <>
                        <Sparkles size={20} />
                        Initiate Neural Cloning
                      </>
                    )}
                  </button>
                </div>
              )}

              {step === 'cloning' && (
                <div className="py-12 flex flex-col items-center justify-center text-center space-y-6">
                  <div className="relative">
                    <div className="w-32 h-32 rounded-full border-4 border-celestial-saturn/20 animate-ping absolute inset-0" />
                    <div className="w-32 h-32 rounded-full border-4 border-t-celestial-saturn border-white/5 animate-spin relative flex items-center justify-center">
                      <Sparkles size={48} className="text-celestial-saturn animate-pulse" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-2xl font-bold text-white">Synthesizing Neural Map</h4>
                    <p className="text-sm font-medium text-white/40 max-w-xs mx-auto">Mapping your vocal frequencies to a new neural voice archetype.</p>
                  </div>
                </div>
              )}

              {step === 'success' && (
                <div className="py-12 flex flex-col items-center justify-center text-center space-y-6">
                  <div className="w-32 h-32 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 shadow-2xl shadow-green-500/20">
                    <CheckCircle2 size={64} className="animate-bounce" />
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-2xl font-bold text-white">Archetype Initialized</h4>
                    <p className="text-sm font-medium text-white/40">The voice archetype <span className="text-celestial-saturn font-bold">{voiceName}</span> is now active in your neural network.</p>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
