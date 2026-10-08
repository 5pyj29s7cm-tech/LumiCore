import { useSyncExternalStore } from 'react';
import { socketService } from '@/services/socketService';
import { runtimeStatusCopy } from '@/i18n/locales/runtimeStatus';
import { getLocale, type Locale } from '@/i18n/runtime';

export function ClientConnectionStatus({ lang = getLocale() }: { lang?: Locale }) {
  const registration = useSyncExternalStore(socketService.subscribeDeviceRegistration, socketService.getDeviceRegistration);
  const copy = runtimeStatusCopy(lang);
  const label = {
    disconnected: copy.registrationDisconnected,
    pending: copy.registrationPending,
    registered: copy.registrationRegistered,
    rejected: copy.registrationRejected,
  }[registration.status];
  const reason = registration.status === 'rejected' ? ({
    DESKTOP_SESSION_PROOF_REQUIRED: copy.registrationProof,
    NATIVE_DESKTOP_REGISTRATION_REQUIRED: copy.registrationIdentity,
    NATIVE_CLIENT_IDENTITY_MISMATCH: copy.registrationIdentity,
    NATIVE_CLIENT_IDENTITY_NOT_ALLOWED: copy.registrationIdentity,
    NATIVE_CLIENT_IDENTITY_UNAVAILABLE: copy.registrationIdentity,
    REGISTRATION_TIMEOUT: copy.registrationTimeout,
  } as Record<string, string>)[registration.code || ''] || copy.registrationFailed : '';
  return <section role={reason ? 'alert' : 'status'} className="rounded-xl border border-white/10 bg-white/[0.025] p-3 text-xs" data-lumi-device-registration={registration.status}>
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-white/40">{copy.deviceConnection}</span><span>{label}</span></div>
    {reason && <p className="mt-2 text-red-300">{reason}</p>}
  </section>;
}
