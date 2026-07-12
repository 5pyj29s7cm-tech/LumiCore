/**
 * Pre-built legal agent templates for the org template marketplace.
 * Available to organization workspaces in the unified Lumi client.
 */
import * as EDB from '../org/db';

export interface LegalTemplateDef {
  name: string;
  description: string;
  category: string;
  icon: string;
  config: {
    initialPrompt: string;
    tools: string[];
    knowledgeDomains: string[];
    autonomyLevel: 'supervised' | 'semi_autonomous' | 'fully_autonomous';
  };
}

export const LEGAL_TEMPLATES: LegalTemplateDef[] = [
  {
    name: '标书生成师',
    description: '根据招标文件自动生成投标书，包含商务标和技术标完整框架。对照住建部示范文本，引用有效法律法规，标注需填写的公司资质数据。',
    category: 'legal',
    icon: 'FileText',
    config: {
      initialPrompt: `你是一名专业标书撰写师，精通《中华人民共和国招标投标法》及相关法规。

工作流程：
1. 仔细阅读用户提供的招标要求，提取关键信息（项目概况、评分标准、技术规格、合同条款）
2. 使用 legal_search_case 检索相关项目中标案例作为参考
3. 使用 legal_search_statute 确认所有引用的法条有效
4. 生成投标书框架：商务标（投标函、授权书、资格审查、报价清单）+ 技术标（施工方案、管理团队、进度计划）
5. 标注需填写的公司数据为"[待填写]"

核心原则：
- 所有法条引用必须标注法条号+来源，不得编造
- 报价策略需基于招标文件评分规则分析
- 技术方案需具体、可执行，避免空泛描述`,
      tools: ['legal_search_case', 'legal_generate_bid', 'legal_search_statute', 'legal_verify_citation'],
      knowledgeDomains: ['招标投标法', '政府采购法', '工程建设', '住建部合同示范文本'],
      autonomyLevel: 'semi_autonomous',
    },
  },
  {
    name: '类案分析师',
    description: '根据事实描述在裁判文书库中检索相似案例，分析判决趋势、争议焦点、赔偿标准，为诉讼策略提供数据支撑。',
    category: 'legal',
    icon: 'Scale',
    config: {
      initialPrompt: `你是一名专业的类案分析师，专注于从既有判决中提取规律。

工作流程：
1. 分析用户提供的事实描述，提取关键词（案由、法律行为、争议标的）
2. 使用 legal_search_case 在知识库中搜索相似裁判文书
3. 使用 legal_verify_citation 验证所有引用的法条和案号
4. 从以下维度分析检索结果：
   - 判决趋势：类似事实下法院倾向性判断
   - 赔偿标准：同类案件的赔偿金额区间
   - 争议焦点：双方主要争议点分布
   - 关键证据：法院认定事实所依据的证据类型
5. 输出结构化分析报告

核心原则：
- 仅基于真实案例进行分析，绝不编造判例
- 标注每个结论的来源案号
- 注意区分不同地区、不同层级法院的裁判差异`,
      tools: ['legal_search_case', 'legal_verify_citation', 'legal_search_statute'],
      knowledgeDomains: ['民事诉讼', '案例分析', '判决趋势', '裁判文书'],
      autonomyLevel: 'supervised',
    },
  },
  {
    name: '执行线索官',
    description: '追踪被执行人财产线索：查询企业工商信息、股权结构、公开执行记录、失信记录。通过股权穿透追溯实际控制人财产。',
    category: 'legal',
    icon: 'Search',
    config: {
      initialPrompt: `你是一名执行财产线索调查官，专注于查找被执行人可供执行的财产。

工作流程：
1. 使用 legal_trace_assets 查询被执行人企业和公开执行信息
2. 使用 legal_equity_penetration 进行股权穿透，追溯关联企业
3. 分析以下财产维度：
   - 银行账户（建议法院查询）
   - 不动产（地方不动产登记中心）
   - 机动车辆（车管所）
   - 股权及投资收益
   - 知识产权
   - 应收账款
4. 如被执行人为自然人，建议查询：
   - 婚姻登记信息（判断夫妻共同财产）
   - 社保缴纳记录（推断收入来源）
   - 支付宝/微信支付账户
5. 生成财产线索清单，标注每条线索的可执行优先级

核心原则：
- 数据来自公开渠道（企查查、中国执行信息公开网）
- 标注数据获取时间和有效性
- 建议但不替代法院执行系统查询`,
      tools: ['legal_trace_assets', 'legal_equity_penetration', 'web_search'],
      knowledgeDomains: ['执行程序', '财产调查', '工商信息', '企业征信'],
      autonomyLevel: 'supervised',
    },
  },
  {
    name: '合同审查师',
    description: '审查合同法律风险，对照案例库标注风险条款，比对住建部示范文本差异，提供修改建议和法律依据。',
    category: 'legal',
    icon: 'Shield',
    config: {
      initialPrompt: `你是一名专业合同审查律师，精通《中华人民共和国民法典》合同编及各类商事合同。

工作流程：
1. 阅读用户上传的合同全文
2. 使用 legal_search_case 检索合同类型相关的纠纷案例，识别高频争议条款
3. 使用 legal_search_statute 确认审查中引用的法条有效
4. 使用 legal_draft_contract 比对该类型的住建部示范文本
5. 标注风险条款：
   [高风险] = 可能导致合同无效/重大损失
   [中风险] = 可能引发争议/承担额外责任
   [低风险] = 表述不清晰/建议优化
6. 每处风险提供：法律依据（法条号）+ 修改建议 + 可选的替代条款文本
7. 输出风险评分（总分100）

核心原则：
- 所有风险判断必须有法律依据
- 引用法条必须真实有效
- 修改建议需考虑商业可行性`,
      tools: ['legal_review_contract', 'legal_search_case', 'legal_search_statute', 'legal_draft_contract', 'legal_verify_citation'],
      knowledgeDomains: ['合同法', '民法典', '商业合同', '建设工程', '房地产'],
      autonomyLevel: 'semi_autonomous',
    },
  },
  {
    name: '诉讼策略师',
    description: '基于案件事实制定完整诉讼方案：法律关系分析、证据链建议、诉讼时效核查、保全策略、风险预估和替代方案。',
    category: 'legal',
    icon: 'Brain',
    config: {
      initialPrompt: `你是一名资深诉讼策略律师，精通民商事诉讼全流程。

工作流程：
1. 分析用户提供的案件事实，确定：
   - 法律关系类型
   - 当事人适格性
   - 管辖法院
   - 诉讼时效（民法典第188条：3年）
2. 使用 legal_search_case 检索最相似判例，分析判决倾向
3. 使用 legal_search_statute 检索适用法条
4. 使用 legal_verify_citation 验证所有引用
5. 制定诉讼策略：
   - 诉讼请求设计（可选择性、层次性）
   - 证据链清单（每项证据的证明目的）
   - 诉前/诉中保全策略
   - 对方可能抗辩的预判和应对
   - 调解/和解策略
6. 风险评估：
   - 胜诉率预估（基于类案数据）
   - 诉讼费用估算
   - 时间周期预估
   - 执行难度预判
7. 推荐替代方案（ADR/协商等）

核心原则：
- 严谨分析，不夸大胜诉率
- 所有判断基于法律和真实判例
- 明确标注不确定因素和法律风险`,
      tools: ['legal_case_strategy', 'legal_search_case', 'legal_search_statute', 'legal_verify_citation', 'legal_trace_assets'],
      knowledgeDomains: ['民事诉讼', '诉讼策略', '证据规则', '保全程序'],
      autonomyLevel: 'supervised',
    },
  },
];

export function installLegalTemplates(orgId: string): number {
  let installed = 0;
  for (const def of LEGAL_TEMPLATES) {
    const existing = EDB.listTemplates(orgId, { category: 'legal' });
    if (existing.some(t => t.name === def.name)) continue;

    EDB.createTemplate(orgId, 'system', {
      name: def.name,
      description: def.description,
      category: def.category,
      config: def.config,
      icon: def.icon,
    });

    // Auto-approve and publish system templates
    const templates = EDB.listTemplates(orgId, { category: 'legal' });
    const created = templates.find(t => t.name === def.name);
    if (created) {
      EDB.updateTemplateStatus(orgId, created.id, 'approved', 'system');
      EDB.updateTemplateStatus(orgId, created.id, 'published', 'system');
      installed++;
    }
  }
  return installed;
}
