import { createHash } from 'node:crypto';
import { queryQichachaMcp, QICHACHA_QUERY_TOOLS, type QichachaQueryType } from '../../../../legal/sources';
import { encodeToolResult } from '../../../../tools/result_envelope';
import { searchCompany, searchEnforcementRecords, type ExternalLegalSearchKind, searchLegalAuthorityDatabase, listLegalSourceCapabilities, searchCompanySources, searchTenderSources } from "../../../../legal/sources";
import { legalWrite, legalExecutionSignal } from "../../../../legal/execution";
import { createLegalArticle, indexLegalArticle } from "../../../../legal/kb";
import { textArg, legalWorkspaceId, listArg } from "./context";
import { appendLegalWorkProductArchiveSection } from "./citations";
import { courtLevelRank, LEGAL_CASE_SEARCH_ORDER, archiveLegalReportToCase } from "./case_workflow";

// ── legal_trace_assets ──────────────────────────────────────────────────

export async function traceAssetsHandler(args: Record<string, any>, context?: any): Promise<string> {
  const subjectName = args.name as string;
  if (!subjectName) return '请提供被执行主体名称（name参数）';
  const caseName = textArg(args, 'caseName') || `${subjectName}财产线索`;

  const lines: string[] = [`# 被执行人"${subjectName}"财产线索报告\n`];

  // 1. Company info
  const sourceErrors: string[] = [];
  const company = await searchCompany(subjectName, { localOnly: context?.dataRoutingPolicy === 'local_only', sourceErrors });
  if (company) {
    lines.push('## 企业基本信息');
    lines.push(`- 名称: ${company.name}`);
    lines.push(`- 法定代表人: ${company.legalPerson}`);
    lines.push(`- 注册资本: ${company.registeredCapital}`);
    lines.push(`- 状态: ${company.status}`);
    lines.push(`- 成立日期: ${company.establishDate}`);
    lines.push(`- 统一社会信用代码: ${company.unifiedCode}`);
    if (company.shareholders.length > 0) {
      lines.push('- 股东结构:');
      for (const s of company.shareholders) {
        lines.push(`  - ${s.name}: ${s.ratio}% (${s.type})`);
      }
    }
    lines.push(`\n## 风险信息`);
    lines.push(`- 被执行记录: ${company.riskInfo.enforcementCount === null ? '未取得该项来源' : company.riskInfo.enforcementCount + ' 条'}`);
    lines.push(`- 失信记录: ${company.riskInfo.dishonestyCount === null ? '未取得该项来源' : company.riskInfo.dishonestyCount + ' 条'}`);
    lines.push(`- 限制消费: ${company.riskInfo.restrictionsCount === null ? '未取得该项来源' : company.riskInfo.restrictionsCount + ' 条'}`);
    lines.push(`- 查询来源: ${company.sourceName || '企业信息数据源'} ${company.queriedAt ? `(${company.queriedAt.slice(0, 10)})` : ''}`);
  } else {
    lines.push('## 企业基本信息');
    lines.push('- 未通过已配置 API 查询到企业信息，或尚未配置企查查官方 API 凭证。');
    lines.push('- 请在企查查官网登录授权账号，核验企业信息。');
    lines.push('- 律师在授权网页内确认企业信息、股东信息、涉诉/被执行信息后，使用 材料入库 导入知识库。');
  }

  if (sourceErrors.length) lines.push('\n## 企业查询异常', ...sourceErrors.map(message => '- ' + message));

  // 2. Enforcement records
  let enforcements: Awaited<ReturnType<typeof searchEnforcementRecords>> = [];
  let enforcementSourceError = '';
  try {
    enforcements = await searchEnforcementRecords(subjectName);
  } catch {
    enforcementSourceError = '中国执行信息公开网需要通过授权网页核验并导入来源材料；当前执行来源未取得，不能认定无执行记录。';
  }
  lines.push('\n## 公开执行记录');
  if (enforcementSourceError) {
    lines.push('- 查询状态: needs_source');
    lines.push(`- ${enforcementSourceError}`);
  } else if (enforcements.length > 0) {
    for (const e of enforcements) {
      lines.push(`- [${e.caseNumber}] ${e.court} | 立案: ${e.filingDate} | 执行标的: ${e.executionTarget} | ${e.status}`);
    }
  }

  const observedSourceCount = (company ? 1 : 0) + enforcements.length;
  const needsSource = sourceErrors.length > 0 || Boolean(enforcementSourceError) || observedSourceCount === 0;
  lines.push('\n## 数据可用性');
  lines.push(`- 数据状态: ${needsSource ? 'needs_source' : 'observed'}`);
  lines.push(`- 已取得来源记录: ${observedSourceCount}`);
  if (enforcementSourceError) {
    lines.push('- 企业已有来源予以保留；公开执行查询尚未完成，不能将本步骤标记为已完成。请由律师通过授权网页核验后导入来源材料。');
  } else if (observedSourceCount === 0) {
    lines.push('- 当前步骤未取得可核验的外部企业或执行数据，不能标记为已完成；请配置官方 API，或由律师通过授权浏览器核验后导入来源材料。');
  }

  lines.push('\n## 财产线索分析');
  lines.push('1. **银行账户**: 建议通过法院执行系统查询被执行人银行开户信息');
  lines.push('2. **不动产**: 建议查询被执行人及其配偶名下不动产登记信息');
  lines.push('3. **车辆**: 建议通过车管所查询被执行人名下机动车辆');
  lines.push('4. **股权**: 通过股权穿透分析关联企业（见股权穿透分析工具）');
  lines.push('5. **婚姻状况**: 建议查询被执行人婚姻登记信息，判断是否涉及夫妻共同财产');
  lines.push('6. **知识产权**: 建议查询被执行人名下专利、商标、著作权');
  lines.push(`\n*数据来源: ${company?.sourceName || '授权网页登录协作/待人工确认'} | 公开执行来源${enforcementSourceError ? '未取得（待授权网页核验）' : '已返回查询结果'} | ${new Date().toISOString().slice(0, 10)}*`);

  const report = lines.join('\n');
  const archivedReport = await appendLegalWorkProductArchiveSection(report, needsSource ? { ...args, persistCase: false } : args, context, {
    caseName,
    title: `${subjectName}财产线索报告`,
    type: 'evidence',
    cause: textArg(args, 'caseType') || '执行/财产保全线索',
  });
  return needsSource ? encodeToolResult(archivedReport, { ok: false, status: 'partial' }) : archivedReport;
}

