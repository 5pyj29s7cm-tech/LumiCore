import { useEffect, useRef, useState, useCallback } from 'react';
import type { FaceRecognitionResult } from './useFaceRecognition';
import type { VoiceprintResult } from './useVoiceprint';

interface UsePresenceOptions {
  socket?: any;
  faceResult: FaceRecognitionResult;
  voiceprintResult: VoiceprintResult;
  userId?: string;
}

export interface PresenceState {
  isAway: boolean;
  status: 'present' | 'uncertain' | 'away';
}

export function normalizePresenceStatus(status: unknown): PresenceState['status'] {
  return status === 'present' || status === 'uncertain' || status === 'away'
    ? status
    : 'away';
}

export function usePresence({ socket, faceResult, voiceprintResult, userId }: UsePresenceOptions) {
  const [presence, setPresence] = useState<PresenceState>({
    isAway: false,
    status: 'present',
  });

  const prevStatusRef = useRef<string>('present');

  // Send heartbeat every 2 seconds
  useEffect(() => {
    if (!socket || !userId) return;
    const timer = setInterval(() => {
      socket.emit('presence:heartbeat', {
        facePresent: faceResult.facePresent,
        faceMatched: faceResult.ownerPresent,
        faceConfidence: faceResult.confidence,
        voiceprintMatched: voiceprintResult.isOwnerSpeaking,
        voiceprintConfidence: voiceprintResult.confidence,
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [socket, userId, faceResult, voiceprintResult]);

  // Listen for presence state changes from server
  useEffect(() => {
    if (!socket) return;
    const handler = (data: { isAway: boolean; status: string }) => {
      const status = normalizePresenceStatus(data.status);
      setPresence({ isAway: Boolean(data.isAway), status });
      if (status !== prevStatusRef.current) {
        prevStatusRef.current = status;
      }
    };
    socket.on('presence:state_change', handler);
    return () => { socket.off('presence:state_change', handler); };
  }, [socket]);

  // Local away detection (fast path — doesn't wait for server roundtrip)
  useEffect(() => {
    const ownerSignal = faceResult.ownerPresent || voiceprintResult.isOwnerSpeaking;
    const away = !ownerSignal && !faceResult.facePresent;
    const status: PresenceState['status'] = ownerSignal
      ? 'present'
      : (faceResult.facePresent ? 'uncertain' : 'away');

    setPresence({ isAway: away, status });
  }, [faceResult.facePresent, faceResult.ownerPresent, voiceprintResult.isOwnerSpeaking]);

  return presence;
}
