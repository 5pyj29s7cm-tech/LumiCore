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

let baseUrl = '';
let cleanup: (() => void) | undefined;
const userToken = jwt.sign({
  uid: 'remote-chat-user',
  username: 'remote',
  role: 'user',
}, JWT_SECRET);

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
      body: JSON.stringify({ message: 'read a local file and inspect running processes' }),
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
  });
});
