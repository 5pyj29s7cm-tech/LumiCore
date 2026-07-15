import { describe, expect, it } from 'vitest';
import { matchQuickCommand } from '../server/cognition/quick_commands';
import { buildActionContract } from '../server/cognition/action_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { parseWeChatConversationReadyVerification } from '../server/tools/definitions/external_app_tools';
import { describeRecentActionsFromHistory } from '../server/socket/voice_action_history';
import { resolveWeChatRecipientFromHistory } from '../server/socket/voice_messaging_context';

describe('live voice regression cases', () => {
  it('keeps combined WeChat inquiry out of the generic app-open quick path', async () => {
    expect(await matchQuickCommand('打开微信，问一下阿陆在干嘛。', 'u1')).toBeNull();
    expect(buildActionContract('打开微信，问一下阿陆在干嘛。').kind).toBe('messaging_send');
    expect(buildActionContract('我没有户型图发给你。').kind).toBe('none');
  });

  it('uses dedicated browser and knowledge tools for the exact spoken requests', async () => {
    expect(await matchQuickCommand('你能听到我吗？', 'u1')).toMatchObject({
      responseText: '能听见。你说。',
      matched: true,
    });
    expect(await matchQuickCommand('打开浏览器。', 'u1')).toMatchObject({
      toolCall: { name: 'browser_open_task' },
    });
    expect(await matchQuickCommand('打开中国裁判文书网。', 'u1')).toMatchObject({
      toolCall: {
        name: 'browser_open_task',
        arguments: { url: 'https://wenshu.court.gov.cn/', open: true },
      },
    });
    expect(await matchQuickCommand('看一下现在知识库里有多少的文件内容。', 'u1')).toMatchObject({
      toolCall: { name: 'knowledge_file_stats' },
    });
  });

  it('resolves a recipient pronoun from the latest real WeChat tool call', () => {
    const resolved = resolveWeChatRecipientFromHistory({ contact: '他', message: '在干嘛？' }, [{
      role: 'assistant',
      toolCalls: JSON.stringify([{
        name: 'wechat_send_message',
        arguments: { contact: '阿陆', message: '在干嘛？' },
        result: '{"sent":false}',
      }]),
    }]);
    expect(resolved.contact).toBe('阿陆');
  });

  it('requires strong visible evidence before treating a searched chat as ready', () => {
    expect(parseWeChatConversationReadyVerification('{"ready":true,"confidence":0.91,"reason":"exact chat header and composer"}').ready).toBe(true);
    expect(parseWeChatConversationReadyVerification('{"ready":true,"confidence":0.42,"reason":"only search results"}').ready).toBe(false);
    expect(parseWeChatConversationReadyVerification('{"ready":false,"confidence":0.99,"reason":"wrong chat"}').ready).toBe(false);
  });

  it('answers what just happened from tool receipts instead of inventing an explanation', () => {
    const response = describeRecentActionsFromHistory('我问你刚刚干了什么？你打开微信干了什么。', [{
      role: 'assistant',
      toolCalls: [{
        name: 'wechat_send_message',
        arguments: { contact: '阿路', message: '在干嘛？' },
        result: JSON.stringify({ sent: false, sendAttempted: true, verificationStatus: 'uncertain' }),
      }],
    }]);
    expect(response).toContain('搜索了“阿路”');
    expect(response).toContain('不能算发送成功');
  });

  it('keeps a successful simple AutoCAD open response concise', () => {
    const result = finalizeLumiResponse({
      taskText: '打开AutoCAD。',
      responseText: '已打开AutoCAD。',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: 'AutoCAD' },
        result: 'Opened app AutoCAD via desktop shortcut',
      }],
      source: 'voice',
    });
    expect(result.text).toBe('已打开AutoCAD。');
    expect(result.text).not.toContain('桌面状态读取');
  });
});
