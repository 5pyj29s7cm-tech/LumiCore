import { expect, it } from 'vitest';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { hasClientActionOnlyIntent } from '../server/cognition/tool_intent';

it.each([
  ['打开人格实验室', 'personality', 'open_personality_lab'],
  ['返回个人工作区', 'home', 'open_personal_workspace'],
  ['打开应用启动器', 'app-launcher', 'open_app_launcher'],
  ['打开终端', 'terminal', 'open_terminal'],
  ['打开模型用量', 'tokens', 'open_token_dashboard'],
  ['打开个人资料', 'profile', 'open_profile'],
  ['打开 MCP 设置', 'settings', 'open_mcp_settings'],
  ['打开语音工坊', 'settings', 'open_voice_forge'],
  ['打开技能生成器', 'generate', 'open_skill_generator'],
  ['open personality lab', 'personality', 'open_personality_lab'],
  ['open token dashboard', 'tokens', 'open_token_dashboard'],
  ['open voice forge', 'settings', 'open_voice_forge'],
  ['open token dashboard.', 'tokens', 'open_token_dashboard'],
] as const)('routes the registered surface and exact action: %s', (text, target, clientAction) => {
  expect(normalizeActionIntent(text)).toMatchObject({ kind: 'client_navigation', target, clientAction });
  expect(hasClientActionOnlyIntent(text)).toBe(true);
});

it.each([
  '不要打开人格实验室',
  '解释“打开人格实验室”这句话',
  '如果打开人格实验室会怎样？',
  '在浏览器打开人格实验室的网站',
  '打开 C:\\reports\\人格实验室.txt',
  'Explain the phrase "open token dashboard".',
  'Do not open voice forge.',
  'Open token-dashboard.example.com in the browser.',
  'Open personality-lab.md',
  '打开人格实验室.txt',
  'Open token-dashboard/reports',
])('does not turn an alias in non-navigation text into a client action: %s', text => {
  expect(normalizeActionIntent(text).kind).not.toBe('client_navigation');
  expect(hasClientActionOnlyIntent(text)).toBe(false);
});
