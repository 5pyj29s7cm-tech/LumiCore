import React, { useEffect, useState } from "react";
import { Shield, Camera, Mic, CheckCircle, AlertCircle } from "lucide-react";
import { Button } from "../ui/button";
import { toast } from "sonner";
import { BACKGROUND_FACE_PRESENCE_CHANGED, BACKGROUND_FACE_PRESENCE_ENABLED_KEY, getSensorPermissionSnapshot, isBackgroundFacePresenceEnabled, isSensorEnabled, requestSensorPermission, setBackgroundFacePresenceEnabled, setSensorEnabled, SENSOR_ACCESS_CHANGED, SENSOR_PERMISSIONS_CHANGED, type SensorPermissionState } from "@/services/sensorPermissionService";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { SettingsSection } from './components';

export function HardwareSettings({ t }: { t: any }) {
  const [micStatus, setMicStatus] = useState<SensorPermissionState>('unknown');
  const [camStatus, setCamStatus] = useState<SensorPermissionState>('unknown');
  const [micEnabled, setMicEnabled] = useState(() => isSensorEnabled('microphone'));
  const [camEnabled, setCamEnabled] = useState(() => isSensorEnabled('camera'));
  const [backgroundFacePresenceEnabled, setBackgroundFacePresenceState] = useState(() => (
    isBackgroundFacePresenceEnabled()
  ));
  const [isRequesting, setIsRequesting] = useState(false);

  useEffect(() => {
    let disposed = false;

    const refresh = async () => {
      const snapshot = await getSensorPermissionSnapshot();
      if (disposed) return;
      setMicStatus(snapshot.microphone);
      setCamStatus(snapshot.camera);
    };

    const onSensorChange = (event: Event) => {
      const detail = (event as CustomEvent<Partial<Record<'microphone' | 'camera', SensorPermissionState>>>).detail;
      if (detail?.microphone) setMicStatus(detail.microphone);
      if (detail?.camera) setCamStatus(detail.camera);
      if (!detail?.microphone && !detail?.camera) void refresh();
    };

    const refreshAccess = () => {
      setMicEnabled(isSensorEnabled('microphone'));
      setCamEnabled(isSensorEnabled('camera'));
      setBackgroundFacePresenceState(isBackgroundFacePresenceEnabled());
    };

    const onSensorAccessChange = (event: Event) => {
      const detail = (event as CustomEvent<Partial<Record<'microphone' | 'camera', boolean>>>).detail;
      if (typeof detail?.microphone === 'boolean') setMicEnabled(detail.microphone);
      if (typeof detail?.camera === 'boolean') setCamEnabled(detail.camera);
      if (typeof detail?.microphone !== 'boolean' && typeof detail?.camera !== 'boolean') refreshAccess();
    };

    const onStorageChange = (event: StorageEvent) => {
      if (
        event.key === 'lumi_mic_enabled' ||
        event.key === 'lumi_camera_enabled' ||
        event.key === BACKGROUND_FACE_PRESENCE_ENABLED_KEY
      ) {
        refreshAccess();
      }
    };

    void refresh();
    refreshAccess();
    window.addEventListener(SENSOR_PERMISSIONS_CHANGED, onSensorChange);
    window.addEventListener(SENSOR_ACCESS_CHANGED, onSensorAccessChange);
    window.addEventListener(BACKGROUND_FACE_PRESENCE_CHANGED, refreshAccess);
    window.addEventListener('storage', onStorageChange);
    window.addEventListener('visibilitychange', refresh);
    window.addEventListener('visibilitychange', refreshAccess);
    return () => {
      disposed = true;
      window.removeEventListener(SENSOR_PERMISSIONS_CHANGED, onSensorChange);
      window.removeEventListener(SENSOR_ACCESS_CHANGED, onSensorAccessChange);
      window.removeEventListener(BACKGROUND_FACE_PRESENCE_CHANGED, refreshAccess);
      window.removeEventListener('storage', onStorageChange);
      window.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('visibilitychange', refreshAccess);
    };
  }, []);

  const requestPermissions = async (type: 'mic' | 'camera') => {
    setIsRequesting(true);
    try {
      const kind = type === 'mic' ? 'microphone' : 'camera';
      const result = await requestSensorPermission(kind);
      if (type === 'mic') setMicStatus(result.state);
      if (type === 'camera') setCamStatus(result.state);
      if (!result.ok) {
        throw new Error(result.error || uiMessage('settings.please-enable-access-in-system.3fa8966e6c'));
      }

      toast.success(type === 'mic' ? (t.micAccessSynced || uiMessage('settings.microphone-access-synchronized.cf6ea6edc8')) : (t.camAccessSynced || uiMessage('settings.camera-access-synchronized.8effc04251')));
      return true;
    } catch (err: any) {
      toast.error(`${t.sensorLinkFailed || uiMessage('settings.sensor-link-failed.ccc93e4061')}: ${err.message}`);
      return false;
    } finally {
      setIsRequesting(false);
    }
  };

  const handleSensorToggle = async (type: 'mic' | 'camera', enabled: boolean) => {
    const kind = type === 'mic' ? 'microphone' : 'camera';
    setSensorEnabled(kind, enabled);
    if (type === 'mic') setMicEnabled(enabled);
    if (type === 'camera') setCamEnabled(enabled);

    if (!enabled) {
      toast.success(type === 'mic'
        ? (t.audioReceptorsDisabled || uiMessage('settings.audio-input-disabled.7a401ffe0b'))
        : (t.visualCortexDisabled || uiMessage('settings.visual-perception-disabled.d15e5b5cc6')));
      return;
    }

    const ok = await requestPermissions(type);
    if (!ok) {
      setSensorEnabled(kind, false);
      if (type === 'mic') setMicEnabled(false);
      if (type === 'camera') setCamEnabled(false);
    }
  };

  const handleBackgroundFacePresenceToggle = async (enabled: boolean) => {
    if (enabled && !camEnabled) {
      toast.error(uiMessage('settings.enable-camera-access-before-turning.fbd6cf6197'));
      return;
    }
    if (enabled && camStatus !== 'granted') {
      const cameraReady = await requestPermissions('camera');
      if (!cameraReady) return;
    }
    setBackgroundFacePresenceEnabled(enabled);
    setBackgroundFacePresenceState(enabled);
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <SettingsSection title={t.hardwareSensorNetwork || uiMessage('settings.hardware-sensor-network.5ac24401d0')} icon={<Camera size={18} className="text-celestial-saturn" />}>
        <p className="text-sm text-white/40 mb-8 max-w-xl">
          {t.hardwareSensorNetworkDesc || uiMessage('settings.lumiai-requires-access-to-your.2c2519e903')}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <HardwareCapCard
            icon={<Mic size={24} />}
            label={t.audioReceptors || uiMessage('settings.audio-receptors.2d53651196')}
            desc={t.audioReceptorsDesc || uiMessage('settings.enable-neural-speech-recognition-and.37c49ca0c6')}
            status={micStatus}
            enabled={micEnabled}
            onToggle={(enabled) => void handleSensorToggle('mic', enabled)}
            disabled={isRequesting}
            t={t}
          />
          <HardwareCapCard
            icon={<Camera size={24} />}
            label={t.visualCortex || uiMessage('settings.visual-cortex.215cdec3f7')}
            desc={t.visualCortexDesc || uiMessage('settings.enable-multimodal-vision-and-gesture.2861691bfc')}
            status={camStatus}
            enabled={camEnabled}
            onToggle={(enabled) => void handleSensorToggle('camera', enabled)}
            disabled={isRequesting}
            t={t}
          />
        </div>

        <div className="mt-6 flex items-center justify-between gap-6 rounded-2xl border border-white/5 bg-white/[0.035] p-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
              backgroundFacePresenceEnabled && camEnabled
                ? 'bg-celestial-saturn/20 text-celestial-saturn'
                : 'bg-white/5 text-white/35'
            }`}>
              <Camera size={17} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold text-white/90">
                {uiMessage('settings.background-face-presence.c07ac0f5cb')}
              </div>
              <div className="mt-1 max-w-2xl text-xs leading-relaxed text-white/45">
                {uiMessage('settings.when-enabled-lumi-may-use.25f7da1264')}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleBackgroundFacePresenceToggle(!backgroundFacePresenceEnabled)}
            disabled={isRequesting || (camStatus === 'unavailable' && !backgroundFacePresenceEnabled)}
            aria-pressed={backgroundFacePresenceEnabled}
            aria-label={uiMessage('settings.background-face-presence.c07ac0f5cb')}
            className={`relative h-7 w-12 shrink-0 rounded-full border transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
              backgroundFacePresenceEnabled
                ? 'border-celestial-saturn/40 bg-celestial-saturn/25'
                : 'border-white/10 bg-white/5'
            }`}
          >
            <span className={`absolute top-1 h-5 w-5 rounded-full transition-all ${
              backgroundFacePresenceEnabled
                ? 'left-6 bg-celestial-saturn'
                : 'left-1 bg-white/35'
            }`} />
          </button>
        </div>

        <div className="mt-12 p-6 glass-dark rounded-[2rem] border border-white/5 space-y-4">
           <div className="flex items-center gap-3">
              <Shield className="text-celestial-saturn" size={20} />
              <h4 className="text-sm font-bold uppercase tracking-tight text-white">{t.privacyAssurance || uiMessage('settings.privacy-assurance.2ce5c06cdb')}</h4>
           </div>
           <p className="text-xs text-white/55 leading-relaxed italic">
             {t.privacyAssuranceText || uiMessage('settings.our-protocol-strictly-enforces-local.872b7c5677')}
           </p>
        </div>
      </SettingsSection>
    </div>
  );
}

export function HardwareCapCard({ icon, label, desc, status, enabled, onToggle, disabled, t }: {
  icon: React.ReactNode,
  label: string,
  desc: string,
  status: SensorPermissionState,
  enabled: boolean,
  onToggle: (enabled: boolean) => void,
  disabled: boolean,
  t: any
}) {
  const isUnavailable = status === 'unavailable';
  const isLinked = enabled && status === 'granted';
  const isBlocked = status === 'denied';
  return (
    <div className="p-8 bg-white/5 rounded-[2.5rem] border border-white/5 flex flex-col justify-between gap-6 group hover:border-white/10 transition-all">
      <div className="space-y-4">
        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all ${
          isLinked ? 'bg-celestial-saturn text-black' : 'bg-white/5 text-white/40'
        }`}>
          {icon}
        </div>
        <div>
          <h4 className="text-lg font-bold text-white">{label}</h4>
          <p className="text-xs text-white/40 leading-relaxed mt-1">{desc}</p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
           {isLinked ? (
             <div className="flex items-center gap-1.5 text-celestial-saturn text-xs font-black uppercase tracking-widest">
               <CheckCircle size={12} />
                {t.linked || uiMessage('settings.linked.6892680d46')}
             </div>
           ) : isBlocked ? (
             <div className="flex items-center gap-1.5 text-red-500 text-xs font-black uppercase tracking-widest">
               <AlertCircle size={12} />
                {t.blocked || uiMessage('settings.blocked.f5f31a9aa5')}
             </div>
           ) : isUnavailable ? (
             <div className="flex items-center gap-1.5 text-white/35 text-xs font-black uppercase tracking-widest">
               <AlertCircle size={12} />
               {t.unavailable || uiMessage('settings.unavailable.a19c84a34b')}
             </div>
           ) : !enabled ? (
              <div className="text-xs font-black uppercase tracking-widest text-white/45">{t.disabled || uiMessage('settings.disabled.2caae825fe')}</div>
           ) : (
              <div className="text-xs font-black uppercase tracking-widest text-white/45">{t.awaitingAccess || uiMessage('settings.awaiting-access.75952ad010')}</div>
           )}
        </div>

        <div className="flex items-center gap-2">
          {enabled && status !== 'granted' && !isUnavailable && (
            <Button
              onClick={() => onToggle(true)}
              disabled={disabled}
              className="bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-black uppercase tracking-widest px-4 h-9 rounded-xl"
            >
              {status === 'denied' ? (t.retryLink || uiMessage('settings.retry-link.394f83238c')) : (t.authorize || uiMessage('settings.authorize.9ed688f227'))}
            </Button>
          )}
          <button
            type="button"
            onClick={() => onToggle(!enabled)}
            disabled={disabled || isUnavailable}
            aria-pressed={enabled}
            aria-label={enabled ? formatUiMessage('settings.disable-value0.aaf58c1a29', { value0: label }) : formatUiMessage('settings.enable-value0.71e0c154da', { value0: label })}
            className={`relative h-9 w-16 rounded-full border transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
              enabled
                ? 'border-celestial-saturn/40 bg-celestial-saturn/25 shadow-[0_0_18px_rgba(255,204,0,0.18)]'
                : 'border-white/10 bg-white/5 hover:bg-white/10'
            }`}
          >
            <span
              className={`absolute top-1 h-7 w-7 rounded-full transition-all ${
                enabled
                  ? 'left-8 bg-celestial-saturn'
                  : 'left-1 bg-white/35'
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
