import React, { lazy, Suspense } from 'react';
import type { SkillCenterTab } from './SkillCenter';

const SkillCenter = lazy(() => import('./SkillCenter').then(m => ({ default: m.SkillCenter })));

/** Thin wrapper — delegates to SkillCenter, the canonical skill hall component. */
export function SkillHall({ t, lang, initialTab }: { t: any; lang: 'en' | 'zh'; initialTab?: SkillCenterTab }) {
  return (
    <Suspense fallback={null}>
      <SkillCenter t={t} lang={lang} initialTab={initialTab} />
    </Suspense>
  );
}
