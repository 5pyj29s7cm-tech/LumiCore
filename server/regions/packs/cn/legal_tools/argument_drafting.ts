import { searchSimilarCases, searchStatutes } from "../../../../legal/kb";
import { legalWorkspaceId, textArg, LEGAL_REASONING_BASELINE, runLegalLLM, sanitizeLegalWorkProductOutput, roleLabel, materialSummary, buildCaseContext, inferDisputeFocuses, buildSearchQueries, listArg } from "./context";
import { appendLegalWorkProductArchiveSection } from "./citations";

// ── legal_case_strategy ─────────────────────────────────────────────────

export async function caseStrategyHandler(args: Record<string, any>, context?: any): Promise<string> {
  const facts = args.facts as string;
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || '诉讼策略分析';
  const caseType = textArg(args, 'caseType') || '诉讼策略';
  if (!facts) return '请提供案件事实描述（facts参数）';

  // Search similar cases
  const similarCases = await searchSimilarCases(orgId, facts, 5, userId);
  // Search relevant statutes
  const statutes = await searchStatutes(orgId, facts, 5, userId);

  const caseRefs = similarCases.map(c =>
    `- ${c.title} (${c.caseNumber || 'N/A'}, ${c.court || ''}, 相似度: ${c.score})`,
  ).join('\n');

  const statuteRefs = statutes.filter(s => s.isEffective).map(s =>
    `- ${s.title}: ${s.chunk.slice(0, 200)}`,
  ).join('\n');

  const prompt = `你是一名资深诉讼律师。请根据以下事实和相关法条、判例，制定诉讼策略。

## 案件事实
${facts}

## 相关法条（已验证有效）
${statuteRefs || '（未在本地法条库中找到直接相关法条，建议使用legal_search_statute补充检索）'}

## 相似判例
${caseRefs || '（未在本地知识库中找到相似判例）'}

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 分析要求
1. 确定案由和法律关系
2. 分析原告/被告的有利点和风险点
3. 证据链建议（需要收集什么证据）
4. 适用法条（必须标注法条号+来源，不得编造）
5. 参考判例的判决倾向
6. 诉前保全/财产保全建议
7. 预估诉讼风险和时间成本

**重要：不得编造任何法条或判例。如无法确认，标注"待核实"。**`;

  try {
    const text = await runLegalLLM(prompt, context, 2048);
    if (text) {
      const report = sanitizeLegalWorkProductOutput(text);
      return appendLegalWorkProductArchiveSection(report, args, context, {
        caseName,
        title: `${caseName}诉讼策略分析`,
        type: 'note',
        cause: caseType,
      });
    }
  } catch { /* fall through */ }

  const report = `[诉讼策略分析 — 无LLM可用时的结构化框架]

## 案件初步分析

**案件事实**: ${facts.slice(0, 500)}...

## 相似判例
${caseRefs || '未找到相似判例'}

## 适用法条
${statuteRefs || '未找到直接相关法条'}

## 策略要点
1. 确定管辖权 — 核实被告住所地/合同履行地/侵权行为地
2. 证据保全 — 对关键证据申请公证/证据保全
3. 财产保全 — 查询被告财产线索，申请诉前/诉中财产保全
4. 诉讼时效 — 核实是否在诉讼时效期间内（民法典第188条: 3年）

*注: 连接LLM以进行完整诉讼策略分析。*`;
  return appendLegalWorkProductArchiveSection(report, args, context, {
    caseName,
    title: `${caseName}诉讼策略分析`,
    type: 'note',
    cause: caseType,
  });
}

// ── legal_extract_dispute_focus ─────────────────────────────────────────

