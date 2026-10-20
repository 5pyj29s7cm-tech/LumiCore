import path from "path";
import { legalWrite, assertLegalExecutionActive } from "../../../../legal/execution";
import fs from "fs";
import * as LegalCases from "../../../../org/legal_cases";
import { legalTemporalOptions, buildCaseContext, runLegalLLMWithin, LegalStructuredResponseError, textArg, roleLabel, listArg, inferDisputeFocuses, buildSearchQueries, legalWorkspaceId, resolveWritableOutputDir, ensureLegalDeliveryRoot } from "./context";
import { buildEvidenceReviewRows, LEGAL_CASE_SEARCH_ORDER, normalizeLegalCaseStage, workspaceMaterialInputs, makeWorkspaceWorkflowCase, workspaceMaterialIndexRows, formatLegalWorkflowRows, formatLegalWorkflowActionQueue, formatEvidenceReviewRows, formatEvidenceGapList } from "./case_workflow";
import { ownCaseNumbersFromArgs, evaluateCurrentLawGate, legalReasoningGateStatus, formatCitationList } from "./citations";

import { buildReasoningSources, buildMaterialSources, reasoningGenerationPrompt, resolveReasoningEntries, reasoningReviewPrompt, applyReasoningReview, type Source } from "../legal_reasoning_generation";
import { inspectLegalReasoningLinks } from "../legal_reasoning_links";
import { LEGAL_REASONING_MODEL_TIMEOUT_MS, LEGAL_REASONING_WORKFLOW_BUDGET_MS, LEGAL_STRUCTURED_MAX_TOKENS } from "../../../../legal/budgets";
import { isLegalSourceMaterial } from "../../../../../shared/legal_workflow_receipts";

