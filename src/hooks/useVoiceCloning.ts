import { useState, useRef, useCallback } from 'react';
import { uploadSamples, cloneVoice as apiCloneVoice, listVoices } from '../services/voiceService';
import { requestMicrophoneStream } from '@/services/sensorPermissionService';

interface VoiceCloneState {
  isRecording: boolean;
  isProcessingRecording: boolean;
  audioLevel: number;
  recordingDuration: number;
  recordings: Blob[];
  isUploading: boolean;
  isCloning: boolean;
  cloneProgress: string;
  cloneStatus: 'idle' | 'uploading' | 'cloning' | 'success' | 'error';
  cloneError: string;
  voices: any[];
  error: string | null;
}

const MAX_SAMPLES = 5;
const MAX_SAMPLE_SIZE = 10 * 1024 * 1024;

function extensionForMime(type: string): string {
  const base = (type || '').split(';')[0];
  switch (base) {
    case 'audio/wav':
    case 'audio/wave':
    case 'audio/x-wav':
    case 'audio/x-pn-wav':
      return 'wav';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/flac':
    case 'audio/x-flac':
      return 'flac';
    default:
      return 'webm';
  }
}

function toSampleFile(blob: Blob, index: number): File {
  if (blob instanceof File && blob.name) return blob;
  const type = blob.type || 'audio/webm';
  return new File([blob], `sample_${index}.${extensionForMime(type)}`, { type });
}

