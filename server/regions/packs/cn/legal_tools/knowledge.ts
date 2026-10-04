import { searchSimilarCases, searchStatutes, type LegalArticleType, createLegalArticle, indexLegalArticle, type CitationCheck, verifyMultipleCitations, verifyCitation } from "../../../../legal/kb";
import { searchLegalAuthorityDatabase } from "../../../../legal/sources";
import { extractLegalMetadata, parseDocument } from "../../../../legal/parser";
import { legalWrite, legalExecutionSignal } from "../../../../legal/execution";
import path from "path";
import fs from "fs";
import { refreshAuthoritativeStatuteSources, formatStatuteAuthorityRefreshReport } from "../../../../legal/statute_authority_refresh";
import { loadStatuteAuthorityRefreshState } from "../../../../legal/statute_authority_store";
import { encodeToolResult } from "../../../../tools/result_envelope";
import { legalWorkspaceId, textArg, listArg, LEGAL_MATERIAL_EXTENSIONS, LEGAL_IMAGE_EXTENSIONS } from "./context";
import { normalizeMaterialArticleType, buildImportedMaterialContent, materialCategory, normalizeTagsFromArgs, collectMaterialFiles } from "./documents";

// ── legal_search_case ───────────────────────────────────────────────────

export async function searchCaseHandler(args: Record<string, any>, context?: any): Promise<string> {
  const query = args.query as string;
  const limit = (args.limit as number) || 5;
  if (!query) return '请提供案由或事实描述（query参数）';

  // Search local KB
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const localResults = await searchSimilarCases(orgId, query, limit, userId);

  if (localResults.length > 0) {
    const lines = localResults.map((r, i) =>
      `${i + 1}. **${r.title}** [相似度: ${r.score}]\n   案号: ${r.caseNumber || 'N/A'} | 法院: ${r.court || 'N/A'}\n   摘要: ${r.chunk.slice(0, 300)}...`,
    );
    return `本地知识库检索到 ${localResults.length} 个相似案例：\n\n${lines.join('\n\n')}\n\n*来源: 本地裁判文书知识库*`;
  }

  // Fallback: search wenshu
  return '本地知识库中未找到相似案例。建议导入相关裁判文书到知识库，或访问中国裁判文书网 (wenshu.court.gov.cn) 手动检索。';
}

// ── legal_search_statute ────────────────────────────────────────────────

export async function searchStatuteHandler(args: Record<string, any>, context?: any): Promise<string> {
  const query = args.query as string;
  if (!query) return '请提供法条名称或关键词（query参数）';

  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const results = await searchStatutes(orgId, query, 5, userId);
  const externalResults = await searchLegalAuthorityDatabase({
    query,
    type: 'law',
    sourceIds: [
      ...listArg(args, 'sourceIds'),
      ...listArg(args, 'sources'),
      ...listArg(args, 'platforms'),
    ],
    includeOfficialWeb: args.includeOfficialWeb === true,
    limit: Number(args.limit) || 5,
  });

  if (results.length === 0 && externalResults.length === 0) {
    return `未找到与"${query}"相关的法条。建议通过国家法律法规数据库 (flk.npc.gov.cn) 核实。`;
  }

  const lines = results.map((r, i) =>
    `${i + 1}. **${r.title}** ${r.isEffective ? '✓ 现行有效' : '✗ 已废止'}\n   ${r.chunk.slice(0, 200)}`,
  );
  const externalLines = externalResults.map((r, i) =>
    `${results.length + i + 1}. **${r.title}** ${r.effectiveStatus || '待律师复核'}\n   来源: ${r.sourceName}${r.url ? ` | ${r.url}` : ''}\n   ${r.summary.slice(0, 200)}`,
  );
  return [...lines, ...externalLines].join('\n\n')
    + '\n\n*来源: 本地法条库、已配置授权法律数据库；未配置 API 的平台需通过网页登录协作核验。*';
}

