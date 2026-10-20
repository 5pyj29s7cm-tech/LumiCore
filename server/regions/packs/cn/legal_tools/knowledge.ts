import { searchSimilarCases, searchStatutes, type LegalArticleType, createLegalArticle, indexLegalArticle, type CitationCheck, verifyMultipleCitations, verifyCitation } from "../../../../legal/kb";
import { searchLegalAuthorityDatabase } from "../../../../legal/sources";
import { extractLegalMetadata } from "../../../../legal/parser";
import { legalWrite, legalExecutionSignal, assertLegalExecutionActive } from "../../../../legal/execution";
import path from "path";
import crypto from "node:crypto";
import * as LegalCases from "../../../../org/legal_cases";
import * as EDB from "../../../../org/db";
import fs from "fs";
import { refreshAuthoritativeStatuteSources, formatStatuteAuthorityRefreshReport } from "../../../../legal/statute_authority_refresh";
import { loadStatuteAuthorityRefreshState } from "../../../../legal/statute_authority_store";
import { encodeToolResult } from "../../../../tools/result_envelope";
import { legalTemporalOptions, legalWorkspaceId, textArg, listArg, expandLocalPath, LEGAL_MATERIAL_EXTENSIONS, LEGAL_IMAGE_EXTENSIONS } from "./context";
import { normalizeMaterialArticleType, buildImportedMaterialContent, materialCategory, normalizeTagsFromArgs, collectMaterialFiles, parseLegalDocument, legalReadError } from "./documents";

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
  const content = textArg(args, 'materials') || textArg(args, 'content');
  const caseId = textArg(args, 'caseId');
  if (caseId && !LegalCases.getCase(orgId, caseId, userId, 'write')) throw new Error('Legal case unavailable for this user.');
  if (!filePath && !folderPath && !content) return '请提供 filePath、folderPath 或 content。';
  const imported: Array<{ title: string; articleId: string; chunks: number; category: string; reused: boolean }> = [];
  const skipped: Array<{ source: string; reason: string }> = [];
  const ingestOne = async (source: string, text: string, format: string, title: string) => {
    if (text.trim().length < 20) { skipped.push({ source, reason: '文本过短或解析为空' }); return; }
    const articleType = normalizeMaterialArticleType(textArg(args, 'materialType') || title);
    const identity = 'legal-import:' + crypto.createHash('sha256')
      .update(JSON.stringify([userId, caseId, source, text, articleType])).digest('hex');
    const existing = EDB.listKbArticles(orgId).find(article => article.authorId === userId && (() => {
      try { return JSON.parse(article.tags || '[]').includes(identity); } catch { return false; }
    })());
    const metadata = articleType === 'judgment' ? extractLegalMetadata(text) : undefined;
    const article = existing || legalWrite(() => createLegalArticle(orgId, userId, {
      title,
      content: buildImportedMaterialContent(args, { title, text, source, format, articleType }),
      category: materialCategory(articleType),
      tags: [...normalizeTagsFromArgs(args, articleType, source), identity, ...(caseId ? ['legal-case:' + caseId] : [])],
      articleType,
      metadata: { articleType, ...metadata, jurisdiction: metadata?.court },
    }));
    // Retry an interrupted index without making a duplicate article or another case.
    let chunks = 0;
    try { chunks = await indexLegalArticle(orgId, article.id, userId, { signal: context?.executionSignal || legalExecutionSignal() }); }
    catch (error) { assertLegalExecutionActive(context); skipped.push({ source, reason: '原文已保存，向量索引未完成；可重试原材料。' }); }
    if (caseId) {
      const marker = 'knowledge-article:' + article.id;
      const current = LegalCases.getCase(orgId, caseId, userId, 'write');
      if (!current) throw new Error('Legal case authorization changed.');
      if (!current.materials.some(material => material.content?.includes(marker))) {
        const material = legalWrite(() => LegalCases.addMaterial(orgId, userId, caseId, {
          type: 'evidence', title, content: marker + '\n' + text,
          fileName: source === 'pasted-content' ? undefined : path.basename(source),
          localPath: source === 'pasted-content' ? undefined : source, source: 'manual',
        }));
        if (!material) throw new Error('Legal case archive failed.');
      }
    }
    imported.push({ title, articleId: article.id, chunks, category: article.category, reused: Boolean(existing) });
  };
  if (content) await ingestOne('pasted-content', content, 'text', textArg(args, 'title') || textArg(args, 'caseName') || '粘贴法律材料');
  const files = new Set<string>();
  if (filePath) files.add(path.resolve(expandLocalPath(filePath)));
  if (folderPath) {
    const resolved = path.resolve(expandLocalPath(folderPath));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) skipped.push({ source: resolved, reason: '文件夹不存在或不可访问' });
    else {
      const limit = Math.max(1, Math.min(Number(args.maxFiles) || 30, 100));
      const found = collectMaterialFiles(resolved, args.recursive !== false, limit + 1);
      found.slice(0, limit).forEach(file => files.add(file));
      if (!found.length) skipped.push({ source: resolved, reason: '未找到可导入的材料' });
      if (found.length > limit) skipped.push({ source: resolved, reason: '超过本次文件数量上限，其余文件尚未导入' });
    }
  }
  for (const source of files) {
    assertLegalExecutionActive(context);
    try {
      const ext = path.extname(source).toLowerCase();
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) { skipped.push({ source, reason: '文件不存在或不是文件' }); continue; }
      if (!LEGAL_MATERIAL_EXTENSIONS.has(ext)) {
        skipped.push({ source, reason: LEGAL_IMAGE_EXTENSIONS.has(ext)
          ? '图片材料需先进行图片文字识别，再将识别文本导入知识库'
          : '暂不支持该格式：' + ext }); continue;
      }
      const parsed = await parseLegalDocument(source, args);
      if (!parsed?.text?.trim()) { skipped.push({ source, reason: '解析失败或内容为空' }); continue; }
      await ingestOne(source, parsed.text, parsed.format, path.basename(source));
    } catch (error) {
      assertLegalExecutionActive(context);
      skipped.push({ source, reason: legalReadError(error) });
    }
  }
  const totalChunks = imported.reduce((sum, item) => sum + item.chunks, 0);
  const lines = imported.map((item, index) =>
    (index + 1) + '. ' + item.title + '\n   - articleId: ' + item.articleId + '\n   - category: ' + item.category
    + '\n   - indexedChunks: ' + item.chunks + (item.reused ? '\n   - 已复用原入库记录，未重复创建' : '')).join('\n');
  const report = '# 法律材料导入知识库报告\n\n## 一、导入结果\n- 成功导入：' + imported.length
    + ' 份\n- 索引块数：' + totalChunks + '\n- 跳过/失败：' + skipped.length + ' 份\n- 案件：' + (caseId || '未指定，不另建案件')
    + '\n\n## 二、已导入材料\n' + (lines || '无')
    + '\n\n## 三、跳过/失败材料\n' + (skipped.map(item => '- ' + item.source + ' — ' + item.reason).join('\n') || '无')
    + '\n\n## 四、后续处理\n' + (imported.length ? '- 已列出的原文已保存，可检索和复用。' : '- 本次没有材料入库。')
    + '\n- 失败材料仍待处理；补充密码后用相同路径和案件ID重试，密码只用于当次读取。'
    + '\n- 向量索引为0不等于原文丢失，但语义检索可能尚未就绪。';
  return encodeToolResult(report, {
    ok: imported.length > 0 && skipped.length === 0,
    status: imported.length ? (skipped.length ? 'partial' : 'imported') : 'blocked',
    existingArticleIds: imported.filter(item => item.reused).map(item => item.articleId),
  });
}

