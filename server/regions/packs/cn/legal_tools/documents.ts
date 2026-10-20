import { legalWrite, assertLegalExecutionActive, legalExecutionContext } from "../../../../legal/execution";
import fs from "fs";
import { transformWordDocument } from "../../../../tools/definitions/document_tools";
import { type LegalArticleType } from "../../../../legal/kb";
import path from "path";
import os from "os";
import { parseDocument } from "../../../../legal/parser";
import { PdfPasswordError } from "../../../../utils/pdf_text";
import { textArg, sanitizeLegalWorkProductOutput, listArg, expandLocalPath, safeFileSegment, LEGAL_MATERIAL_EXTENSIONS, LEGAL_IMAGE_EXTENSIONS } from "./context";

export function markdownTitle(markdown: string, fallback: string): string {
  const line = markdown.split(/\r?\n/).find(item => /^#\s+/.test(item));
  return line ? line.replace(/^#\s+/, '').trim() : fallback;
}

function stripMarkdownTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

export function normalizeFormalDocumentType(input: string): string {
  const raw = String(input || '').trim();
  if (/起诉|complaint/i.test(raw)) return '起诉状';
  if (/要素式/i.test(raw)) return '要素式诉状';
  if (/答辩|defense|answer/i.test(raw)) return '答辩状';
  if (/质证/i.test(raw)) return '质证意见';
  if (/证据目录/i.test(raw)) return '证据目录';
  if (/代理词|argument/i.test(raw)) return '代理词';
  if (/法律意见|opinion/i.test(raw)) return '法律意见书';
  if (/合同/i.test(raw)) return '合同文本';
  if (/标书|投标/i.test(raw)) return '投标书';
  return raw || '法律文书';
}

function normalizeMarkdownBody(content: string, title: string): string {
  const lines = String(content || '').replace(/\r/g, '').split('\n');
  if (lines[0]?.trim() === `# ${title}`) return lines.slice(1).join('\n').trim();
  return lines.join('\n').trim();
}

export function buildFormalLegalMarkdown(args: Record<string, any>, content: string): string {
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const documentType = normalizeFormalDocumentType(textArg(args, 'documentType') || textArg(args, 'type'));
  const lawFirmName = textArg(args, 'lawFirmName') || '［律所名称］';
  const lawyerName = textArg(args, 'lawyerName') || '［承办律师］';
  const title = textArg(args, 'title') || `${caseName}${documentType}`;
  const body = normalizeMarkdownBody(sanitizeLegalWorkProductOutput(content), title);
  const reviewStatus = args.markDraft === false ? '律师确认稿' : '律师复核稿';

  return [
    `# ${title}`,
    '',
    `- 文书类型：${documentType}`,
    `- 案件名称：${caseName}`,
    `- 案由/类型：${textArg(args, 'caseType') || '待确认'}`,
    `- 我方身份：${textArg(args, 'role') || '待确认'}`,
    `- 拟提交/使用法院：${textArg(args, 'court') || '待确认'}`,
    `- 律所：${lawFirmName}`,
    `- 承办律师：${lawyerName}`,
    `- 生成时间：${new Date().toISOString()}`,
    `- 状态：${reviewStatus}，不得未经律师确认直接提交、签发或发送。`,
    '',
    '## 正文',
    '',
    body || '［正文待补充］',
    '',
    '## 律师复核清单',
    '',
    '- 核对当事人身份信息、送达地址、统一社会信用代码、联系方式。',
    '- 核对诉讼请求、抗辩目标、金额、利息、违约金、保全和管辖。',
    '- 核对所有事实是否有证据对应；不能对应的事实标注“待补证”。',
    '- 核对所有法条、司法解释和案例引用是否真实、现行有效、可用于本案。',
    '- 核对附件、页码、份数、签字盖章、授权范围、法院平台填写项。',
    '',
    '## 使用边界',
    '',
    '本文件由 Lumi 生成，仅作为律师工作底稿或复核稿。正式对外提交、签署、盖章、缴费、确认送达、撤回或承诺性操作，必须由律师或当事人亲自确认。',
    '',
  ].join('\n');
}

export async function writeDocxFromMarkdown(markdown: string, filePath: string): Promise<void> {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    Table, TableRow, TableCell, WidthType,
  } = await import('docx');

  const children: any[] = [];
  const lines = markdown.replace(/\r/g, '').split('\n');
  const tableBuffer: string[][] = [];

  const flushTable = () => {
    if (tableBuffer.length < 2) {
      tableBuffer.length = 0;
      return;
    }
    const header = tableBuffer[0];
    const rows = tableBuffer.slice(1).filter(row => row.some(cell => cell.trim()));
    if (rows.length === 0) {
      tableBuffer.length = 0;
      return;
    }
    const colCount = Math.max(1, header.length);
    const cellWidth = Math.floor(9000 / colCount);
    children.push(new Table({
      width: { size: 9000, type: WidthType.DXA },
      rows: [
        new TableRow({
          children: header.map(cell => new TableCell({
            width: { size: cellWidth, type: WidthType.DXA },
            children: [new Paragraph({ children: [new TextRun({ text: cell.trim(), bold: true })] })],
          })),
        }),
        ...rows.map(row => new TableRow({
          children: header.map((_, index) => new TableCell({
            width: { size: cellWidth, type: WidthType.DXA },
            children: [new Paragraph({ children: [new TextRun(row[index]?.trim() || '')] })],
          })),
        })),
      ],
    }));
    children.push(new Paragraph({ text: '' }));
    tableBuffer.length = 0;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|.*\|$/.test(trimmed) && !stripMarkdownTableDivider(trimmed)) {
      tableBuffer.push(trimmed.slice(1, -1).split('|').map(cell => cell.trim()));
      continue;
    }
    if (stripMarkdownTableDivider(trimmed)) continue;
    flushTable();

    if (/^#\s+/.test(trimmed)) {
      children.push(new Paragraph({
        text: trimmed.replace(/^#\s+/, ''),
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 300 },
      }));
    } else if (/^##\s+/.test(trimmed)) {
      children.push(new Paragraph({
        text: trimmed.replace(/^##\s+/, ''),
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 240, after: 120 },
      }));
    } else if (/^###\s+/.test(trimmed)) {
      children.push(new Paragraph({
        text: trimmed.replace(/^###\s+/, ''),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 },
      }));
    } else if (/^[-*]\s+/.test(trimmed)) {
      children.push(new Paragraph({
        children: [new TextRun(trimmed.replace(/^[-*]\s+/, ''))],
        bullet: { level: 0 },
        spacing: { after: 80 },
      }));
    } else {
      children.push(new Paragraph({
        children: [new TextRun(trimmed || ' ')],
        spacing: { after: trimmed ? 100 : 40 },
      }));
    }
  }
  flushTable();

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);
  legalWrite(() => fs.writeFileSync(filePath, buffer));
}