// ── legal_import_materials_to_kb ────────────────────────────────────────

export async function importMaterialsToKbHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const filePath = textArg(args, 'filePath');
  const folderPath = textArg(args, 'folderPath');
  const content = textArg(args, 'content');
  const recursive = args.recursive !== false;
  const maxFiles = Math.max(1, Math.min(Number(args.maxFiles) || 30, 100));
  const materialType = textArg(args, 'materialType');
  const defaultArticleType = normalizeMaterialArticleType(materialType || textArg(args, 'title'));

  if (!filePath && !folderPath && !content) {
    return '请提供 filePath、folderPath 或 content。Lumi 可以导入本地案件材料、下载后的网页材料或直接粘贴文本。';
  }

  const imported: Array<{ title: string; articleId: string; chunks: number; category: string }> = [];
  const skipped: Array<{ source: string; reason: string }> = [];

  const ingestOne = async (source: string, rawText: string, format: string, title: string, articleType: LegalArticleType) => {
    const text = rawText.trim();
    if (text.length < 20) {
      skipped.push({ source, reason: '文本过短或解析为空' });
      return;
    }
    const metadata = articleType === 'judgment' ? extractLegalMetadata(text) : undefined;
    const article = legalWrite(() => createLegalArticle(orgId, userId, {
      title,
      content: buildImportedMaterialContent(args, { title, text, source, format, articleType }),
      category: materialCategory(articleType),
      tags: normalizeTagsFromArgs(args, articleType, source),
      articleType,
      metadata: metadata ? {
        articleType,
        caseNumber: metadata.caseNumber,
        court: metadata.court,
        parties: metadata.parties,
        causeOfAction: metadata.causeOfAction,
        judgmentDate: metadata.judgmentDate,
        statutesCited: metadata.statutesCited,
        jurisdiction: metadata.court,
      } : { articleType },
    }));
    const chunks = await indexLegalArticle(orgId, article.id, context?.userId || userId, { signal: context?.executionSignal || legalExecutionSignal() });
    imported.push({ title, articleId: article.id, chunks, category: article.category });
  };

  if (content) {
    const title = textArg(args, 'title') || textArg(args, 'caseName') || '粘贴法律材料';
    await ingestOne('pasted-content', content, 'text', title, defaultArticleType);
  }

  if (filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      skipped.push({ source: resolved, reason: '文件不存在' });
    } else if (!fs.statSync(resolved).isFile()) {
      skipped.push({ source: resolved, reason: '不是文件' });
    } else if (!LEGAL_MATERIAL_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      const ext = path.extname(resolved).toLowerCase();
      skipped.push({
        source: resolved,
        reason: LEGAL_IMAGE_EXTENSIONS.has(ext)
          ? '图片材料需先使用 ocr_image_file 提取文字，再将 OCR 文本导入知识库'
          : `暂不支持该格式：${ext || '无扩展名'}`,
      });
    } else {
      const parsed = await parseDocument(resolved);
      if (!parsed?.text) {
        skipped.push({ source: resolved, reason: '解析失败或内容为空' });
      } else {
        const inferredType = normalizeMaterialArticleType(materialType || path.basename(resolved));
        await ingestOne(resolved, parsed.text, parsed.format, textArg(args, 'title') || path.basename(resolved), inferredType);
      }
    }
  }

  if (folderPath) {
    const resolvedFolder = path.resolve(folderPath);
    if (!fs.existsSync(resolvedFolder)) {
      skipped.push({ source: resolvedFolder, reason: '文件夹不存在' });
    } else if (!fs.statSync(resolvedFolder).isDirectory()) {
      skipped.push({ source: resolvedFolder, reason: '不是文件夹' });
    } else {
      const files = collectMaterialFiles(resolvedFolder, recursive, maxFiles);
      if (files.length === 0) skipped.push({ source: resolvedFolder, reason: '未找到可导入的文档格式' });
      for (const file of files) {
        try {
          const ext = path.extname(file).toLowerCase();
          if (!LEGAL_MATERIAL_EXTENSIONS.has(ext)) {
            skipped.push({
              source: file,
              reason: LEGAL_IMAGE_EXTENSIONS.has(ext)
                ? '图片材料需先使用 ocr_image_file 提取文字，再将 OCR 文本导入知识库'
                : `暂不支持该格式：${ext || '无扩展名'}`,
            });
            continue;
          }
          const parsed = await parseDocument(file);
          if (!parsed?.text) {
            skipped.push({ source: file, reason: '解析失败或内容为空' });
            continue;
          }
          const inferredType = normalizeMaterialArticleType(materialType || path.basename(file));
          await ingestOne(file, parsed.text, parsed.format, path.basename(file), inferredType);
        } catch (err: any) {
          skipped.push({ source: file, reason: err?.message || '导入失败' });
        }
      }
    }
  }

  const totalChunks = imported.reduce((sum, item) => sum + item.chunks, 0);
  const importedLines = imported.length > 0
    ? imported.map((item, index) =>
      `${index + 1}. ${item.title}\n   - articleId: ${item.articleId}\n   - category: ${item.category}\n   - indexedChunks: ${item.chunks}`,
    ).join('\n')
    : '无';
  const skippedLines = skipped.length > 0
    ? skipped.map((item, index) => `${index + 1}. ${item.source} — ${item.reason}`).join('\n')
    : '无';

  return `# 法律材料导入知识库报告

## 一、导入结果
- 工具：legal_import_materials_to_kb
- 组织：${orgId}
- 成功导入：${imported.length} 份
- 索引块数：${totalChunks}
- 跳过/失败：${skipped.length} 份

## 二、已导入材料
${importedLines}

## 三、跳过/失败材料
${skippedLines}

## 四、后续可用能力
- 这些材料已进入组织知识库，可用于案件问答、争议焦点提炼、代理词/法律意见书、证据目录和类案检索底稿。
- 若 indexedChunks 为 0，通常是当前未配置向量模型；材料仍保存在知识库中，可通过标题、标签和关键词检索。
- 从外部网站获得的网页、下载文件或摘录，应先由律师确认来源和使用权限，再由本工具入库。
`;
}

