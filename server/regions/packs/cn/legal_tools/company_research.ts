import { searchCompany, searchEnforcementRecords, type ExternalLegalSearchKind, searchLegalAuthorityDatabase, listLegalSourceCapabilities, searchCompanySources } from "../../../../legal/sources";
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
  const company = await searchCompany(subjectName);
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
    lines.push(`- 被执行记录: ${company.riskInfo.enforcementCount} 条`);
    lines.push(`- 失信记录: ${company.riskInfo.dishonestyCount} 条`);
    lines.push(`- 限制消费: ${company.riskInfo.restrictionsCount} 条`);
    lines.push(`- 查询来源: ${company.sourceName || '企业信息数据源'} ${company.queriedAt ? `(${company.queriedAt.slice(0, 10)})` : ''}`);
  } else {
    lines.push('## 企业基本信息');
    lines.push('- 未通过已配置 API 查询到企业信息，或尚未配置企查查官方 API 凭证。');
    lines.push('- 可执行：web_login_profile_save_from_preset {"presetId":"qichacha"}');
    lines.push('- 然后执行：web_login_run {"profileId":"qichacha","headless":false}');
    lines.push('- 律师在授权网页内确认企业信息、股东信息、涉诉/被执行信息后，使用 legal_import_materials_to_kb 导入知识库。');
  }

  // 2. Enforcement records
  const enforcements = await searchEnforcementRecords(subjectName);
  if (enforcements.length > 0) {
    lines.push('\n## 公开执行记录');
    for (const e of enforcements) {
      lines.push(`- [${e.caseNumber}] ${e.court} | 立案: ${e.filingDate} | 执行标的: ${e.executionTarget} | ${e.status}`);
    }
  }

  lines.push('\n## 财产线索分析');
  lines.push('1. **银行账户**: 建议通过法院执行系统查询被执行人银行开户信息');
  lines.push('2. **不动产**: 建议查询被执行人及其配偶名下不动产登记信息');
  lines.push('3. **车辆**: 建议通过车管所查询被执行人名下机动车辆');
  lines.push('4. **股权**: 通过股权穿透分析关联企业（见legal_equity_penetration工具）');
  lines.push('5. **婚姻状况**: 建议查询被执行人婚姻登记信息，判断是否涉及夫妻共同财产');
  lines.push('6. **知识产权**: 建议查询被执行人名下专利、商标、著作权');
  lines.push(`\n*数据来源: ${company?.sourceName || '授权网页登录协作/待人工确认'} | 全国法院被执行人信息(zhixing.court.gov.cn) | ${new Date().toISOString().slice(0, 10)}*`);

  const report = lines.join('\n');
  return appendLegalWorkProductArchiveSection(report, args, context, {
    caseName,
    title: `${subjectName}财产线索报告`,
    type: 'evidence',
    cause: textArg(args, 'caseType') || '执行/财产保全线索',
  });
}

// ── legal_equity_penetration ─────────────────────────────────────────────

