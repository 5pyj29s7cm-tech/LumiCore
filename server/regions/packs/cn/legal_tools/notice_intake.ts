import path from "path";
import * as LegalCases from "../../../../org/legal_cases";
import { legalWrite, legalExecutionSignal } from "../../../../legal/execution";
import fs from "fs";
import { createLegalArticle, indexLegalArticle } from "../../../../legal/kb";
import { parseLegalDocument, legalReadError } from "./documents";
import { encodeToolResult } from "../../../../tools/result_envelope";
import { readResponseBytes } from "../../../../tools/media_artifact";
import { LEGAL_MATERIAL_EXTENSIONS, textArg, extractFirstUrl, legalWorkspaceId, NOTICE_LINK_MAX_BYTES, ensureLegalIntakeDir, safeFileSegment } from "./context";
import { archiveLegalReportToCase } from "./case_workflow";

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.includes(':')) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some(part => part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function extensionFromUrlOrType(url: URL, contentType: string): string {
  const ext = path.extname(url.pathname).toLowerCase();
  if (LEGAL_MATERIAL_EXTENSIONS.has(ext) || ext === '.html' || ext === '.json' || ext === '.xml') return ext;
  if (/pdf/i.test(contentType)) return '.pdf';
  if (/wordprocessingml|msword/i.test(contentType)) return '.docx';
  if (/spreadsheetml|excel/i.test(contentType)) return '.xlsx';
  if (/presentationml|powerpoint/i.test(contentType)) return '.pptx';
  if (/json/i.test(contentType)) return '.json';
  if (/html/i.test(contentType)) return '.html';
  if (/xml/i.test(contentType)) return '.xml';
  if (/text/i.test(contentType)) return '.txt';
  return '.bin';
}

function extensionFromContentDisposition(header: string): string {
  const match = header.match(/filename\*?=(?:UTF-8''|")?([^";\r\n]+)/i);
  if (!match) return '';
  let filename = match[1].trim().replace(/^"|"$/g, '');
  try { filename = decodeURIComponent(filename); } catch { /* keep raw filename */ }
  const ext = path.extname(filename).toLowerCase();
  return (LEGAL_MATERIAL_EXTENSIONS.has(ext) || ['.html', '.json', '.xml'].includes(ext)) ? ext : '';
}