// ── legal_verify_citation ───────────────────────────────────────────────

function formatCitationVerificationResult(check: CitationCheck): string {
  const verificationLabel = check.verificationStatus === 'verified'
    ? '权威快照有效'
    : check.verificationStatus === 'changed'
      ? '权威记录已变化，正式交付阻断'
    : check.verificationStatus === 'expired'
      ? '权威快照已过期，正式交付阻断'
      : check.verificationStatus === 'repealed'
        ? '已确认废止，正式交付阻断'
        : check.verificationStatus === 'missing'
          ? '缺少权威条文快照，正式交付阻断'
          : check.verificationStatus === 'not_found'
            ? '未找到或超出已核验条文范围，正式交付阻断'
            : '不适用';
  return [
    check.citation,
    `  类型: ${check.type === 'statute' ? '法条引用' : '案例引用'}`,
    `  存在: ${check.exists ? '是' : '否'}`,
    `  有效: ${check.isEffective === null ? '尚未确认' : check.isEffective ? '现行有效' : '已废止'}`,
    `  核验状态: ${verificationLabel}`,
    check.authorityRefreshStatus ? `  自动巡检: ${check.authorityRefreshStatus}` : '',
    check.verifiedAt ? `  核验日期: ${check.verifiedAt}` : '',
    check.reviewAfter ? `  复核期限: ${check.reviewAfter}` : '',
    `  ${check.detail}`,
    `  来源: ${check.source || 'N/A'}`,
    check.sourceUrl ? `  官方链接: ${check.sourceUrl}` : '',
  ].filter(Boolean).join('\n');
}

