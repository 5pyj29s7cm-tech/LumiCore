import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isUserLLMProvider } from '../server/llm/user_preferences';

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('model provider access', () => {
  it('keeps local providers available as normal user-selected providers', () => {
    expect(isUserLLMProvider('lmstudio')).toBe(true);
    expect(isUserLLMProvider('ollama')).toBe(true);

    const providerRuntime = readRepoFile('server/llm/providers.ts');
    expect(providerRuntime).toContain("config.provider === 'lmstudio'");
    expect(providerRuntime).toContain("config.provider === 'ollama'");
    expect(providerRuntime).toContain('getLmStudio?.()');
    expect(providerRuntime).not.toMatch(/checkLLMAccess|PROVIDER_RESTRICTED|TOKEN_LIMIT/);
  });

  it('does not gate chat, REST, meeting, or miscellaneous model calls by a Lumi plan', () => {
    const executionEntries = [
      'server/socket/chat.ts',
      'server/routes/chat_routes.ts',
      'server/routes/misc_routes.ts',
    ].map(readRepoFile).join('\n');

    expect(executionEntries).not.toMatch(/subscription\/proxy|checkLLMAccess|recordUsage|PROVIDER_RESTRICTED|TOKEN_LIMIT|token:quota_update/);
    expect(executionEntries).toContain('recordTokenUsage');
  });

  it('keeps the retired subscription system out of the server and desktop UI', () => {
    for (const retiredFile of ['db.ts', 'proxy.ts', 'routes.ts', 'types.ts']) {
      expect(existsSync(path.join(process.cwd(), 'server/subscription', retiredFile))).toBe(false);
    }

    const serverEntry = readRepoFile('server.ts');
    const desktopUi = [
      'src/components/DesktopUI.tsx',
      'src/components/Profile.tsx',
      'src/components/TokenDashboard.tsx',
      'src/components/NeuralSynthesisMonitor.tsx',
    ].map(readRepoFile).join('\n');

    expect(serverEntry).not.toMatch(/subscriptionRoutes|server\/subscription/);
    expect(desktopUi).not.toMatch(/\/api\/subscription|token:quota_update|monthlyTokenCap|tokensUsedThisMonth/);
  });
});
