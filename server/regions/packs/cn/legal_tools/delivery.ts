import path from "path";
import fs from "fs";
import { parseDocument } from "../../../../legal/parser";
import { legalWrite, legalExecutionSignal } from "../../../../legal/execution";
import { createLegalArticle, indexLegalArticle, verifyMultipleCitations } from "../../../../legal/kb";
import * as LegalCases from "../../../../org/legal_cases";
import { legalTemporalOptions, textArg, expandLocalPath, legalWorkspaceId, resolveWritableOutputDir, ensureLegalDeliveryRoot, safeFileSegment } from "./context";
import { formatCitationReportMarkdown, findArchivedLegalReasoningGateText, ownCaseNumbersFromArgs, evaluateCurrentLawGate, evaluateLegalReasoningGate, formatCurrentLawGateBlock, formatCitationList, formatCaseSourceGateBlock } from "./citations";
import { markdownTitle, normalizeFormalDocumentType, buildFormalLegalMarkdown, writeDocxFromMarkdown, tryConvertDocxToPdf } from "./documents";
import { appendLegalCaseMaterial } from "./case_workflow";

// ── legal_generate_citation_verification_report ─────────────────────────

async function readLegalTextForReport(args: Record<string, any>): Promise<{ text: string; title: string; source: string }> {
  const content = textArg(args, 'text') || textArg(args, 'content');
  if (content) {
    return {
      text: content,
      title: textArg(args, 'title') || textArg(args, 'caseName') || '粘贴文本',
      source: 'pasted_text',
    };
  }

  const filePath = textArg(args, 'filePath');
  if (filePath) {
    const resolved = path.resolve(expandLocalPath(filePath));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`待核验文件不存在：${resolved}`);
    }
    const parsed = await parseDocument(resolved);
    if (!parsed?.text?.trim()) throw new Error(`无法从文件中提取文本：${resolved}`);
    return {
      text: parsed.text,
      title: textArg(args, 'title') || path.basename(resolved),
      source: resolved,
    };
  }

  throw new Error('请提供 text/content 或 filePath，用于生成引用核验报告。');
}

export async function generateCitationVerificationReportHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const input = await readLegalTextForReport({ ...args, orgId });
  const caseName = textArg(args, 'caseName') || input.title || '未命名案件';
  const outputDir = resolveWritableOutputDir(
    textArg(args, 'outputDir'),
    ensureLegalDeliveryRoot(orgId),
    caseName,
    'citation_report',
  );
  const report = formatCitationReportMarkdown({ ...args, caseName, orgId }, input.text, input.source);
  const reportPath = path.join(outputDir, 'citation-verification-report.md');
  legalWrite(() => fs.writeFileSync(reportPath, report, 'utf-8'));

  let kbLine = '- 知识库：未导入。';
  if (args.importToKb === true || args.confirmedForKb === true) {
    const article = legalWrite(() => createLegalArticle(orgId, userId, {
      title: `${caseName} 引用核验报告`,
      content: report,
      articleType: 'research_note',
      category: 'legal_research_note',
      tags: ['legal:citation-verification', `caseName:${caseName}`],
    }));
    const indexed = await indexLegalArticle(orgId, article.id, context?.userId || userId, { signal: context?.executionSignal || legalExecutionSignal() });
    kbLine = `- 知识库：已导入 articleId=${article.id}，索引块数=${indexed}`;
  }

  const checks = verifyMultipleCitations(input.text, orgId, { ...legalTemporalOptions(args), actorUserId: context?.userId });
  const repealed = checks.filter(item => item.isEffective === false).length;
  const missing = checks.filter(item => !item.exists).length;

  return [
    '# 引用核验报告已生成',
    '',
    `- 案件：${caseName}`,
    `- 来源：${input.source}`,
    `- 报告文件：${reportPath}`,
    `- 引用总数：${checks.length}`,
    `- 已废止/失效风险：${repealed}`,
    `- 未确认存在：${missing}`,
    kbLine,
    '',
    '## 下一步',
    '- 已废止法条应核验与案件事实日期对应的历史版本和时间效力规则；不得机械替换为现行法。',
    '- 未在本地库命中的案号，请到人民法院案例库、裁判文书网或授权商业库人工复核。',
  ].join('\n');
}

