// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { extractSourceExpression as extract } from './source_expression';

afterEach(cleanup);
const source = 'src/components/SkillCenter.tsx';
function button(variant: string, skill: Record<string, any>, installed = false, installing: string | null = null) {
  const icon = () => React.createElement('span', { 'aria-hidden': true });
  const dependencies: Record<string, any> = { React, Button: 'button', CheckCircle: icon, AlertTriangle: icon, ShieldCheck: icon,
    RefreshCw: icon, Download: icon, uiMessage: (key: string) => key };
  dependencies.getInstallActionText = extract(source, 'getInstallActionText', dependencies);
  const Component = extract(source, 'SkillInstallButton', dependencies);
  const onInstall = vi.fn(), onParent = vi.fn();
  render(<div onClick={onParent}><Component skill={{ id: 'skill-test', installSource: 'bundled', ...skill }} installed={installed}
    installing={installing} variant={variant} lang="en" t={{}} onInstall={onInstall} /></div>);
  return { onInstall, onParent, element: screen.getByRole('button') as HTMLButtonElement };
}
it.each(['recommended', 'marketplace', 'detail'])('%s has one installation boundary for every entry', variant => {
  for (const item of [
    { skill: {}, installed: true, installing: null },
    { skill: { officialIdentityStatus: 'conflict' }, installed: false, installing: null },
    { skill: { runtimeInstallable: false }, installed: false, installing: null },
    { skill: { installSource: 'github' }, installed: false, installing: null },
    { skill: {}, installed: false, installing: 'skill-test' },
  ]) {
    const b = button(variant, item.skill, item.installed, item.installing);
    expect(b.element.disabled).toBe(true); fireEvent.click(b.element); expect(b.onInstall).not.toHaveBeenCalled(); cleanup();
  }
  const b = button(variant, {}); expect(b.element.disabled).toBe(false); fireEvent.click(b.element);
  expect(b.onInstall).toHaveBeenCalledOnce(); expect(b.onParent).not.toHaveBeenCalled();
});
it('catalog and management share runtime precedence while retaining their display wording', () => {
  const dependencies: Record<string, any> = { uiMessage: (key: string) => key };
  for (const name of ['normalizeSkillKey', 'findInstalledSkillForMarket', 'getInstalledSkillAvailability', 'getDisplayAvailability']) {
    dependencies[name] = extract(source, name, dependencies);
  }
  for (const state of [{ broken: true }, { enabled: true, usable: false }, { usable: true }, { enabled: false }]) {
    const skill = { name: 'test', enabled: true, usable: true, ...state };
    const catalog = dependencies.getDisplayAvailability({ id: 'skill-test', name: 'test' }, [skill], {}, 'en');
    const management = dependencies.getInstalledSkillAvailability(skill, 'en');
    expect(catalog.tone).toBe(management.tone); expect(catalog.label).toBe(management.label);
    expect(catalog.installedSkill).toBe(skill);
  }
});
