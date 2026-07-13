import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, Camera, Shield, CheckCircle2, Loader2, Trash2, RefreshCw } from 'lucide-react';
import { useVoiceprint } from '../../hooks/useVoiceprint';
import { useFaceRecognition } from '../../hooks/useFaceRecognition';
import { useT } from '../../lib/useT';
import { toast } from 'sonner';
import { formatUiMessage, uiMessage } from '../../i18n/uiMessages';

export function BiometricsEnrollPanel() {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => isZh ? zh : en;
  const voiceprint = useVoiceprint();
  // Enrollment opens its own short-lived camera stream on demand.
  const faceRecognition = useFaceRecognition({ enabled: false });

  const [voiceLabel, setVoiceLabel] = useState(() => uiMessage('biometrics-enroll-panel.my-voice.01d40d0a28'));
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'recording' | 'done'>('idle');
  const [voiceProgress, setVoiceProgress] = useState(0);

  const [faceStatus, setFaceStatus] = useState<'idle' | 'scanning' | 'done'>('idle');

  const [voiceprints, setVoiceprints] = useState<any[]>([]);
  const [faces, setFaces] = useState<any[]>([]);

  const loadEnrolled = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/biometric/list', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setVoiceprints(data.voiceprints || []);
        setFaces(data.faces || []);
      }
    } catch {}
  }, []);

  useEffect(() => { loadEnrolled(); }, [loadEnrolled]);

  const notifyBiometricsUpdated = useCallback((type: string) => {
    window.dispatchEvent(new CustomEvent('lumi:biometrics-updated', { detail: { type } }));
  }, []);

  // ── Voiceprint enrollment ──
  const handleVoiceEnroll = useCallback(async () => {
    if (voiceStatus === 'recording') return;
    setVoiceStatus('recording');
    setVoiceProgress(0);

    // Animate progress over ~6 seconds
    const startTime = Date.now();
    const duration = 6500;
    const tick = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const pct = Math.min(elapsed / duration, 1);
      setVoiceProgress(pct);
      if (pct >= 1) clearInterval(tick);
    }, 100);

    let result: { success: boolean; voiceprintId?: string } = { success: false };
    try {
      result = await voiceprint.startEnrollment(voiceLabel);
    } finally {
      clearInterval(tick);
      voiceprint.stopListening();
    }
    setVoiceProgress(result.success ? 1 : 0);

    if (result.success) {
      setVoiceStatus('done');
      toast.success(uiMessage('biometrics-enroll-panel.voiceprint-enrolled.ccb18b5b8c'));
      notifyBiometricsUpdated('voiceprint');
      loadEnrolled();
    } else {
      setVoiceStatus('idle');
      toast.error(uiMessage('biometrics-enroll-panel.voiceprint-enrollment-failed-move-closer.b1d5ff9891'));
    }
  }, [voiceStatus, voiceLabel, voiceprint, loadEnrolled, notifyBiometricsUpdated, ui]);

  // ── Face enrollment ──
  const handleFaceEnroll = useCallback(async () => {
    if (faceStatus === 'scanning') return;
    setFaceStatus('scanning');

    const result = await faceRecognition.enrollFace(uiMessage('biometrics-enroll-panel.my-face.87864a5c8a'));
    if (result.success) {
      setFaceStatus('done');
      notifyBiometricsUpdated('face');
      toast.success(uiMessage('biometrics-enroll-panel.face-enrolled.1d4355a687'));
      loadEnrolled();
    } else {
      setFaceStatus('idle');
      toast.error(uiMessage('biometrics-enroll-panel.face-enrollment-failed-look-at.ccc08993ab'));
    }
  }, [faceStatus, faceRecognition, loadEnrolled, notifyBiometricsUpdated, ui]);

  // ── Delete ──
  const handleDelete = useCallback(async (type: string, id: string) => {
    try {
      const res = await fetch(`/api/auth/biometric/${type}/${id}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) {
        toast.success(uiMessage('biometrics-enroll-panel.deleted.e8250ae78f'));
        notifyBiometricsUpdated(type);
        loadEnrolled();
      }
    } catch {
      toast.error(uiMessage('biometrics-enroll-panel.delete-failed.eea779ae78'));
    }
  }, [loadEnrolled, notifyBiometricsUpdated, ui]);

  return (
    <div className="space-y-8">
      {/* ── Voiceprint ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-amber-500/10 flex items-center justify-center">
            <Mic size={20} className="text-amber-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white/90">{uiMessage('biometrics-enroll-panel.voiceprint-enrollment.0b4b432308')}</h3>
            <p className="text-xs text-white/45">{uiMessage('biometrics-enroll-panel.used-for-owner-voice-verification.9f0eebbc40')}</p>
          </div>
        </div>

        {/* Input for voice label */}
        <input
          type="text"
          value={voiceLabel}
          onChange={e => setVoiceLabel(e.target.value)}
          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white/80 placeholder-white/30 focus:outline-none focus:border-amber-500/40"
          placeholder={uiMessage('biometrics-enroll-panel.voice-label.edf3f8a654')}
        />

        {/* Record button */}
        <button
          onClick={handleVoiceEnroll}
          disabled={voiceStatus === 'recording'}
          className="w-full flex items-center justify-center gap-3 px-5 py-4 rounded-2xl transition-all
            bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 hover:border-amber-500/30"
        >
          <AnimatePresence mode="wait">
            {voiceStatus === 'idle' && (
              <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="flex items-center gap-3"
              >
                <Mic size={20} className="text-amber-400" />
                <span className="text-sm font-medium text-amber-300">{uiMessage('biometrics-enroll-panel.start-voiceprint-enrollment.b20d86e5c5')}</span>
              </motion.div>
            )}
            {voiceStatus === 'recording' && (
              <motion.div key="recording" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="flex flex-col items-center gap-2 w-full"
              >
                <span className="text-sm text-amber-300 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  {uiMessage('biometrics-enroll-panel.recording-please-speak-a-few.8491ad0cc8')}
                </span>
                <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-amber-500 rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${voiceProgress * 100}%` }}
                  />
                </div>
              </motion.div>
            )}
            {voiceStatus === 'done' && (
              <motion.div key="done" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
                className="flex items-center gap-3"
              >
                <CheckCircle2 size={20} className="text-green-400" />
                <span className="text-sm font-medium text-green-400">{uiMessage('biometrics-enroll-panel.enrollment-complete.90da19cc7f')}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </button>

        {/* Enrolled voiceprints */}
        {voiceprints.length > 0 && (
          <div className="space-y-2">
            {voiceprints.map((vp: any) => (
              <div key={vp.id} className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-white/5 border border-white/5">
                <div className="flex items-center gap-2">
                  <Mic size={14} className="text-amber-400/60" />
                  <span className="text-sm text-white/70">{vp.label}</span>
                  <span className="text-[10px] text-white/30">{vp.sampleCount} {uiMessage('biometrics-enroll-panel.frames.1ec4e94a78')}</span>
                </div>
                <button onClick={() => handleDelete('voiceprint', vp.id)}
                  className="p-1 rounded-lg hover:bg-white/10 text-white/30 hover:text-red-400 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Face ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-blue-500/10 flex items-center justify-center">
            <Camera size={20} className="text-blue-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white/90">{uiMessage('biometrics-enroll-panel.face-enrollment.d14f394759')}</h3>
            <p className="text-xs text-white/45">{uiMessage('biometrics-enroll-panel.used-only-as-a-local.ae813375b9')}</p>
          </div>
        </div>

        <button
          onClick={handleFaceEnroll}
          disabled={faceStatus === 'scanning'}
          className="w-full flex items-center justify-center gap-3 px-5 py-4 rounded-2xl transition-all
            bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 hover:border-blue-500/30"
        >
          <AnimatePresence mode="wait">
            {faceStatus === 'idle' && (
              <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="flex items-center gap-3"
              >
                <Camera size={20} className="text-blue-400" />
                <span className="text-sm font-medium text-blue-300">{uiMessage('biometrics-enroll-panel.start-face-enrollment.785fb50585')}</span>
              </motion.div>
            )}
            {faceStatus === 'scanning' && (
              <motion.div key="scanning" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="flex items-center gap-3"
              >
                <Loader2 size={20} className="text-blue-400 animate-spin" />
                <span className="text-sm text-blue-300">{uiMessage('biometrics-enroll-panel.scanning-face.bcbc457e5a')}</span>
              </motion.div>
            )}
            {faceStatus === 'done' && (
              <motion.div key="done" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
                className="flex items-center gap-3"
              >
                <CheckCircle2 size={20} className="text-green-400" />
                <span className="text-sm font-medium text-green-400">{uiMessage('biometrics-enroll-panel.enrollment-complete.90da19cc7f')}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </button>

        {faces.length > 0 && (
          <div className="space-y-2">
            {faces.map((f: any) => (
              <div key={f.id} className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-white/5 border border-white/5">
                <div className="flex items-center gap-2">
                  <Camera size={14} className="text-blue-400/60" />
                  <span className="text-sm text-white/70">{f.label}</span>
                </div>
                <button onClick={() => handleDelete('face', f.id)}
                  className="p-1 rounded-lg hover:bg-white/10 text-white/30 hover:text-red-400 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Status ── */}
      <div className="p-4 rounded-2xl bg-white/5 border border-white/5 flex items-center gap-3">
        <Shield size={18} className="text-white/40" />
        <div>
          <p className="text-xs text-white/60">
            {voiceprints.length === 0 && faces.length === 0
              ? uiMessage('biometrics-enroll-panel.optional-voiceprints-can-gate-normal.b9a806a402')
              : formatUiMessage('biometrics-enroll-panel.value0-voiceprints-value1-faces-enrolled.1680122940', { value0: voiceprints.length, value1: faces.length })
            }
          </p>
        </div>
      </div>
    </div>
  );
}
