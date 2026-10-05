import * as LegalCases from '../../../org/legal_cases';
import * as OrgKB from '../../../org/kb';
import type { IncomingAttachment, IncomingMessage } from '../../../messaging/types';
import { getMember } from '../../../org/db';
import { getRequestText, remotePlatformLabel, remoteMaterialSource, needsBinding } from "./remote_materials";
import { assertMessagingAuthorization } from "./messaging_ingress_runtime";

function formatKbResults(results: any[]): string {
  if (!results || results.length === 0) return '没有在组织知识库里找到相关内容。';
  return [
    `找到 ${results.length} 条组织知识库结果：`,
    '',
    ...results.slice(0, 5).map((item: any, index: number) => {
      const title = item.title || item.articleTitle || item.article?.title || `结果 ${index + 1}`;
      const content = String(item.content || item.chunk || item.snippet || '').slice(0, 500);
      const score = typeof item.score === 'number' ? ` 相似度 ${(item.score * 100).toFixed(1)}%` : '';
      return `${index + 1}. ${title}${score}\n${content}`;
    }),
  ].join('\n');
}

function formatCaseResults(cases: LegalCases.OrgLegalCaseFile[]): string {
  if (!cases || cases.length === 0) return '没有找到匹配的组织案件。';
  return [
    `找到 ${cases.length} 个组织案件：`,
    '',
    ...cases.slice(0, 8).map((item, index) => {
      const materialCount = item.materials?.length || 0;
      return `${index + 1}. ${item.title || '未命名案件'}\n案号：${item.caseNumber || '未填写'}\n案由：${item.cause || '未填写'}\n法院：${item.court || '未填写'}\n阶段：${item.stage}\n材料：${materialCount} 份\n更新：${new Date(item.updatedAt).toLocaleString()}`;
    }),
  ].join('\n');
}

