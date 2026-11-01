import { createHash } from 'node:crypto';
import { assertLegalExecutionActive, legalExecutionContext } from '../../../../legal/execution';
import { toolRegistry } from '../../../../tools/registry';
import { decodeToolResult, encodeToolResult } from '../../../../tools/result_envelope';
import type { ToolContext } from '../../../../tools/types';

/** Search candidates only: no model synthesis, source-page fetching, or case writes. */
export async function searchPublicFootprintHandler(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const executionContext = context || legalExecutionContext();
  assertLegalExecutionActive(executionContext);
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const subjectType = args.subjectType === 'individual' ? 'individual' : 'enterprise';
  const queriedAt = new Date().toISOString();
  const query = JSON.stringify(name);
  const header = [
    '# 公开网络足迹检索',
    '',
    '- 查询主体: ' + name,
    '- 主体类型: ' + (subjectType === 'individual' ? '个人' : '企业'),
    '- 检索词: ' + query,
    '- 查询时间: ' + queriedAt,
    '',
    '本次仅登记搜索引擎返回的标题、摘要及原始页面链接，未读取链接页面全文；搜索命中不确认同名主体身份、关联关系、资产归属或可供执行财产。',
  ];
  const result = (body: string, ok: boolean, sourceResults: Record<string, unknown>[] = []) => encodeToolResult(
    [...header, '', body].join('\n'),
    { ok, status: ok ? 'observed' : 'partial', persisted: false, changedCaseIds: [], articleIds: [], artifacts: [], sourceResults },
  );
  if (!name) return result('请提供查询主体名称（name参数）；未执行网络检索。', false);
  if (executionContext?.dataRoutingPolicy === 'local_only') {
    return result('当前采用 local_only 数据策略，未向外部搜索引擎发送主体名称；公开网络检索未执行。', false);
  }
  const registry = executionContext?.toolRegistry || toolRegistry;
  if (!registry.get('web_search')) return result('公开网络搜索工具当前不可用，未取得搜索来源。', false);
  try {
    const original = decodeToolResult(await registry.execute('web_search', { query, maxResults: 5 }, executionContext));
    assertLegalExecutionActive(executionContext);
    const receipt = original.receipt as Record<string, unknown> | undefined;
    const ok = receipt?.ok === true && receipt.status === 'observed' && Boolean(original.content.trim());
    const sourceTextSha256 = createHash('sha256').update(original.content).digest('hex');
    const source = {
      sourceName: '公开网络搜索（搜索引擎摘要）', sourceTool: 'web_search', subject: name, subjectType,
      query, queriedAt, status: ok ? 'observed' : 'partial', sourceText: original.content, sourceTextSha256,
      ...(typeof receipt?.provider === 'string' ? { provider: receipt.provider } : {}),
      ...(typeof receipt?.resultCount === 'number' ? { resultCount: receipt.resultCount } : {}),
    };
    return result([
      ok ? '## 已取得的搜索线索' : '## 检索未完成',
      ok ? '以下内容为搜索引擎摘要，仍需结合原页面及主体身份判断。'
        : '本次未取得可用搜索结果，不能据此认定查询主体没有网络足迹。',
      '',
      '## 搜索工具原始结果',
      '- 来源: ' + source.sourceName,
      '- 工具: web_search',
      '- 查询时间: ' + queriedAt,
      '- SHA256: ' + sourceTextSha256,
      '',
      original.content,
    ].join('\n'), ok, [source]);
  } catch (error) {
    assertLegalExecutionActive(executionContext);
    return result('公开网络检索未完成：' + (error instanceof Error ? error.message : String(error))
      + '\n未取得搜索来源，不能据此认定查询主体没有网络足迹。', false);
  }
}
