import { useEffect, useRef, useState, useCallback } from 'react';
import type { FaceRecognitionResult } from './useFaceRecognition';
import type { VoiceprintResult } from './useVoiceprint';

interface UsePresenceOptions {
  enabled?: boolean;
  socket?: any;
  faceResult: FaceRecognitionResult;
  voiceprintResult: VoiceprintResult;
  userId?: string;
}

export interface PresenceState {
  isAway: boolean;
  status: 'present' | 'uncertain' | 'away';
}

export function samePresenceState(a: PresenceState, b: PresenceState): boolean {
  return a.isAway === b.isAway && a.status === b.status;
}

export function normalizePresenceStatus(status: unknown): PresenceState['status'] {
  return status === 'present' || status === 'uncertain' || status === 'away'
    ? status
    : 'away';
}

export function buildPresenceHeartbeat(faceResult: FaceRecognitionResult, voiceprintResult: VoiceprintResult) {
  return {
    facePresent: faceResult.facePresent,
    faceMatched: faceResult.ownerPresent,
    faceConfidence: faceResult.confidence,
    voiceprintMatched: voiceprintResult.isOwnerSpeaking,
    voiceprintConfidence: voiceprintResult.confidence,
  };
}

export function usePresence({
  enabled = true,
  socket,
  faceResult,
  voiceprintResult,
  userId,
}: UsePresenceOptions) {
  const [presence, setPresence] = useState<PresenceState>({
    isAway: false,
    status: 'present',
  });

  const prevStatusRef = useRef<string>('present');
  const faceResultRef = useRef(faceResult);
  const voiceprintResultRef = useRef(voiceprintResult);
  faceResultRef.current = faceResult;
  voiceprintResultRef.current = voiceprintResult;

  const updatePresence = useCallback((next: PresenceState) => {
    setPresence(current => samePresenceState(current, next) ? current : next);
  }, []);

  useEffect(() => {
    if (enabled) return;
    updatePresence({ isAway: false, status: 'present' });
    prevStatusRef.current = 'present';
  }, [enabled, updatePresence]);

  // Send heartbeat every 2 seconds
  useEffect(() => {
    if (!enabled || !socket || !userId) return;
    const sendHeartbeat = () => {
      if (socket.connected === false) return;
      socket.emit('presence:heartbeat', buildPresenceHeartbeat(faceResultRef.current, voiceprintResultRef.current));
    };
    sendHeartbeat();
    socket.on?.('connect', sendHeartbeat);
    const timer = setInterval(sendHeartbeat, 2000);
    return () => {
      clearInterval(timer);
      socket.off?.('connect', sendHeartbeat);
    };
  }, [enabled, socket, userId]);

  // Listen for presence state changes from server
  useEffect(() => {
    if (!enabled || !socket) return;
    const handler = (data: { isAway: boolean; status: string }) => {
      const status = normalizePresenceStatus(data.status);
      updatePresence({ isAway: Boolean(data.isAway), status });
      if (status !== prevStatusRef.current) {
        prevStatusRef.current = status;
      }
    };
    socket.on('presence:state_change', handler);
    return () => { socket.off('presence:state_change', handler); };
  }, [enabled, socket, updatePresence]);

  // Local away detection (fast path — doesn't wait for server roundtrip)
  useEffect(() => {
    if (!enabled) return;
    const ownerSignal = faceResult.ownerPresent || voiceprintResult.isOwnerSpeaking;
    const away = !ownerSignal && !faceResult.facePresent;
    const status: PresenceState['status'] = ownerSignal
      ? 'present'
      : (faceResult.facePresent ? 'uncertain' : 'away');

    updatePresence({ isAway: away, status });
  }, [enabled, faceResult.facePresent, faceResult.ownerPresent, updatePresence, voiceprintResult.isOwnerSpeaking]);

  return presence;
}
