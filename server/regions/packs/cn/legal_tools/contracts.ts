import { searchMOHURDTemplates } from "../../../../legal/sources";
import { searchSimilarCases } from "../../../../legal/kb";
import { readBidRequirementInput } from "./documents";
import { legalWorkspaceId, textArg, runLegalLLM, sanitizeLegalWorkProductOutput, LEGAL_REASONING_BASELINE } from "./context";
import { buildLegalWorkProductPreflightSection } from "./citations";
import { archiveLegalReportToCase } from "./case_workflow";

export async function generateBidHandler(args: Record<string, any>, context?: any): Promise<string> {
  const bidInput = await readBidRequirementInput(args);
  const requirements = bidInput.requirements;
  const projectName = (args.projectName as string) || '项目';
  if (!requirements) {
    const skipped = bidInput.skipped.length ? `\n\n## 未读取材料\n${bidInput.skipped.map(item => `- ${item}`).join('\n')}` : '';
    return `请提供招标要求内容（requirements参数），或提供可读取的 filePath / filePaths / folderPath。${skipped}`;
  }
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || projectName;

  // Try to find relevant templates
  const templates = await searchMOHURDTemplates('施工');

  const prompt = `你是一名专业标书撰写师。请根据以下招标要求，生成一份完整的投标书框架。

## 招标要求
${requirements}

## 可用合同模板参考
${templates.slice(0, 3).map(t => `- ${t.title}`).join('\n')}

## 要求
1. 生成完整的标书目录结构
2. 每个章节写核心内容概要（商务标+技术标）
3. 标注每部分需要从招标文件中提取的具体信息
4. 所有引用的法条必须标注来源（法条名称+条款号）
5. 不要编造任何公司资质、业绩数据——标注为"[待填写]"

请用中文输出，格式清晰。`;

  // Try to use LLM
  let report = '';
  try {
    const text = await runLegalLLM(prompt, context, 2048);
    if (text) report = sanitizeLegalWorkProductOutput(text);
  } catch { /* LLM unavailable, return structured outline */ }

  if (!report) {
    report = `[标书生成 — 无LLM可用时的结构化大纲]

# ${projectName} 投标书

## 一、商务标
### 1.1 投标函及投标函附录 [待填写]
### 1.2 法定代表人身份证明 [待填写]
### 1.3 授权委托书 [待填写]
### 1.4 投标保证金 [待填写]
### 1.5 资格审查资料 [待填写]
  - 营业执照、资质证书
  - 近年财务状况
  - 近年类似项目业绩
### 1.6 已标价工程量清单 [待填写]

## 二、技术标
### 2.1 施工组织设计
### 2.2 项目管理机构
### 2.3 拟分包项目情况

## 三、报价策略建议
[基于招标文件的评分规则分析]

*注: 请连接LLM以生成完整标书内容。标注"[待填写]"处需根据实际公司资料补充。*`;
  }

  const sourceSection = [
    '## 招标文件来源',
    bidInput.sources.length ? bidInput.sources.map(source => `- ${source}`).join('\n') : '- 粘贴文本',
    bidInput.skipped.length ? ['', '## 未读取材料', bidInput.skipped.map(item => `- ${item}`).join('\n')].join('\n') : '',
  ].filter(Boolean).join('\n');
  const archivedReport = `${report}\n\n${sourceSection}`;
  const preflightSection = buildLegalWorkProductPreflightSection(archivedReport, args, orgId);
  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName,
    title: `${projectName} 投标书工作底稿`,
    content: `${archivedReport}\n\n${preflightSection}`,
    type: 'note',
    cause: textArg(args, 'caseType') || '投标/招标文件响应',
  });
  return `${archivedReport}

${preflightSection}

## 案件归档与交付边界
${caseLine}
- 三段论核心基础：已作为内部合规和风险分析逻辑使用；正式投标文件仍需人工补齐资质、业绩、报价和签章材料。
- 正式交付：如需生成律所/团队正式交付包，请继续使用 legal_finalize_delivery_package 进行现行有效法律硬门槛和来源登记。`;
}

// ── legal_review_contract ───────────────────────────────────────────────