export async function extractDisputeFocusHandler(args: Record<string, any>, context?: any): Promise<string> {
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const role = roleLabel(textArg(args, 'role'));
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const facts = textArg(args, 'facts');
  const materials = materialSummary(args);
  const hasInput = facts || textArg(args, 'materials') || textArg(args, 'complaint') ||
    textArg(args, 'evidence') || textArg(args, 'transcript') || textArg(args, 'trialNotes');

  if (!hasInput) return '请提供起诉状、证据材料、庭审笔录、案件事实或其他案件材料。';
  const finish = (report: string) => appendLegalWorkProductArchiveSection(report, args, context, {
    caseName,
    title: `${caseName}争议焦点提炼`,
    type: 'note',
    cause: caseType,
  });

  const prompt = `你是一名律所诉讼支持律师。请根据案件材料提炼争议焦点，输出律师可复核的办案工作稿。

## 案件信息
${buildCaseContext(args)}

## 材料范围
${materials}

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 输出要求
1. 按争议焦点逐项输出：我方立场、对方可能主张、待证事实、已有证据、待补证据、质证/抗辩点、外部检索关键词。
2. 事实必须绑定证据；不能绑定证据的标注“待补证”。
3. 法条和类案只写“待检索/待核验”或引用已确认来源，不得编造。
4. 给出检索顺序：现行有效法律、人民法院案例库、裁判文书网、法蝉/Alpha、企业/被执行人查询。
5. 输出面向聊天窗或语音办理结果，不要输出内部方法论标题。
请用中文 Markdown 输出。`;

  try {
    const text = await runLegalLLM(prompt, context, 2500);
    if (text) return finish(sanitizeLegalWorkProductOutput(text));
  } catch { /* fall through */ }

  const focuses = inferDisputeFocuses(args);
  const queries = buildSearchQueries({ ...args, caseType, facts, issues: focuses });
  const evidence = textArg(args, 'evidence') || '待拆分并编号';

  return finish(sanitizeLegalWorkProductOutput(`# ${caseName} 争议焦点提炼稿

## 一、材料范围
${materials}

## 二、争议焦点清单
${focuses.map((focus, index) => `### ${index + 1}. ${focus}
- 我方立场：以${role}办理目标为准，需律师结合诉请、抗辩目标和证据强度确认。
- 对方可能主张：待从起诉状、答辩状、庭审笔录或沟通记录中逐项摘录。
- 待证事实：围绕“${focus}”拆分时间、主体、行为、金额、通知、履行结果等要件事实。
- 已有证据：${evidence}
- 待补证据：原件核验、送达/签收记录、付款或履行凭证、沟通记录、金额计算表。
- 质证/抗辩点：审查真实性、合法性、关联性、证明目的能否成立，以及是否存在反证。
- 外部检索关键词：${caseType} ${focus} 裁判规则；${caseType} ${focus} 举证责任。`).join('\n\n')}

## 三、检索与复核
- 先用 legal_search_statute 或国家法律法规数据库核验现行有效法律。
- 再按人民法院案例库、中国裁判文书网、法蝉、Alpha 的顺序补强类案。
- 涉企业、股东、被执行人线索时，使用企查查和国家企业信用信息公示系统的授权浏览器会话核验。
- 推荐检索词：${queries.join('；')}

## 四、律师确认
- 本稿仅用于办案梳理，不能直接作为最终法律意见或庭审发言。
- 争议焦点、证据取舍、法条引用、类案引用和对外提交文本必须由律师复核确认。
`));
}

// ── legal_generate_argument_or_opinion ─────────────────────────────────

function normalizeLegalWorkProductType(type: string): '代理词' | '法律意见书' | '庭审提纲' | '应对策略' {
  if (/法律意见|意见书|legal\s+opinion/i.test(type)) return '法律意见书';
  if (/庭审|提纲|开庭|trial/i.test(type)) return '庭审提纲';
  if (/策略|应对|方案|strategy/i.test(type)) return '应对策略';
  return '代理词';
}