export async function tryConvertDocxToPdf(docxPath: string): Promise<{ ok: boolean; pdfPath?: string; error?: string }> {
  const pdfPath = docxPath.replace(/\.docx$/i, '.pdf');
  assertLegalExecutionActive();
  try {
    await transformWordDocument(docxPath, pdfPath, 'pdf', '', legalExecutionContext());
    assertLegalExecutionActive();
    return { ok: true, pdfPath };
  } catch (error: any) {
    assertLegalExecutionActive();
    return { ok: false, error: String(error?.message || error) };
  }
}

export function normalizeMaterialArticleType(input: string): LegalArticleType {
  if (/裁判|判决|裁定|judg/i.test(input)) return 'judgment';
  if (/法条|法规|法律|statute/i.test(input)) return 'statute';
  if (/合同|协议|contract/i.test(input)) return 'contract';
  if (/证据|evidence/i.test(input)) return 'evidence';
  if (/起诉|答辩|申请书|诉状|代理词|pleading/i.test(input)) return 'pleading';
  if (/笔录|庭审|会议|录音|转写|transcript/i.test(input)) return 'transcript';
  if (/标书|投标|招标|bid|tender/i.test(input)) return 'bid_template';
  if (/意见书|法律意见|opinion/i.test(input)) return 'legal_opinion';
  if (/检索|摘录|类案|research/i.test(input)) return 'research_note';
  if (/企查查|工商|企业|股东|被执行|company/i.test(input)) return 'company_report';
  return 'case_material';
}

