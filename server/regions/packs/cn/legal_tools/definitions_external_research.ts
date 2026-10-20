import type { ToolDefinition } from '../../../../tools/types';
import { searchExternalAuthoritiesHandler, companyDatabaseLookupHandler, searchTenderProjectsHandler } from "./company_research";
import { externalResearchPlanHandler, prepareExternalBrowserWorkspaceHandler } from "./external_workspace";
import { withLegalReceipt, legalCapability, legalEvidence, legalInputBlocked } from "./tool_contracts";
import { generateCitationVerificationReportHandler, finalizeDeliveryPackageHandler, verifyArchivedDeliveryHandler } from "./delivery";
import { LEGAL_TEMPORAL_FIELDS, defineLegalTool, stringField, numberField, booleanField, stringListField, CASE_ARCHIVE_FIELDS } from "./tool_contracts";

export function external_researchTools(): ToolDefinition[] {
  return [
defineLegalTool({
name: 'legal_verify_archived_delivery',
description: '已归档文书交付核验 — 只读取指定案件和已归档草稿，逐项核对案件事实来源、法条/类案引用、时效期限、管辖、文件状态和律师复核边界；输出通过、阻断、待确认及正式交付结论，不重新生成、发送、提交或签署文书。',
properties: {
caseId: stringField('已有案件工作台 ID'),
caseName: stringField('案件名称；未提供 caseId 时按名称查找'),
materialTitle: stringField('要核验的已归档草稿或文书名称'),
documentTitle: stringField('materialTitle 的别名'),
orgId: stringField('组织 ID，默认使用当前工作域'),
userId: stringField('操作用户 ID，默认使用当前用户'),
},
handler: withLegalReceipt(verifyArchivedDeliveryHandler, { status: 'verified' }),
capability: legalCapability({
      id: 'legal.archived-delivery.verify', operation: 'observe', risk: 'low', successStatuses: ['verified'],
      sideEffects: [{ type: 'local_read', scope: 'organization legal case and archived work product', reversible: true }],
      limitations: ['This assessment does not create a formal package and never replaces lawyer review, filing, signing, sending, payment, or service confirmation.'],
    }),
evidence: legalEvidence('legal.archived-delivery.verify', 'observe', 'caseId')
}),
defineLegalTool({
name: 'legal_search_tender_projects',
description: '招投标与应收款线索查询 — 调用律所已配置的招投标数据网关；未配置 API 时生成全国公共资源交易平台核验动作、来源登记和证据缺口，不生成模拟项目。',
properties: {
keyword: stringField('企业、项目、采购人、招标人或供应商名称'),
name: stringField('keyword 的别名'),
companyName: stringField('keyword 的别名'),
subjectName: stringField('keyword 的别名'),
sourceIds: stringListField('指定数据源；当前 API 源为 tender-data'),
sources: stringListField('sourceIds 的别名'),
platforms: stringListField('sourceIds 的别名'),
limit: numberField('返回数量上限，默认 10，最高 50'),
caseId: stringField('已有案件工作台 ID；提供后归档查询报告'),
caseName: stringField('关联案件名称或简称'),
caseType: stringField('案由或案件类型'),
persistCase: booleanField('是否归档到案件空间；设置 false 可关闭'),
orgId: stringField('组织 ID'),
userId: stringField('操作用户 ID'),
},
required: ['keyword'],
handler: withLegalReceipt(searchTenderProjectsHandler, { status: 'observed', expectCaseMutation: 'when_requested' }),
capability: legalCapability({
  id: 'legal.tender-projects.search', operation: 'observe', risk: 'medium', successStatuses: ['observed'],
  sideEffects: [{ type: 'network_read', scope: 'authorized configured tender gateway', reversible: true },
    { type: 'local_state_change', scope: 'optional observed tender report in the selected legal case', reversible: true }],
  limitations: ['An empty or unavailable source remains partial and is not archived as a successful search. A tender announcement does not prove a due unpaid receivable.'],
}),
evidence: legalEvidence('legal.tender-projects.search', 'observe', 'keyword')
}),
  defineLegalTool({
    name: 'legal_search_external_authorities',
    description: '外部法律数据库 API 检索 — 调用已配置授权网关（如北大法宝、通义法睿）检索法规、法条、案例和裁判规则；未配置时明确降级到授权网页登录协作，不抓取平台数据库。',
    properties: {
      ...CASE_ARCHIVE_FIELDS,
      query: stringField('检索词、争议焦点、案由、法条名称或案件事实摘要'),
      type: stringField('检索类型：law/case/mixed，或中文“法规/案例/综合”'),
      kind: stringField('type 的别名'),
      sourceIds: stringListField('指定数据源，如 pkulaw、farui、national-law-regulations'),
      sources: stringListField('sourceIds 的别名'),
      platforms: stringListField('sourceIds 的别名'),
      includeOfficialWeb: booleanField('是否同时尝试国家法律法规数据库公开网页检索，默认 false'),
      limit: numberField('返回结果数量上限，默认 5，最高 20'),
      confirmedForKb: booleanField('律师确认来源和授权后设为 true，可将检索报告导入组织知识库'),
    },
    required: ['query'],
    handler: searchExternalAuthoritiesHandler,
  }),
  defineLegalTool({
    name: 'legal_company_database_lookup',
    description: '企业主体数据库查询 — 企查查单 Key 使用官方 MCP，默认仅工商；queryType 可指定一项股东、实控人或风险查询，每次只调用对应工具。天眼查沿授权 API；未配置或失败保留待核验。',
    properties: {
      ...CASE_ARCHIVE_FIELDS,
      name: stringField('公司、被执行人或主体名称'),
      companyName: stringField('name 的别名'),
      subjectName: stringField('name 的别名'),
queryType: { ...stringField('企查查本次明确查询范围；默认registration，不自动加查其他范围'), enum: ['registration', 'shareholders', 'controller', 'risk', 'enforcement', 'dishonesty', 'restrictions'] },
      sourceIds: stringListField('指定数据源，如 qichacha、tianyancha'),
      sources: stringListField('sourceIds 的别名'),
      platforms: stringListField('sourceIds 的别名'),
      confirmedForKb: booleanField('律师确认来源和授权后设为 true，可将报告导入组织知识库'),
    },
    required: ['name'],
    handler: companyDatabaseLookupHandler,
  }),
  defineLegalTool({
    name: 'legal_external_research_plan',
    description: '半自动外部检索行动单 — 生成法条、人民法院案例库、裁判文书网、法蝉、Alpha、企查查、国家企业信用、法院在线服务的检索顺序、网页登录预设和来源登记表。',
    properties: {
      ...CASE_ARCHIVE_FIELDS,
      facts: stringField('案件事实摘要'),
      issues: stringListField('争议焦点列表'),
      companyNames: stringListField('需要查询的公司或被执行人名称'),
    },
    handler: externalResearchPlanHandler,
  }),
  defineLegalTool({
    name: 'legal_generate_citation_verification_report',
    description: '引用核验报告 — 对文书全文或文件中的法条、案号引用生成可落盘的核验报告，统计现行有效、已废止、未确认存在的风险项，并可导入组织知识库。',
    properties: {
      ...LEGAL_TEMPORAL_FIELDS,
      text: stringField('需要核验的文书全文、代理词、法律意见或合同审查结果'),
      content: stringField('text 的别名'),
      filePath: stringField('需要核验的本地文件路径，支持 PDF/DOCX/TXT/MD 等法律材料格式'),
      caseName: stringField('案件名称或简称'),
      title: stringField('报告标题或来源材料标题'),
      outputDir: stringField('可选输出目录；默认写入 data/legal_delivery/{orgId}'),
      importToKb: booleanField('律师确认后是否导入组织知识库，默认 false'),
      confirmedForKb: booleanField('importToKb 的确认别名'),
      orgId: stringField('组织 ID，默认上下文 orgId 或 default'),
      userId: stringField('操作用户 ID，默认上下文 userId 或 system'),
    },
    handler: withLegalReceipt(generateCitationVerificationReportHandler, {
      status: 'generated',
      requireArtifacts: true,
    }),
    capability: legalCapability({
      id: 'legal.citation-verification-report.generate', operation: 'create', risk: 'medium', successStatuses: ['generated'], requireArtifacts: true,
      sideEffects: [
        { type: 'local_state_change', scope: 'optional legal knowledge-base verification report', reversible: true },
        { type: 'local_write', scope: 'citation verification report file', reversible: true },
        { type: 'local_read', scope: 'optional source legal document', reversible: true },
      ],
    }),
    evidence: legalEvidence('legal.citation-verification-report.generate', 'create', 'filePath'),
  }),
  defineLegalTool({
    name: 'legal_finalize_delivery_package',
    description: '正式文书交付包 — 将代理词、起诉状、答辩状、法律意见书、证据目录等草稿整理为律所交付包，生成正式 Markdown、DOCX、引用核验报告、来源登记表和提交签署清单。不会自动签发、提交、缴费或送达。',
    properties: {
      ...LEGAL_TEMPORAL_FIELDS,
      content: stringField('需要整理成正式交付包的文书草稿或工作底稿'),
      packetText: stringField('content 的别名，用于诉讼文书包结果'),
      documentText: stringField('content 的别名，用于单份文书结果'),
      reasoningMatrix: stringField('legal_case_reasoning_matrix 生成的大前提/小前提/涵摄结论底稿；正式交付前建议提供'),
      reasoningSummary: stringField('三段论推理摘要：现行法/类案、事实证据、涵摄结论'),
      legalReasoning: stringField('reasoningMatrix 的别名，用于传入可复核的法律推理链'),
      caseId: stringField('已有案件工作台 ID；提供后会把交付包或阻断记录归档到该案件空间'),
      caseName: stringField('案件名称或简称'),
      documentType: stringField('文书类型：起诉状/答辩状/质证意见/代理词/法律意见书/证据目录/合同文本/投标书等'),
      role: stringField('我方身份'),
      caseType: stringField('案由或案件类型'),
      court: stringField('拟提交或使用法院'),
      lawFirmName: stringField('律所名称，未提供时使用占位符'),
      lawyerName: stringField('承办律师，未提供时使用占位符'),
      outputDir: stringField('可选输出目录；默认写入 data/legal_delivery/{orgId}'),
      includeDocx: booleanField('是否生成 DOCX，默认 true'),
      includePdf: booleanField('是否尝试用 Microsoft Word 转 PDF，默认 false'),
      markDraft: booleanField('是否标记为律师复核稿，默认 true'),
      orgId: stringField('组织 ID，默认上下文 orgId 或 default'),
      userId: stringField('操作用户 ID，默认上下文 userId 或 system'),
    },
    handler: withLegalReceipt(finalizeDeliveryPackageHandler, {
      status: 'generated',
      expectCaseMutation: 'when_case_id',
      requireArtifacts: true,
      classify: content => legalInputBlocked(content)
        ? { ok: false, status: 'blocked' }
        : /正式交付包未生成/.test(content)
          ? { ok: false, status: 'blocked' }
          : { ok: true, status: 'generated' },
    }),
    capability: legalCapability({
      id: 'legal.delivery-package.finalize', operation: 'create', risk: 'medium', successStatuses: ['generated'], requireArtifacts: true,
      sideEffects: [
        { type: 'local_state_change', scope: 'optional legal case delivery archive or gate-block record', reversible: true },
        { type: 'local_write', scope: 'formal-review legal package, verification, source, and checklist files', reversible: true },
        { type: 'process_execution', scope: 'optional Microsoft Word PDF conversion', reversible: true },
      ],
      limitations: ['A generated package remains a lawyer-review draft and is never automatically filed, signed, sent, paid, or served.'],
    }),
    evidence: legalEvidence('legal.delivery-package.finalize', 'create', 'outputDir'),
  }),
  defineLegalTool({
    name: 'legal_prepare_external_browser_workspace',
    description: '外部网页登录工作区 — 为人民法院案例库、裁判文书网、法蝉、Alpha、企查查、国家企业信用、法院在线服务等生成可见浏览器登录命令、检索词、来源登记表和授权边界说明。',
    properties: {
      caseName: stringField('案件名称或简称'),
      caseType: stringField('案由或案件类型'),
      facts: stringField('案件事实摘要'),
      issues: stringListField('争议焦点列表'),
      queries: stringListField('额外检索词'),
      companyNames: stringListField('需要查询的公司或被执行人名称'),
      sourceIds: stringListField('指定数据源/preset，如 people-court-case-library、china-judgments-online、fachan、alpha-lawyer、qichacha、national-enterprise-credit、court-online-service'),
      sources: stringListField('sourceIds 的别名'),
      platforms: stringListField('sourceIds 的别名'),
      action: stringField('检索目的：类案检索/立案/企业查询/合同审查等'),
      outputDir: stringField('可选输出目录；默认写入 data/legal_external_workspaces/{orgId}'),
      orgId: stringField('组织 ID，默认上下文 orgId 或 default'),
    },
    handler: withLegalReceipt(prepareExternalBrowserWorkspaceHandler, {
      status: 'prepared',
      requireArtifacts: true,
    }),
    capability: legalCapability({
      id: 'legal.external-browser-workspace.prepare', operation: 'create', risk: 'medium', successStatuses: ['prepared'], requireArtifacts: true,
      sideEffects: [
        { type: 'local_state_change', scope: 'local legal browser-workspace runbook state', reversible: true },
        { type: 'local_write', scope: 'browser runbook, source register, and login command files', reversible: true },
      ],
      limitations: ['Prepares commands and records only; it does not log in, bypass verification, scrape, or download.'],
    }),
    evidence: legalEvidence('legal.external-browser-workspace.prepare', 'create', 'outputDir'),
  })
  ];
}