// ── legal_equity_penetration ─────────────────────────────────────────────

export async function equityPenetrationHandler(args: Record<string, any>, context?: any): Promise<string> {
  const companyName = args.name as string;
  if (!companyName) return '请提供公司名称（name参数）';
  const caseName = textArg(args, 'caseName') || `${companyName}股权穿透`;

  const sourceErrors: string[] = [];
  const company = await searchCompany(companyName, { localOnly: context?.dataRoutingPolicy === 'local_only', sourceErrors });
  if (!company) {
    const report = sourceErrors.join("\n") + `\n未通过已配置 API 取得"${companyName}"的可核验企业信息，不能据此认定企业不存在。

可执行以下授权网页登录协作：
1. 打开企查查官网并登录授权账号。
2. 核验查询主体和股东信息。
3. 律师在网页内确认股东、对外投资、风险信息后，使用 材料入库 导入 Lumi 知识库。

边界：这不是平台数据接入；不自动抓取、不批量同步、不绕过验证码、付费墙、账号权限或频控。`;
    return encodeToolResult(await appendLegalWorkProductArchiveSection(report, { ...args, persistCase: false }, context, {
      caseName,
      title: `${companyName}股权穿透协作报告`,
      type: 'evidence',
      cause: textArg(args, 'caseType') || '主体/股权穿透',
    }), { ok: false, status: 'partial' });
  }

  const lines: string[] = [`# ${companyName} 股权穿透分析\n`];
  if (!company.shareholders.length) lines.push('未取得可核验股东来源，股权穿透尚未完成；不能把空字段解释为没有股东。');
  lines.push('## 第一层：直接股东');
  for (const s of company.shareholders) {
    lines.push(`- ${s.name}: 持股 ${s.ratio}% (${s.type})`);
  }

  // Recursively trace each shareholder (max 3 levels)
  for (const s of company.shareholders.slice(0, 5)) {
    const subCompany = await searchCompany(s.name, { localOnly: context?.dataRoutingPolicy === 'local_only', sourceErrors });
    if (subCompany && subCompany.shareholders.length > 0) {
      lines.push(`\n## 穿透 ${s.name} 的股东`);
      for (const ss of subCompany.shareholders) {
        const indirectRatio = Math.round(s.ratio * ss.ratio / 100);
        lines.push(`- ${ss.name}: 间接持股 ~${indirectRatio}% (${ss.type})`);
      }
    }
  }

  lines.push('\n## 财产线索');
  lines.push(`- 实际控制人: 需结合工商登记+公司章程判断`);
  lines.push(`- 注册资本: ${company.registeredCapital}`);
  lines.push('- 建议进一步查询: 银行流水、关联交易、对外投资');
  lines.push('\n*注意: 股权穿透信息基于公开工商数据，实际控制关系需综合判断。*');
  lines.push(`*数据来源: ${company.sourceName || '企查查授权数据源'} | ${new Date().toISOString().slice(0, 10)}*`);

  if (sourceErrors.length) lines.push('\n## 查询异常', ...sourceErrors.map(message => '- ' + message));
  const needsSource = sourceErrors.length > 0 || !company.shareholders.length;
  const report = lines.join('\n');
  const archivedReport = await appendLegalWorkProductArchiveSection(report, needsSource ? { ...args, persistCase: false } : args, context, {
    caseName,
    title: `${companyName}股权穿透分析报告`,
    type: 'evidence',
    cause: textArg(args, 'caseType') || '主体/股权穿透',
  });
  return needsSource ? encodeToolResult(archivedReport, { ok: false, status: 'partial' }) : archivedReport;
}

