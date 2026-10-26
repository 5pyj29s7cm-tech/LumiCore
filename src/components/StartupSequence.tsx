import { useT } from '../lib/useT';

export function StartupSequence() {
  const t = useT();
  return (
    <div role="status" className="fixed inset-0 z-[100000] flex min-h-screen items-center justify-center bg-[#080a0d] text-sm text-white/55">
      {t.startupCoreConnecting}
    </div>
  );
}
