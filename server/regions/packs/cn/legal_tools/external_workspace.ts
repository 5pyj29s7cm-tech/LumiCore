import { listLegalSourceCapabilities } from "../../../../legal/sources";
import path from "path";
import { legalWrite } from "../../../../legal/execution";
import fs from "fs";
import { legalWorkspaceId, textArg, listArg, buildSearchQueries, EXTERNAL_LEGAL_SOURCES, resolveWritableOutputDir, ensureLegalExternalWorkspaceRoot } from "./context";
import { archiveLegalReportToCase } from "./case_workflow";

export async function externalSourceStatusHandler(): Promise<string> {
  const rows = listLegalSourceCapabilities().map(source =>
    `| ${source.label} | ${source.accessMode} | ${source.configured ? '已配置/可用' : '未配置或网页登录'} | ${source.canAutoQuery ? '可以' : '不承诺'} | ${source.boundary} | ${source.nextAction} |`,
  ).join('\n');

  return `# 外部法律数据源接入状态

| 数据源 | 当前模式 | 状态 | 自动查询 | 边界 | 下一步 |
| --- | --- | --- | --- | --- | --- |
${rows}

## 统一口径
- 只有配置官方 API 凭证并受合同授权的数据源，才称为“平台数据接入”。
- 其他站点按“授权网页登录协作”处理：Lumi 可打开页面、组织检索词、辅助登记来源，但不绕过验证码、付费墙、账号权限、频控或下载限制。
- 律师确认后的网页摘录、下载文件和本地材料，可以用 legal_import_materials_to_kb 导入组织知识库。`;
}

// ── legal_external_research_plan ────────────────────────────────────────

export async function externalResearchPlanHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || '半自动外部检索行动单';
  const facts = textArg(args, 'facts');
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const issues = listArg(args, 'issues');
  const companyNames = listArg(args, 'companyNames');
  const queries = buildSearchQueries({ ...args, caseType, facts, issues });
  const courtLevels = ['最高人民法院', '高级人民法院', '中级人民法院', '基层人民法院'];
  const sourceCapabilities = listLegalSourceCapabilities();
  const loginActions = EXTERNAL_LEGAL_SOURCES
    .filter(source => source.presetId)
    .map(source => `- ${source.label} (${source.presetId})
  1. web_login_profile_save_from_preset {"presetId":"${source.presetId}"}
  2. web_login_run {"profileId":"${source.presetId}","headless":false}
  3. 律师在网页内检索、筛选、摘录，并回填来源登记表。`)
    .join('\n');

  const report = `# ${caseName}

## 一、检索边界
- Lumi 不复制第三方平台数据，不绕过验证码、付费墙、账号权限或频控。
- 只有已配置官方 API 凭证并受合同授权的数据源，才称为“平台数据接入”；未配置 API 的数据源按授权网页登录协作处理。
- 使用 web_login_profile_save_from_preset 保存授权站点，再用 web_login_run 打开真实浏览器。
- 律师在网页内确认检索结果后，将标题、链接、案号、法院、裁判日期、关键摘录和使用理由登记回案件；确认后的文件或摘录可由 legal_import_materials_to_kb 自动导入知识库。

## 数据源接入状态
${sourceCapabilities.map(source => `- ${source.label}: ${source.accessMode} / ${source.configured ? '已配置或官网可用' : '未配置 API'} / ${source.canAutoQuery ? '可自动查询' : '网页登录或人工确认'}`).join('\n')}

## 二、案件线索
- 案由/类型：${caseType}
- 争议焦点：${issues.join('；') || '待补充'}
- 事实摘要：${facts || '待补充'}
- 企业/被执行人：${companyNames.join('；') || '待补充'}

## 三、推荐检索顺序
1. 国家法律法规数据库：先核验法律依据是否现行有效。
2. 人民法院案例库：优先查权威案例和裁判规则。
3. 中国裁判文书网：按法院层级筛选，顺序为 ${courtLevels.join(' > ')}。
4. 法蝉 / Alpha：使用律所授权账号补充商业库资料。
5. 企查查 / 国家企业信用信息公示系统：核验公司和被执行人情况。
6. 人民法院在线服务：仅用于半自动立案材料核对和人工提交。

## 四、网页登录动作
${loginActions}

## 五、站点打开清单
${EXTERNAL_LEGAL_SOURCES.map(source => {
  const preset = source.presetId ? `presetId: ${source.presetId}` : '无需登录预设或使用通用网页登录';
  return `- ${source.label}（${preset}）：${source.use}\n  ${source.url}`;
}).join('\n')}

## 六、检索词
${queries.map((q, index) => `${index + 1}. ${q}`).join('\n')}

## 七、来源登记表字段
| 来源 | 检索词 | 标题/案号 | 法院层级 | 裁判日期/发布日期 | 链接 | 关键摘录 | 对我方有利点 | 不利/区分点 | 复核人 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 |
`;
  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName,
    title: `${caseName} 外部检索行动单`,
    content: report,
    type: 'note',
    cause: caseType,
  });
  return `${report}\n## 八、案件空间归档\n${caseLine}`;
}

// ── legal_prepare_external_browser_workspace ────────────────────────────