// ── legal_external_source_status ────────────────────────────────────────

function mdCell(value: unknown): string {
  return String(value ?? '').replace(/\|/g, ' ').replace(/\n+/g, ' ').trim() || '待登记';
}

function normalizeExternalLegalKind(value: string): ExternalLegalSearchKind {
  if (/案例|判例|裁判|case|judgment/i.test(value)) return 'case';
  if (/法条|法规|法律|statute|law/i.test(value)) return 'law';
  return 'mixed';
}

export async function searchExternalAuthoritiesHandler(args: Record<string, any>, context?: any): Promise<string> {
  const query = textArg(args, 'query') || textArg(args, 'facts') || textArg(args, 'issue') || textArg(args, 'caseType');
  if (!query) return '请提供 query（检索词、争议焦点、案由或案件事实）。';

  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || '外部法律数据库检索';
  const sourceIds = [
    ...listArg(args, 'sourceIds'),
    ...listArg(args, 'sources'),
    ...listArg(args, 'platforms'),
  ];
  const type = normalizeExternalLegalKind(textArg(args, 'type') || textArg(args, 'kind'));
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 20));
  const includeOfficialWeb = args.includeOfficialWeb === true;

  const results = await searchLegalAuthorityDatabase({
    query,
    type,
    sourceIds,
    limit,
    includeOfficialWeb,
  });
  const orderedResults = [...results].sort((a, b) => {
    const aRank = courtLevelRank([a.court, a.title, a.summary].filter(Boolean).join(' '));
    const bRank = courtLevelRank([b.court, b.title, b.summary].filter(Boolean).join(' '));
    return aRank - bRank;
  });
  const capabilities = listLegalSourceCapabilities()
    .filter(source => ['pkulaw', 'farui', 'people-court-case-library', 'china-judgments-online'].includes(source.id));

  const resultRows = orderedResults.length
    ? orderedResults.map((item, index) =>
      `| ${index + 1} | ${mdCell(item.sourceName)} | ${mdCell(item.title)} | ${mdCell(item.caseNumber || item.effectiveStatus)} | ${mdCell(item.publishDate || item.court)} | ${mdCell(item.url || item.summary)} | 律师复核 |`,
    ).join('\n')
    : '| 1 | 未命中 | 未通过已配置 API 返回结果 | 待补充 | 待补充 | 请配置授权 API 或使用网页登录协作 | 律师复核 |';

  const statusRows = capabilities.map(source =>
    `| ${mdCell(source.label)} | ${source.accessMode} | ${source.configured ? '已配置（以本次回执为准）' : '未配置或网页登录'} | ${source.canAutoQuery ? '可以' : '不承诺'} | ${mdCell(source.nextAction)} |`,
  ).join('\n');
  const sourceRegisterRows = orderedResults.length
    ? orderedResults.map((item, index) =>
      `| ${index + 1} | ${mdCell(item.sourceName)} | ${mdCell(query)} | ${mdCell(item.title)} | ${mdCell(item.caseNumber || item.effectiveStatus)} | ${mdCell(item.court || item.publishDate)} | ${mdCell(item.url)} | ${mdCell(item.summary || '待摘录')} | 律师复核 |`,
    ).join('\n')
    : '| 1 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待摘录 | 律师复核 |';

  const report = `# ${caseName} 外部法律数据库检索

## 一、检索条件
- 检索词：${query}
- 检索类型：${type}
- 指定数据源：${sourceIds.join('；') || '自动选择已配置 API'}
- 官方网页兜底：${includeOfficialWeb ? '启用' : '未启用'}
- 类案排序：${LEGAL_CASE_SEARCH_ORDER.join(' > ')}；无法识别法院层级的结果列后。

## 二、API 查询结果
| 序号 | 数据源 | 标题 | 案号/效力 | 日期/法院 | 链接或摘要 | 复核状态 |
| --- | --- | --- | --- | --- | --- | --- |
${resultRows}

## 三、来源登记回填
| 序号 | 来源 | 检索词 | 标题 | 案号/效力 | 法院/发布日期 | 链接 | 关键摘录 | 复核状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${sourceRegisterRows}

## 四、接入状态
| 数据源 | 模式 | 状态 | 自动查询 | 下一步 |
| --- | --- | --- | --- | --- |
${statusRows}

## 五、边界
- 仅调用已配置且授权的 API/网关；未配置的数据源不承诺自动查询。
- 人民法院案例库、裁判文书网、法蝉、Alpha 默认仍按授权网页登录协作和材料导入处理。
- 所有法条效力、案例适用性和引用表述必须由律师最终复核。`;

  let kbLine = '- 知识库：未导入。律师确认来源和授权范围后，可设置 confirmedForKb=true 入库。';
  if (args.confirmedForKb === true && orderedResults.length > 0) {
    const article = legalWrite(() => createLegalArticle(orgId, userId, {
      title: `${caseName} 外部法律数据库检索`,
      content: report,
      articleType: 'research_note',
      category: 'legal_research',
      tags: [
        'legal:external-api',
        `query:${query.slice(0, 40)}`,
        ...Array.from(new Set(orderedResults.map(item => `source:${item.sourceId}`))),
      ],
      metadata: {
        articleType: 'research_note',
      },
    }));
    const chunks = await indexLegalArticle(orgId, article.id, context?.userId || userId, { signal: context?.executionSignal || legalExecutionSignal() });
    kbLine = `- 知识库：已导入（articleId=${article.id}，索引块=${chunks}）。`;
  }

  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName,
    title: `${caseName} 外部法律数据库检索`,
    content: report,
    type: type === 'case' ? 'judgment' : 'note',
    cause: textArg(args, 'caseType') || query,
  });

  return `${report}\n\n## 六、入库与案件归档\n${kbLine}\n${caseLine}`;
}

