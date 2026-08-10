import { useCallback, useEffect, useRef, useState } from 'react';
import { socketService } from '@/services/socketService';
import {
  applyLumiScenePatch,
  validateLumiSceneSnapshot,
  type LumiSceneSnapshot,
} from '../../shared/lumi_scene';

interface SceneSyncResponse {
  ok?: boolean;
  kind?: 'snapshot' | 'patch' | 'noop';
  snapshot?: unknown;
  patch?: unknown;
  revision?: number;
  digest?: string;
  error?: string;
}

export function useLumiScene(input: { enabled?: boolean; scopeKey?: string } = {}) {
  const { enabled = true, scopeKey = 'personal' } = input;
  const [scene, setScene] = useState<LumiSceneSnapshot | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const sceneRef = useRef<LumiSceneSnapshot | null>(null);
  const requestRef = useRef<(force?: boolean) => void>(() => {});

  const refresh = useCallback((force = false) => requestRef.current(force), []);

  useEffect(() => {
    if (!enabled) {
      sceneRef.current = null;
      setScene(null);
      setLoading(false);
      setError('');
      requestRef.current = () => {};
      return;
    }
    const socket = socketService.connect();
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const acceptSnapshot = (value: unknown) => {
      const snapshot = validateLumiSceneSnapshot(value);
      sceneRef.current = snapshot;
      setScene(snapshot);
      setError('');
    };
    const request = (force = false) => {
      if (disposed) return;
      const current = sceneRef.current;
      if (!current) setLoading(true);
      socket.emit(force ? 'scene:resync' : 'scene:sync', {
        currentRevision: current?.revision || 0,
        currentDigest: current?.digest || '',
      }, (response: SceneSyncResponse = {}) => {
        if (disposed) return;
        setLoading(false);
        if (!response.ok) {
          setError(String(response.error || 'scene_sync_failed'));
          return;
        }
        try {
          if (response.kind === 'snapshot') {
            acceptSnapshot(response.snapshot);
            return;
          }
          if (response.kind === 'patch') {
            const base = sceneRef.current;
            if (!base) {
              request(true);
              return;
            }
            const applied = applyLumiScenePatch(base, response.patch);
            if (applied.status !== 'applied') {
              request(true);
              return;
            }
            sceneRef.current = applied.snapshot;
            setScene(applied.snapshot);
            setError('');
          }
        } catch (syncError: any) {
          setError(String(syncError?.message || 'scene_validation_failed'));
          request(true);
        }
      });
    };
    requestRef.current = request;
    const schedule = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => request(false), 180);
    };

    request(false);
    socket.on('connect', schedule);
    socket.on('agent:status', schedule);
    socket.on('agent:tool', schedule);
    socket.on('focus:updated', schedule);
    socket.on('audio:work_progress', schedule);
    const interval = window.setInterval(() => request(false), 10_000);
    return () => {
      disposed = true;
      requestRef.current = () => {};
      if (refreshTimer) clearTimeout(refreshTimer);
      window.clearInterval(interval);
      socket.off('connect', schedule);
      socket.off('agent:status', schedule);
      socket.off('agent:tool', schedule);
      socket.off('focus:updated', schedule);
      socket.off('audio:work_progress', schedule);
    };
  }, [enabled, scopeKey]);

  return { scene, loading, error, refresh };
}
