import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('computer exploration UI wiring', () => {
  it('offers explicit allow and decline actions in System Explorer', () => {
    const explorer = source('src/components/SystemExplorer.tsx');

    expect(explorer).toContain("body: JSON.stringify({ granted: true })");
    expect(explorer).toContain("body: JSON.stringify({ granted: false })");
    expect(explorer).toContain('consentCopy.allowLocalScan');
    expect(explorer).toContain('consentCopy.notNow');
  });

  it('routes evidence-backed onboarding and profile questions into a real chat submission', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const explorer = source('src/components/SystemExplorer.tsx');

    expect(desktop).toContain('const askComputerProfileQuestion = useCallback');
    expect(desktop).toContain("openCommandCenter('office')");
    expect(desktop).toContain("new CustomEvent('lumi:replace-command-input'");
    expect(desktop).toContain("new CustomEvent('lumi:submit-command-input')");
    expect(desktop).toContain('onAsk={askComputerProfileQuestion}');
    expect(desktop).toContain('<KernelMonitorApp t={t} onAsk={askComputerProfileQuestion} />');
    expect(explorer).toContain('(latest.capabilityProfile.firstQuestions || []).slice(0, 6)');
    expect(explorer).toContain('onClick={() => onAsk?.(prompt)}');
  });
});