export function materialCategory(articleType: LegalArticleType): string {
  return `legal_${articleType}`;
}

export function normalizeTagsFromArgs(args: Record<string, any>, articleType: LegalArticleType, source: string): string[] {
  const tags = new Set<string>([
    'legal_material',
    `material:${articleType}`,
    `source:${source}`,
  ]);
  for (const tag of listArg(args, 'tags')) tags.add(tag);
  const caseName = textArg(args, 'caseName');
  const caseType = textArg(args, 'caseType');
  if (caseName) tags.add(`caseName:${caseName}`);
  if (caseType) tags.add(`caseType:${caseType}`);
  return [...tags];
}

export function buildImportedMaterialContent(args: Record<string, any>, item: {
  title: string;
  text: string;
  source: string;
  format?: string;
  articleType: LegalArticleType;
}): string {
  const header = [
    '# Lumi 法律材料入库记录',
    `- 标题: ${item.title}`,
    `- 来源: ${item.source}`,
    `- 格式: ${item.format || 'text'}`,
    `- 材料类型: ${item.articleType}`,
    `- 案件名称: ${textArg(args, 'caseName') || '未指定'}`,
    `- 案由/类型: ${textArg(args, 'caseType') || '未指定'}`,
    `- 导入时间: ${new Date().toISOString()}`,
    '- 使用边界: 本材料为知识库检索来源，进入正式文书前必须核对原件、来源、页码、形成时间和律师复核意见。',
  ].join('\n');
  return `${header}\n\n---\n\n${item.text.trim()}`;
}

export function collectMaterialFiles(folderPath: string, recursive: boolean, maxFiles: number): string[] {
  const out: string[] = [];
  const root = path.resolve(folderPath);
  const visit = (dir: string) => {
    if (out.length >= maxFiles) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && !entry.name.startsWith('.')) visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(fullPath);
    }
  };
  visit(root);
  return out;
}