function buildLegalReasoningMatrixMarkdown(args: Record<string, any>, orgId?: string): string {
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const role = roleLabel(textArg(args, 'role'));
  const caseType = textArg(args, 'caseType') || textArg(args, 'cause') || '待确认案由';
  const facts = textArg(args, 'facts') || textArg(args, 'materials') || textArg(args, 'transcript') || '待补充案件事实';
  const evidence = textArg(args, 'evidence') || '待整理证据材料';
  const legalAuthorities = textArg(args, 'legalAuthorities') || textArg(args, 'statutes') || '待检索现行有效法律、司法解释和裁判规则';
  const similarCases = textArg(args, 'similarCases') || '待按法院层级检索类案';
  const issues = (listArg(args, 'issues').length ? listArg(args, 'issues') : inferDisputeFocuses({ ...args, facts, caseType })).slice(0, 12);
  const queries = buildSearchQueries({ ...args, facts, caseType, issues });
  const evidenceRows = buildEvidenceReviewRows({ ...args, facts, evidence, caseType });
  const lawGate = evaluateCurrentLawGate([
    legalAuthorities,
    textArg(args, 'content'),
    textArg(args, 'documentText'),
  ].filter(Boolean).join('\n'), orgId, ownCaseNumbersFromArgs(args), textArg(args, 'factDate'), legalTemporalOptions(args));
  const gateStatus = legalReasoningGateStatus(lawGate);
  const searchOrder = LEGAL_CASE_SEARCH_ORDER.join(' > ');
  const majorRows = issues.map(issue =>
    `| ${issue.replace(/\|/g, ' ')} | ${legalAuthorities.replace(/\|/g, ' ').slice(0, 160)} | 围绕请求权基础、抗辩构成、举证责任和裁判规则解释适用边界 | ${similarCases.replace(/\|/g, ' ').slice(0, 120)}；检索顺序：${searchOrder} | ${gateStatus} |`,
  ).join('\n');
  const minorRows = evidenceRows.map(row =>
    `| ${row.index} | ${row.fact.replace(/\|/g, ' ')} | ${row.name.replace(/\|/g, ' ')} | ${row.proofPurpose.replace(/\|/g, ' ')} | ${row.authenticity}；${row.legality}；${row.relevance} | ${row.gap} |`,
  ).join('\n');
  const conclusionRows = issues.map(issue =>
    `| ${issue.replace(/\|/g, ' ')} | 以已归集事实和证据目录为基础，未能证明部分标注“待补证” | 将大前提规则适用于小前提事实，形成可复核的支持/抗辩路径 | 可转入答辩状、代理词、法律意见书或诉讼策略；正式交付前必须通过现行有效法律硬门槛 |`,
  ).join('\n');

  return `# ${caseName} 法律分析三段论底稿

- 案由/类型：${caseType}
- 我方身份：${role}
- 生成时间：${new Date().toISOString()}
- 状态：律师复核稿；用于办案分析、文书起草和外部检索，不得直接作为最终对外法律意见。

## 一、大前提：检索法律、解释法律、类案补强

- 现行有效法律预检：${gateStatus}
- 法源处理：先检索现行有效法律和司法解释，再按类案层级补强裁判规则。
- 类案检索顺序：${searchOrder}
- 未核验法条和类案不得进入正式交付包；正式文书需经 legal_finalize_delivery_package 硬门槛。

| 争议焦点 | 检索法律 | 解释法律 | 类案补强 | 当前状态 |
| --- | --- | --- | --- | --- |
${majorRows}

## 二、小前提：待证事实、证据材料、举证质证

- 事实摘要：${facts.slice(0, 800)}
- 证据摘要：${evidence.slice(0, 800)}

| 序号 | 待证事实 | 证据材料 | 证明目的 | 举证/质证处理 | 缺口或风险 |
| --- | --- | --- | --- | --- | --- |
${minorRows}

## 三、结论：涵摄、文书表达、风险

| 争议焦点 | 事实基础 | 涵摄结论 | 可转化成果 |
| --- | --- | --- | --- |
${conclusionRows}

## 四、阻断项和复核项

- 现行有效法律阻断项：${lawGate.blockingStatutes.length}
- 未确认案例引用：${lawGate.missingCaseChecks.length}
- 证据缺口：${evidenceRows.filter(row => /待|缺|补|风险/.test(row.gap)).length}

### 阻断法条
${formatCitationList(lawGate.blockingStatutes).join('\n')}

### 未确认案例
${formatCitationList(lawGate.missingCaseChecks).join('\n')}

## 五、下一步工具链

1. legal_external_research_plan：生成外部法条、类案、主体信息检索行动单。
2. legal_search_external_authorities：在已授权 API 或网页协作结果中登记法源和类案。
3. legal_generate_litigation_packet：生成起诉状、答辩状、质证意见和证据目录工作底稿。
4. legal_generate_argument_or_opinion：生成代理词、法律意见书、庭审提纲或应对策略。
5. legal_finalize_delivery_package：正式交付前强制核验现行有效法律。

## 六、检索关键词
${queries.map((query, index) => `${index + 1}. ${query}`).join('\n')}
`;
}

