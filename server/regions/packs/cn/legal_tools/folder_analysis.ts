import path from "path";
import { legalWrite, legalExecutionSignal } from "../../../../legal/execution";
import fs from "fs";
import { createLegalArticle, indexLegalArticle } from "../../../../legal/kb";
import { readLegalFolderMaterials, inferFolderCaseType, extractFolderParties, buildFolderEvidenceTable, summarizeFilesForFolder, legalOutputDirName } from "./documents";
import { textArg, roleLabel, inferDisputeFocuses, LEGAL_REASONING_BASELINE, runLegalLLM, sanitizeLegalWorkProductOutput, buildSearchQueries, expandLocalPath, legalWorkspaceId } from "./context";
import { generateArgumentOrOpinionHandler } from "./argument_drafting";

// ── legal_analyze_folder_and_draft_argument ────────────────────────────

export async function analyzeFolderAndDraftArgumentHandler(args: Record<string, any>, context?: any): Promise<string> {
  const read = await readLegalFolderMaterials(args);
  const folderBaseName = path.basename(read.folderPath);
  const caseName = textArg(args, 'caseName') || folderBaseName || '未命名案件';
  const caseType = inferFolderCaseType(read.corpus, textArg(args, 'caseType') || textArg(args, 'matterType'));
  const role = roleLabel(textArg(args, 'role') || textArg(args, 'clientRole'));
  const objective = textArg(args, 'objective') || textArg(args, 'claims') || '形成代理词草稿并准备律师复核';
  const parties = textArg(args, 'parties') || extractFolderParties(read.corpus) || '待从主体材料中补充';

  if (read.filesRead.length === 0) {
    const skipped = read.skipped.map(item => `- ${item.path}: ${item.reason}`).join('\n') || '- 未发现可读材料';
    return `未能从案件文件夹中读取到可分析的文本材料。

文件夹：${read.folderPath}

## 暂未读取材料
${skipped}

请确认文件夹路径是否正确；若材料主要是图片/扫描件，请先使用 OCR 识别后再生成代理词。`;
  }

  const evidenceTable = buildFolderEvidenceTable(read.filesRead);
  const fileSummary = summarizeFilesForFolder(read.filesRead);
  const issues = inferDisputeFocuses({
    caseName,
    role,
    caseType,
    facts: read.corpus,
    materials: read.corpus,
    evidence: evidenceTable,
  });
  const issueLines = issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n');
  const skippedLines = read.skipped.length
    ? read.skipped.map(item => `- ${item.path}: ${item.reason}`).join('\n')
    : '- 无';

  const analysisPrompt = `你是一名诉讼律师助理。请根据本地案件文件夹材料，形成可保存的案件分析工作底稿。

## 案件信息
- 案件名称：${caseName}
- 案由/类型：${caseType}
- 我方身份：${role}
- 当事人：${parties}
- 办理目标：${objective}

## 已读取文件
${fileSummary.slice(0, 8000)}

## 材料正文节选
${read.corpus.slice(0, 24000)}

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 输出要求
1. 整理案件事实时间线。
2. 提炼争议焦点和待证事实。
3. 指出证据缺口和质证风险。
4. 给出代理词写作方向。
5. 所有法条、案例只能标注“待检索/待核验”，不得编造。
请用中文 Markdown 输出。`;

  let analysis = '';
  try {
    analysis = await runLegalLLM(analysisPrompt, context, 3500) || '';
  } catch { /* fall through */ }
  if (!analysis) {
    analysis = `# ${caseName} 案情分析工作底稿

## 一、案件概要
- 案由/类型：${caseType}
- 我方身份：${role}
- 当事人：${parties}
- 办理目标：${objective}

## 二、已读取材料
${fileSummary}

## 三、初步争议焦点
${issueLines}

## 四、证据目录草稿
${evidenceTable}

## 五、证据缺口与质证风险
- 图片、扫描件、加密文件或无法解析文件需补 OCR 或重新提供可读版本。
- 所有证据需核对原件、形成时间、来源、页码和证明目的。
- 法条、类案、裁判规则进入代理词前必须另行检索并登记来源。

## 六、代理词写作方向
- 围绕争议焦点逐项绑定事实和证据。
- 对证据不足部分标注“待补证”，避免写成确定性事实。
- 根据我方身份选择请求支持或抗辩驳回的表达。`;
  } else {
    analysis = sanitizeLegalWorkProductOutput(analysis);
  }

  const argumentDraft = await generateArgumentOrOpinionHandler({
    caseName,
    role,
    documentType: '代理词',
    caseType,
    facts: read.corpus.slice(0, 45000),
    issues,
    evidence: evidenceTable,
    opponentMaterials: textArg(args, 'opponentMaterials'),
    objective,
    materials: read.corpus.slice(0, 45000),
  }, context);

  const researchPlan = `# ${caseName} 外部检索与复核清单

## 一、法条核验
- 先检索国家法律法规数据库，确认拟引用法律、司法解释是否现行有效。
- 代理词中所有条款号、施行日期、修订状态均需复核。

## 二、类案检索
1. 人民法院案例库：检索权威案例和裁判规则。
2. 中国裁判文书网：按最高人民法院 > 高级人民法院 > 中级人民法院 > 基层人民法院顺序筛选。
3. 法蝉 / Alpha：使用律所授权账号补充商业库资料。

## 三、推荐检索词
${buildSearchQueries({ caseType, facts: read.corpus, issues }).map((query, index) => `${index + 1}. ${query}`).join('\n')}

## 四、人工确认点
- 争议焦点、证据取舍、法条引用、类案引用和对外提交文本必须由律师复核。
- 外部平台材料属于授权网页登录协作；确认后的摘录或下载文件再导入知识库。
`;

  const readReport = `# ${caseName} 文件夹读取报告

## 一、读取结果
- 文件夹：${read.folderPath}
- 已读取：${read.filesRead.length} 个文件
- 暂未读取：${read.skipped.length} 个文件
- 文本总量：${read.corpus.length} 字

## 二、已读取文件
${fileSummary}

## 三、暂未读取文件
${skippedLines}

## 四、说明
- 图片、扫描件、加密 PDF、损坏文件可能需要 OCR 或人工转换后再分析。
- 本报告和后续文书为律师工作底稿，不作为最终法律意见。
`;

  const outputDir = textArg(args, 'outputDir')
    ? path.resolve(expandLocalPath(textArg(args, 'outputDir')))
    : path.join(read.folderPath, legalOutputDirName(textArg(args, 'outputDirName') || 'Lumi代理词草稿'));
  const writeFiles = args.writeFiles !== false;
  const outputs: Array<{ name: string; path?: string; content: string }> = [
    { name: '00_文件夹读取报告.md', content: readReport },
    { name: '01_案情分析与争议焦点.md', content: analysis },
    { name: '02_证据目录草稿.md', content: `# ${caseName} 证据目录草稿\n\n${evidenceTable}\n\n## 复核提示\n- 提交前逐项核对真实性、合法性、关联性、页码和原件状态。\n- 证明目的需与最终争议焦点保持一致。\n` },
    { name: '03_代理词草稿.md', content: argumentDraft },
    { name: '04_外部检索与复核清单.md', content: researchPlan },
  ];

  if (writeFiles) {
    legalWrite(() => fs.mkdirSync(outputDir, { recursive: true }));
    for (const item of outputs) {
      const target = path.join(outputDir, item.name);
      legalWrite(() => fs.writeFileSync(target, item.content, 'utf-8'));
      item.path = target;
    }
  }

  let kbLine = '';
  if (args.importToKb === true || args.confirmedForKb === true) {
    const orgId = legalWorkspaceId(args, context);
    const userId = textArg(args, 'userId') || context?.userId || 'system';
    const article = legalWrite(() => createLegalArticle(orgId, userId, {
      title: `${caseName} 代理词工作底稿`,
      content: outputs.map(item => `# ${item.name}\n\n${item.content}`).join('\n\n---\n\n'),
      articleType: 'pleading',
      category: 'legal_pleading',
      tags: ['legal:folder-argument', `caseName:${caseName}`, `caseType:${caseType}`],
      metadata: { articleType: 'pleading' },
    }));
    const indexed = await indexLegalArticle(orgId, article.id, context?.userId || userId, { signal: context?.executionSignal || legalExecutionSignal() });
    kbLine = `\n- 知识库：已导入 articleId=${article.id}，索引块数=${indexed}`;
  }

  return `# 案件文件夹代理词生成完成

## 一、处理结果
- 案件：${caseName}
- 文件夹：${read.folderPath}
- 已读取材料：${read.filesRead.length} 个
- 暂未读取材料：${read.skipped.length} 个
- 案由/类型：${caseType}
- 我方身份：${role}
- 输出模式：${writeFiles ? '已保存文件' : '仅生成预览'}${kbLine}

## 二、生成文件
${outputs.map(item => `- ${item.name}${item.path ? `：${item.path}` : ''}`).join('\n')}

## 三、初步争议焦点
${issueLines}

## 四、未读取材料提示
${skippedLines}

## 五、边界
- 代理词是律师工作底稿，不能直接作为最终庭审发表或提交文本。
- 未核验法条、类案、证据原件和页码前，正式文书中应保留“待检索/待核验/待补证”标记。`;
}