function resolveLegalFolderPath(folderPath: string, folderName: string): string {
  const direct = expandLocalPath(folderPath);
  if (direct && fs.existsSync(path.resolve(direct)) && fs.statSync(path.resolve(direct)).isDirectory()) {
    return path.resolve(direct);
  }

  const name = safeFileSegment(folderName || folderPath, '').replace(/_/g, ' ').trim();
  if (!name) return direct ? path.resolve(direct) : '';

  const home = os.homedir();
  const bases = [
    path.join(home, 'Desktop'),
    path.join(home, '桌面'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop') : '',
    process.cwd(),
  ].filter(Boolean);

  for (const base of bases) {
    try {
      if (!fs.existsSync(base)) continue;
      const exact = path.join(base, name);
      if (fs.existsSync(exact) && fs.statSync(exact).isDirectory()) return path.resolve(exact);
      const entries = fs.readdirSync(base, { withFileTypes: true });
      const hit = entries.find(entry => entry.isDirectory() && entry.name.includes(name));
      if (hit) return path.resolve(path.join(base, hit.name));
    } catch { /* ignore inaccessible folders */ }
  }

  return direct ? path.resolve(direct) : '';
}

export function legalOutputDirName(input: string): string {
  return safeFileSegment(input || 'Lumi代理词草稿', 'Lumi代理词草稿');
}

function buildEvidencePurpose(name: string, text: string): string {
  const source = `${name}\n${text}`;
  if (/合同|协议|订单|报价|补充协议/.test(source)) return '证明双方法律关系、权利义务、履行条件及违约责任约定。';
  if (/转账|银行|流水|付款|收款|发票|收据|对账|结算/.test(source)) return '证明款项支付、结算金额、欠款金额或损失计算基础。';
  if (/微信|短信|邮件|聊天|催告|通知|函/.test(source)) return '证明沟通过程、通知送达、催告事实、对方确认或抗辩内容。';
  if (/送货|签收|验收|交付|物流|出库/.test(source)) return '证明合同履行、交付、验收或对方接收事实。';
  if (/起诉状|答辩状|申请书|裁判|判决|裁定|庭审|笔录/.test(source)) return '证明诉讼程序、对方主张、法院查明事实或既有裁判情况。';
  if (/营业执照|身份证|统一社会信用代码|法定代表人/.test(source)) return '证明当事人主体资格、身份信息和诉讼主体适格。';
  return '证明案件相关事实，具体证明目的待律师结合原件和争议焦点复核。';
}

export function inferFolderCaseType(corpus: string, explicit = ''): string {
  if (explicit) return explicit;
  if (/买卖合同|货款|供货|订单|对账/.test(corpus)) return '买卖合同纠纷';
  if (/借款|借条|本金|利息|还款/.test(corpus)) return '民间借贷纠纷';
  if (/劳动|工资|加班|解除劳动|社保/.test(corpus)) return '劳动争议';
  if (/租赁|租金|房屋|承租|出租/.test(corpus)) return '租赁合同纠纷';
  if (/建设工程|施工|工程款|竣工|结算/.test(corpus)) return '建设工程施工合同纠纷';
  if (/侵权|损害|赔偿|过错|事故/.test(corpus)) return '侵权责任纠纷';
  return '民事纠纷';
}

export function extractFolderParties(corpus: string): string {
  const matches = Array.from(corpus.matchAll(/(?:原告|被告|上诉人|被上诉人|申请人|被申请人|甲方|乙方|委托人|受托人)[：:\s]*([\u4e00-\u9fa5A-Za-z0-9（）()·._-]{2,50})/g))
    .map(match => match[0].replace(/\s+/g, ' ').trim());
  return Array.from(new Set(matches)).slice(0, 12).join('；');
}

export function summarizeFilesForFolder(files: Array<{ name: string; path: string; format: string; chars: number; excerpt: string }>): string {
  return files.map((file, index) =>
    `${index + 1}. ${file.name}（${file.format}，${file.chars}字）\n   路径：${file.path}\n   摘要：${file.excerpt.slice(0, 240).replace(/\s+/g, ' ')}`,
  ).join('\n');
}

export function buildFolderEvidenceTable(files: Array<{ name: string; excerpt: string; path: string }>): string {
  if (files.length === 0) {
    return '| 编号 | 证据名称 | 来源 | 证明目的 | 原件/复印件 | 复核状态 |\n| --- | --- | --- | --- | --- | --- |\n| 1 | 待补充 | 案件文件夹 | 待补充 | 待核对 | 律师复核 |';
  }
  const rows = files.map((file, index) =>
    `| ${index + 1} | ${file.name} | ${file.path} | ${buildEvidencePurpose(file.name, file.excerpt)} | 待核对 | 律师复核 |`,
  );
  return ['| 编号 | 证据名称 | 来源 | 证明目的 | 原件/复印件 | 复核状态 |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
}

export async function readLegalFolderMaterials(args: Record<string, any>): Promise<{
  folderPath: string;
  filesRead: Array<{ name: string; path: string; format: string; chars: number; excerpt: string }>;
  skipped: Array<{ path: string; reason: string }>;
  corpus: string;
}> {
  const folderPath = resolveLegalFolderPath(textArg(args, 'folderPath'), textArg(args, 'folderName'));
  if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error(`案件文件夹不存在或无法访问：${textArg(args, 'folderPath') || textArg(args, 'folderName') || '(未提供)'}`);
  }

  const recursive = args.recursive !== false;
  const maxFiles = Math.max(1, Math.min(Number(args.maxFiles) || 80, 200));
  const maxChars = Math.max(10000, Math.min(Number(args.maxChars) || 220000, 800000));
  const files = collectMaterialFiles(folderPath, recursive, maxFiles);
  const filesRead: Array<{ name: string; path: string; format: string; chars: number; excerpt: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let corpus = '';

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!LEGAL_MATERIAL_EXTENSIONS.has(ext)) {
      skipped.push({
        path: file,
        reason: LEGAL_IMAGE_EXTENSIONS.has(ext)
          ? '图片/扫描件需先用 ocr_image_file 识别，或在聊天中上传后让 Lumi OCR'
          : `暂不支持该格式：${ext || '无扩展名'}`,
      });
      continue;
    }
    if (corpus.length >= maxChars) {
      skipped.push({ path: file, reason: '已达到本次读取字数上限' });
      continue;
    }
    let parsed;
    try { parsed = await parseLegalDocument(file, args); } catch (error) {
      skipped.push({ path: file, reason: legalReadError(error) }); continue;
    }
    if (!parsed?.text?.trim()) {
      skipped.push({ path: file, reason: '解析失败或文本为空' });
      continue;
    }
    const text = parsed.text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    const remaining = maxChars - corpus.length;
    const clipped = text.slice(0, remaining);
    corpus += `\n\n# ${path.basename(file)}\n${clipped}`;
    filesRead.push({
      name: path.basename(file),
      path: file,
      format: parsed.format,
      chars: text.length,
      excerpt: text.slice(0, 1500),
    });
  }

  return { folderPath, filesRead, skipped, corpus: corpus.trim() };
}