function formatCitationVerificationResult(check: CitationCheck): string {
  const verificationLabel = check.verificationStatus === 'verified'
    ? '具体引用已对照权威原文（案件适用仍待复核）'
    : check.verificationStatus === 'metadata_only' ? '仅核验版本，具体条文未核验，正式交付阻断'
    : check.verificationStatus === 'text_mismatch' ? '引文与权威原文不符，正式交付阻断'
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
    `  版本效力: ${check.isEffective === null ? '尚未确认' : check.isEffective ? '本次核验版本有效；本案适用另行复核' : '已废止/不在有效区间'}`,
    `  核验状态: ${verificationLabel}`,
    check.authorityRefreshStatus ? `  自动巡检: ${check.authorityRefreshStatus}` : '',
    check.verifiedAt ? `  核验日期: ${check.verifiedAt}` : '',
    check.reviewAfter ? `  复核期限: ${check.reviewAfter}` : '',
    `  ${check.detail}`,
    check.sourceText ? `  条文原文: ${check.sourceText}` : '',
    `  来源: ${check.source || 'N/A'}`,
    check.sourceUrl ? `  官方链接: ${check.sourceUrl}` : '',
  ].filter(Boolean).join('\n');
}

export async function verifyCitationHandler(args: Record<string, any>, context?: any): Promise<string> {
  const citation = args.citation as string;
  const text = args.text as string;
  const orgId = legalWorkspaceId(args, context);

  if (text) {
    const checks = verifyMultipleCitations(text, orgId, { ...legalTemporalOptions(args), actorUserId: context?.userId });
    if (checks.length === 0) return '未在文本中检测到法条引用（《XX法》格式）或案号引用。';
    return checks.map(formatCitationVerificationResult).join('\n\n');
  }

  if (citation) {
    const check = verifyCitation(citation, orgId, { ...legalTemporalOptions(args), quotedText: textArg(args, 'quotedText') || undefined, actorUserId: context?.userId });
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
  const content = textArg(args, 'materials') || textArg(args, 'content');

  if (!filePath && !content) return '请提供filePath（文件路径）或content（文书正文）。';

  let text: string;
  if (content) {
    text = content;
  } else {
    const result = await parseLegalDocument(filePath, args);
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
