import { useState, useEffect } from 'react';
import { isTauriRuntime } from '@/services/apiBridge';

export type Platform = 'web' | 'electron' | 'tauri' | 'ios' | 'android';

export interface SensorData {
  latitude?: number;
  longitude?: number;
  speed?: number;
  acceleration?: { x: number; y: number; z: number };
}

export function usePlatform() {
  const [platform] = useState<Platform>(() => {
    if (typeof window !== 'undefined') {
      if ((window as any).lumiElectron || navigator.userAgent.toLowerCase().includes('electron')) {
        return 'electron';
      }
      if (isTauriRuntime()) return 'tauri';
      const mobile = (window as any).Capacitor?.platform;
      if (mobile === 'ios' || mobile === 'android') return mobile;
    }
    return 'web';
  });
  const [isSyncing, setIsSyncing] = useState(false);
  const [sensors, setSensors] = useState<SensorData>({});

  useEffect(() => {
    if (!isSyncing) return;
    const cleanupFns: (() => void)[] = [];

    // Real GPS via Geolocation API
    if (navigator.geolocation) {
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setSensors(prev => ({
            ...prev,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            speed: pos.coords.speed || 0,
          }));
        },
        (err) => console.error('[Sensors] GPS error:', err.message),
        { enableHighAccuracy: true },
      );
      cleanupFns.push(() => navigator.geolocation.clearWatch(watchId));
    }

    // Real accelerometer via DeviceMotionEvent
    if ('DeviceMotionEvent' in window) {
      const handleMotion = (e: DeviceMotionEvent) => {
        const acc = e.accelerationIncludingGravity;
        if (acc) {
          setSensors(prev => ({
            ...prev,
            acceleration: {
              x: acc.x ?? 0,
              y: acc.y ?? 0,
              z: acc.z ?? 9.8,
            },
          }));
        }
      };
      window.addEventListener('devicemotion', handleMotion);
      cleanupFns.push(() => window.removeEventListener('devicemotion', handleMotion));
    }

    return () => {
      cleanupFns.forEach(fn => fn());
    };
  }, [isSyncing]);

  return {
    platform,
    isElectron: platform === 'electron',
    isTauri: platform === 'tauri',
    isDesktop: platform === 'electron' || platform === 'tauri',
    isMobile: platform === 'ios' || platform === 'android',
    isWeb: platform === 'web',
    electronAPI: (window as any).lumiElectron || null,
    setSensorSyncEnabled: setIsSyncing,
    sensors,
    isSyncing
  };
}