export async function resolveLegalReasoningDraft(args: Record<string, any>, context?: any, currentSources: Source[] = []) {
  assertLegalExecutionActive(context);
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  let sourceCase = textArg(args, 'caseId') ? LegalCases.getCase(orgId, textArg(args, 'caseId'), userId) : null;
  let links = args.reasoningLinks;
  let generationFailure = '';
  let reasoningReviewed = false;
  let generationErrors: string[] = [];
  if (sourceCase && currentSources.length) {
    const originals = sourceCase.materials.filter(isLegalSourceMaterial);
    const knownQuotes = new Set(buildMaterialSources(originals).map(source => source.quote));
    const pending = currentSources.filter(source => !knownQuotes.has(source.quote)
      && !originals.some(material => source.quote === `[材料 ${material.id}：${material.title}]`));
    const pendingFields = [...new Set(pending.map(source => source.materialId))];
    if (pendingFields.length && args.persistCase === false) generationFailure = '本次输入尚未归档；persistCase=false，未忽略新材料或消耗模型调用，请先归档原件再继续。';
    else if (pendingFields.length) {
      if (!LegalCases.getCase(orgId, sourceCase.id, userId, 'write')) generationFailure = '本次输入尚未归档：当前案件不可写，未生成旧材料分析。';
      else for (const field of pendingFields) {
        const added = pending.filter(source => source.materialId === field);
        const content = [...new Set(added.map(source => source.quote))].join('\n');
        const material = legalWrite(() => LegalCases.addMaterial(orgId, userId, sourceCase!.id, {
          type: 'note', title: added[0].title + '（本次新增原句，待核实）', content, source: 'manual',
        }));
        if (!material) { generationFailure = '本次输入归档未完成，未生成旧材料分析。'; break; }
      }
      sourceCase = LegalCases.getCase(orgId, sourceCase.id, userId) || sourceCase;
    }
  }
  if (!generationFailure && !Array.isArray(links) && sourceCase && context?.llmGetters) {
    const sources = buildReasoningSources(sourceCase, textArg(args, 'legalAuthorities'), orgId, { ...legalTemporalOptions(args), actorUserId: userId });
    const summary = buildCaseContext({ ...args, facts: '', evidence: '', complaint: '', opponentMaterials: '', materials: '', transcript: '', trialNotes: '', legalAuthorities: '' }) + '\n用户所列争点：' + JSON.stringify(listArg(args, 'issues'));
    const prompt = reasoningGenerationPrompt(sources, summary);
    const decode = (raw: string) => JSON.parse(raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''));
    try {
      const deadline = Date.now() + LEGAL_REASONING_WORKFLOW_BUDGET_MS;
      let request = prompt;
      if (!sources.sources.length || !sources.rules.length) generationFailure = '缺少已归档原始材料或已核验的具体法条，分析未完成。';
      // Generation, correction and applicability review share the same deadline.
      for (let attempt = 0; !generationFailure && attempt < 2; attempt++) {
        const remaining = Math.min(LEGAL_REASONING_MODEL_TIMEOUT_MS, deadline - Date.now());
        if (remaining <= 0) { generationFailure = '分析时间预算已用尽，未完成来源关联校正。'; break; }
        const raw = await runLegalLLMWithin(request, context, LEGAL_STRUCTURED_MAX_TOKENS, remaining, true);
        if (!raw) { generationFailure = '模型未在时间预算内返回分析正文。'; break; }
        try {
          const resolved = resolveReasoningEntries(decode(raw), sources);
          links = resolved.links;
          generationErrors = resolved.errors;
        } catch { generationFailure = '模型返回的分析格式不完整，未取得可核验的结构化结果。'; }
        const inspected = inspectLegalReasoningLinks(links, sourceCase, orgId, { ...legalTemporalOptions(args), actorUserId: userId });
        if (!generationErrors.length && inspected.passed) break;
        generationErrors = [...generationErrors, ...inspected.errors];
        request = `${prompt}\n上次编号或格式校验未通过，请修正这些问题：${JSON.stringify(generationErrors)}\n上次草稿：${raw}`;
      }
      for (let reviewAttempt = 0; !generationFailure && !generationErrors.length && Array.isArray(links) && links.length && reviewAttempt < 2; reviewAttempt++) {
        // Generation and review share one deadline. Real four-issue reviews can
        // require over 50 seconds; do not discard them at an arbitrary sublimit.
        const remaining = Math.min(LEGAL_REASONING_MODEL_TIMEOUT_MS, deadline - Date.now());
        if (remaining <= 0) generationFailure = '适用复核时间预算已用尽，分析未完成。';
        else {
          const raw = await runLegalLLMWithin(reasoningReviewPrompt(links, summary, sources), context, LEGAL_STRUCTURED_MAX_TOKENS, remaining, true);
          if (!raw) generationFailure = '法律适用复核超时，已保留待复核底稿。';
          else {
            const reviewed = applyReasoningReview(decode(raw), links, sources);
            links = reviewed.links;
            generationErrors = reviewed.errors;
            reasoningReviewed = !reviewed.errors.length;
            if (reasoningReviewed) break;
            // Fill explicitly identified omissions once within the same budget.
            // A missing prerequisite stays conditional; it must not be invented.
            if (reviewAttempt === 0 && reviewed.errors.length && reviewed.errors.every(error => /^核心争议尚未分析：|^第\d+项适用分析缺少依据：/.test(error))) {
              const repairBudget = Math.min(LEGAL_REASONING_MODEL_TIMEOUT_MS, deadline - Date.now());
              if (repairBudget > 0) {
                const repair = await runLegalLLMWithin(`${prompt}\n复核已指出以下覆盖不足或规则不适用，补充对应分析，删除与本案请求无关的规则条目，并返回完整entries。不要求用完所有法条。资料缺漏只作条件分析，不能补造事实；核算条件和付款关联有疑问时，明确说明如何核对，不得当成已证实。\n${JSON.stringify(reviewed.errors)}\n已复核底稿：${JSON.stringify(links.map((link: any) => ({ issue: link.issue, application: link.application, conclusion: link.conclusion, limitations: link.limitations })))}`,
                  context, LEGAL_STRUCTURED_MAX_TOKENS, repairBudget, true);
                if (repair) {
                  const resolved = resolveReasoningEntries(decode(repair), sources);
                  const check = inspectLegalReasoningLinks(resolved.links, sourceCase, orgId, { ...legalTemporalOptions(args), actorUserId: userId });
                  if (!resolved.errors.length && check.passed) { links = resolved.links; generationErrors = []; }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      assertLegalExecutionActive(context);
      generationFailure = error instanceof LegalStructuredResponseError
        ? error.reason === 'output_limit' ? '模型输出额度已耗尽，未取得完整分析正文。' : '模型已结束但未返回分析正文。'
        : /504|请求超时|gateway.*timeout/i.test(error instanceof Error ? error.message : '')
          ? '官方模型线路返回超时，分析未完成；原始材料和已生成草稿已保留。'
          : '模型调用失败，分析未完成。';
    }
  } else if (!generationFailure && !Array.isArray(links)) {
    generationFailure = !sourceCase ? '需要先将原始材料归档到明确案件，再进行来源关联分析。' : '模型服务未连接，当前仅保留分析模板。';
  }
  const traceability = inspectLegalReasoningLinks(links, sourceCase, orgId, { ...legalTemporalOptions(args), actorUserId: userId });
  traceability.errors.push(...generationErrors);
  if (generationFailure) traceability.errors.push(generationFailure);
  traceability.passed = traceability.errors.length === 0;
  return { sourceCase, traceability, reasoningReviewed, generationFailure };
}

export async function reasoningMatrixHandler(args: Record<string, any>, context?: any): Promise<string> {
  const hasInput = textArg(args, 'facts') || textArg(args, 'materials') || textArg(args, 'evidence') ||
    textArg(args, 'legalAuthorities') || textArg(args, 'complaint') || textArg(args, 'transcript') ||
    listArg(args, 'issues').length > 0;
  if (!hasInput) return '请提供 facts / evidence / legalAuthorities / issues / materials 中至少一项，用于生成法律分析三段论底稿。';

  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const persist = args.persistCase !== false;
  const writeFiles = args.writeFiles !== false && args.writeFile !== false;
  const markdown = buildLegalReasoningMatrixMarkdown(args, orgId);
  const lawGate = evaluateCurrentLawGate([
    textArg(args, 'legalAuthorities'),
    textArg(args, 'content'),
    textArg(args, 'documentText'),
  ].filter(Boolean).join('\n'), orgId, ownCaseNumbersFromArgs(args), textArg(args, 'factDate'), legalTemporalOptions(args));

  let reasoningPath = '';
  if (writeFiles) {
    const outputDir = resolveWritableOutputDir(
      textArg(args, 'outputDir'),
      ensureLegalDeliveryRoot(orgId),
      caseName,
      'reasoning_matrix',
    );
    reasoningPath = path.join(outputDir, 'legal-reasoning-matrix.md');
    legalWrite(() => fs.writeFileSync(reasoningPath, markdown, 'utf-8'));
  }

  let caseFile: LegalCases.OrgLegalCaseFile | null = null;
  let archiveLine = '- 案件空间：未归档（persistCase=false）';
  if (persist) {
    const explicitCaseId = textArg(args, 'caseId');
    caseFile = explicitCaseId ? LegalCases.getCase(orgId, explicitCaseId, userId, 'write') : null;
    if (!caseFile) caseFile = LegalCases.listCases(orgId, caseName, 1, userId)[0] || null;
    if (!caseFile) {
      caseFile = legalWrite(() => LegalCases.createCase(orgId, userId, {
        title: caseName,
        party: textArg(args, 'parties') || roleLabel(textArg(args, 'role')),
        cause: textArg(args, 'caseType') || textArg(args, 'cause'),
        court: textArg(args, 'court'),
        stage: normalizeLegalCaseStage(textArg(args, 'stage')),
        notes: (textArg(args, 'facts') || textArg(args, 'materials') || '').slice(0, 3000),
      }));
    }
    const material = legalWrite(() => LegalCases.addMaterial(orgId, userId, caseFile.id, {
      type: 'note',
      title: `${caseName}法律分析三段论底稿`,
      content: markdown,
      localPath: reasoningPath || undefined,
      source: 'tool',
    }));
    archiveLine = material
      ? `- 案件空间：已归档 caseId=${caseFile.id} materialId=${material.id}`
      : `- 案件空间：未归档 caseId=${caseFile.id}`;
  }

  return [
    '# 法律分析三段论底稿已生成',
    '',
    `- 案件：${caseName}`,
    `- 现行有效法律预检：${legalReasoningGateStatus(lawGate)}`,
    reasoningPath ? `- 底稿文件：${reasoningPath}` : '- 底稿文件：未写入（writeFiles=false）',
    archiveLine,
    '',
    '## 下一步',
    '- 用 legal_external_research_plan 补齐法条、类案和主体检索。',
    '- 用 legal_generate_argument_or_opinion 生成代理词/法律意见书律师复核稿。',
    '- 正式交付前用 legal_finalize_delivery_package 触发现行有效法律硬门槛。',
  ].join('\n');
}

export async function caseWorkspaceHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || textArg(args, 'title') || '未命名案件';
  const role = roleLabel(textArg(args, 'role'));
  const caseType = textArg(args, 'caseType') || textArg(args, 'cause') || '待确认案由';
  const court = textArg(args, 'court');
  const parties = textArg(args, 'parties');
  const claims = textArg(args, 'claims') || textArg(args, 'objective');
  const facts = textArg(args, 'facts') || textArg(args, 'materials');
  const evidence = textArg(args, 'evidence');
  const stage = normalizeLegalCaseStage(textArg(args, 'stage'));
  const persist = args.persistCase !== false;
  const focuses = inferDisputeFocuses({ ...args, caseType, facts });
  const queries = buildSearchQueries({ ...args, caseType, facts, issues: focuses });
  const lawGate = evaluateCurrentLawGate([
    textArg(args, 'legalAuthorities'),
    textArg(args, 'content'),
    textArg(args, 'documentText'),
    facts,
  ].filter(Boolean).join('\n'), orgId, ownCaseNumbersFromArgs(args), textArg(args, 'factDate'), legalTemporalOptions(args));

  let caseFile: LegalCases.OrgLegalCaseFile | null = null;
  if (persist) {
    const explicitCaseId = textArg(args, 'caseId');
    caseFile = explicitCaseId ? LegalCases.getCase(orgId, explicitCaseId, userId, 'write') : null;
    if (!caseFile) {
      caseFile = LegalCases.listCases(orgId, caseName, 1, userId)[0] || null;
    }
    const patch = {
      title: caseName,
      party: parties || role,
      cause: caseType,
      court,
      stage,
      notes: [
        claims ? `办理目标：${claims}` : '',
        facts ? `事实摘要：${facts.slice(0, 2000)}` : '',
        evidence ? `证据摘要：${evidence.slice(0, 1200)}` : '',
      ].filter(Boolean).join('\n'),
    };
    caseFile = caseFile
      ? legalWrite(() => LegalCases.updateCase(orgId, userId, caseFile.id, patch)) || caseFile
      : legalWrite(() => LegalCases.createCase(orgId, userId, patch));

    for (const material of workspaceMaterialInputs(args)) {
      legalWrite(() => LegalCases.addMaterial(orgId, userId, caseFile.id, {
        ...material,
        source: 'tool',
      }));
    }
    caseFile = LegalCases.getCase(orgId, caseFile.id, userId) || caseFile;
  }

  const workflowCase = caseFile || makeWorkspaceWorkflowCase(args, {
    orgId,
    caseName,
    role,
    caseType,
    court,
    parties,
    claims,
    facts,
    evidence,
    stage,
  });
  const workflow = LegalCases.evaluateCaseWorkflow(workflowCase, {
    currentLawGate: lawGate.statuteChecks.length === 0 ? 'none' : lawGate.passed ? 'passed' : 'blocked',
    currentLawBlockingSummary: lawGate.blockingStatutes.length
      ? formatCitationList(lawGate.blockingStatutes).join('；')
      : '',
  });
  const workflowNext = workflow.nextStep
    ? `${workflow.nextStep.label}：${workflow.nextStep.nextStep}`
    : '闭环已完成，进入持续复核和归档。';
  const materialRows = workspaceMaterialIndexRows(caseFile?.materials || []);
  const evidenceReviewRows = buildEvidenceReviewRows({ ...args, caseType, facts, evidence });

  return `# ${caseFile?.title || caseName} 案件工作台

## 一、案件空间
- 案件现有材料：${caseFile ? `共 ${caseFile.materials.length} 份` : '尚未入案'}
- 阶段：${stage}
- 我方身份：${role}
- 案由/类型：${caseType}
- 法院/机构：${court || '待确认'}
- 当事人：${parties || '待补充'}
- 办理目标：${claims || '待补充'}

## 二、闭环状态
- 完成度：${workflow.doneCount}/${workflow.steps.length}（${workflow.completionRatio}%）
- 阻断项：${workflow.blockedCount}
- 待补项：${workflow.missingCount}
- 下一动作：${workflowNext}

| 模块 | 状态 | 判断依据 | 下一步 |
| --- | --- | --- | --- |
${formatLegalWorkflowRows(workflow.steps)}

${formatLegalWorkflowActionQueue(workflow)}

## 三、材料索引
| 序号 | 类型 | 标题 | 来源 | 归档时间 |
| --- | --- | --- | --- | --- |
${materialRows}

## 四、争议焦点
${focuses.map((focus, index) => `${index + 1}. ${focus}`).join('\n')}

## 五、证据目录与三性审查矩阵
| 编号 | 证据名称 | 待证事实 | 证明目的 | 真实性核验 | 合法性核验 | 关联性核验 | 缺口/质证风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${formatEvidenceReviewRows(evidenceReviewRows)}

## 六、证据缺口与补强清单
${formatEvidenceGapList(evidenceReviewRows)}

## 七、法源与类案检索顺序
1. 国家法律法规数据库/已授权权威库：先确认法律、司法解释现行有效。
2. 人民法院案例库：优先检索指导性/参考性/权威案例。
3. 中国裁判文书网：按法院层级筛选，顺序为 ${LEGAL_CASE_SEARCH_ORDER.join(' > ')}。
4. 法蝉 / Alpha：在律所授权账号内补充商业库案例和裁判规则。
5. 企查查 / 国家企业信用信息公示系统 / 执行信息公开网：核验主体、股东、涉诉、被执行人和财产线索。
6. 人民法院在线服务：仅做立案材料核对和人工提交协作。

## 八、推荐检索词
${queries.map((query, index) => `${index + 1}. ${query}`).join('\n')}

## 九、边界
- Lumi 可以归集材料、生成草稿、打开授权网页登录、记录来源和生成交付包。
- 自动立案、签名、盖章、缴费、确认送达、撤回、和解承诺、最终法律意见必须由律师或当事人确认。
`;
}

export async function caseWorkflowStatusHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || textArg(args, 'title') || textArg(args, 'query');
  const caseId = textArg(args, 'caseId');
  const role = roleLabel(textArg(args, 'role'));
  const caseType = textArg(args, 'caseType') || textArg(args, 'cause') || '待确认案由';
  const court = textArg(args, 'court');
  const parties = textArg(args, 'parties');
  const claims = textArg(args, 'claims') || textArg(args, 'objective');
  const facts = textArg(args, 'facts') || textArg(args, 'materials');
  const evidence = textArg(args, 'evidence');
  const stage = normalizeLegalCaseStage(textArg(args, 'stage'));

  let caseFile = caseId ? LegalCases.getCase(orgId, caseId, userId) : null;
  if (!caseFile && caseName) {
    caseFile = LegalCases.listCases(orgId, caseName, 1, userId)[0] || null;
  }

  const hasInlineMaterial = [
    caseName,
    parties,
    claims,
    facts,
    evidence,
    textArg(args, 'complaint'),
    textArg(args, 'opponentMaterials'),
    textArg(args, 'transcript'),
    textArg(args, 'trialNotes'),
    textArg(args, 'legalAuthorities'),
    textArg(args, 'similarCases'),
    textArg(args, 'content'),
    textArg(args, 'documentText'),
  ].some(Boolean);

  if (!caseFile && !hasInlineMaterial) {
    return '请提供 caseId / caseName，或直接提供 facts、evidence、legalAuthorities 等案件材料，用于评估案件闭环状态。';
  }

  const workflowCase = caseFile || makeWorkspaceWorkflowCase(args, {
    orgId,
    caseName: caseName || '未命名案件',
    role,
    caseType,
    court,
    parties,
    claims,
    facts,
    evidence,
    stage,
  });
  const gateText = [
    textArg(args, 'legalAuthorities'),
    textArg(args, 'content'),
    textArg(args, 'documentText'),
    textArg(args, 'facts'),
    textArg(args, 'materials'),
    caseFile?.notes || '',
    ...(caseFile?.materials || []).map(material => material.content || ''),
  ].filter(Boolean).join('\n');
  const lawGate = evaluateCurrentLawGate(gateText, orgId, ownCaseNumbersFromArgs(args), textArg(args, 'factDate'), legalTemporalOptions(args));
  const workflow = LegalCases.evaluateCaseWorkflow(workflowCase, {
    currentLawGate: lawGate.statuteChecks.length === 0 ? 'none' : lawGate.passed ? 'passed' : 'blocked',
    currentLawBlockingSummary: lawGate.blockingStatutes.length
      ? formatCitationList(lawGate.blockingStatutes).join('；')
      : '',
  });
  const next = workflow.nextStep
    ? `${workflow.nextStep.label}：${workflow.nextStep.nextStep}`
    : '闭环已完成，进入持续复核和归档。';
  const title = caseFile?.title || caseName || '未命名案件';

  return `# ${title} 案件闭环状态

- 案件现有材料：${caseFile ? `共 ${caseFile.materials.length} 份` : '尚未入案'}
- 完成度：${workflow.doneCount}/${workflow.steps.length}（${workflow.completionRatio}%）
- 阻断项：${workflow.blockedCount}
- 待补项：${workflow.missingCount}
- 可进入文书起草：${workflow.readyForDraft ? '是' : '否'}
- 可进入正式交付：${workflow.readyForFormalDelivery ? '是' : '否'}
- 下一动作：${next}

| 模块 | 状态 | 判断依据 | 下一步 |
| --- | --- | --- | --- |
${formatLegalWorkflowRows(workflow.steps)}

${formatLegalWorkflowActionQueue(workflow)}

## 边界
- 本状态用于办案推进和工具选择，不替代律师对事实、证据、法源和程序风险的最终判断。
- 状态为“阻断”的模块必须先处理；状态为“待人工确认”的模块不得由 Lumi 自动提交、签名、缴费或对外承诺。`;
}