function stripExtractionQuery(text: string, source: 'case' | 'kb' | 'any' = 'any'): string {
  let query = text
    .replace(/绑定 Lumi [A-Z0-9]{4,12}/gi, ' ')
    .replace(/(请|帮我|麻烦|一下|从|在|把|将|给我|发我|Lumi|露米|组织|工作域|远程|飞书|企业微信|企微|微信)/g, ' ')
    .replace(/(提取|调取|获取|查看|查询|查找|搜索|检索|整理|总结|摘要|列出|找出|读取|看看)/g, ' ')
    .replace(/(出来|一下|相关|有关|里面|中的|里的|关于|信息|资料|内容|全文|要点|清单|列表|目录|报告)/g, ' ');

  if (source === 'case' || source === 'any') {
    query = query.replace(/(案件|案号|卷宗|案情|材料|证据|关键日期|时间线|期限|开庭|判决|上诉|执行|事实|争议焦点|争议|焦点|法院|法官|当事人|案由|阶段)/g, ' ');
  }
  if (source === 'kb' || source === 'any') {
    query = query.replace(/(知识库|资料库|文档库|制度|文档|文章|规范|流程|政策)/g, ' ');
  }

  return query
    .replace(/[「」《》"“”'‘’：:，。；;、?？!！\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function fallbackKnowledgeSearch(orgId: string, userId: string, query: string, limit: number) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return OrgKB.listArticles(orgId, { status: 'published' }, userId)
    .filter((article: any) => {
      const haystack = `${article.title || ''}\n${article.content || ''}\n${article.category || ''}`.toLowerCase();
      return haystack.includes(q);
    })
    .slice(0, limit)
    .map((article: any) => ({
      articleId: article.id,
      title: article.title || '未命名资料',
      chunk: String(article.content || '').slice(0, 700),
      score: undefined,
    }));
}

async function searchOrgKnowledge(orgId: string, userId: string, query: string, limit = 5) {
  const q = query.trim();
  if (!q) return [];
  const semantic = await OrgKB.searchKnowledgeBase(orgId, q, { limit, userId });
  return semantic.length > 0 ? semantic : fallbackKnowledgeSearch(orgId, userId, q, limit);
}

function formatKbExtraction(results: any[], query: string): string {
  if (!results || results.length === 0) {
    return `没有从组织知识库里提取到“${query || '相关'}”资料。`;
  }
  return [
    `从组织知识库提取到 ${results.length} 条资料：`,
    '',
    ...results.slice(0, 6).map((item: any, index: number) => {
      const title = item.title || item.articleTitle || item.article?.title || `资料 ${index + 1}`;
      const content = String(item.content || item.chunk || item.snippet || '').trim().slice(0, 700);
      const score = typeof item.score === 'number' ? ` 相似度 ${(item.score * 100).toFixed(1)}%` : '';
      return `${index + 1}. ${title}${score}\n${content || '没有可展示的摘要内容'}`;
    }),
  ].join('\n');
}

function formatCaseTimeline(caseFile: LegalCases.OrgLegalCaseFile): string {
  const lines = [
    `案件：${caseFile.title || '未命名案件'}`,
    `案号：${caseFile.caseNumber || '未填写'}`,
    `阶段：${caseFile.stage || '未填写'}`,
    `开庭日：${caseFile.hearingDate || '未填写'}`,
    `判决日：${caseFile.judgmentDate || '未填写'}`,
    `上诉期限：${caseFile.appealDeadline || '未填写'}`,
    `执行期限：${caseFile.enforcementDeadline || '未填写'}`,
  ];
  return lines.join('\n');
}

function formatMaterialSnippet(material: LegalCases.OrgLegalCaseMaterial, includeContent: boolean): string {
  const created = material.createdAt ? new Date(material.createdAt).toLocaleString() : '未知时间';
  const head = `- ${material.title || material.fileName || '案件材料'}｜${material.type}｜${material.source}｜${created}`;
  if (!includeContent) return head;
  const snippet = String(material.content || '').replace(/\s+/g, ' ').slice(0, 450);
  return `${head}\n  ${snippet || '暂无可读文本'}`;
}

function formatCaseMaterials(caseFile: LegalCases.OrgLegalCaseFile, requestText: string): string {
  const includeContent = /(内容|全文|摘录|摘要|提取|看看|读取|具体)/.test(requestText);
  const materials = caseFile.materials || [];
  if (materials.length === 0) {
    return `案件“${caseFile.title}”目前还没有归档材料。`;
  }
  return [
    `案件“${caseFile.title}”共有 ${materials.length} 份材料：`,
    '',
    ...materials.slice(0, includeContent ? 6 : 20).map(item => formatMaterialSnippet(item, includeContent)),
  ].join('\n');
}

function formatCaseBrief(caseFile: LegalCases.OrgLegalCaseFile): string {
  const latestMaterials = (caseFile.materials || []).slice(0, 4);
  return [
    `案件：${caseFile.title || '未命名案件'}`,
    `案号：${caseFile.caseNumber || '未填写'}`,
    `当事人：${caseFile.party || '未填写'}`,
    `案由：${caseFile.cause || '未填写'}`,
    `法院/法官：${[caseFile.court, caseFile.judge].filter(Boolean).join(' / ') || '未填写'}`,
    `阶段：${caseFile.stage || '未填写'}`,
    `关键日期：开庭 ${caseFile.hearingDate || '未填写'}；判决 ${caseFile.judgmentDate || '未填写'}；上诉 ${caseFile.appealDeadline || '未填写'}；执行 ${caseFile.enforcementDeadline || '未填写'}`,
    `材料数量：${caseFile.materials?.length || 0} 份`,
    caseFile.notes ? `备注摘录：${caseFile.notes.replace(/\s+/g, ' ').slice(0, 600)}` : '',
    latestMaterials.length > 0 ? `最近材料：${latestMaterials.map(item => item.title || item.fileName || '案件材料').join('；')}` : '',
  ].filter(Boolean).join('\n');
}

function formatCaseFocusedExtraction(caseFile: LegalCases.OrgLegalCaseFile, requestText: string): string {
  const wantsTimeline = /(日期|时间线|期限|开庭|判决|上诉|执行|提醒)/.test(requestText);
  const wantsMaterials = /(材料|证据|附件|文件|卷宗|清单|列表|目录|全文|内容)/.test(requestText);
  const wantsBrief = /(摘要|总结|梳理|案情|事实|争议|焦点|分析|要点|信息|资料)/.test(requestText);

  const sections: string[] = [];
  if (wantsTimeline) {
    sections.push('【关键日期】');
    sections.push(formatCaseTimeline(caseFile));
  }
  if (wantsMaterials) {
    sections.push('【材料】');
    sections.push(formatCaseMaterials(caseFile, requestText));
  }
  if (!wantsTimeline && !wantsMaterials || wantsBrief) {
    sections.push('【案件摘要】');
    sections.push(formatCaseBrief(caseFile));
  }

  sections.push('');
  sections.push('注意：以上为案件资料提取与辅助整理，正式法律意见由执业律师确认。');
  return sections.join('\n');
}

async function handleRemoteExtractionCommand(msg: IncomingMessage, textAttachments: IncomingAttachment[]): Promise<string | null> {
  const requestText = getRequestText(msg);

  const asksAboutCurrentAttachments = textAttachments.length > 0
    && /(提取|摘要|总结|整理|分析|读取|看看).*(附件|文件|这份|这个|材料|资料|内容|信息)/.test(requestText)
    && !/(知识库|资料库|文档库|案件库|案件|案号|卷宗|归档|保存|导入|上传|收录)/.test(requestText);
  if (asksAboutCurrentAttachments) return null;

  const wantsKbExtraction = /(提取|调取|获取|查看|查询|查找|整理|总结|摘要|列出|读取).*(知识库|资料库|文档库|制度|组织资料|组织文档)|(知识库|资料库|文档库|制度).*(提取|调取|获取|查看|整理|总结|摘要|资料|信息)/.test(requestText);
  if (wantsKbExtraction) {
    const query = stripExtractionQuery(requestText, 'kb') || requestText;
    const results = await searchOrgKnowledge(msg.boundOrgId!, msg.boundUserId!, query, 6);
    return formatKbExtraction(results, query);
  }

  const wantsCaseExtraction = /(提取|调取|获取|查看|查询|查找|整理|总结|摘要|列出|读取).*(案件|案号|卷宗|案情|材料|证据)|(案件|案号|卷宗).*(提取|调取|获取|查看|整理|总结|摘要|材料|证据|关键日期|时间线|资料|信息)/.test(requestText);
  if (wantsCaseExtraction) {
    const query = stripExtractionQuery(requestText, 'case');
    const cases = query
      ? LegalCases.listCases(msg.boundOrgId!, query, 5, msg.boundUserId)
      : LegalCases.listCases(msg.boundOrgId!, '', 5, msg.boundUserId);
    if (cases.length === 0) {
      return query
        ? `没有找到“${query}”对应的组织案件。可以换一个案号、当事人、法院或案件名称再试。`
        : '请告诉我你要提取哪个案件，例如：提取 张三合同纠纷案 的材料清单。';
    }
    if (cases.length > 1 && query) {
      const exact = cases.find(item => item.caseNumber === query || item.title === query);
      if (!exact) {
        return [
          `找到 ${cases.length} 个可能相关的案件，请再指定一个案号或案件名称：`,
          '',
          ...cases.slice(0, 5).map((item, index) => `${index + 1}. ${item.title || '未命名案件'}｜${item.caseNumber || '未填案号'}｜${item.cause || '未填案由'}`),
        ].join('\n');
      }
      return formatCaseFocusedExtraction(exact, requestText);
    }
    return formatCaseFocusedExtraction(cases[0], requestText);
  }

  const wantsGenericExtraction = /(提取|调取|获取|查看|查询|查找|整理|总结|摘要|列出|读取).*(资料|信息|文档)/.test(requestText);
  if (wantsGenericExtraction) {
    const query = stripExtractionQuery(requestText, 'any');
    if (!query) return null;
    const [kbResults, cases] = await Promise.all([
      searchOrgKnowledge(msg.boundOrgId!, msg.boundUserId!, query, 4),
      Promise.resolve(LegalCases.listCases(msg.boundOrgId!, query, 3, msg.boundUserId)),
    ]);
    if (kbResults.length === 0 && cases.length === 0) {
      return `没有从组织知识库或案件库里提取到“${query}”相关资料。`;
    }
    return [
      `围绕“${query}”提取到这些组织资料：`,
      '',
      cases.length > 0 ? '【相关案件】' : '',
      ...cases.map((item, index) => `${index + 1}. ${item.title || '未命名案件'}｜${item.caseNumber || '未填案号'}｜材料 ${item.materials?.length || 0} 份`),
      cases.length > 0 ? '' : '',
      kbResults.length > 0 ? '【知识库资料】' : '',
      ...kbResults.slice(0, 4).map((item: any, index: number) => `${index + 1}. ${item.title || '资料'}\n${String(item.chunk || item.content || '').slice(0, 500)}`),
    ].filter(Boolean).join('\n');
  }

  return null;
}

function extractCaseArchiveTarget(text: string): string {
  const patterns = [
    /(?:归档|保存|加入|添加|放入|放到).{0,12}(?:到|进|给)\s*(?:案件|案号|卷宗)?[：:\s「《"]*([^，。；;\n」》"]{2,80})/,
    /(?:案件|案号|卷宗)[：:\s「《"]+([^，。；;\n」》"]{2,80})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/^(里|中|内|为|是)/, '').trim();
    }
  }
  return '';
}