export function useVoiceCloning() {
  const [state, setState] = useState<VoiceCloneState>({
    isRecording: false,
    isProcessingRecording: false,
    audioLevel: 0,
    recordingDuration: 0,
    recordings: [],
    isUploading: false,
    isCloning: false,
    cloneProgress: '',
    cloneStatus: 'idle',
    cloneError: '',
    voices: [],
    error: null,
  });

  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const recordingStartTime = useRef<number>(0);
  const durationTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const animationFrame = useRef<number>(0);
  const chunks = useRef<Blob[]>([]);

  const startDurationTimer = useCallback(() => {
    recordingStartTime.current = Date.now();
    setState(prev => ({ ...prev, recordingDuration: 0 }));
    durationTimer.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime.current) / 1000);
      setState(prev => ({ ...prev, recordingDuration: elapsed }));
    }, 200);
  }, []);

  const stopDurationTimer = useCallback(() => {
    if (durationTimer.current) {
      clearInterval(durationTimer.current);
      durationTimer.current = null;
    }
  }, []);

  const updateAudioLevel = useCallback(() => {
    if (!analyser.current) return;
    const dataArray = new Uint8Array(analyser.current.frequencyBinCount);
    analyser.current.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    setState(prev => ({ ...prev, audioLevel: avg / 255 }));
    animationFrame.current = requestAnimationFrame(updateAudioLevel);
  }, []);

  const startRecording = useCallback(async () => {
    try {
      chunks.current = [];
      const stream = await requestMicrophoneStream(true);

      audioContext.current = new AudioContext();
      const source = audioContext.current.createMediaStreamSource(stream);
      analyser.current = audioContext.current.createAnalyser();
      analyser.current.fftSize = 256;
      source.connect(analyser.current);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      mediaRecorder.current = new MediaRecorder(stream, { mimeType });

      mediaRecorder.current.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };

      mediaRecorder.current.onstop = () => {
        stopDurationTimer();
        const blob = new Blob(chunks.current, { type: mimeType });
        const hasData = chunks.current.some(c => c.size > 0);
        stream.getTracks().forEach(t => t.stop());
        if (audioContext.current) audioContext.current.close();
        cancelAnimationFrame(animationFrame.current);
        if (!hasData) {
          setState(prev => ({ ...prev, isRecording: false, error: 'Recording was empty — please try again and speak clearly.' }));
          return;
        }
        setState(prev => ({
          ...prev,
          isRecording: false,
          recordings: [...prev.recordings, blob],
        }));
      };

      mediaRecorder.current.start();
      setState(prev => ({ ...prev, isRecording: true, audioLevel: 0, recordingDuration: 0 }));
      startDurationTimer();
      updateAudioLevel();
    } catch (err: any) {
      setState(prev => ({ ...prev, error: err.message || 'Microphone access denied' }));
    }
  }, [updateAudioLevel, startDurationTimer]);

  const stopRecording = useCallback(() => {
    if (mediaRecorder.current && mediaRecorder.current.state !== 'inactive') {
      mediaRecorder.current.stop();
    }
  }, []);

  const removeRecording = useCallback((index: number) => {
    setState(prev => ({
      ...prev,
      recordings: prev.recordings.filter((_, i) => i !== index),
    }));
  }, []);

  const clearRecordings = useCallback(() => {
    setState(prev => ({ ...prev, recordings: [] }));
  }, []);

  const addFiles = useCallback((files: File[]) => {
    setState(prev => ({
      ...prev,
      recordings: [
        ...prev.recordings,
        ...files
          .filter(file => file.type.startsWith('audio/') || /\.(webm|mp3|wav|ogg|m4a|aac|flac)$/i.test(file.name))
          .filter(file => file.size <= MAX_SAMPLE_SIZE)
          .slice(0, Math.max(0, MAX_SAMPLES - prev.recordings.length)),
      ],
      error: files.some(file => file.size > MAX_SAMPLE_SIZE)
        ? 'Some audio files were skipped because they are larger than 10 MB.'
        : prev.error,
    }));
  }, []);

  const uploadAndClone = useCallback(async (name: string) => {
    console.log('[VoiceClone] uploadAndClone called, recordings:', state.recordings.length);
    if (state.recordings.length === 0) {
      console.log('[VoiceClone] No recordings, setting error');
      setState(prev => ({ ...prev, cloneError: 'No recordings to clone from', cloneStatus: 'error' }));
      return null;
    }

    try {
      setState(prev => ({ ...prev, isUploading: true, cloneProgress: 'Uploading samples...', cloneStatus: 'uploading', cloneError: '' }));

      const files = state.recordings.slice(0, MAX_SAMPLES).map(toSampleFile);

      console.log('[VoiceClone] Uploading', files.length, 'files...');
      const { urls } = await uploadSamples(files);
      console.log('[VoiceClone] Uploaded, got URLs:', urls);

      setState(prev => ({ ...prev, isUploading: false, isCloning: true, cloneProgress: 'Cloning voice...', cloneStatus: 'cloning' }));

      console.log('[VoiceClone] Starting clone with name:', name);
      const result = await apiCloneVoice(urls, name);
      console.log('[VoiceClone] Clone result:', result);

      setState(prev => ({
        ...prev,
        isCloning: false,
        cloneProgress: 'Clone complete!',
        cloneStatus: 'success',
        cloneError: '',
        voices: [...prev.voices, result],
        recordings: [],
      }));

      // Keep success state visible briefly then reset
      setTimeout(() => {
        setState(prev => prev.cloneStatus === 'success' ? { ...prev, cloneStatus: 'idle' as const, cloneProgress: '' } : prev);
      }, 3000);

      return result;
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        isUploading: false,
        isCloning: false,
        cloneStatus: 'error',
        cloneError: err.message || 'Clone failed',
        cloneProgress: '',
      }));
      return null;
    }
  }, [state.recordings]);

  const refreshVoices = useCallback(async () => {
    try {
      const data = await listVoices();
      setState(prev => ({ ...prev, voices: [...data.cloned, ...data.premade] }));
    } catch {
      // voices unavailable
    }
  }, []);

  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    startRecording,
    stopRecording,
    removeRecording,
    clearRecordings,
    addFiles,
    uploadAndClone,
    refreshVoices,
    clearError,
  };
}