export async function reviewContractHandler(args: Record<string, any>, context?: any): Promise<string> {
  const contractText = args.contract as string;
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || textArg(args, 'title') || '合同审查';
  if (!contractText) return '请提供合同文本（contract参数）';

  // Search for similar cases to identify risk areas
  const riskKeywords = ['合同纠纷', '违约', '合同无效', '合同解除', '违约责任'];
  const caseResults: string[] = [];

  for (const kw of riskKeywords.slice(0, 3)) {
    const cases = await searchSimilarCases(orgId, kw, 3, userId);
    for (const c of cases) {
      caseResults.push(`- ${c.title} (${c.caseNumber || 'N/A'}): ${c.chunk.slice(0, 150)}`);
    }
  }

  const prompt = `你是一名专业合同审查律师。请审查以下合同，标注风险条款。

## 合同文本
${contractText.slice(0, 8000)}

## 相关判例参考
${caseResults.slice(0, 10).join('\n')}

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 审查要求
1. 逐一标注风险条款（条款号+风险等级 高/中/低）
2. 每处风险提供：法律依据 + 修改建议
3. 引用真实法条并标注法条号（禁止编造）
4. 如合同类型有住建部示范文本，建议比对差异
5. 标注可能导致的违约责任范围

请用中文输出。`;

  let report = '';
  try {
    const text = await runLegalLLM(prompt, context, 2048);
    if (text) report = sanitizeLegalWorkProductOutput(text);
  } catch { /* fall through */ }

  if (!report) {
    report = `[合同审查 — 基于规则分析]

## 自动检测的风险条款

对合同文本中常见风险条款进行关键词检测：

${detectRiskClauses(contractText)}

## 建议
1. 参照住建部示范文本比对标准条款
2. 核实所有引用法条的有效性
3. 建议人工审查后定稿

*注: 连接LLM以进行深度合同审查分析。*`;
  }

  const preflightSection = buildLegalWorkProductPreflightSection(report, args, orgId);
  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName,
    title: `${caseName} 合同审查报告`,
    content: `${report}\n\n${preflightSection}`,
    type: 'contract',
    cause: textArg(args, 'caseType') || '合同审查',
  });
  return `${report}

${preflightSection}

## 案件归档与交付边界
${caseLine}
- 三段论核心基础：已作为内部审查逻辑使用；风险条款需继续对应现行有效法律、合同事实和证据材料。
- 正式交付：如需形成正式法律意见书/合同审查意见，请继续使用 legal_finalize_delivery_package 触发现行有效法律硬门槛。`;
}

function detectRiskClauses(text: string): string {
  const risks: string[] = [];
  const patterns: Record<string, string> = {
    '违约金.*超过.*%|违约金.*(合同总价|总价|价款|金额).*[0-9０-９]{2,}\\s*%|[0-9０-９]{2,}\\s*%.*违约金|逾期.*违约金.*[0-9０-９]{2,}\\s*%': '违约金比例可能过高，依据《民法典》第585条，违约金明显高于实际损失的，人民法院或仲裁机构可以根据请求予以调整',
    '不可抗力': '不可抗力条款需要明确界定范围，避免模糊表述',
    '单方.*解除权|单方.*解除|任意解除': '单方解除权条款需注意《民法典》第563条关于法定解除权的限制，并明确触发条件、通知义务和补救期',
    '管辖.*法院|法院.*管辖|仲裁.*机构': '争议解决条款需明确管辖法院或仲裁机构，单方所在地管辖约定应复核是否与合同履行地、被告住所地等连接点匹配',
    '连带.*责任|无限.*责任': '连带责任或无限责任条款需审慎评估风险敞口',
    '知识产权.*归属|保密.*永久': '知识产权归属条款需明确，保密期限"永久"可能不合理',
    '转让.*提前.*三个月': '合同权利义务转让需双方协商一致（《民法典》第545条）',
  };

  for (const [pattern, advice] of Object.entries(patterns)) {
    if (new RegExp(pattern).test(text)) {
      risks.push(`- ⚠️ ${advice}`);
    }
  }
  return risks.length > 0 ? risks.join('\n') : '未检测到明显风险条款模式。建议使用LLM进行深度分析。';
}

// ── legal_draft_contract ────────────────────────────────────────────────

export async function draftContractHandler(args: Record<string, any>, context?: any): Promise<string> {
  const contractType = (args.type as string) || '';
  const details = (args.details as string) || '';
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || `${contractType || '合同'}起草`;
  const templates = await searchMOHURDTemplates(contractType);

  if (templates.length === 0) {
    return `未找到"${contractType}"类型的住建部合同模板。可用模板类型：建设工程施工合同、商品房买卖合同（预售/现售）、工程总承包合同、建筑工人简易劳动合同、物业临时管理规约。请指定具体类型。`;
  }

  const prompt = `你是一名专业合同律师。请根据住建部示范文本起草一份${contractType}合同。

## 合同要求
${details || '标准合同'}

## 住建部示范文本
${templates[0].title} (${templates[0].publishDate})

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 要求
1. 按照住建部示范文本结构起草
2. 所有条款必须符合现行法律（民法典为主，标注引用法条号）
3. 需要填写的地方标注[请填写]
4. 可选项标注[可选]
5. 禁止编造法律条文

请输出完整合同文本。`;

  let report = '';
  try {
    const text = await runLegalLLM(prompt, context, 2048);
    if (text) report = sanitizeLegalWorkProductOutput(text);
  } catch { /* fall through */ }

  if (!report) {
    report = `[合同起草 — 模板]

使用住建部示范文本: **${templates[0].title}** (${templates[0].publishDate})

请访问 ${templates[0].url} 下载完整模板。

*注: 连接LLM可自动填充合同具体条款。*`;
  }

  const preflightSection = buildLegalWorkProductPreflightSection(report, args, orgId);
  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName,
    title: `${caseName} 合同起草底稿`,
    content: `${report}\n\n${preflightSection}`,
    type: 'contract',
    cause: textArg(args, 'caseType') || contractType || '合同起草',
  });
  return `${report}

${preflightSection}

## 案件归档与交付边界
${caseLine}
- 三段论核心基础：已作为内部条款构造和风险配置逻辑使用；空白项、主体信息、价款、期限、违约责任仍需人工补齐。
- 正式交付：如需形成正式合同文本，请继续使用 legal_finalize_delivery_package 触发现行有效法律硬门槛。`;
}
