import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runWithTools: vi.fn(),
}));

vi.mock('../server/llm/adapter', () => ({
  runWithTools: mocks.runWithTools,
}));

import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { mountChatRoutes } from '../server/routes/chat_routes';
import {
  DESKTOP_SESSION_HEADER,
  issueDesktopSessionProof,
} from '../server/config/desktop_bootstrap';

let baseUrl = '';
let cleanup: (() => void) | undefined;
const userToken = jwt.sign({
  uid: 'remote-chat-user',
  username: 'remote',
  role: 'user',
}, JWT_SECRET);
const nativeClientIdentity = {
  schemaVersion: 1 as const,
  clientKind: 'tauri' as const,
  pid: process.pid,
  startedAtUnixMs: Math.floor((Date.now() - 10_000) / 1_000) * 1_000,
  executablePath: process.execPath,
  executableSha256: 'd'.repeat(64),
  binaryHashUnavailable: false,
  buildId: 'c'.repeat(40),
  buildIdSemantics: 'baseline_commit' as const,
  sourceFingerprint: 'e'.repeat(64),
  sourceDirty: false,
  appVersion: '3.1.0',
};

describe('REST chat remote execution boundary', () => {
  beforeAll(async () => {
    const app = await makeApp();
    baseUrl = app.url;
    cleanup = app.cleanup;
    const unavailable = () => null;
    mountChatRoutes(app.apiRouter, JWT_SECRET, {
      getDeepSeek: unavailable,
      getGemini: unavailable,
      getOpenAI: unavailable,
      getAnthropic: unavailable,
      getQwen: unavailable,
    });
  });

  afterAll(() => cleanup?.());

  beforeEach(() => {
    mocks.runWithTools.mockReset();
    mocks.runWithTools.mockResolvedValue({
      text: 'remote answer',
      toolCalls: [],
      usageRecords: [],
    });
  });

  it('does not expose the shared model to an anonymous caller', async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(response.status).toBe(401);
    expect(mocks.runWithTools).not.toHaveBeenCalled();
  });

  it('marks authenticated REST chat remote and narrows the model policy before dispatch', async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ message: '读取 D:\\work\\brief.txt 并告诉我唯一风险，但不要修改文件' }),
    });
    expect(response.status).toBe(200);
    expect(mocks.runWithTools).toHaveBeenCalledTimes(1);
    const context = mocks.runWithTools.mock.calls[0][11] as any;
    expect(context).toMatchObject({
      userId: 'remote-chat-user',
      authenticated: true,
      authRole: 'user',
      localExecution: false,
      executionBoundary: 'remote_restricted',
      source: 'rest_chat',
      currentTurnExecutionRequested: false,
      trustedActionContinuation: false,
    });
    expect(context.toolPolicy.allowedTools.every((name: string) => name === 'web_search')).toBe(true);
    expect(context.toolPolicy.allowedTools).not.toEqual(expect.arrayContaining([
      'read_file',
      'list_directory',
      'search_files',
      'desktop_capture_screen',
      'desktop_running_processes',
      'run_command',
      'credential_get',
    ]));
    expect(context.toolPolicy.maxIterations).toBeLessThanOrEqual(4);
    expect(context.modelToolProjection.toolNames.every(
      (name: string) => context.toolPolicy.allowedTools.includes(name),
    )).toBe(true);
    expect(context.modelToolProjection.toolNames).not.toEqual(expect.arrayContaining([
      'read_file',
      'list_directory',
      'search_files',
      'desktop_capture_screen',
      'desktop_running_processes',
      'run_command',
      'credential_get',
    ]));
  });

  it('accepts the backend-issued native proof on loopback without weakening ordinary REST chat', async () => {
    const desktopSession = issueDesktopSessionProof('remote-chat-user', nativeClientIdentity);
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
        [DESKTOP_SESSION_HEADER]: desktopSession.proof,
      },
      body: JSON.stringify({ message: '读取 D:\\work\\brief.txt 并告诉我唯一风险，但不要修改文件' }),
    });
    expect(response.status).toBe(200);
    const context = mocks.runWithTools.mock.calls[0][11] as any;
    expect(context).toMatchObject({
      userId: 'remote-chat-user',
      authenticated: true,
      localExecution: true,
      executionBoundary: 'trusted_local',
      source: 'rest_chat_local',
      currentTurnExecutionRequested: false,
      trustedActionContinuation: false,
    });
  });

  it('fails closed when a caller presents an invalid native proof', async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
        [DESKTOP_SESSION_HEADER]: 'invalid-proof-that-must-not-downgrade-to-remote-chat',
      },
      body: JSON.stringify({ message: 'read a local file' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'DESKTOP_SESSION_PROOF_REQUIRED' });
    expect(mocks.runWithTools).not.toHaveBeenCalled();
  });

  it('treats an explicitly empty native proof as presented and fails closed', async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
        [DESKTOP_SESSION_HEADER]: '',
      },
      body: JSON.stringify({ message: 'read a local file' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'DESKTOP_SESSION_PROOF_REQUIRED' });
    expect(mocks.runWithTools).not.toHaveBeenCalled();
  });
});
