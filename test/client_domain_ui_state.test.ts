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
    expect(context).toContain('${voiceStorageKeys.selected}_provider_${provider}');
    expect(context).not.toContain('JSON.stringify({ tts: provider })');
    expect(picker).toContain('workDomain, orgConnection?.orgId');
    expect(picker).toContain('VOICE_PROVIDER_CHANGED_EVENT');
    expect(picker).toContain('getSelectedVoiceIdForProvider(data.provider)');
    expect(picker).toContain('preferredVoice.provider || data.provider');
  });

  it('keeps the personalization voice studio read-only for provider selection', () => {
    const panel = source('src/components/DesktopPersonalizationSoundPanel.tsx');
    const desktop = source('src/components/DesktopUI.tsx');

    expect(panel).toContain("ui('当前语音服务', 'Current voice service')");
    expect(panel).toContain("ui('前往语音服务', 'Voice settings')");
    expect(panel).toContain('onOpenVoiceSettings');
    expect(panel).not.toContain('/api/voice/provider');
    expect(desktop).toContain("setSettingsSection('voice-model')");
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
    const appCatalog = source('shared/system_apps.ts');

    expect(routes).toContain('requirePersonalSystemAdmin, requireLocalRequest');
    expect(explorer).toContain("from '../../shared/system_apps'");
    expect(appCatalog).toContain('/workbuddy/i');
    expect(appCatalog).toContain('/codex/i');
    expect(appCatalog).toContain('/gstarcad/i');
  });

  it('does not let organization-only presence states crash the personal indicator', async () => {
    const { normalizePresenceStatus } = await import('../src/hooks/usePresence');
    const desktop = source('src/components/DesktopUI.tsx');
    const indicator = source('src/components/biometrics/PresenceIndicator.tsx');

    expect(normalizePresenceStatus('unavailable_in_organization')).toBe('away');
    expect(normalizePresenceStatus('present')).toBe('present');
    expect(desktop).toContain("userId: workDomain === 'personal' ? user?.uid : undefined");
    expect(desktop).toContain('facePresenceRequested && faceRecognition.hasTemplates && (');
    expect(indicator).toContain('colors[status] || colors.away');
  });
});