function sniffDocumentExtension(bytes: Buffer): string {
  if (bytes.length >= 4 && bytes.slice(0, 4).toString('latin1') === '%PDF') return '.pdf';
  return '';
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function explicitNoticePdfLinks(html: string, base: URL): string[] {
  const links = new Set<string>();
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  for (const match of withoutScripts.matchAll(/<(?:a|iframe|embed)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(match[1].replace(/&amp;/g, '&'), base);
      if (url.origin === base.origin && !url.username && !url.password && /\.pdf(?:[?#]|$)/i.test(url.href)) links.add(url.href);
    } catch { /* Invalid link is not a downloadable source. */ }
  }
  return [...links];
}

function extractNoticeHints(input: string): { caseNumber?: string; court?: string; hearingDate?: string } {
  const sharedHints = LegalCases.extractLegalCaseHints(input);
  const court = Array.from(input.matchAll(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院)/g))
    .map(match => match[0])
    .filter(candidate => !['人民法院', '法院'].includes(candidate))
    .sort((a, b) => b.length - a.length)[0]
    || sharedHints.court;
  return {
    caseNumber: sharedHints.caseNumber,
    court,
    hearingDate: sharedHints.hearingDate,
  };
}

function noticeNeedsBrowser(status: number, contentType: string, textSample: string): boolean {
  if ([401, 403, 407, 429].includes(status)) return true;
  if (!/html|text|json|xml/i.test(contentType)) return false;
  return /<input[^>]+type\s*=\s*["']password["']/i.test(textSample) || /(?:请先|需要|必须|尚未|未|重新)[^。\n]{0,12}(?:登录|登陆|身份验证)|请输入.{0,10}验证码|(?:captcha|authentication|login|sign in)\s+(?:required|failed)|access denied|访问受限|未授权/i.test(stripHtmlToText(textSample).slice(0, 6000));
}

export async function processNoticeLinkHandler(args: Record<string, any>, context?: any): Promise<string> {
  const isDocumentLink = args.documentLink === true || /document|doc|legal/i.test(textArg(args, 'mode') || textArg(args, 'sourceType'));
  const resultTitle = isDocumentLink ? '文书链接下载与提取结果' : '短信/通知链接处理结果';
  const rawInput = [
    textArg(args, 'url'),
    textArg(args, 'message'),
    textArg(args, 'noticeText'),
    textArg(args, 'linkText'),
  ].filter(Boolean).join('\n');
  const urlValue = textArg(args, 'url') || extractFirstUrl(rawInput);
  const caseName = textArg(args, 'caseName');
  const materialTitle = textArg(args, 'title') || (isDocumentLink ? '链接文书材料' : '短信/法院通知链接材料');
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const confirmedForKb = args.confirmedForKb === true || args.importToKb === true;
  const includeExtractedText = args.includeExtractedText !== false;
  const extractedTextLimit = Math.max(500, Math.min(Number(args.extractedTextLimit) || 4000, 20000));

  if (!urlValue) {
    return isDocumentLink
      ? '请提供需要下载和提取正文的 http(s) 文书链接，或把包含链接的文本粘贴到 message / linkText 参数。'
      : '请提供短信/通知中的 http(s) 链接，或把完整短信粘贴到 message / noticeText 参数。';
  }

  let target: URL;
  try {
    target = new URL(urlValue);
  } catch {
    return `链接格式无效：${urlValue}`;
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    return '仅支持 http/https 链接；不读取 file、内网协议或其他本地资源。';
  }
  if (isPrivateOrLocalHost(target.hostname)) {
    return '出于安全原因，链接下载工具不抓取 localhost、内网 IP 或本地域名。请在授权浏览器中人工打开后导入已确认材料。';
  }

  const hints = extractNoticeHints(rawInput);
  const browserSteps = [
    '1. 如该站点需要登录，请使用已有授权账号。',
    `2. 在浏览器中打开材料链接：${target.href}`,
    '3. 律师/工作人员在真实浏览器中完成登录、验证码、人脸、短信验证或下载确认。',
    '4. 下载后的 PDF/DOCX/网页摘录，再用 材料入库 导入组织知识库。',
  ].join('\n');

  const archiveNoticeReport = (report: string, localPath?: string, originalText?: string, archiveContent?: string) => {
    const archiveLine = archiveLegalReportToCase(args, {
      orgId,
      userId,
      caseName: caseName || materialTitle,
      title: caseName ? `${caseName} ${materialTitle}` : materialTitle,
      content: originalText || archiveContent || report,
      type: originalText ? 'evidence' : 'note',
      source: originalText ? 'import' : 'tool',
      localPath,
    });
    return `${report}\n\n## 案件空间归档\n${archiveLine}`;
  };

  const authFallback = (reason: string) => encodeToolResult(archiveNoticeReport(`# ${resultTitle}

## 一、处理结论
- 链接：${target.href}
- 结果：${reason}
- 当前模式：授权网页登录协作，不承诺自动绕过登录、验证码、人脸、短信验证、平台频控或下载限制。

## 二、已识别信息
- 案号：${hints.caseNumber || '未识别'}
- 法院：${hints.court || '未识别'}
- 开庭/通知日期：${hints.hearingDate || '未识别'}
- 案件：${caseName || '未指定'}

## 三、建议动作
${browserSteps}
`), { ok: false, status: 'browser_handoff' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const abort = () => controller.abort(context?.executionSignal?.reason);
  if (context?.executionSignal?.aborted) abort();
  context?.executionSignal?.addEventListener('abort', abort, { once: true });
  let response: Response;
  let bytes: Buffer;
  try {
    for (let redirects = 0; ; redirects++) {
      response = await fetch(target.href, {
        signal: controller.signal, redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 LumiLegalIntake/1.0', 'Accept': 'application/pdf,text/html,text/plain,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      });
      if (response.status < 300 || response.status >= 400) break;
      const next = new URL(response.headers.get('location') || '', target);
      if (redirects >= 3 || !response.headers.get('location') || !['http:', 'https:'].includes(next.protocol) || isPrivateOrLocalHost(next.hostname) || next.username || next.password) {
        return authFallback('链接跳转未取得可下载的公开文书，请通过授权网页核对。');
      }
      target = next;
    }
    bytes = await readResponseBytes(response, NOTICE_LINK_MAX_BYTES, controller.signal);
  } catch (err: any) {
    return authFallback('未取得完整链接内容；请核对来源，或通过授权网页下载后导入。');
  } finally {
    clearTimeout(timeout);
    context?.executionSignal?.removeEventListener('abort', abort);
  }

  const contentType = response.headers.get('content-type') || '';
  const contentDisposition = response.headers.get('content-disposition') || '';
  const preliminaryExt = extensionFromContentDisposition(contentDisposition) || extensionFromUrlOrType(target, contentType);
  const textLike = !sniffDocumentExtension(bytes) && (/text|html|json|xml/i.test(contentType) || ['.html', '.json', '.xml', '.txt', '.md', '.csv'].includes(preliminaryExt));


  if (textLike) {
    const body = bytes.toString('utf-8');
    if (!response.ok || noticeNeedsBrowser(response.status, contentType, body)) {
      return authFallback(`页面需要登录/验证或返回异常状态（HTTP ${response.status}）`);
    }

    const pdfLinks = context?.noticeSourcePage ? [] : explicitNoticePdfLinks(body, target);
    if (pdfLinks.length === 1) return processNoticeLinkHandler({ ...args, url: pdfLinks[0], message: rawInput, documentLink: true }, { ...context, noticeSourcePage: target.href });

    const ext = extensionFromContentDisposition(contentDisposition) || extensionFromUrlOrType(target, contentType);
    const intakeDir = ensureLegalIntakeDir(orgId);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = safeFileSegment(`${stamp}_${caseName || materialTitle}`, 'notice_link');
    const rawPath = path.join(intakeDir, `${base}${ext === '.bin' ? '.txt' : ext}`);
    legalWrite(() => fs.writeFileSync(rawPath, body, 'utf-8'));

    const extractedText = ext === '.html' ? stripHtmlToText(body) : body.trim();
    const report = [
      `# ${materialTitle}`,
      '',
      `- 来源链接：${target.href}`,
    ...(context?.noticeSourcePage ? [`- 来源页面：${context.noticeSourcePage}`] : []),
      `- 抓取时间：${new Date().toISOString()}`,
      `- HTTP 状态：${response.status}`,
      `- Content-Type：${contentType || '未提供'}`,
      `- 案件：${caseName || '未指定'}`,
      `- 案号：${hints.caseNumber || '未识别'}`,
      `- 法院：${hints.court || '未识别'}`,
      `- 开庭/通知日期：${hints.hearingDate || '未识别'}`,
      '',
      '## 提取文本',
      '',
      extractedText || '未提取到可读文本。',
    ].join('\n');
    const reportPath = path.join(intakeDir, `${base}_source-note.md`);
    legalWrite(() => fs.writeFileSync(reportPath, report, 'utf-8'));

    let kbLine = '- 知识库：未导入。请先由律师确认来源和使用权限，再将材料导入知识库。';
    if (confirmedForKb) {
      const article = legalWrite(() => createLegalArticle(orgId, userId, {
        title: caseName ? `${caseName} ${materialTitle}` : materialTitle,
        content: report,
        articleType: 'case_material',
        category: 'legal_notice',
        tags: ['legal:notice-link', `source:${target.hostname}`],
        metadata: {
          articleType: 'case_material',
          caseNumber: hints.caseNumber,
          court: hints.court,
        },
      }));
      const indexed = await indexLegalArticle(orgId, article.id, context?.userId || userId, { signal: context?.executionSignal || legalExecutionSignal() });
      kbLine = `- 知识库：已导入 articleId=${article.id}，索引块数=${indexed}`;
    }

    const excerptSection = includeExtractedText
      ? `\n## 四、文书内容摘录\n${(extractedText || '未提取到可读文本。').slice(0, extractedTextLimit)}\n`
      : '';

    const output = `# ${resultTitle}

## 一、处理结论
- 链接：${target.href}
- 结果：已直接读取并保存网页/文本留痕。
- 原始文件：${rawPath}
- 留痕报告：${reportPath}
${kbLine}

## 二、已识别信息
- 案号：${hints.caseNumber || '未识别'}
- 法院：${hints.court || '未识别'}
- 开庭/通知日期：${hints.hearingDate || '未识别'}

## 三、边界
- 当前只保存了网页/文本留痕，正式 PDF 尚未取得，不能记为文书下载完成。
- 如法院页面提供正式 PDF 下载，请用授权浏览器打开并人工下载，再导入知识库或案件材料。${excerptSection}`;
    return encodeToolResult(archiveNoticeReport(output, reportPath, undefined, report), { ok: false, status: 'partial' });
  }

  if (!response.ok || noticeNeedsBrowser(response.status, contentType, '')) {
    return authFallback(`下载返回异常状态（HTTP ${response.status}）`);
  }


  let ext = sniffDocumentExtension(bytes) || extensionFromContentDisposition(contentDisposition) || extensionFromUrlOrType(target, contentType);
  if (ext === '.bin') ext = sniffDocumentExtension(bytes) || ext;
  const intakeDir = ensureLegalIntakeDir(orgId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = safeFileSegment(`${stamp}_${caseName || materialTitle}`, 'notice_link');
  const filePath = path.join(intakeDir, `${base}${ext}`);
  legalWrite(() => fs.writeFileSync(filePath, bytes));

  let parsedText = '';
  let parseStatus = '未解析文本';
  if (LEGAL_MATERIAL_EXTENSIONS.has(ext)) {
    let parsed;
    try { parsed = await parseLegalDocument(filePath, args); }
    catch (error) { parseStatus = legalReadError(error); }
    if (parsed?.text) {
      parsedText = parsed.text;
      parseStatus = `已解析为 ${parsed.format}`;
    }
  }

  const report = [
    `# ${materialTitle}`,
    '',
    `- 来源链接：${target.href}`,
    `- 下载时间：${new Date().toISOString()}`,
    `- HTTP 状态：${response.status}`,
    `- Content-Type：${contentType || '未提供'}`,
    `- 保存文件：${filePath}`,
    `- 文件大小：${bytes.length} bytes`,
    `- 解析状态：${parseStatus}`,
    `- 案件：${caseName || '未指定'}`,
    `- 案号：${hints.caseNumber || '未识别'}`,
    `- 法院：${hints.court || '未识别'}`,
    `- 开庭/通知日期：${hints.hearingDate || '未识别'}`,
    '',
    '## 文本摘录',
    '',
    parsedText ? parsedText : '二进制材料已保存；如需文本，请使用 read_pdf / extract_document_text 或人工确认后导入。',
  ].join('\n');
  const reportPath = path.join(intakeDir, `${base}_source-note.md`);
  legalWrite(() => fs.writeFileSync(reportPath, report, 'utf-8'));

  let kbLine = '- 知识库：未导入。若律师已确认来源和使用权限，可再次设置 confirmedForKb=true，或使用 材料入库 导入保存文件。';
  if (confirmedForKb && parsedText) {
    const content = parsedText;
    const article = legalWrite(() => createLegalArticle(orgId, userId, {
      title: caseName ? `${caseName} ${materialTitle}` : materialTitle,
      content,
      articleType: 'case_material',
      category: 'legal_notice',
      tags: ['legal:notice-link', `source:${target.hostname}`, ext.replace('.', 'format:')],
      metadata: {
        articleType: 'case_material',
        caseNumber: hints.caseNumber,
        court: hints.court,
      },
    }));
    const indexed = await indexLegalArticle(orgId, article.id, context?.userId || userId, { signal: context?.executionSignal || legalExecutionSignal() });
    kbLine = `- 知识库：已导入 articleId=${article.id}，索引块数=${indexed}`;
  }

  const excerptSection = includeExtractedText
    ? `\n## 四、文书内容摘录\n${(parsedText || '未提取到可读文本。若这是扫描件或图片型 PDF，请使用 OCR 后再导入。').slice(0, extractedTextLimit)}\n`
    : '';

  const output = `# ${resultTitle}

## 一、处理结论
- 链接：${target.href}
- 结果：已下载材料并保存。
- 保存文件：${filePath}
- 留痕报告：${reportPath}
- 类型：${contentType || ext}
- 大小：${bytes.length} bytes
- 解析状态：${parseStatus}
${kbLine}

## 二、已识别信息
- 案号：${hints.caseNumber || '未识别'}
- 法院：${hints.court || '未识别'}
- 开庭/通知日期：${hints.hearingDate || '未识别'}

## 三、人工确认
- 请律师核对链接来源、下载文件是否为法院或平台正式文书，以及是否需要补充签收/送达时间记录。
- 若需提交、签收、撤回、缴费或确认送达，必须由律师或当事人在授权页面人工完成。${excerptSection}`;
  const archived = archiveNoticeReport(output, filePath, parsedText);
  return !parsedText && (confirmedForKb || includeExtractedText)
    ? encodeToolResult(`${archived}\n\n- 原文件已保存，文本读取/入库未完成；可补充密码后用 材料入库 重试上述保存路径和原案件ID。`, { ok: false, status: 'partial' })
    : archived;
}