export async function companyDatabaseLookupHandler(args: Record<string, any>, context?: any): Promise<string> {
  const name = textArg(args, 'name') || textArg(args, 'companyName') || textArg(args, 'subjectName');
  if (!name) return '请提供 name 或 companyName（公司/被执行主体名称）。';

  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || `${name} 主体信息查询`;
  const sourceIds = [
    ...listArg(args, 'sourceIds'),
    ...listArg(args, 'sources'),
    ...listArg(args, 'platforms'),
  ];

  const queryType = (textArg(args, 'queryType') || 'registration') as QichachaQueryType;
  if (!Object.hasOwn(QICHACHA_QUERY_TOOLS, queryType) || (queryType !== 'registration' && sourceIds.some(id => !['qichacha', 'qcc', '企查查'].includes(id.toLowerCase())))) return encodeToolResult('该查询范围需要明确选择企查查及支持的 queryType，未发起外部查询。', { ok: false, status: 'partial' });
  const sourceErrors: string[] = [];
  let mcpSource: Awaited<ReturnType<typeof queryQichachaMcp>> = null;
  if (queryType !== 'registration') {
    try { mcpSource = await queryQichachaMcp(name, queryType, context?.dataRoutingPolicy === 'local_only'); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('[QCC_')) throw error;
      sourceErrors.push(error.message);
    }
  }
  const companies = queryType === 'registration' ? await searchCompanySources(name, sourceIds, { localOnly: context?.dataRoutingPolicy === 'local_only', sourceErrors }) : [];
  const observed = companies.length > 0 || Boolean(mcpSource);
  const complete = observed && sourceErrors.length === 0;
  const sourceOriginals = [...companies.filter(company => company.sourceText).map(company => ({ sourceName: company.sourceName, sourceTool: company.sourceTool, sourceEndpoint: company.sourceEndpoint, queriedAt: company.queriedAt, text: company.sourceText })), ...(mcpSource ? [mcpSource] : [])];
  const capabilities = listLegalSourceCapabilities()
    .filter(source => ['qichacha', 'tianyancha', 'qixinbao', 'national-enterprise-credit'].includes(source.id));

  const companyRows = companies.length
    ? companies.map((company, index) =>
      `| ${index + 1} | ${mdCell(company.sourceName)} | ${mdCell(company.name)} | ${mdCell(company.legalPerson)} | ${mdCell(company.registeredCapital)} | ${mdCell(company.status)} | ${mdCell(company.unifiedCode)} | ${mdCell(company.url)} |`,
    ).join('\n')
    : mcpSource ? '| 1 | 企查查官方 MCP | 本次请求主体见查询对象，数据见原始回执 | 未另外查询工商字段 | 未另外查询工商字段 | 未另外查询工商字段 | 待核验 | https://agent.qcc.com/ |' : '| 1 | 未命中 | 未取得可核验主体来源；不能据此认定主体不存在 | 待补充 | 待补充 | 待补充 | 待补充 | 使用授权网页登录协作 |';

  const statusRows = capabilities.map(source =>
    `| ${mdCell(source.label)} | ${source.accessMode} | ${source.configured ? '已配置（以本次回执为准）' : '未配置或网页登录'} | ${source.canAutoQuery ? '可以' : '不承诺'} | ${mdCell(source.nextAction)} |`,
  ).join('\n');
  const sourceRegisterRows = companies.length
    ? companies.map((company, index) =>
      `| ${index + 1} | ${mdCell(company.sourceName)} | ${mdCell(company.name)} | ${mdCell(company.unifiedCode)} | ${mdCell(company.legalPerson)} | ${mdCell(company.status)} | ${mdCell(company.url)} | 股东、涉诉、被执行和限制高消费信息待律师继续核验 | 律师复核 |`,
    ).join('\n')
    : mcpSource ? `| 1 | ${mdCell(mcpSource.sourceName)} | 请求主体：${mdCell(name)} | 本次未另查工商字段 | 本次未另查工商字段 | 本次未另查工商字段 | ${mdCell(mcpSource.sourceEndpoint)} | ${mdCell(queryType)}原始回执，身份与适用范围待核验 | 律师复核 |` : '| 1 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 授权网页核验后回填 | 律师复核 |';

  const report = `# ${caseName} 企业/被执行主体数据库查询

## 一、查询对象
- 主体名称：${name}
- 本次查询范围：${queryType}
- 指定数据源：${sourceIds.join('；') || '企查查、天眼查优先，官方网页兜底'}

## 二、API 查询结果
| 序号 | 数据源 | 主体名称 | 法定代表人 | 注册资本 | 状态 | 统一社会信用代码 | 来源链接 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${companyRows}

## 三、主体信息来源登记
| 序号 | 来源 | 主体名称 | 统一社会信用代码 | 法定代表人 | 状态 | 链接 | 后续核验 | 复核状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${sourceRegisterRows}

${sourceOriginals.map(source => '### 官方 MCP 原始回执（数据，尚待律师核验）\n- 来源：' + source.sourceName + '\n- 工具：' + source.sourceTool + '\n- 端点：' + source.sourceEndpoint + '\n- 查询时间：' + source.queriedAt + '\n\n' + source.text).join('\n\n')}

## 四、接入状态
| 数据源 | 模式 | 状态 | 自动查询 | 下一步 |
| --- | --- | --- | --- | --- |
${statusRows}

${sourceErrors.length ? '### 本次查询异常\n' + sourceErrors.map(message => '- ' + message).join('\n') : ''}

## 五、下一步
- 若 API 未命中或未配置，请使用 qichacha、tianyancha、qixinbao 或 national-enterprise-credit 登录预设打开网页核验。
- 律师确认股东、涉诉、被执行、失信和限制高消费信息后，再用 材料入库 导入组织知识库。
- Lumi 不绕过验证码、付费墙、账号权限、平台频控或下载限制。`;

  let kbLine = '- 知识库：未导入。律师确认来源和使用权限后，可设置 confirmedForKb=true 入库。';
  if (args.confirmedForKb === true && complete) {
    const article = legalWrite(() => createLegalArticle(orgId, userId, {
      title: `${caseName} 企业主体信息`,
      content: report,
      articleType: 'company_report',
      category: 'legal_company_report',
      tags: [
        'legal:company-api',
        `company:${name}`,
        ...Array.from(new Set(companies.map(company => `source:${company.sourceName || 'company-api'}`))),
      ],
      metadata: {
        articleType: 'company_report',
      },
    }));
    const chunks = await indexLegalArticle(orgId, article.id, context?.userId || userId, { signal: context?.executionSignal || legalExecutionSignal() });
    kbLine = `- 知识库：已导入（articleId=${article.id}，索引块=${chunks}）。`;
  }

  const caseLine = archiveLegalReportToCase(complete ? args : { ...args, persistCase: false }, {
    orgId,
    userId,
    caseName,
    title: `${caseName} 企业/被执行主体数据库查询`,
    content: report,
    type: 'evidence',
    cause: textArg(args, 'caseType') || '主体信息核验',
  });

  return encodeToolResult(`${report}\n\n## 六、入库与案件归档\n${kbLine}\n${caseLine}`, { ok: complete, status: complete ? 'observed' : 'partial',
    sourceResults: sourceOriginals.map(({ text, ...source }) => ({ ...source, subject: name, queryType, status: 'observed', sourceTextSha256: createHash('sha256').update(text).digest('hex') })),
  });
}