export async function generateArgumentOrOpinionHandler(args: Record<string, any>, context?: any): Promise<string> {
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const role = roleLabel(textArg(args, 'role'));
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const documentType = normalizeLegalWorkProductType(textArg(args, 'documentType') || textArg(args, 'type') || '代理词');
  const facts = textArg(args, 'facts') || textArg(args, 'materials');
  const evidence = textArg(args, 'evidence') || '待整理证据目录';
  const opponentArguments = textArg(args, 'opponentArguments') || textArg(args, 'opponentMaterials') || '待从对方材料中摘录';
  const objective = textArg(args, 'objective') || textArg(args, 'claims') || '待律师确认办理目标';
  const hasInput = facts || textArg(args, 'evidence') || textArg(args, 'opponentArguments') ||
    textArg(args, 'opponentMaterials') || listArg(args, 'issues').length > 0;
  const issues = inferDisputeFocuses(args);

  if (!hasInput) {
    return '请提供案件事实、争议焦点、证据材料或对方材料，以便生成代理词/法律意见书草稿。';
  }
  const finish = (report: string) => appendLegalWorkProductArchiveSection(report, args, context, {
    caseName,
    title: `${caseName}${documentType}草稿`,
    type: 'pleading',
    cause: caseType,
  });

  const prompt = `你是一名资深诉讼律师。请生成“${documentType}”草稿，供律师复核后使用。

## 案件信息
${buildCaseContext(args)}

## 材料范围
${materialSummary(args)}

## 办理目标
${objective}

## 争议焦点
${issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 输出要求
1. 输出${documentType}草稿，不要输出内部方法论标题。
2. 所有事实必须对应证据；证据不足处标注“待补证”。
3. 所有法条、案例、裁判规则必须标注“待检索/待核验”或已确认来源，不得编造。
4. 结尾加入律师复核清单和人工确认节点。
5. 根据文书类型调整结构：
   - 代理词：首部、案件事实摘要、争议焦点、事实认定与证据评价、法律适用意见、结论请求、复核清单。
   - 法律意见书：委托事项、事实摘要、问题清单、法律分析、风险提示、处理建议、附件清单。
   - 庭审提纲：庭审目标、发问提纲、举证质证、争点回应、庭后补充事项。
请用中文 Markdown 输出。`;

  try {
    const text = await runLegalLLM(prompt, context, 3000);
    if (text) return finish(sanitizeLegalWorkProductOutput(text));
  } catch { /* fall through */ }

  const focusLines = issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n');
  const commonReview = [
    '核验所有法条是否现行有效，并补充条款号和来源。',
    '核验类案的案号、法院、裁判日期、裁判规则和引用边界。',
    '核对证据原件、页码、形成时间、来源、证明目的和质证风险。',
    '最终签发、提交、发送或庭审发表前由律师人工确认。',
  ];

  if (documentType === '法律意见书') {
    return finish(sanitizeLegalWorkProductOutput(`# ${caseName} 法律意见书草稿

## 一、委托事项
围绕${caseType}，就“${objective}”形成初步法律意见，供律师复核。

## 二、事实摘要
${facts || '待补充案件事实和时间线。'}

## 三、问题清单
${focusLines}

## 四、法律分析
- 我方身份：${role}
- 对方主张/风险：${opponentArguments}
- 证据基础：${evidence}
- 法律依据：待检索现行有效法律、司法解释和可比类案后补充。

## 五、风险提示
- 事实不能被证据证明的部分应标注“待补证”，不得作为确定性结论。
- 金额、期限、利息、违约金、责任比例等需结合合同、流水、票据和鉴定材料复核。
- 未核验的法条和案例不得对外引用。

## 六、处理建议
- 先补齐争议焦点对应证据，再形成最终意见。
- 需要类案补强时，按人民法院案例库、中国裁判文书网、法蝉、Alpha 顺序检索。
- 涉公司主体和财产线索时，使用授权浏览器核验企查查和国家企业信用信息公示系统。

## 七、复核清单
${commonReview.map(item => `- ${item}`).join('\n')}
`));
  }

  if (documentType === '庭审提纲') {
    return finish(sanitizeLegalWorkProductOutput(`# ${caseName} 庭审提纲草稿

## 一、庭审目标
以${role}立场围绕“${objective}”组织发问、举证、质证和争点回应。

## 二、争议焦点
${focusLines}

## 三、发问提纲
- 围绕合同/行为形成、履行过程、通知送达、金额计算、损失后果逐项发问。
- 对对方证据来源、形成时间、原件状态、证明目的和前后矛盾进行追问。
- 对我方关键证据的形成过程、真实性和关联性进行补强说明。

## 四、举证质证
- 我方证据：${evidence}
- 对方观点：${opponentArguments}
- 质证方向：真实性、合法性、关联性、证明目的、证明力大小和反证需求。

## 五、庭后补充事项
- 补交证据目录、金额计算表、类案检索表和法条核验表。
- 根据庭审归纳焦点调整代理词和书面意见。

## 六、复核清单
${commonReview.map(item => `- ${item}`).join('\n')}
`));
  }

  if (documentType === '应对策略') {
    return finish(sanitizeLegalWorkProductOutput(`# ${caseName} 应对策略草稿

## 一、办理目标
${objective}

## 二、争议焦点
${focusLines}

## 三、我方有利点
- 已有证据：${evidence}
- 可从事实经过、履行行为、通知记录、金额计算和对方违约/过错中提炼有利事实。

## 四、主要风险
- 对方观点：${opponentArguments}
- 待补证或待核验事实不得作为确定性结论。
- 管辖、时效、主体资格、证据原件和金额计算需单独复核。

## 五、行动清单
- 先补齐证据目录和证明目的。
- 核验现行有效法律和司法解释。
- 按法院层级检索类案，并登记来源。
- 涉执行或财产保全时，补充企业信息、股权穿透和被执行人情况查询。

## 六、复核清单
${commonReview.map(item => `- ${item}`).join('\n')}
`));
  }

  return finish(sanitizeLegalWorkProductOutput(`# ${caseName} 代理词草稿

## 一、首部
代理人接受委托，依据已提交材料和庭审情况，就${caseType}发表代理意见。本稿为系统草稿，需律师复核后使用。

## 二、案件事实摘要
${facts || '待补充案件事实、时间线和庭审确认事项。'}

## 三、争议焦点
${focusLines}

## 四、事实认定与证据评价
- 我方证据：${evidence}
- 对方主张：${opponentArguments}
- 证据评价方向：真实性、合法性、关联性、证明目的、证明力大小、是否存在反证或待补证。

## 五、法律适用意见
- 法律依据需以现行有效法律、司法解释和可比类案为准。
- 未完成核验的条款和案例统一标注“待检索/待核验”。
- 围绕争议焦点逐项说明请求或抗辩理由。

## 六、结论请求
请法院结合查明事实、证据规则和已核验法律依据，支持我方关于“${objective}”的意见。

## 七、复核清单
${commonReview.map(item => `- ${item}`).join('\n')}
`));
}
