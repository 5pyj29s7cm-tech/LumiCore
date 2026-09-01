import { describe, expect, it, vi } from 'vitest';
import { registerAllTools } from '../server/tools/definitions';
import { registerClientSelfTools } from '../server/tools/definitions/client_self_tools';
import { ToolRegistry } from '../server/tools/registry';

function sampleTool(name: string, securityLevel: 'safe' | 'confirm' | 'forbidden' = 'safe') {
  return {
    name,
    description: `Capability for ${name}`,
    permission: 'public' as const,
    securityLevel,
    parameters: {
      target: { type: 'string', required: true },
    },
    handler: vi.fn(async () => 'ok'),
  };
}

describe('runtime capability manifest', () => {
  it('materializes complete metadata for every built-in tool', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);

    const definitions = registry.list();
    const manifest = registry.getCapabilityManifest();

    expect(manifest).toHaveLength(definitions.length);
    expect(manifest.length).toBeGreaterThan(200);
    for (const entry of manifest) {
      expect(entry.toolName).toBeTruthy();
      expect(entry.capabilityId).toBeTruthy();
      expect(entry.family).toBeTruthy();
      expect(entry.lane).toBeTruthy();
      expect(['builtin', 'adapter']).toContain(entry.source);
      expect(entry.description).toBeTruthy();
      expect(entry.routingTerms.length).toBeGreaterThan(0);
      expect(entry.modes).toEqual(expect.arrayContaining(['assistant', 'autonomous']));
      expect(['none', 'low', 'medium', 'high', 'critical']).toContain(entry.risk);
      expect(entry.verification.required).toBe(true);
      expect(entry.provenance.provider).toBeTruthy();
      expect(entry.trust).toBeTruthy();
      expect(entry.metadataSources.operation).toBeTruthy();
      expect(entry.metadataSources.lane).toBeTruthy();
      expect(entry.metadataSources.risk).toBeTruthy();
      expect(entry.metadataSources.verification).toBeTruthy();
      if (entry.deprecated) {
        expect(entry.replacedBy).toBeTruthy();
        expect(entry.executable).toBe(false);
      }
      expect(['safe', 'confirm', 'forbidden']).toContain(entry.effectiveSecurityLevel);
      expect(['observe', 'test', 'mutate', 'create', 'communicate', 'unknown']).toContain(entry.operation);
      expect(entry.domains.length).toBeGreaterThan(0);
    }
    expect(new Set(manifest.map(entry => entry.capabilityId)).size).toBe(manifest.length);
    expect(
      manifest.filter(entry => entry.sideEffects.length > 0 && !entry.hasEvidenceContract),
    ).toEqual([]);
    expect(
      manifest.filter(entry => entry.sideEffects.length > 0 && (
        !entry.evidence
        || entry.risk === 'none'
        || !entry.metadataSources.risk
        || !entry.metadataSources.sideEffects
        || entry.metadataSources.evidence === 'not_required'
      )),
    ).toEqual([]);
  });

  it('uses the same effective policy for manifest visibility, model declarations, and execution', async () => {
    const registry = new ToolRegistry();
    registry.register(sampleTool('allowed_read'));
    registry.register(sampleTool('blocked_write', 'confirm'));
    const policy = {
      allowedTools: ['allowed_read', 'blocked_write'],
      forbiddenTools: ['blocked_write'],
      requireConfirmation: [],
      maxIterations: 3,
    };

    const manifest = registry.getCapabilityManifest(policy);
    const declarations = registry.getToolDeclarationsForPolicy(policy);

    expect(manifest.find(entry => entry.toolName === 'allowed_read')?.executable).toBe(true);
    expect(manifest.find(entry => entry.toolName === 'blocked_write')?.executable).toBe(false);
    expect(declarations.map(item => item.function.name)).toEqual(['allowed_read']);
    await expect(registry.execute('blocked_write', {}, { toolPolicy: policy }))
      .rejects.toThrow(/forbidden/i);
  });

  it('exposes only single-target external AI tools to new model plans', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);

    const declarations = registry.getToolDeclarationsForPolicy().map(item => item.function.name);
    expect(declarations).toEqual(expect.arrayContaining([
      'desktop_ai_ask',
      'desktop_ai_collect_answer',
      'desktop_ai_list_targets',
    ]));

    const manifest = registry.getCapabilityManifest();
    expect(manifest.find(entry => entry.toolName === 'desktop_ai_ask')).toMatchObject({
      deprecated: false,
      executable: true,
    });
    expect(manifest.find(entry => entry.toolName === 'desktop_ai_collect_answer')).toMatchObject({
      deprecated: false,
      executable: true,
    });
  });

  it('records skill ownership and treats undeclared side effects conservatively', () => {
    const registry = new ToolRegistry();
    registry.register({
      ...sampleTool('mcp_cad-drafting_autocad_playback_file', 'confirm'),
      capability: {
        source: 'skill',
        provider: 'cad-drafting',
        family: 'cad-drafting',
        operation: 'unknown',
        domains: ['cad'],
      },
    });

    expect(registry.getCapabilityManifest()).toEqual([
      expect.objectContaining({
        toolName: 'mcp_cad-drafting_autocad_playback_file',
        source: 'skill',
        provider: 'cad-drafting',
        family: 'cad-drafting',
        lane: 'cad',
        domains: ['cad'],
        operation: 'unknown',
        risk: 'high',
        hasEvidenceContract: true,
        evidence: expect.objectContaining({
          operation: 'mutate',
          assurance: 'declared',
          declarationSource: 'manifest_policy',
          explicit: false,
        }),
        assurance: 'none',
      }),
    ]);
  });

  it('ranks capabilities from a natural Chinese sentence instead of requiring an exact substring', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...sampleTool('netease_music_play'),
      description: '在网易云音乐中搜索并播放歌曲',
      routingHints: ['网易云', '播放音乐', '歌曲'],
    });
    registry.register({
      ...sampleTool('desktop_open'),
      description: '打开一个桌面应用',
      routingHints: ['打开软件'],
    });
    registerClientSelfTools(registry);

    const output = JSON.parse(await registry.execute('client_capability_manifest', {
      query: '请帮我打开网易云，然后播放一首周杰伦的歌',
      executableOnly: true,
      limit: 2,
    }, {
      toolPolicy: {
        allowedTools: ['*'],
        forbiddenTools: [],
        requireConfirmation: [],
        maxIterations: 4,
      },
    }));

    expect(output.matched).toBeGreaterThan(0);
    expect(output.capabilities[0]).toMatchObject({
      toolName: 'netease_music_play',
      executableThisTurn: true,
    });
    expect(output.capabilities[0].matchScore).toBeGreaterThan(0);
    expect(output.capabilities[0].matchedTerms).toEqual(expect.arrayContaining(['网易云', '播放']));
  });
});