// ── legal_finalize_delivery_package ─────────────────────────────────────

export async function finalizeDeliveryPackageHandler(args: Record<string, any>, context?: any): Promise<string> {
  const content = textArg(args, 'content') || textArg(args, 'packetText') || textArg(args, 'documentText');
  if (!content) return '请提供 content / packetText / documentText，用于生成正式交付包。';

  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseId = textArg(args, 'caseId');
  const caseName = textArg(args, 'caseName') || markdownTitle(content, '未命名案件');
  const documentType = normalizeFormalDocumentType(textArg(args, 'documentType') || textArg(args, 'type'));
  const outputDir = resolveWritableOutputDir(
    textArg(args, 'outputDir'),
    ensureLegalDeliveryRoot(orgId),
    caseName,
    'delivery_package',
  );

  const archivedReasoning = findArchivedLegalReasoningGateText(args, orgId, userId);
  const reasoningArgs = archivedReasoning ? { ...args, archivedReasoning } : args;
  const caseFileForDeliveryGate = caseId ? LegalCases.getCase(orgId, caseId, userId) : null;
  const citationGateArgs = {
    ...args,
    caseName,
    orgId,
    caseNumber: textArg(args, 'caseNumber') || caseFileForDeliveryGate?.caseNumber || '',
  };
  const ownCaseNumbers = ownCaseNumbersFromArgs(citationGateArgs);
  const formalMarkdown = buildFormalLegalMarkdown({ ...args, caseName, documentType }, content);
  const citationReport = formatCitationReportMarkdown(citationGateArgs, formalMarkdown, 'formal_delivery_document');
  const currentLawGate = evaluateCurrentLawGate(formalMarkdown, orgId, ownCaseNumbers, textArg(args, 'factDate'), { ...legalTemporalOptions(args), actorUserId: context?.userId });
  const reasoningGate = evaluateLegalReasoningGate(reasoningArgs, content);
  const reasoningSourceRow = archivedReasoning
    ? '| 内部推理底稿 | 案件工作台 | 已归档三段论底稿 | 案件材料 | 已归档 | 三段论推理链 gate | 已复用 |'
    : '| 内部推理底稿 | legal_case_reasoning_matrix / reasoningSummary | 待登记 | 待登记 | 待登记 | 三段论推理链 gate | 待补充 |';
  const sourceRegister = [
    `# ${caseName} 来源登记表`,
    '',
    '| 来源类型 | 来源名称/平台 | 标题/案号 | 链接/文件路径 | 取得时间 | 用途 | 复核状态 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| 法律法规 | 国家法律法规数据库/本地法条库 | 待登记 | 待登记 | 待登记 | 核验现行有效法律 | 律师复核 |',
    '| 类案案例 | 人民法院案例库/裁判文书网/法蝉/Alpha | 待登记 | 待登记 | 待登记 | 类案补强 | 律师复核 |',
    '| 证据材料 | 本地案件材料/当事人提供 | 待登记 | 待登记 | 待登记 | 证明待证事实 | 原件核对 |',
    reasoningSourceRow,
    '| 外部主体信息 | 企查查/国家企业信用/执行信息公开网 | 待登记 | 待登记 | 待登记 | 主体与财产线索核验 | 律师复核 |',
    '',
    '边界：未登记来源的法条、案例、网页摘录和主体信息，不应作为最终对外文书中的确定性依据。',
    '',
  ].join('\n');
  const manifest = [
    `# ${caseName} 正式交付包`,
    '',
    `- 文书类型：${documentType}`,
    `- 生成时间：${new Date().toISOString()}`,
    `- 输出目录：${outputDir}`,
    `- 状态：律师复核稿（引用来源与底稿结构检查已通过；事实、证据与法律结论仍待律师复核）`,
    '',
    '## 文件清单',
    '- 01_formal-document.md：正式文书复核稿',
    '- 02_citation-verification-report.md：法条/案例引用核验报告',
    '- 03_source-register.md：来源登记表',
    '- 04_filing-and-signature-checklist.md：提交、签署、盖章、送达确认清单',
    '',
    '## 边界',
    '- Lumi 只生成本地文件和复核清单，不自动提交、签名、盖章、缴费、发送或确认送达。',
    '- 已废止、失效或未确认的法条引用会阻断正式交付包生成。',
    '- 缺少大前提、小前提或涵摄结论的三段论推理链会阻断正式交付包生成。',
    '- 若需 PDF，请在安装 Microsoft Word 的 Windows 环境中设置 includePdf=true 生成，或由律师确认后另行导出。',
    '',
  ].join('\n');
  const filingChecklist = [
    `# ${caseName} 提交与签署确认清单`,
    '',
    '- 当事人身份、主体资格、授权委托手续是否齐全。',
    '- 诉讼请求/抗辩目标、金额、利息、违约金、保全、诉讼费是否复核。',
    '- 管辖法院、案由、法院平台字段是否与材料一致。',
    '- 证据目录、证明目的、页码、份数、原件核对状态是否一致。',
    '- 律师签字、律所盖章、当事人签章、特别授权范围是否确认。',
    '- 网上立案、缴费、送达确认、撤回、和解等动作必须人工完成。',
    '',
  ].join('\n');

  const formalPath = path.join(outputDir, '01_formal-document.md');
  const reportPath = path.join(outputDir, '02_citation-verification-report.md');
  const sourcePath = path.join(outputDir, '03_source-register.md');
  const checklistPath = path.join(outputDir, '04_filing-and-signature-checklist.md');
  const manifestPath = path.join(outputDir, '00_manifest.md');
  const gatePath = path.join(outputDir, '00_current-law-gate-blocked.md');
  const caseSourceGatePath = path.join(outputDir, '00_case-source-gate-blocked.md');
  const reasoningGatePath = path.join(outputDir, '00_reasoning-gate-blocked.md');

  if (!currentLawGate.passed) {
    const currentLawBlockReason = currentLawGate.missingStatuteCitation
      ? '现行有效法律硬门槛未通过。正式法律交付包未检测到可核验的法条引用。'
      : '现行有效法律硬门槛未通过。存在已废止、失效或未确认的法条引用。';
    const currentLawNextStep = currentLawGate.missingStatuteCitation
      ? '请先补充至少一条现行有效法律或司法解释引用，并完成三段论大前提说明，再重新运行 legal_finalize_delivery_package。'
      : '请先替换或核验法条，再重新运行 legal_finalize_delivery_package。';
    const gateReport = formatCurrentLawGateBlock({
      caseName,
      documentType,
      outputDir,
      reportPath,
      sourcePath,
      gate: currentLawGate,
    });
    legalWrite(() => fs.writeFileSync(reportPath, citationReport, 'utf-8'));
    legalWrite(() => fs.writeFileSync(sourcePath, sourceRegister, 'utf-8'));
    legalWrite(() => fs.writeFileSync(gatePath, gateReport, 'utf-8'));
    const blockedMaterial = appendLegalCaseMaterial({
      orgId,
      userId,
      caseId,
      type: 'note',
      title: `${documentType}交付包阻断记录`,
      content: gateReport,
      localPath: outputDir,
    });
    const caseArchiveLine = caseId
      ? blockedMaterial ? `- 案件空间：已归档阻断记录 materialId=${blockedMaterial.id}` : '- 案件空间：未归档（caseId 不存在或无权限）'
      : '- 案件空间：未归档（未提供 caseId）';

    return [
      '# 正式交付包未生成',
      '',
      `- 案件：${caseName}`,
      `- 文书类型：${documentType}`,
      `- 输出目录：${outputDir}`,
      `- 阻断原因：${currentLawBlockReason}`,
      `- 已识别法条数：${currentLawGate.statuteChecks.length}`,
      `- 阻断法条数：${currentLawGate.blockingStatutes.length}`,
      `- 引用核验报告：${reportPath}`,
      `- 来源登记表：${sourcePath}`,
      `- 阻断记录：${gatePath}`,
      caseArchiveLine,
      '',
      '## 阻断项',
      ...formatCitationList(currentLawGate.blockingStatutes),
      '',
      currentLawNextStep,
    ].join('\n');
  }

  if (!currentLawGate.caseSourcePassed) {
    const gateReport = formatCaseSourceGateBlock({
      caseName,
      documentType,
      outputDir,
      reportPath,
      sourcePath,
      gate: currentLawGate,
    });
    legalWrite(() => fs.writeFileSync(reportPath, citationReport, 'utf-8'));
    legalWrite(() => fs.writeFileSync(sourcePath, sourceRegister, 'utf-8'));
    legalWrite(() => fs.writeFileSync(caseSourceGatePath, gateReport, 'utf-8'));
    const blockedMaterial = appendLegalCaseMaterial({
      orgId,
      userId,
      caseId,
      type: 'note',
      title: `${documentType}案例来源阻断记录`,
      content: gateReport,
      localPath: outputDir,
    });
    const caseArchiveLine = caseId
      ? blockedMaterial ? `- 案件空间：已归档阻断记录 materialId=${blockedMaterial.id}` : '- 案件空间：未归档（caseId 不存在或无权限）'
      : '- 案件空间：未归档（未提供 caseId）';

    return [
      '# 正式交付包未生成',
      '',
      `- 案件：${caseName}`,
      `- 文书类型：${documentType}`,
      `- 输出目录：${outputDir}`,
      `- 阻断原因：类案/案号来源硬门槛未通过。正式法律交付包存在未入库或未核验来源的案例引用。`,
      `- 未核验案例数：${currentLawGate.missingCaseChecks.length}`,
      `- 引用核验报告：${reportPath}`,
      `- 来源登记表：${sourcePath}`,
      `- 阻断记录：${caseSourceGatePath}`,
      caseArchiveLine,
      '',
      '## 未核验案例',
      ...formatCitationList(currentLawGate.missingCaseChecks),
      '',
      '请先导入裁判文书、授权网页摘录或来源登记，再重新运行 legal_finalize_delivery_package。',
    ].join('\n');
  }

  if (!reasoningGate.passed) {
    const reasoningReport = [
      `# ${caseName} reasoning gate blocked`,
      '',
      `- Document type: ${documentType}`,
      `- Checked at: ${new Date().toISOString()}`,
      `- Output directory: ${outputDir}`,
      `- Citation report: ${reportPath}`,
      `- Source register: ${sourcePath}`,
      `- Major premise present: ${reasoningGate.hasMajorPremise ? 'yes' : 'no'}`,
      `- Minor premise present: ${reasoningGate.hasMinorPremise ? 'yes' : 'no'}`,
      `- Conclusion/subsumption present: ${reasoningGate.hasConclusion ? 'yes' : 'no'}`,
      '',
      '## Missing Reasoning Links',
      '',
      ...(reasoningGate.missing.length ? reasoningGate.missing.map(item => `- ${item}`) : ['- None']),
      '',
      '## Required Fix',
      '',
      '- Run legal_case_reasoning_matrix or provide reasoningMatrix/reasoningSummary before generating the formal delivery package.',
      '- The formal package must show a reviewable chain from current law, to facts/evidence, to application/conclusion.',
      '',
    ].join('\n');
    legalWrite(() => fs.writeFileSync(reportPath, citationReport, 'utf-8'));
    legalWrite(() => fs.writeFileSync(sourcePath, sourceRegister, 'utf-8'));
    legalWrite(() => fs.writeFileSync(reasoningGatePath, reasoningReport, 'utf-8'));
    const blockedMaterial = appendLegalCaseMaterial({
      orgId,
      userId,
      caseId,
      type: 'note',
      title: `${documentType}三段论推理链阻断记录`,
      content: reasoningReport,
      localPath: outputDir,
    });
    const caseArchiveLine = caseId
      ? blockedMaterial ? `- 案件空间：已归档阻断记录 materialId=${blockedMaterial.id}` : '- 案件空间：未归档（caseId 不存在或无权限）'
      : '- 案件空间：未归档（未提供 caseId）';

    return [
      '# 正式交付包未生成',
      '',
      `- 案件：${caseName}`,
      `- 文书类型：${documentType}`,
      `- 输出目录：${outputDir}`,
      '- 阻断原因：推理底稿结构不完整。缺少有实质内容的大前提、小前提或涵摄结论；结构完整也不代表法律结论已核实。',
      `- 大前提：${reasoningGate.hasMajorPremise ? '已识别' : '缺失'}`,
      `- 小前提：${reasoningGate.hasMinorPremise ? '已识别' : '缺失'}`,
      `- 涵摄结论：${reasoningGate.hasConclusion ? '已识别' : '缺失'}`,
      `- 引用核验报告：${reportPath}`,
      `- 来源登记表：${sourcePath}`,
      `- 阻断记录：${reasoningGatePath}`,
      caseArchiveLine,
      '',
      '请先运行 legal_case_reasoning_matrix，或提供 reasoningMatrix/reasoningSummary，再重新运行 legal_finalize_delivery_package。',
    ].join('\n');
  }

  legalWrite(() => fs.writeFileSync(manifestPath, manifest, 'utf-8'));
  legalWrite(() => fs.writeFileSync(formalPath, formalMarkdown, 'utf-8'));
  legalWrite(() => fs.writeFileSync(reportPath, citationReport, 'utf-8'));
  legalWrite(() => fs.writeFileSync(sourcePath, sourceRegister, 'utf-8'));
  legalWrite(() => fs.writeFileSync(checklistPath, filingChecklist, 'utf-8'));

  const docxLines: string[] = [];
  if (args.includeDocx !== false) {
    const docxPath = path.join(outputDir, `${safeFileSegment(`${caseName}_${documentType}`, 'formal-document')}.docx`);
    await writeDocxFromMarkdown(formalMarkdown, docxPath);
    docxLines.push(`- DOCX：${docxPath}`);
    if (args.includePdf === true) {
      const pdf = await tryConvertDocxToPdf(docxPath);
      docxLines.push(pdf.ok ? `- PDF：${pdf.pdfPath}` : `- PDF：未生成（${String(pdf.error || '').slice(0, 300)}）`);
    }
  }

  const riskCount = currentLawGate.checks.filter(item => !item.exists || item.isEffective === false).length;
  const archivedMaterial = appendLegalCaseMaterial({
    orgId,
    userId,
    caseId,
    type: 'pleading',
    title: `${documentType}正式交付包`,
    content: [
      formalMarkdown,
      '',
      '---',
      '',
      citationReport,
      '',
      '---',
      '',
      sourceRegister,
    ].join('\n'),
    localPath: outputDir,
  });
  const caseArchiveLine = caseId
    ? archivedMaterial ? `- 案件空间：已归档正式交付包 materialId=${archivedMaterial.id}` : '- 案件空间：未归档（caseId 不存在或无权限）'
    : '- 案件空间：未归档（未提供 caseId）';

  return [
    '# 正式交付包已生成',
    '',
    `- 案件：${caseName}`,
    `- 文书类型：${documentType}`,
    `- 输出目录：${outputDir}`,
    `- 交付清单：${manifestPath}`,
    `- 正式文书复核稿：${formalPath}`,
    `- 引用核验报告：${reportPath}`,
    `- 来源登记表：${sourcePath}`,
    `- 提交确认清单：${checklistPath}`,
    caseArchiveLine,
    ...docxLines,
    '- 现行有效法律硬门槛：通过',
    '- 推理底稿结构检查：通过；事实、证据与法律结论仍待律师复核',
    `- 引用风险项：${riskCount}`,
    '',
    '## 人工边界',
    'Lumi 已生成本地交付文件，但没有自动提交、签发、盖章、缴费、发送或确认送达。正式使用前必须由律师复核。',
  ].join('\n');
}
