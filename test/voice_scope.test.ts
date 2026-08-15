import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JWT_SECRET, makeApp } from './helpers';
import voiceRoutes from '../routes/voice';
import * as OrgDB from '../server/org/db';
import {
  addScopedVoiceProfile,
  voiceProfileScope,
} from '../server/tts/profile_store';

describe('voice assets across personal and organization Lumi', () => {
  let cleanup = () => {};
  let baseUrl = '';
  let orgId = '';
  const ownerId = `voice-scope-owner-${Date.now()}`;
  const viewerId = `voice-scope-viewer-${Date.now()}`;
  const personalVoiceId = `personal-voice-${Date.now()}`;
  const orgVoiceId = `org-voice-${Date.now()}`;

  const token = (userId: string, work: boolean) => jwt.sign({
    uid: userId,
    username: userId,
    role: 'user',
    ...(work ? { orgId } : {}),
  }, JWT_SECRET);
  const headers = (userId: string, work: boolean) => ({
    'Content-Type': 'application/json',
    Cookie: `token=${token(userId, work)}`,
  });

  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    baseUrl = app.url;
    const org = OrgDB.createOrg('Voice Scope Org', `voice-scope-${Date.now()}`, ownerId);
    orgId = org.id;
    OrgDB.addMember(orgId, ownerId, 'owner');
    OrgDB.addMember(orgId, viewerId, 'viewer');
    addScopedVoiceProfile(voiceProfileScope(ownerId, 'personal', ''), {
      voiceId: personalVoiceId,
      name: 'Personal Voice',
      provider: 'cosyvoice',
      category: 'cloned',
    });
    addScopedVoiceProfile(voiceProfileScope(ownerId, 'work', orgId), {
      voiceId: orgVoiceId,
      name: 'Organization Voice',
      provider: 'cosyvoice',
      category: 'cloned',
    });
    app.apiRouter.use('/', voiceRoutes);
  });

  afterAll(() => cleanup());

  it('lists only the voices in the active Lumi domain', async () => {
    const personal = await fetch(`${baseUrl}/api/voice/voices?provider=cosyvoice`, { headers: headers(ownerId, false) });
    const work = await fetch(`${baseUrl}/api/voice/voices?provider=cosyvoice`, { headers: headers(ownerId, true) });
    expect(personal.ok).toBe(true);
    expect(work.ok).toBe(true);
    const personalIds = (await personal.json()).cloned.map((voice: any) => voice.voiceId);
    const workIds = (await work.json()).cloned.map((voice: any) => voice.voiceId);
    expect(personalIds).toContain(personalVoiceId);
    expect(personalIds).not.toContain(orgVoiceId);
    expect(workIds).toContain(orgVoiceId);
    expect(workIds).not.toContain(personalVoiceId);
  });

  it('blocks a cloned voice from another domain before synthesis', async () => {
    const response = await fetch(`${baseUrl}/api/voice/synthesize`, {
      method: 'POST',
      headers: headers(ownerId, false),
      body: JSON.stringify({ text: 'scope check', voiceId: orgVoiceId, provider: 'cosyvoice' }),
    });
    expect(response.status).toBe(403);
  });

  it('keeps organization shared voice mutations administrator-only', async () => {
    const viewerDelete = await fetch(`${baseUrl}/api/voice/${encodeURIComponent(orgVoiceId)}`, {
      method: 'DELETE',
      headers: headers(viewerId, true),
    });
    expect(viewerDelete.status).toBe(403);

    const ownerDelete = await fetch(`${baseUrl}/api/voice/${encodeURIComponent(orgVoiceId)}`, {
      method: 'DELETE',
      headers: headers(ownerId, true),
    });
    expect(ownerDelete.ok).toBe(true);
  });
});