function pickExternalLegalSources(args: Record<string, any>): typeof EXTERNAL_LEGAL_SOURCES {
  const rawSources = [
    ...listArg(args, 'sourceIds'),
    ...listArg(args, 'sources'),
    ...listArg(args, 'platforms'),
  ].map(item => item.toLowerCase());
  const action = `${textArg(args, 'action')} ${textArg(args, 'purpose')} ${textArg(args, 'caseType')}`;
  let selected = EXTERNAL_LEGAL_SOURCES.filter(source => {
    const haystack = `${source.label} ${source.presetId} ${source.url}`.toLowerCase();
    return rawSources.length > 0 && rawSources.some(item => haystack.includes(item));
  });

  if (selected.length === 0) {
    selected = EXTERNAL_LEGAL_SOURCES.filter(source =>
      ['people-court-case-library', 'china-judgments-online', 'fachan', 'alpha-lawyer'].includes(source.presetId),
    );
  }
  if (/公司|企业|被执行|股权|工商|企查查|信用/i.test(action) || listArg(args, 'companyNames').length > 0) {
    for (const source of EXTERNAL_LEGAL_SOURCES.filter(item => ['qichacha', 'national-enterprise-credit'].includes(item.presetId))) {
      if (!selected.includes(source)) selected.push(source);
    }
  }
  if (/立案|法院在线|提交|filing/i.test(action)) {
    const filing = EXTERNAL_LEGAL_SOURCES.find(item => item.presetId === 'court-online-service');
    if (filing && !selected.includes(filing)) selected.push(filing);
  }
  return selected;
}

export async function prepareExternalBrowserWorkspaceHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = legalWorkspaceId(args, context);
  const caseName = textArg(args, 'caseName') || '外部检索';
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const issues = listArg(args, 'issues');
  const facts = textArg(args, 'facts');
  const companyNames = listArg(args, 'companyNames');
  const selectedSources = pickExternalLegalSources(args);
  const queries = [
    ...listArg(args, 'queries'),
    ...buildSearchQueries({ ...args, caseType, facts, issues }),
  ].filter((item, index, arr) => item && arr.indexOf(item) === index).slice(0, 18);
  const outputDir = resolveWritableOutputDir(
    textArg(args, 'outputDir'),
    ensureLegalExternalWorkspaceRoot(orgId),
    caseName,
    'browser_workspace',
  );

  const commands = selectedSources
    .filter(source => source.presetId)
    .map(source => [
      `# ${source.label}`,
      `web_login_profile_save_from_preset {"presetId":"${source.presetId}"}`,
      `web_login_run {"profileId":"${source.presetId}","headless":false}`,
    ].join('\n'))
    .join('\n\n');
  const runbook = [
    `# ${caseName} 外部网页登录工作区`,
    '',
    `- 案由/类型：${caseType}`,
    `- 争议焦点：${issues.join('；') || '待补充'}`,
    `- 企业/被执行人：${companyNames.join('；') || '待补充'}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## 工作边界',
    '- 当前是“授权网页登录协作”，不是平台数据库接入。',
    '- Lumi 可打开可见浏览器、复用授权会话、整理检索词和来源登记表。',
    '- Lumi 不绕过验证码、二维码、人脸、短信验证、付费墙、账号权限、频控或下载限制。',
    '- 律师确认后的下载文件、网页摘录和来源登记，可再导入组织知识库。',
    '',
    '## 建议检索词',
    queries.map((query, index) => `${index + 1}. ${query}`).join('\n') || '1. 待补充检索词',
    '',
    '## 站点与用途',
    selectedSources.map(source => `- ${source.label}：${source.use}\n  ${source.url}`).join('\n'),
    '',
    '## 浏览器动作',
    commands || '无需登录预设；使用普通浏览器打开官网并人工确认。',
    '',
  ].join('\n');
  const sourceRegisterCsv = [
    'source,query,title_or_case_number,court_level,date,url,key_excerpt,favorable_point,unfavorable_or_distinguish,reviewer,status',
    '待登记,待登记,待登记,待登记,待登记,待登记,待登记,待登记,待登记,待登记,待复核',
  ].join('\n');
  const commandsMd = [
    '# web_login commands',
    '',
    commands || 'No preset command generated.',
    '',
    'After the lawyer confirms a source, import it with legal_import_materials_to_kb.',
    '',
  ].join('\n');

  const runbookPath = path.join(outputDir, '00_browser-workspace.md');
  const registerPath = path.join(outputDir, '01_source-register.csv');
  const commandsPath = path.join(outputDir, '02_web-login-commands.md');
  legalWrite(() => fs.writeFileSync(runbookPath, runbook, 'utf-8'));
  legalWrite(() => fs.writeFileSync(registerPath, sourceRegisterCsv, 'utf-8'));
  legalWrite(() => fs.writeFileSync(commandsPath, commandsMd, 'utf-8'));

  return [
    '# 外部网页登录工作区已生成',
    '',
    `- 案件：${caseName}`,
    `- 输出目录：${outputDir}`,
    `- 操作手册：${runbookPath}`,
    `- 来源登记表：${registerPath}`,
    `- 登录命令：${commandsPath}`,
    `- 站点数量：${selectedSources.length}`,
    '',
    '## 可执行命令',
    commands || '无网页登录预设。',
    '',
    '边界：不自动抓取、不批量同步、不绕过平台限制；登录、验证码、下载权限和最终引用均由律师确认。',
  ].join('\n');
}
