import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCommunityLumiDirectory } from '../server/lap/community_directory';

describe('LAP community directory adapter', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    delete process.env.LUMI_COMMUNITY_DIRECTORY_URL;
    delete process.env.LUMI_COMMUNITY_DIRECTORY_API_KEY;
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  it('reports an honest not-configured state instead of returning demo agents', async () => {
    await expect(fetchCommunityLumiDirectory()).resolves.toMatchObject({
      configured: false,
      status: 'not_configured',
      profiles: [],
    });
  });

  it('rejects insecure non-loopback directory endpoints', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LUMI_COMMUNITY_DIRECTORY_URL = 'http://community.example.test/lumi';
    await expect(fetchCommunityLumiDirectory()).resolves.toMatchObject({ status: 'invalid_configuration', profiles: [] });
  });

  it('normalizes public profiles and keeps remote private fields out', async () => {
    process.env.NODE_ENV = 'test';
    process.env.LUMI_COMMUNITY_DIRECTORY_URL = 'http://127.0.0.1:9988/v1/lumi';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ profiles: [{
      agentId: 'agent-community-1',
      displayName: 'Designer Lumi',
      description: 'Visual design specialist',
      publicKey: 'ed25519:community-public-key',
      privateKey: 'must-not-leak',
      capabilities: ['design', 'design', 'image'],
      trustTags: ['community'],
      homeNode: 'cn-east',
      updatedAt: '2026-08-12T00:00:00.000Z',
    }] }), { status: 200 })) as any);

    const snapshot = await fetchCommunityLumiDirectory();
    expect(snapshot.status).toBe('online');
    expect(snapshot.profiles).toHaveLength(1);
    expect(snapshot.profiles[0]).toMatchObject({ agentId: 'agent-community-1', capabilities: ['design', 'image'] });
    expect(snapshot.profiles[0]).not.toHaveProperty('privateKey');
    expect(snapshot.profiles[0].publicKeyFingerprint).toHaveLength(64);
  });
});