// ── legal_generate_bid ──────────────────────────────────────────────────

export async function readBidRequirementInput(args: Record<string, any>): Promise<{
  requirements: string;
  sources: string[];
  skipped: string[];
}> {
  const sources: string[] = [];
  const skipped: string[] = [];
  const chunks: string[] = [];
  const maxChars = Math.max(5000, Math.min(Number(args.maxChars) || 180000, 600000));

  const addText = (title: string, text: string) => {
    const clean = String(text || '').replace(/\r/g, '').trim();
    if (!clean) return;
    const used = chunks.join('\n\n').length;
    if (used >= maxChars) {
      skipped.push(`${title}: 已达到本次读取字数上限`);
      return;
    }
    const clipped = clean.slice(0, maxChars - used);
    chunks.push(`# ${title}\n${clipped}`);
    sources.push(title);
  };

  addText('粘贴的招标要求', textArg(args, 'requirements') || textArg(args, 'content') || textArg(args, 'text'));

  const filePaths = Array.from(new Set([
    textArg(args, 'filePath'),
    ...listArg(args, 'filePaths'),
  ].filter(Boolean)));

  const addFile = async (rawPath: string) => {
    const resolved = path.resolve(expandLocalPath(rawPath));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      skipped.push(`${rawPath}: 文件不存在或不可访问`);
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    if (!LEGAL_MATERIAL_EXTENSIONS.has(ext)) {
      skipped.push(`${resolved}: 暂不支持该格式 ${ext || '(无扩展名)'}`);
      return;
    }
    const parsed = await parseDocument(resolved);
    if (!parsed?.text?.trim()) {
      skipped.push(`${resolved}: 未提取到可用文本`);
      return;
    }
    addText(`招标文件 ${path.basename(resolved)}`, parsed.text);
  };

  for (const filePath of filePaths) {
    await addFile(filePath);
  }

  if (textArg(args, 'folderPath') || textArg(args, 'folderName')) {
    const folder = resolveLegalFolderPath(textArg(args, 'folderPath'), textArg(args, 'folderName'));
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      skipped.push(`${textArg(args, 'folderPath') || textArg(args, 'folderName')}: 文件夹不存在或不可访问`);
    } else {
      const files = collectMaterialFiles(
        folder,
        args.recursive !== false,
        Math.max(1, Math.min(Number(args.maxFiles) || 30, 100)),
      );
      for (const file of files) {
        await addFile(file);
      }
    }
  }

  return {
    requirements: chunks.join('\n\n').trim(),
    sources,
    skipped,
  };
}

export function legalDocumentPassword(args: Record<string, any>, filePath: string): string | undefined {
  const perFile = args.passwords && typeof args.passwords === 'object' ? args.passwords : {};
  const value = perFile[path.resolve(filePath)] ?? perFile[filePath] ?? args.password;
  return typeof value === 'string' && value.length ? value : undefined;
}

export async function parseLegalDocument(filePath: string, args: Record<string, any>) {
  return parseDocument(filePath, { password: legalDocumentPassword(args, filePath) });
}

export function legalReadError(error: unknown): string {
  if (error instanceof PdfPasswordError) return error.code === 'PDF_PASSWORD_INCORRECT'
    ? 'PDF_PASSWORD_INCORRECT：密码不正确，请提供正确密码后重试原文件。'
    : 'PDF_PASSWORD_REQUIRED：文件需要打开密码，请提供密码后重试原文件。';
  return '文件解析或入库失败，请核对原文件后重试。';
}
