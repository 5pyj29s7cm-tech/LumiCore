import './helpers';
import { describe, expect, it } from 'vitest';
import { buildActionEvidenceContract } from '../server/cognition/action_contract';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { guardToolResponseIfNeeded } from '../server/llm/tool_loop/projection';
import type { ToolExecutionRecord } from '../server/tools/types';

const scope = { requestId: 'inline-observation-request', taskId: 'inline-observation-task' };
const task = '请根据题设说明两个阶段的因果关系和理由，直接在聊天回答，不创建文件。';
const observation = (overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord => ({
  ...scope, name: 'web_search', arguments: { query: 'background concepts' }, result: 'Search unavailable', error: 'search_unavailable',
  capability: { capabilityId: 'web_search', lane: 'web', operation: 'observe', risk: 'low', sideEffects: [{ type: 'network_read', scope: 'public source', reversible: true }], verification: { strategy: 'terminal_receipt', required: true, requiredFields: [], successSignals: [], limitations: [] } },
  terminalVerification: { status: 'failed', strategy: 'terminal_receipt', reason: 'The optional source did not return.' },
  ...overrides,
});
const failed = observation();
const source = observation({ name: 'url_fetch', arguments: { url: 'https://example.org/source' }, error: undefined,
  result: 'Source paragraph explaining the stages.', terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'The source content returned.' } });
const unrelated = observation({ name: 'get_system_info', arguments: {}, error: undefined, result: 'System info returned.',
  terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'System observation returned.' } });
const check = (request: string, response: string, records: ToolExecutionRecord[]) => {
  const guard = guardToolResponseIfNeeded({ task: request, response, toolCalls: records, ...scope });
  const final = finalizeLumiResponse({ taskText: request, responseText: guard.text, toolRecords: records, completionGuard: guard, source: 'chat', ...scope,
    flow: { routeText: request, allowToolUseForTurn: true, completionEvidenceNeeded: false, acceptedActionContract: { taskText: request, contract: buildActionEvidenceContract(request) } } as any });
  return { guard, final };
};

describe('optional observation outcomes do not create an external execution obligation', () => {
  it.each([
    '两个阶段的变化均在同一轮实验中完成，因此不能据此认定后来阶段造成了先前变化。',
    '分析已完成：阶段甲先发生，阶段乙后发生；还需独立证据证明因果联系。',
    '我已完成上述分析。阶段先后关系本身不能证明因果关系。',
    'The first stage was completed before the second stage began. Temporal order alone does not establish causation.',
    'I have completed the analysis: temporal order alone does not establish causation.',
    'This analysis is complete. The available facts do not establish causation.',
  ])('preserves factual and inline analysis completion after an optional failed observation: %s', answer => {
    expect(buildActionEvidenceContract(task)).toMatchObject({ applies: false, kind: 'none' });
    for (const records of [[], [failed], [failed, source]]) {
      const { guard, final } = check(task, answer, records);
      expect(guard).toMatchObject({ blocked: false, text: answer });
      expect(final).toMatchObject({ blocked: false, text: answer });
    }
  });

  it.each([
    '我已检索并核验官方来源，分析如下：两个阶段的先后不能单独证明因果关系。',
    '本轮已查询并查阅原始来源，分析如下。',
    'I have searched and verified the original sources. The analysis follows.',
    '我已检索并核验，分析如下。',
    'I have searched and verified. Here is the analysis.',
  ])('requires successful source evidence for a current source lookup or verification claim: %s', answer => {
    for (const records of [[], [failed], [failed, unrelated], [{ ...source, requestId: 'another-request' }]]) {
      const { guard, final } = check(task, answer, records);
      expect(guard.blocked).toBe(true);
      expect(final.blocked).toBe(true);
    }
    const { guard, final } = check(task, answer, [failed, source]);
    // A fetched paragraph proves observation, not factual/authority verification.
    if (/核验|verified/iu.test(answer)) {
      expect(guard.blocked).toBe(true);
      expect(final.blocked).toBe(true);
    } else {
      expect(guard).toMatchObject({ blocked: false, text: answer });
      expect(final).toMatchObject({ blocked: false, text: answer });
    }
  });

  it.each([
    '没有检索或核验来源，仅根据题设作上述分析。',
    '如果已检索并核验来源，需要另行说明。',
    '原文写着“我已检索并核验来源”。这里只解释这句话。',
    'I have not searched or verified sources; the analysis uses only the supplied facts.',
    '我已验证计算结果：十二加八等于二十。这只是对题设的算术分析。',
  ])('does not create a source execution claim from denial, hypothesis or quotation: %s', answer => {
    const { guard, final } = check(task, answer, [failed]);
    expect(guard).toMatchObject({ blocked: false, text: answer });
    expect(final).toMatchObject({ blocked: false, text: answer });
  });

  it.each([
    ['请读取 D:/case-source/source.docx，分析其中内容。', '已完整读取 source.docx 并完成分析。'],
    ['请创建 D:/case-source/result.txt。', '文件已创建并保存。'],
    ['请打开计算器。', '已打开计算器。'],
    ['请给审阅人发送消息。', '已发送消息给审阅人。'],
  ])('retains evidence requirements for actual source reads and physical actions: %s', (request, answer) => {
    const { guard, final } = check(request, answer, [failed]);
    expect(guard.blocked).toBe(true);
    expect(final.blocked).toBe(true);
  });
});
