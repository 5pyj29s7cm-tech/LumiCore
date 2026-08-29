import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('role-aware diagnostics UI', () => {
  it('falls back from privileged health details and reads the real process uptime field', () => {
    const profile = source('src/components/Profile.tsx');
    expect(profile).toContain("apiFetch('/api/health?details=1')");
    expect(profile).toContain("response = await apiFetch('/api/health')");
    expect(profile).toContain('health?.process?.uptimeSec');
    expect(profile).not.toContain('health?.uptime');
    expect(profile).not.toContain('"99.9%"');
    expect(profile).not.toContain('>12ms<');
  });

  it('does not present privileged voice status or interactive controls to an ordinary user', () => {
    const voice = source('src/components/VoiceProviderSwitch.tsx');
    expect(voice).toContain("const isAdmin = user?.role === 'admin'");
    expect(voice).toContain("response.status === 401 || response.status === 403");
    expect(voice).toContain("setAccess('restricted')");
    // Provider buttons retain the privileged access gate and may additionally
    // disable capabilities that have no backend adapter (for example Lumi's
    // official speech entry).
    expect(voice).toMatch(/disabled=\{access !== 'allowed'(?: \|\| o\.disabled)?\}/u);
    expect(voice).toContain('Local administrator access required');
  });

  it('does not prefill a blocked loopback HTTP company endpoint', () => {
    const branchPanel = source('src/components/OrgBranchPanel.tsx');
    expect(branchPanel).not.toContain("companyUrl: 'http://127.0.0.1:3000'");
  });
});
