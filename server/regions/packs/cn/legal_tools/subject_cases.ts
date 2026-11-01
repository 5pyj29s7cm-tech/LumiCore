import { createHash } from 'node:crypto';
import { assertLegalExecutionActive, legalExecutionContext } from '../../../../legal/execution';
import { queryQichachaSubjectCases, searchEnforcementRecords } from '../../../../legal/sources';
import { encodeToolResult } from '../../../../tools/result_envelope';
import type { ToolContext } from '../../../../tools/types';

/** Subject lookup uses the authorized provider, never local case-similarity retrieval. */
export async function searchSubjectCasesHandler(args: Record<string, any>, context: ToolContext | undefined = legalExecutionContext()): Promise<string> {
  assertLegalExecutionActive(context);
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const scope = args.scope === 'enforcement' ? 'enforcement' : 'cases';
  const heading = ['# 主体案件来源查询', '', '- 查询主体: ' + name, '- 查询范围: ' + (scope === 'enforcement' ? '公开执行来源' : '涉诉案件来源'), ''];
  const partial = (reason: string) => encodeToolResult([...heading, reason, '本次没有取得可核对的案件来源，不能据此认定该主体无案件或无执行记录。'].join('\n'), { ok: false, status: 'partial', sourceResults: [] });
  if (!name) return partial('未提供主体名称，未执行查询。');
  const localOnly = context?.dataRoutingPolicy === 'local_only';
  if (localOnly) return partial('当前为仅本地模式，未向外部来源发送主体名称。');
  try {
    const source = scope === 'enforcement'
      ? await searchEnforcementRecords(name, { localOnly })
      : await queryQichachaSubjectCases(name, localOnly);
    assertLegalExecutionActive(context);
    if (!source) return partial('当前没有配置可用的授权主体案件查询来源。');
    const sourceTextSha256 = createHash('sha256').update(source.text).digest('hex');
    return encodeToolResult([...heading,
      '以下仅保留本次授权来源的原始回执；是否为同一当事人及案件范围，应以回执中的主体和案件字段为准。', '',
      '## 授权来源原始结果', '- 来源: ' + source.sourceName, '- 工具: ' + source.sourceTool,
      '- 端点: ' + source.sourceEndpoint, '- 查询时间: ' + source.queriedAt, '- SHA256: ' + sourceTextSha256, '', source.text,
    ].join('\n'), { ok: true, status: 'observed', sourceResults: [{
      sourceName: source.sourceName, sourceTool: source.sourceTool, sourceEndpoint: source.sourceEndpoint,
      queriedAt: source.queriedAt, subject: name, queryScope: scope, status: 'observed', sourceTextSha256,
    }] });
  } catch (error) {
    assertLegalExecutionActive(context);
    return partial('主体案件查询未完成：' + (error instanceof Error ? error.message : String(error)));
  }
}
