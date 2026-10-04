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
    description: '标书生成 — 导入招标文件要求，生成对应投标书框架（商务标+技术标）。使用住建部合同模板作为参考。',
    properties: {
      ...CASE_ARCHIVE_FIELDS,
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
    },
    handler: withLegalReceipt(generateBidHandler, { status: 'generated', expectCaseMutation: 'when_requested' }),
    capability: legalCapability({
      id: 'legal.bid.generate', operation: 'create', risk: 'medium', successStatuses: ['generated'],
      sideEffects: [
        { type: 'local_state_change', scope: 'optional legal case work-product archive', reversible: true },
        { type: 'local_read', scope: 'optional tender files and folders', reversible: true },
        { type: 'network_read', scope: 'configured legal drafting model', reversible: true },
      ],
    }),
    evidence: legalEvidence('legal.bid.generate', 'create', 'projectName'),
  }),
  defineLegalTool({
    name: 'legal_review_contract',
    description: '合同审查 — 对照本地案例库审查合同条款风险，标注风险等级、法律依据和修改建议。所有法条引用均会标注来源。',
    properties: {
      ...CASE_ARCHIVE_FIELDS,
      contract: stringField('待审查的合同全文'),
      title: stringField('caseName 的别名'),
    },
    required: ['contract'],
    handler: reviewContractHandler,
  }),
  defineLegalTool({
    name: 'legal_draft_contract',
    description: '合同起草 — 基于中国住建部示范文本生成合同。支持施工合同、买卖合同、工程总承包、劳动合同等类型。',
    properties: {
      ...CASE_ARCHIVE_FIELDS,
      type: stringField('合同类型：建设工程施工合同 / 商品房买卖合同 / 工程总承包合同 / 建筑工人劳动合同'),
      details: stringField('合同具体要求（项目信息、工期、价款等）'),
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
    evidence: legalEvidence('legal.contract.draft', 'create', 'type'),
  })
  ];
}