export async function equityPenetrationHandler(args: Record<string, any>, context?: any): Promise<string> {
  const companyName = args.name as string;
  if (!companyName) return '请提供公司名称（name参数）';
  const caseName = textArg(args, 'caseName') || `${companyName}股权穿透`;

  const company = await searchCompany(companyName);
  if (!company) {
    const report = `未通过已配置 API 查询到"${companyName}"的企业信息，或尚未配置企查查官方 API 凭证。

可执行以下授权网页登录协作：
1. web_login_profile_save_from_preset {"presetId":"qichacha"}
2. web_login_run {"profileId":"qichacha","headless":false}
3. 律师在网页内确认股东、对外投资、风险信息后，使用 legal_import_materials_to_kb 导入 Lumi 知识库。

边界：这不是平台数据接入；不自动抓取、不批量同步、不绕过验证码、付费墙、账号权限或频控。`;
    return appendLegalWorkProductArchiveSection(report, args, context, {
      caseName,
      title: `${companyName}股权穿透协作报告`,
      type: 'evidence',
      cause: textArg(args, 'caseType') || '主体/股权穿透',
    });
  }

  const lines: string[] = [`# ${companyName} 股权穿透分析\n`];
  lines.push('## 第一层：直接股东');
  for (const s of company.shareholders) {
    lines.push(`- ${s.name}: 持股 ${s.ratio}% (${s.type})`);
  }

  // Recursively trace each shareholder (max 3 levels)
  for (const s of company.shareholders.slice(0, 5)) {
    const subCompany = await searchCompany(s.name);
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

  const report = lines.join('\n');
  return appendLegalWorkProductArchiveSection(report, args, context, {
    caseName,
    title: `${companyName}股权穿透分析报告`,
    type: 'evidence',
    cause: textArg(args, 'caseType') || '主体/股权穿透',
  });
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
    `| ${mdCell(source.label)} | ${source.accessMode} | ${source.configured ? '已配置/可用' : '未配置或网页登录'} | ${source.canAutoQuery ? '可以' : '不承诺'} | ${mdCell(source.nextAction)} |`,
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

  const companies = await searchCompanySources(name, sourceIds);
  const capabilities = listLegalSourceCapabilities()
    .filter(source => ['qichacha', 'tianyancha', 'national-enterprise-credit'].includes(source.id));

  const companyRows = companies.length
    ? companies.map((company, index) =>
      `| ${index + 1} | ${mdCell(company.sourceName)} | ${mdCell(company.name)} | ${mdCell(company.legalPerson)} | ${mdCell(company.registeredCapital)} | ${mdCell(company.status)} | ${mdCell(company.unifiedCode)} | ${mdCell(company.url)} |`,
    ).join('\n')
    : '| 1 | 未命中 | 未通过已配置 API 查询到主体信息 | 待补充 | 待补充 | 待补充 | 待补充 | 使用授权网页登录协作 |';

  const statusRows = capabilities.map(source =>
    `| ${mdCell(source.label)} | ${source.accessMode} | ${source.configured ? '已配置/可用' : '未配置或网页登录'} | ${source.canAutoQuery ? '可以' : '不承诺'} | ${mdCell(source.nextAction)} |`,
  ).join('\n');
  const sourceRegisterRows = companies.length
    ? companies.map((company, index) =>
      `| ${index + 1} | ${mdCell(company.sourceName)} | ${mdCell(company.name)} | ${mdCell(company.unifiedCode)} | ${mdCell(company.legalPerson)} | ${mdCell(company.status)} | ${mdCell(company.url)} | 股东、涉诉、被执行和限制高消费信息待律师继续核验 | 律师复核 |`,
    ).join('\n')
    : '| 1 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 授权网页核验后回填 | 律师复核 |';

  const report = `# ${caseName} 企业/被执行主体数据库查询

## 一、查询对象
- 主体名称：${name}
- 指定数据源：${sourceIds.join('；') || '企查查、天眼查优先，官方网页兜底'}

## 二、API 查询结果
| 序号 | 数据源 | 主体名称 | 法定代表人 | 注册资本 | 状态 | 统一社会信用代码 | 来源链接 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${companyRows}

## 三、主体信息来源登记
| 序号 | 来源 | 主体名称 | 统一社会信用代码 | 法定代表人 | 状态 | 链接 | 后续核验 | 复核状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${sourceRegisterRows}

## 四、接入状态
| 数据源 | 模式 | 状态 | 自动查询 | 下一步 |
| --- | --- | --- | --- | --- |
${statusRows}

## 五、下一步
- 若 API 未命中或未配置，请使用 web_login_profile_save_from_preset {"presetId":"qichacha"} 或 {"presetId":"national-enterprise-credit"} 打开授权网页核验。
- 律师确认股东、涉诉、被执行、失信和限制高消费信息后，再用 legal_import_materials_to_kb 导入组织知识库。
- Lumi 不绕过验证码、付费墙、账号权限、平台频控或下载限制。`;

  let kbLine = '- 知识库：未导入。律师确认来源和使用权限后，可设置 confirmedForKb=true 入库。';
  if (args.confirmedForKb === true && companies.length > 0) {
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

  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName,
    title: `${caseName} 企业/被执行主体数据库查询`,
    content: report,
    type: 'evidence',
    cause: textArg(args, 'caseType') || '主体信息核验',
  });

  return `${report}\n\n## 六、入库与案件归档\n${kbLine}\n${caseLine}`;
}
