import type { ToolDefinition } from '../../../../tools/types';
import { searchCaseHandler, searchStatuteHandler } from "./knowledge";
import { withLegalReceipt, legalCapability, legalEvidence } from "./tool_contracts";
import { generateBidHandler, reviewContractHandler, draftContractHandler } from "./contracts";
import { defineLegalTool, stringField, numberField, booleanField, stringListField, CASE_ARCHIVE_FIELDS } from "./tool_contracts";

export function catalog_contractsTools(): ToolDefinition[] {
  return [
  defineLegalTool({
    name: 'legal_search_case',
    description: '类案检索 — 根据案由或事实描述在本地裁判文书库中搜索相似案例，返回案号、法院、相似度分数、摘要。数据来源：本地导入的中国裁判文书网公开文书。',
    properties: {
      query: stringField('案由或事实描述，如"民间借贷纠纷"或"开发商逾期交房"'),
      limit: numberField('返回结果数量上限，默认5'),
      orgId: stringField('组织ID'),
    },
    required: ['query'],
    handler: searchCaseHandler,
  }),
  defineLegalTool({
    name: 'legal_search_statute',
    description: '法条检索候选 — 按关键词或法条号搜索法名状态、权威网页结果及本地法条库。正式交付仅接受带权威来源和已核验条文范围的引用；未核验结果不得标记为现行有效。',
    properties: {
      query: stringField('法条名称或关键词，如"民法典合同编"或"劳动合同法"'),
      sourceIds: stringListField('可选外部授权库，如 pkulaw、farui、national-law-regulations'),
      sources: stringListField('sourceIds 的别名'),
      includeOfficialWeb: booleanField('是否同时尝试国家法律法规数据库公开网页检索，默认 false'),
      limit: numberField('外部授权库返回数量上限，默认 5'),
      orgId: stringField('组织ID'),
    },
    required: ['query'],
    handler: searchStatuteHandler,
  }),
  defineLegalTool({
name: 'legal_generate_bid',
description: '标书生成 — 按完整招标文件及用户要求生成对应商务标和技术标草稿，保留缺失的资格、业绩和附件待补项，不用固定施工合同模板替代招标要求。',
properties: {
      ...CASE_ARCHIVE_FIELDS,
password: stringField('PDF打开密码，仅用于本次读取；不得回显或保存到案件材料、记忆和日志。'),
passwords: { type: 'object', additionalProperties: { type: 'string' }, description: '可选：按文件完整路径提供各自PDF密码，仅用于本次读取。' },
requirements: stringField('招标文件中的技术要求/评分标准/合同条款要求'),
content: stringField('requirements 的别名，可粘贴招标文件正文'),
text: stringField('requirements 的别名，可粘贴招标文件正文'),
filePath: stringField('单个招标文件路径，支持 PDF/DOCX/XLSX/PPTX/RTF/TXT/MD/CSV'),
filePaths: stringListField('多个招标文件路径'),
folderPath: stringField('招标文件夹路径，会批量读取支持的文档格式'),
folderName: stringField('桌面/文档/下载目录中的招标文件夹名称或关键词'),
recursive: booleanField('读取文件夹时是否递归子目录，默认 true'),
maxFiles: numberField('文件夹读取最大文件数，默认 30，最高 100'),
maxChars: numberField('最多提取文本字数，默认 180000，最高 600000'),
projectName: stringField('项目名称'),
useModel: booleanField('是否使用配置的起草模型；false 时生成严格依据已提供要求的确定性工作底稿'),
outputDir: stringField('可选输出目录；默认写入 data/legal_delivery/{orgId} 下的独立标书工作底稿目录'),
},
handler: withLegalReceipt(generateBidHandler, {
      status: 'generated',
      expectCaseMutation: 'when_requested',
      requireArtifacts: true,
    }),
capability: legalCapability({
      id: 'legal.bid.generate', operation: 'create', risk: 'medium', successStatuses: ['generated'],
      sideEffects: [
        { type: 'local_state_change', scope: 'optional legal case work-product archive', reversible: true },
        { type: 'local_write', scope: 'reviewable bid response DOCX artifact', reversible: true },
        { type: 'local_read', scope: 'optional tender files and folders', reversible: true },
        { type: 'network_read', scope: 'configured legal drafting model', reversible: true },
      ],
      requireArtifacts: true,
    }),
evidence: legalEvidence('legal.bid.generate', 'create', 'projectName')
}),
  defineLegalTool({
name: 'legal_review_contract',
description: '合同初审 — 分段核对用户提供的合同，返回风险分析、修改建议与待确认事项；不自动检索类案或核准法条。需要完整修改稿时，以原全文和修改要求调用合同起草；法律意见书使用现有法律意见工具。',
properties: {
      ...CASE_ARCHIVE_FIELDS,
contract: stringField('待审查的合同全文'),
title: stringField('caseName 的别名'),
sourceOnly: booleanField('是否严格只依据所给原文审查；为 true 时不检索或补充类案、背景和法条'),
omitSpecificLawCitations: booleanField('是否不输出具体法条名称或条号'),
},
required: ['contract'],
handler: withLegalReceipt(reviewContractHandler, { status: 'reviewed', expectCaseMutation: 'when_requested' }),
capability: legalCapability({
      id: 'legal.contract.review', operation: 'create', risk: 'low', successStatuses: ['reviewed'],
      sideEffects: [
        { type: 'local_read', scope: 'provided contract text and optional local legal reference data', reversible: true },
        { type: 'local_state_change', scope: 'optional legal case contract-review archive', reversible: true },
        { type: 'network_read', scope: 'configured legal review model when source-only mode is not requested', reversible: true },
      ],
    }),
evidence: legalEvidence('legal.contract.review', 'create', 'contract')
}),
  defineLegalTool({
name: 'legal_draft_contract',
description: '合同起草/完整修改稿 — 根据当事人要求起草合同；修改现有合同时将原全文放入 templateText、修改要求放入 details，输出完整工作稿。不把模板目录当官方正文。',
properties: {
      ...CASE_ARCHIVE_FIELDS,
type: stringField('合同类型，例如买卖、施工、劳动、服务、法律顾问等合同'),
details: stringField('合同具体要求（项目信息、工期、价款等）'),
templateText: stringField('可选：已取得并确认来源的完整模板正文；不是模板名称或网址'),
templatePath: stringField('可选：完整模板文件路径，支持PDF/DOCX/TXT等可读文档'),
},
required: ['type'],
handler: withLegalReceipt(draftContractHandler, { status: 'generated', expectCaseMutation: 'when_requested' }),
capability: legalCapability({
      id: 'legal.contract.draft', operation: 'create', risk: 'medium', successStatuses: ['generated'],
      sideEffects: [
        { type: 'local_state_change', scope: 'optional legal case contract draft archive', reversible: true },
        { type: 'network_read', scope: 'configured legal drafting model', reversible: true },
      ],
    }),
evidence: legalEvidence('legal.contract.draft', 'create', 'type')
}),

  ];
}