function normalizeCaseArchiveIdentity(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^(?:案件|案号|案卷|卷宗)[:：]?/u, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function selectReliableArchiveCase(
  candidates: LegalCases.OrgLegalCaseFile[],
  target: string,
): { selected: LegalCases.OrgLegalCaseFile | null; alternatives: LegalCases.OrgLegalCaseFile[] } {
  const normalizedTarget = normalizeCaseArchiveIdentity(target);
  if (!normalizedTarget) return { selected: null, alternatives: [] };
  const caseIdentities = (caseFile: LegalCases.OrgLegalCaseFile) => [
    caseFile.id,
    caseFile.caseNumber,
    caseFile.title,
  ].map(normalizeCaseArchiveIdentity).filter(Boolean);

  const exact = candidates.filter(caseFile => caseIdentities(caseFile).includes(normalizedTarget));
  if (exact.length === 1) return { selected: exact[0], alternatives: exact };
  if (exact.length > 1) return { selected: null, alternatives: exact };

  // A partial name is reliable only when it identifies exactly one case by
  // title/case number. Matches found solely in notes, parties or materials are
  // search hints, never sufficient authority for a write.
  const identityPartial = normalizedTarget.length >= 4
    ? candidates.filter(caseFile => [caseFile.caseNumber, caseFile.title]
        .map(normalizeCaseArchiveIdentity)
        .filter(Boolean)
        .some(identity => identity.includes(normalizedTarget) || normalizedTarget.includes(identity)))
    : [];
  return identityPartial.length === 1
    ? { selected: identityPartial[0], alternatives: identityPartial }
    : { selected: null, alternatives: identityPartial.length > 1 ? identityPartial : [] };
}

export type RemoteCaseAttachmentWriteIntent = 'none' | 'archive_existing' | 'create_case';

function stripNegatedRemoteWritePhrases(text: string): string {
  return String(text || '')
    .replace(/(?:不要|别|无需|不用|不需要|请勿|禁止)[^，。；;！？!?\n]{0,12}?(?:建案|入案|归档|保存|导入|上传|收录|加入|添加|放入|放到|新建|创建|写入|修改|更新|删除)/gu, ' ')
    .replace(/\b(?:do\s+not|don't|never|without)\b[^\n.!?;]{0,20}?\b(?:file|archive|save|import|upload|add|create|write|modify|update|delete)\b/giu, ' ');
}

export function classifyRemoteCaseAttachmentWriteIntent(text: string): RemoteCaseAttachmentWriteIntent {
  const request = String(text || '').trim();
  if (!request) return 'none';
  const affirmativeRequest = stripNegatedRemoteWritePhrases(request);
  const explicitlyCreatesCase = /(?:建案|入案|(?:新建|创建|建立|建)(?:一个|一份|该|这个)?(?:案件|案卷|卷宗)|(?:案件|案卷|卷宗).{0,8}(?:新建|创建|建立)|\b(?:create|start)\s+(?:a\s+)?new\s+case\b)/iu.test(affirmativeRequest);
  if (explicitlyCreatesCase) return 'create_case';
  const explicitlyArchives = /(?:归档|保存|导入|上传|收录|加入|添加|放入|放到)|\b(?:archive|save|import|upload|add)\b/iu.test(affirmativeRequest);
  const namesExistingCaseTarget = /(?:已有|现有|当前|指定)?(?:案件|案号|案卷|卷宗)|\b(?:existing|current|specified)\s+case\b/iu.test(affirmativeRequest);
  return explicitlyArchives && namesExistingCaseTarget ? 'archive_existing' : 'none';
}

function inferMaterialType(fileName: string, text: string): LegalCases.LegalCaseMaterialType {
  const lower = fileName.toLowerCase();
  if (/合同|协议|contract/.test(fileName) || lower.includes('contract')) return 'contract';
  if (/判决|裁定|文书|judgment/.test(fileName) || lower.includes('judgment')) return 'judgment';
  if (/起诉状|答辩状|申请书|委托书|代理词|pleading/.test(fileName + text)) return 'pleading';
  if (/笔录|会谈|庭审|transcript/.test(fileName + text)) return 'consultation';
  return 'evidence';
}

function updateCaseHintsFromText(orgId: string, userId: string, caseFile: LegalCases.OrgLegalCaseFile, text: string) {
  const hints = LegalCases.extractLegalCaseHints(text);
  const patch: Partial<LegalCases.OrgLegalCaseFile> = {};
  if (hints.caseNumber && !caseFile.caseNumber) patch.caseNumber = hints.caseNumber;
  if (hints.court && !caseFile.court) patch.court = hints.court;
  if (hints.cause && !caseFile.cause) patch.cause = hints.cause;
  if (hints.hearingDate && !caseFile.hearingDate) patch.hearingDate = hints.hearingDate;
  if (Object.keys(patch).length > 0) {
    LegalCases.updateCase(orgId, userId, caseFile.id, patch);
  }
}

export async function handleRemoteOrgCommand(msg: IncomingMessage, assertExecutionCurrent?: () => void): Promise<string | null> {
  assertMessagingAuthorization(msg);
  assertExecutionCurrent?.();
  const requestText = getRequestText(msg);
  const platformLabel = remotePlatformLabel(msg.platform);
  const materialSource = remoteMaterialSource(msg.platform);
  const wantsOrgData = needsBinding(requestText);
  if (wantsOrgData && (!msg.boundUserId || !msg.boundOrgId)) {
    return `这个操作需要先绑定${platformLabel}身份。请在 Lumi 桌面端生成绑定码，然后在${platformLabel}里发送：绑定 Lumi <绑定码>。`;
  }
  if (!msg.boundUserId || !msg.boundOrgId) return null;
  const membership = getMember(msg.boundOrgId, msg.boundUserId);
  if (!membership || membership.status !== 'active') {
    return '当前 Lumi 身份的组织成员权限已经失效，请重新进入组织或联系管理员。';
  }
  const caseAttachmentWriteIntent = msg.attachments?.length
    ? classifyRemoteCaseAttachmentWriteIntent(requestText)
    : 'none';
  const affirmativeWriteText = stripNegatedRemoteWritePhrases(requestText);
  const writeRequest = /(归档|保存|导入|上传|新建|创建|添加|写入|修改|更新|删除)/.test(affirmativeWriteText)
    || caseAttachmentWriteIntent !== 'none';
  if (writeRequest && membership.role === 'viewer') {
    return '当前 Lumi 身份在该组织中只有查看权限，不能归档、创建或修改组织数据。';
  }

  const textAttachments = (msg.attachments || []).filter(item => item.extractedText?.trim());
  const extractionReply = await handleRemoteExtractionCommand(msg, textAttachments);
  assertMessagingAuthorization(msg);
  assertExecutionCurrent?.();
  if (extractionReply) return extractionReply;

  if (/知识库|制度|资料|文档库/.test(requestText) && /(查|搜|找|检索|搜索)/.test(requestText)) {
    const query = requestText.replace(/(查|搜|找|检索|搜索)?\s*(组织)?\s*(知识库|制度|资料|文档库)/g, '').trim() || requestText;
    const results = await searchOrgKnowledge(msg.boundOrgId, msg.boundUserId, query, 5);
    return formatKbResults(results);
  }

  if (/(查|搜|找|检索|搜索).*(案件|案号|材料|卷宗)|案件.*(在哪|有没有|列表)/.test(requestText)) {
    const query = requestText.replace(/(查|搜|找|检索|搜索)?\s*(组织)?\s*(案件|案号|材料|卷宗)/g, '').trim();
    const cases = LegalCases.listCases(msg.boundOrgId, query, 8, msg.boundUserId);
    return formatCaseResults(cases);
  }

  const wantsKbArchive = textAttachments.length > 0
    && /(知识库|文档库|资料库)/.test(requestText)
    && /(归档|保存|导入|上传|收录)/.test(affirmativeWriteText);
  if (wantsKbArchive) {
    const articles = textAttachments.map(attachment => OrgKB.createArticle(msg.boundOrgId!, msg.boundUserId!, {
      title: attachment.fileName || requestText.slice(0, 80) || `${platformLabel}远程文档`,
      content: attachment.extractedText || '',
      category: materialSource,
      tags: [materialSource, 'remote-file'],
      status: 'published',
    }));
    return [
      `已归档 ${articles.length} 份${platformLabel}文件到组织知识库。`,
      '',
      ...articles.map((article, index) => `${index + 1}. ${article.title}`),
      '',
      `后续可以在${platformLabel}里说“查组织知识库 <关键词>”继续检索。`,
    ].join('\n');
  }

  if (textAttachments.length > 0 && caseAttachmentWriteIntent !== 'none') {
    const first = textAttachments[0];
    const combined = textAttachments
      .map(item => `# ${item.fileName}\n\n${item.extractedText}`)
      .join('\n\n---\n\n');
    const target = extractCaseArchiveTarget(requestText);
    const targetCases = caseAttachmentWriteIntent === 'archive_existing' && target
      ? Array.from(new Map([
          ...LegalCases.listCases(msg.boundOrgId, target, 200, msg.boundUserId),
          ...LegalCases.listCases(msg.boundOrgId, '', 200, msg.boundUserId),
        ].map(caseFile => [caseFile.id, caseFile])).values())
      : [];
    const archiveSelection = selectReliableArchiveCase(targetCases, target);
    if (caseAttachmentWriteIntent === 'archive_existing' && archiveSelection.selected) {
      const targetCase = archiveSelection.selected;
      for (const attachment of textAttachments) {
        LegalCases.addMaterial(msg.boundOrgId, msg.boundUserId, targetCase.id, {
          type: inferMaterialType(attachment.fileName, attachment.extractedText || ''),
          title: attachment.fileName || `${platformLabel}案件材料`,
          content: attachment.extractedText || '',
          fileName: attachment.fileName,
          localPath: attachment.localPath,
          source: materialSource,
        });
      }
      updateCaseHintsFromText(msg.boundOrgId, msg.boundUserId, targetCase, combined);
      const refreshed = LegalCases.getCase(msg.boundOrgId, targetCase.id, msg.boundUserId) || targetCase;
      return [
        `已把 ${textAttachments.length} 份${platformLabel}附件归档到已有案件。`,
        '',
        `案件：${refreshed.title}`,
        `案号：${refreshed.caseNumber || '未识别'}`,
        `法院：${refreshed.court || '未识别'}`,
        `案由：${refreshed.cause || '未识别'}`,
        `材料数：${refreshed.materials.length}`,
        '',
        '后续可以继续发送材料，或说“查案件 <关键词>”。',
        '注意：此归档和分析只辅助律师工作，最终法律意见由执业律师确认。',
      ].join('\n');
    }

    if (caseAttachmentWriteIntent === 'archive_existing') {
      return [
        '附件尚未归档，也没有创建新案件。',
        '',
        archiveSelection.alternatives.length > 1
          ? `找到 ${archiveSelection.alternatives.length} 个可能的已有案件，请提供完整案号或准确案件名称：\n${archiveSelection.alternatives.slice(0, 8).map((item, index) => `${index + 1}. ${item.title || '未命名案件'}｜${item.caseNumber || '未填案号'}`).join('\n')}`
          : target
          ? `没有找到“${target}”对应的已有案件。请提供准确案号或案件名称。`
          : '请指定要归档到的已有案件名称或案号。',
        '只有你明确说“新建案件并归档附件”时，Lumi 才会创建新案件。',
      ].join('\n');
    }

    const title = requestText
      .replace(/(请|帮我|把|将|归档|保存|新建|创建|案件|材料|到|组织|律所)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || first.fileName || `${platformLabel}远程案件材料`;
    const caseFile = LegalCases.createCaseFromRemoteMaterial({
      orgId: msg.boundOrgId,
      userId: msg.boundUserId,
      title,
      text: combined,
      fileName: first.fileName,
      localPath: first.localPath,
      source: materialSource,
    });
    for (const attachment of textAttachments.slice(1)) {
      LegalCases.addMaterial(msg.boundOrgId, msg.boundUserId, caseFile.id, {
        type: 'evidence',
        title: attachment.fileName,
        content: attachment.extractedText || '',
        fileName: attachment.fileName,
        localPath: attachment.localPath,
        source: materialSource,
      });
    }
    const refreshed = LegalCases.getCase(msg.boundOrgId, caseFile.id, msg.boundUserId) || caseFile;
    return [
      `已创建组织案件并归档 ${textAttachments.length} 份${platformLabel}附件。`,
      '',
      `案件：${refreshed.title}`,
      `案号：${refreshed.caseNumber || '未识别'}`,
      `法院：${refreshed.court || '未识别'}`,
      `案由：${refreshed.cause || '未识别'}`,
      `材料数：${refreshed.materials.length}`,
      '',
      `我已按案件材料保存。后续可以在${platformLabel}里说“查案件 <关键词>”，或在桌面端组织律所区域继续整理。`,
      '注意：此归档和分析只辅助律师工作，最终法律意见由执业律师确认。',
    ].join('\n');
  }

  if (/(新建|创建).*(案件)/.test(requestText)) {
    const caseFile = LegalCases.createCaseFromRemoteMaterial({
      orgId: msg.boundOrgId,
      userId: msg.boundUserId,
      title: requestText.slice(0, 80) || `${platformLabel}远程案件`,
      text: requestText,
      source: materialSource,
    });
    return `已新建组织案件：${caseFile.title}\n案号：${caseFile.caseNumber || '未识别'}\n后续可以继续发送文件并说“归档到案件”。`;
  }

  return null;
}
