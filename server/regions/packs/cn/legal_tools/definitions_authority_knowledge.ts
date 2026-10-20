import type { ToolDefinition } from '../../../../tools/types';
import { refreshAuthoritativeSourcesHandler, authoritySourceStatusHandler, verifyCitationHandler, importJudgmentHandler } from "./knowledge";
import { legalCapability, legalEvidence, withLegalReceipt } from "./tool_contracts";
import { LEGAL_TEMPORAL_FIELDS, defineLegalTool, stringField, numberField } from "./tool_contracts";

export function authority_knowledgeTools(): ToolDefinition[] {
  return [
  defineLegalTool({
    name: 'legal_refresh_authoritative_sources',
    description: '立即巡检现行法权威来源 — 逐项访问国家法律法规数据库，核对版本日期、施行日期、效力状态、官方记录 ID、条文范围和稳定指纹。发现变化即阻断正式文书交付并进入人工复核，不会把网络失败当成有效。',
    properties: {
      timeoutMs: numberField('单个官方请求超时毫秒数，范围 2000-30000；默认 12000'),
    },
    handler: refreshAuthoritativeSourcesHandler,
    capability: legalCapability({
      id: 'legal.authoritative-sources.refresh', operation: 'mutate', risk: 'medium', successStatuses: ['refreshed'],
      sideEffects: [
        { type: 'local_state_change', scope: 'authoritative statute source refresh state and history', reversible: true },
        { type: 'network_read', scope: 'official national law and regulation sources', reversible: true },
      ],
      limitations: ['Network failure or changed official records are recorded for review and are never treated as valid law evidence.'],
    }),
    evidence: legalEvidence('legal.authoritative-sources.refresh', 'mutate', 'timeoutMs'),
  }),
  defineLegalTool({
    name: 'legal_authority_source_status',
    description: '查看现行法权威来源巡检状态 — 显示最近运行时间、已验证法源、待人工复核项目和暂时不可用来源，不发起新的外部请求。',
    properties: {

    },
    handler: authoritySourceStatusHandler,
  }),
  defineLegalTool({
    name: 'legal_verify_citation',
    description: '引用校验 — 验证法条引用和案例引用是否真实有效。可检查单个引用或全文中的所有引用，标注：存在/不存在、有效/已废止。禁止使用虚构法条和案例。',
    properties: {
      ...LEGAL_TEMPORAL_FIELDS,
      quotedText: stringField('声称为法条原文的引文，必须与所引条、款、项的权威正文相符。'),
      citation: stringField('单个引用文本，如"《民法典》第585条"或"(2024)京0105民初12345号"'),
      text: stringField('包含多个引用的完整文本（将自动识别所有《XX法》和案号引用）'),
      orgId: stringField('组织ID'),
    },
    handler: verifyCitationHandler,
  }),
  defineLegalTool({
    name: 'legal_import_judgment',
    description: '导入裁判文书 — 上传或粘贴裁判文书全文（PDF/DOCX/TXT），自动提取案号、法院、当事人、法条引用等元数据，分块并向量化索引到组织知识库。导入后可通过类案检索查询。',
    properties: {
      filePath: stringField('裁判文书文件路径（PDF/DOCX/TXT）'),
      password: stringField('PDF 打开密码，仅用于当次读取，不回显、不入库'),
      passwords: { type: 'object', additionalProperties: { type: 'string' }, description: '按原文件完整路径提供 PDF 打开密码，仅用于当次读取' },
      content: stringField('直接粘贴的裁判文书全文（与filePath二选一）'),
      orgId: stringField('组织ID'),
      userId: stringField('操作用户ID'),
    },
    handler: withLegalReceipt(importJudgmentHandler, {
      status: 'imported',
      requireArticleMutation: true,
    }),
    capability: legalCapability({
      id: 'legal.judgment.import', operation: 'create', risk: 'medium', successStatuses: ['imported'],
      sideEffects: [
        { type: 'local_state_change', scope: 'organization judgment knowledge base and vector index', reversible: true },
        { type: 'local_read', scope: 'selected judgment file or pasted content', reversible: true },
        { type: 'network_read', scope: 'configured embedding provider when indexing', reversible: true },
      ],
    }),
    evidence: legalEvidence('legal.judgment.import', 'create', 'filePath'),
  })
  ];
}
