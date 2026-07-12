import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

function source(file: string) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

describe('personal and organization client state boundaries', () => {
  it('scopes selected voices and favorites and reloads the voice catalogue on domain changes', () => {
    const context = source('src/contexts/AppContext.tsx');
    const picker = source('src/components/VoicePicker.tsx');

    expect(context).toContain('lumi_selected_voice_id_${scope}');
    expect(context).toContain('lumi_favorite_voices_${scope}');
    expect(context).toContain("if (workDomain === 'personal')");
    expect(picker).toContain('workDomain, orgConnection?.orgId');
  });

  it('stores meeting drafts per personal user or organization and stops live scope crossover', () => {
    const desktop = source('src/components/DesktopUI.tsx');

    expect(desktop).toContain('lumi_meeting_notes_${meetingPreferenceScopeKey}');
    expect(desktop).toContain('activeVoiceScopeRef.current === meetingPreferenceScopeKey');
    expect(desktop).not.toMatch(/localStorage\.(?:setItem|removeItem)\('lumi_meeting_(?:notes|report|started_at)'/);
  });

  it('keeps host exploration local and recognizes the broader desktop tool set', () => {
    const routes = source('server/routes/plan_explore_routes.ts');
    const explorer = source('src/components/SystemExplorer.tsx');

    expect(routes).toContain('requirePersonalSystemAdmin, requireLocalRequest');
    expect(explorer).toContain('/workbuddy/i');
    expect(explorer).toContain('/codex/i');
    expect(explorer).toContain('/gstarcad/i');
  });

  it('does not let organization-only presence states crash the personal indicator', async () => {
    const { normalizePresenceStatus } = await import('../src/hooks/usePresence');
    const desktop = source('src/components/DesktopUI.tsx');
    const indicator = source('src/components/biometrics/PresenceIndicator.tsx');

    expect(normalizePresenceStatus('unavailable_in_organization')).toBe('away');
    expect(normalizePresenceStatus('present')).toBe('present');
    expect(desktop).toContain("userId: workDomain === 'personal' ? user?.uid : undefined");
    expect(desktop).toContain("workDomain === 'personal' && (");
    expect(indicator).toContain('colors[status] || colors.away');
  });
});