export async function searchTenderProjectsHandler(args: Record<string, any>, context?: any): Promise<string> {
  const keyword = textArg(args, 'keyword') || textArg(args, 'name') || textArg(args, 'companyName') || textArg(args, 'subjectName');
  if (!keyword) return '请提供 keyword（企业、项目、采购人或供应商名称）。';

  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || `${keyword} 招投标与应收款线索`;
  const sourceIds = [
    ...listArg(args, 'sourceIds'),
    ...listArg(args, 'sources'),
    ...listArg(args, 'platforms'),
  ];
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
  const projects = await searchTenderSources({ keyword, sourceIds, limit });
  const capabilities = listLegalSourceCapabilities()
    .filter(source => ['tender-data', 'national-public-resources', 'movable-financing-register'].includes(source.id));
  const projectRows = projects.length
    ? projects.map((project, index) =>
      `| ${index + 1} | ${mdCell(project.sourceName)} | ${mdCell(project.title)} | ${mdCell(project.projectNumber)} | ${mdCell(project.purchaser)} | ${mdCell(project.bidder)} | ${mdCell(project.amount)} | ${mdCell(project.publishDate)} | ${mdCell(project.status)} | ${mdCell(project.url)} | 律师复核 |`,
    ).join('\n')
    : '| 1 | 未配置或未命中 | 待官网核验 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | https://data.ggzy.gov.cn/ | 律师复核 |';
  const statusRows = capabilities.map(source =>
    `| ${mdCell(source.label)} | ${source.accessMode} | ${source.configured ? '已配置/官网可用' : 'API 未配置'} | ${source.canAutoQuery ? '可以' : '需网页登录或人工确认'} | ${mdCell(source.nextAction)} |`,
  ).join('\n');

  const report = `# ${caseName}

## 一、检索条件
- 关键词：${keyword}
- 返回上限：${limit}
- 指定数据源：${sourceIds.join('；') || '招投标授权数据网关；未配置时转全国公共资源交易平台'}

## 二、项目与应收款线索登记
| 序号 | 来源 | 项目/公告 | 项目编号 | 采购人/招标人 | 中标人/供应商 | 金额 | 发布日期 | 状态 | 原文链接 | 复核状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${projectRows}

## 三、接入状态
| 数据源 | 模式 | 状态 | 自动查询 | 下一步 |
| --- | --- | --- | --- | --- |
${statusRows}

## 四、未配置 API 时的真实核验动作
1. 打开全国公共资源交易平台官网，由律师检索关键词“${keyword}”。
2. 回填公告原文、项目编号、采购人、中标人、金额、公告日期、履约状态和原文链接。
3. 对可能的应收账款，继续核验合同、验收、结算、开票、付款节点和质押/保理登记；必要时申请法院调查令。
4. 仅凭中标公告不能认定债权真实存在、已到期或尚未支付，结论必须由律师结合证据复核。

## 五、数据边界
- 未填写 TENDER_DATA_API_KEY 与 TENDER_DATA_BASE_URL 时，不会发起第三方数据 API 请求，也不会生成模拟项目。
- Lumi 不绕过验证码、登录、付费墙、频控或下载限制。`;

  const caseLine = archiveLegalReportToCase(projects.length ? args : { ...args, persistCase: false }, {
    orgId,
    userId,
    caseName,
    title: `${caseName} 招投标与应收款线索查询`,
    content: report,
    type: 'evidence',
    cause: textArg(args, 'caseType') || '执行财产线索调查',
  });
  return encodeToolResult(`${report}\n\n## 六、案件空间归档\n${caseLine}`, { ok: projects.length > 0, status: projects.length ? 'observed' : 'partial' });
}