export async function verifyCitationHandler(args: Record<string, any>, context?: any): Promise<string> {
  const citation = args.citation as string;
  const text = args.text as string;
  const orgId = legalWorkspaceId(args, context);

  if (text) {
    const checks = verifyMultipleCitations(text, orgId);
    if (checks.length === 0) return '未在文本中检测到法条引用（《XX法》格式）或案号引用。';
    return checks.map(formatCitationVerificationResult).join('\n\n');
  }

  if (citation) {
    const check = verifyCitation(citation, orgId);
    return formatCitationVerificationResult(check);
  }

  return '请提供citation（单个引用）或text（批量验证）参数。';
}

export async function refreshAuthoritativeSourcesHandler(args: Record<string, any>): Promise<string> {
  const timeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(2_000, Math.min(30_000, Number(args.timeoutMs)))
    : undefined;
  const result = await refreshAuthoritativeStatuteSources({ timeoutMs });
  const content = [
    formatStatuteAuthorityRefreshReport(result),
    result.archivePath ? `\n巡检记录：${result.archivePath}` : '',
  ].filter(Boolean).join('\n');
  const state = loadStatuteAuthorityRefreshState();
  if (state.lastRunAt !== result.completedAt) {
    throw new Error('Authoritative legal source refresh state was not persisted.');
  }
  const artifacts = result.archivePath && fs.existsSync(result.archivePath)
    ? [path.resolve(result.archivePath)]
    : [];
  return encodeToolResult(content, {
    ok: true,
    status: 'refreshed',
    persisted: true,
    result,
    state,
    changedCaseIds: [],
    articleIds: [],
    artifacts,
    content,
  });
}

export async function authoritySourceStatusHandler(): Promise<string> {
  return formatStatuteAuthorityRefreshReport(loadStatuteAuthorityRefreshState());
}

// ── legal_import_judgment ───────────────────────────────────────────────

export async function importJudgmentHandler(args: Record<string, any>, context?: any): Promise<string> {
  const filePath = args.filePath as string;
  const orgId = legalWorkspaceId(args, context);
  const userId = context?.userId || (args.userId as string) || 'system';
  const content = args.content as string;

  if (!filePath && !content) return '请提供filePath（文件路径）或content（文书正文）。';

  let text: string;
  if (content) {
    text = content;
  } else {
    const result = await parseDocument(filePath);
    if (!result) return `无法解析文件: ${filePath}`;
    text = result.text;
  }

  const metadata = extractLegalMetadata(text);
  const title = metadata.caseNumber
    ? `${metadata.caseNumber} ${metadata.causeOfAction || ''}`
    : (filePath ? filePath.split('/').pop()?.split('\\').pop() || '裁判文书' : '裁判文书');

  const article = legalWrite(() => createLegalArticle(orgId, userId, {
    title,
    content: text,
    articleType: 'judgment',
    metadata: {
      articleType: 'judgment',
      caseNumber: metadata.caseNumber,
      court: metadata.court,
      parties: metadata.parties,
      causeOfAction: metadata.causeOfAction,
      judgmentDate: metadata.judgmentDate,
      statutesCited: metadata.statutesCited,
    },
  }));

  const indexed = await indexLegalArticle(orgId, article.id, context?.userId || userId, { signal: context?.executionSignal || legalExecutionSignal() });

  return `裁判文书导入成功。

- 标题: ${title}
- 案号: ${metadata.caseNumber || '未识别'}
- 审理法院: ${metadata.court || '未识别'}
- 案由: ${metadata.causeOfAction || '未识别'}
- 当事人: ${metadata.parties?.join(', ') || '未识别'}
- 引用法条: ${metadata.statutesCited?.join(', ') || '未识别'}
- 裁判日期: ${metadata.judgmentDate || '未识别'}
- 索引状态: ${indexed} 个文本块已向量化

该文书已录入组织知识库，可通过类案检索查询。`;
}
