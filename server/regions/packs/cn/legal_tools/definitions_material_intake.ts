import type { ToolDefinition } from '../../../../tools/types';
import { withLegalReceipt, legalCapability, legalEvidence, legalInputBlocked } from "./tool_contracts";
import { importMaterialsToKbHandler } from "./knowledge";
import { processNoticeLinkHandler } from "./notice_intake";
import { externalSourceStatusHandler } from "./external_workspace";
import { defineLegalTool, stringField, numberField, booleanField, stringListField } from "./tool_contracts";

export function material_intakeTools(): ToolDefinition[] {
  return [
  defineLegalTool({
    name: 'legal_import_materials_to_kb',
    description: '法律材料导入知识库 — Lumi 自主解析本地文件、案件文件夹或粘贴文本，导入组织知识库并建立法律标签。支持起诉状、证据、庭审笔录、合同、裁判文书、网页摘录、检索笔记等材料；外部网站材料需由律师确认来源和权限后再入库。',
    properties: {
      filePath: stringField('单个本地材料文件路径，支持 PDF/DOCX/XLSX/PPTX/RTF/TXT/MD/CSV'),
      folderPath: stringField('案件材料文件夹路径，会批量导入支持的文档格式'),
      content: stringField('直接粘贴的材料文本、网页摘录或律师确认后的外部检索结果'),
      title: stringField('材料标题，未提供时使用文件名或案件名'),
      caseName: stringField('案件名称或简称'),
      caseType: stringField('案由或案件类型'),
      materialType: stringField('材料类型：起诉状/答辩状/证据/庭审笔录/合同/裁判文书/检索笔记/工商信息等'),
      tags: stringListField('附加标签'),
      recursive: booleanField('导入文件夹时是否递归子目录，默认 true'),
      maxFiles: numberField('文件夹导入最大文件数，默认 30，最高 100'),
      orgId: stringField('组织 ID，默认上下文 orgId 或 default'),
      userId: stringField('导入人 ID，默认上下文 userId 或 system'),
    },
    handler: withLegalReceipt(importMaterialsToKbHandler, {
      status: 'imported',
      requireArticleMutation: true,
    }),
    capability: legalCapability({
      id: 'legal.materials.import-to-kb', operation: 'create', risk: 'medium', successStatuses: ['imported'],
      sideEffects: [
        { type: 'local_state_change', scope: 'organization legal knowledge base and vector index', reversible: true },
        { type: 'local_read', scope: 'selected legal files, folders, or pasted content', reversible: true },
        { type: 'network_read', scope: 'configured embedding provider when indexing', reversible: true },
      ],
    }),
    evidence: legalEvidence('legal.materials.import-to-kb', 'create', 'folderPath'),
  }),
  defineLegalTool({
    name: 'legal_process_notice_link',
    description: '短信/法院通知链接处理 — 从法院短信、开庭通知、送达通知中的链接半自动下载 PDF/DOCX/网页材料，保存本地留痕；需要登录、验证码、人脸或短信验证时生成授权网页登录步骤，不绕过平台限制。律师确认来源和权限后可导入组织知识库。',
    properties: {
      url: stringField('短信或通知中的 http(s) 链接；未提供时会从 message/noticeText 中提取第一个链接'),
      message: stringField('完整短信原文，可用于提取案号、法院、开庭/通知日期和链接'),
      noticeText: stringField('法院通知或送达通知文本'),
      caseId: stringField('已有案件工作台 ID；提供后会把短信/通知处理结果归档到该案件空间'),
      caseName: stringField('关联案件名称或简称'),
      title: stringField('材料标题，默认“短信/法院通知链接材料”'),
      includeExtractedText: booleanField('是否在返回结果中包含正文摘录，默认 true'),
      extractedTextLimit: numberField('返回正文摘录最大字符数，默认 4000，最高 20000'),
      persistCase: booleanField('是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭'),
      confirmedForKb: booleanField('律师已确认来源、授权和使用权限后设为 true，工具会导入组织知识库'),
      orgId: stringField('组织 ID，默认上下文 orgId 或 default'),
      userId: stringField('导入人 ID，默认上下文 userId 或 system'),
    },
    handler: withLegalReceipt(processNoticeLinkHandler, {
      status: 'downloaded',
      expectCaseMutation: 'when_requested',
      classify: content => legalInputBlocked(content)
        ? { ok: false, status: 'blocked' }
        : /已直接读取并保存|已下载|原始文件：/.test(content)
          ? { ok: true, status: 'downloaded' }
          : { ok: true, status: 'browser_handoff' },
    }),
    capability: legalCapability({
      id: 'legal.notice-link.process', operation: 'create', risk: 'medium', successStatuses: ['downloaded', 'browser_handoff'],
      sideEffects: [
        { type: 'local_state_change', scope: 'optional legal case or knowledge-base notice archive', reversible: true },
        { type: 'local_write', scope: 'downloaded notice/document and source trace files when directly accessible', reversible: true },
        { type: 'network_read', scope: 'provided public notice or document URL', reversible: true },
      ],
      limitations: ['browser_handoff means the link needs authorized visible login or verification; no download is claimed.'],
    }),
    evidence: legalEvidence('legal.notice-link.process', 'create', 'url'),
  }),
  defineLegalTool({
    name: 'legal_download_and_extract_document',
    description: '文书链接自动下载与正文提取 — 用户发送裁判文书、起诉状、合同、法院通知等 PDF/DOCX/网页链接后，Lumi 自动下载原文件、保存来源留痕、提取正文内容并返回摘要；需要登录/验证码时转授权浏览器协作，不绕过平台限制。',
    properties: {
      url: stringField('需要下载和提取正文的 http(s) 文书链接；未提供时会从 message/linkText 中提取第一个链接'),
      message: stringField('包含链接的用户消息、短信或网页摘录'),
      linkText: stringField('包含链接的文本'),
      caseId: stringField('已有案件工作台 ID；提供后会把文书链接处理结果归档到该案件空间'),
      caseName: stringField('关联案件名称或简称'),
      title: stringField('材料标题，默认“链接文书材料”'),
      includeExtractedText: booleanField('是否在返回结果中包含正文摘录，默认 true'),
      extractedTextLimit: numberField('返回正文摘录最大字符数，默认 4000，最高 20000'),
      persistCase: booleanField('是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭'),
      confirmedForKb: booleanField('律师已确认来源、授权和使用权限后设为 true，工具会导入组织知识库'),
      importToKb: booleanField('confirmedForKb 的别名'),
      orgId: stringField('组织 ID，默认上下文 orgId 或 default'),
      userId: stringField('导入人 ID，默认上下文 userId 或 system'),
    },
    handler: (args, context) => processNoticeLinkHandler({ ...args, documentLink: true, mode: 'document' }, context),
  }),
  defineLegalTool({
    name: 'legal_external_source_status',
    description: '外部法律数据源接入状态 — 明确企查查、Alpha、法蝉、裁判文书网、人民法院案例库、国家企业信用等数据源当前是官方 API 接入、授权网页登录协作还是材料导入，不夸大自动抓取能力。',
    properties: {

    },
    handler: externalSourceStatusHandler,
  })
  ];
}
