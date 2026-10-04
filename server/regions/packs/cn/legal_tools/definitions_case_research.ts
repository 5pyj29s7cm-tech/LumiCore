import type { ToolDefinition } from '../../../../tools/types';
import { traceAssetsHandler, equityPenetrationHandler } from "./company_research";
import { withLegalReceipt, legalCapability, legalEvidence } from "./tool_contracts";
import { caseStrategyHandler } from "./argument_drafting";
import { caseWorkspaceHandler, caseWorkflowStatusHandler } from "./case_workspace";
import { legalMessageIntakeToCaseHandler } from "./message_intake";
import { defineLegalTool, stringField, booleanField, stringListField, CASE_ARCHIVE_FIELDS } from "./tool_contracts";

export function case_researchTools(): ToolDefinition[] {
  return [
  defineLegalTool({
    name: 'legal_trace_assets',
    description: '财产线索追踪 — 查询被执行人企业信息、公开执行记录、失信记录等财产线索。企查查仅在配置官方 API 凭证后自动查询；未配置时输出授权网页登录协作步骤。后续可查询婚姻状况和股权穿透。',
    properties: {
      ...CASE_ARCHIVE_FIELDS,
      name: stringField('被执行主体名称（个人姓名/公司名称）'),
    },
    required: ['name'],
    handler: traceAssetsHandler,
  }),
  defineLegalTool({
    name: 'legal_equity_penetration',
    description: '股权穿透分析 — 追溯目标公司的股东结构，多层穿透识别实际控制人和关联财产线索。企查查仅在配置官方 API 凭证后自动查询；未配置时输出授权网页登录协作和材料入库步骤。',
    properties: {
      ...CASE_ARCHIVE_FIELDS,
      name: stringField('公司名称'),
    },
    required: ['name'],
    handler: equityPenetrationHandler,
  }),
  defineLegalTool({
    name: 'legal_case_strategy',
    description: '诉讼策略分析 — 给定案件事实，结合相关法条和相似判例，制定应诉方案，包括：案由确定、证据建议、保全策略、风险预估。所有分析基于真实法条和判例，绝不编造。',
    properties: {
      ...CASE_ARCHIVE_FIELDS,
      facts: stringField('案件事实描述（时间、地点、主体、行为、争议焦点）'),
    },
    required: ['facts'],
    handler: withLegalReceipt(caseStrategyHandler, { status: 'generated', expectCaseMutation: 'when_requested' }),
    capability: legalCapability({
      id: 'legal.case.strategy.generate', operation: 'create', risk: 'medium', successStatuses: ['generated'],
      sideEffects: [
        { type: 'local_state_change', scope: 'optional legal case strategy archive', reversible: true },
        { type: 'network_read', scope: 'legal model and authority search context', reversible: true },
      ],
    }),
    evidence: legalEvidence('legal.case.strategy.generate', 'create', 'facts'),
  }),
  defineLegalTool({
    name: 'legal_case_workspace',
    description: '统一案件工作台 — 创建或更新案件空间，归集身份信息、事实、证据、争议焦点、法源、类案、文书包、立案状态，并输出下一步工具链。用于把会议、聊天、材料、诉讼文书和外部检索串成同一个案件闭环。',
    properties: {
      ...CASE_ARCHIVE_FIELDS,
      title: stringField('caseName 的别名'),
      stage: stringField('阶段：consultation/filing/trial/judgment/enforcement/closed，或中文阶段'),
      role: stringField('我方身份：原告/被告/申请人/被申请人等'),
      cause: stringField('caseType 的别名'),
      court: stringField('法院、仲裁机构或拟提交平台'),
      parties: stringField('当事人身份信息、主体信息和联系方式摘要'),
      claims: stringField('诉讼请求、抗辩目标或办理目标'),
      objective: stringField('claims 的别名'),
      facts: stringField('案件事实、时间线或沟通记录摘要'),
      materials: stringField('综合案件材料摘要，facts 的补充来源'),
      evidence: stringField('证据材料、证据目录或零碎证据列表'),
      complaint: stringField('起诉状、申请书、答辩状或对方文书摘要'),
      opponentMaterials: stringField('对方起诉状、证据、答辩意见或代理意见摘要'),
      transcript: stringField('会议、庭审、沟通或询问笔录'),
      trialNotes: stringField('transcript 的别名'),
      legalAuthorities: stringField('已检索或拟引用的法条、司法解释、裁判规则'),
      similarCases: stringField('已检索类案、案号、法院层级和有利/不利点'),
    },
    handler: withLegalReceipt(caseWorkspaceHandler, { status: 'updated', expectCaseMutation: 'always' }),
    capability: legalCapability({
      id: 'legal.case.workspace.update', operation: 'mutate', risk: 'medium', successStatuses: ['updated'],
      sideEffects: [{ type: 'local_state_change', scope: 'organization legal case workspace', reversible: true }],
    }),
    evidence: legalEvidence('legal.case.workspace.update', 'mutate', 'caseId'),
  }),
  defineLegalTool({
    name: 'legal_case_workflow_status',
    description: '案件闭环状态评估 — 只读取已有案件或临时案件材料，不创建文书；输出材料入案、身份主体、事实时间线、证据三性、三段论、现行有效法律、类案来源、文书策略、立案协作、正式交付的完成度、阻断项、待补项和下一步推荐工具。适合聊天、语音、飞书/企微里询问“这个案子还缺什么/下一步做什么/能不能正式交付”。',
    properties: {
      caseId: stringField('已有案件 ID；提供时优先读取该案件空间'),
      caseName: stringField('案件名称或简称；未提供 caseId 时按名称查找'),
      title: stringField('caseName 的别名'),
      query: stringField('caseName 的别名，适合自然语言查找'),
      stage: stringField('阶段：consultation/filing/trial/judgment/enforcement/closed，或中文阶段'),
      role: stringField('我方身份：原告/被告/申请人/被申请人等'),
      caseType: stringField('案由或案件类型'),
      cause: stringField('caseType 的别名'),
      court: stringField('法院、仲裁机构或拟提交平台'),
      parties: stringField('当事人身份信息、主体信息和联系方式摘要'),
      claims: stringField('诉讼请求、抗辩目标或办理目标'),
      objective: stringField('claims 的别名'),
      facts: stringField('案件事实、时间线或沟通记录摘要'),
      materials: stringField('综合案件材料摘要，facts 的补充来源'),
      evidence: stringField('证据材料、证据目录或零碎证据列表'),
      complaint: stringField('起诉状、申请书、答辩状或对方文书摘要'),
      opponentMaterials: stringField('对方起诉状、证据、答辩意见或代理意见摘要'),
      transcript: stringField('会议、庭审、沟通或询问笔录'),
      trialNotes: stringField('transcript 的别名'),
      legalAuthorities: stringField('已检索或拟引用的法条、司法解释、裁判规则'),
      similarCases: stringField('已检索类案、案号、法院层级和有利/不利点'),
      content: stringField('需要纳入法源预检的文书或材料内容'),
      documentText: stringField('content 的别名'),
      orgId: stringField('组织 ID，默认上下文 orgId 或 default'),
    },
    handler: caseWorkflowStatusHandler,
  }),
  defineLegalTool({
    name: 'legal_message_intake_to_case',
    description: '远程法律消息入案 — 把微信、飞书、企微、短信或聊天里转发的案件材料、法院短信链接、通知链接、附件说明和沟通记录写入统一案件空间，归档原文、识别案号/法院/日期、半自动处理链接，并返回案件闭环状态和下一步。适合 Lumi bot 收到“把这个发给 Lumi 入案/归档到案件/法院短信链接/案件材料”时使用。',
    properties: {
      ...CASE_ARCHIVE_FIELDS,
      platform: stringField('来源平台：feishu/wechat/wecom/sms/other，或中文“飞书/微信/企微/短信”'),
      sender: stringField('发送人、联系人或群名'),
      message: stringField('原始消息正文、短信原文、聊天记录或案件材料说明'),
      text: stringField('message 的别名'),
      content: stringField('message 的别名'),
      receivedAt: stringField('收到消息的时间，默认当前时间'),
      attachments: { type: 'array', items: { type: 'object' }, description: '附件对象，可包含 fileName/localPath/extractedText/content' },
      fileNames: stringListField('附件文件名列表'),
      urls: stringListField('消息中的链接列表；未提供时会从正文提取'),
      url: stringField('单个链接；未提供时会从正文提取'),
      title: stringField('caseName 的别名'),
      cause: stringField('caseType 的别名'),
      court: stringField('法院或仲裁机构'),
      parties: stringField('当事人或主体信息'),
      stage: stringField('案件阶段，默认咨询；识别到开庭日期时偏向庭审阶段'),
      processLinks: booleanField('是否处理识别到的链接，默认 true；false 时只归档不抓取'),
    },
    handler: withLegalReceipt(legalMessageIntakeToCaseHandler, { status: 'archived', expectCaseMutation: 'always' }),
    capability: legalCapability({
      id: 'legal.case.message-intake.archive', operation: 'create', risk: 'medium', successStatuses: ['archived'],
      sideEffects: [{ type: 'local_state_change', scope: 'legal case message intake and material archive', reversible: true }],
    }),
    evidence: legalEvidence('legal.case.message-intake.archive', 'create', 'message'),
  })
  ];
}
