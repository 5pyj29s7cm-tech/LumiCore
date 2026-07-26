import fs from 'fs';
import os from 'os';
import path from 'path';

export interface LegalFolderWorkflowArgs {
  folderPath: string;
  caseName?: string;
  matterType?: string;
  stage?: string;
  clientRole?: string;
  objective?: string;
  outputDir?: string;
  writeFiles?: boolean;
  maxFiles?: number;
  maxChars?: number;
}

interface ExtractedFile {
  path: string;
  name: string;
  ext: string;
  chars: number;
  excerpt: string;
}

interface SkippedFile {
  path: string;
  reason: string;
}

interface CaseSignals {
  caseNumbers: string[];
  courts: string[];
  dates: string[];
  amounts: string[];
  parties: string[];
  causes: string[];
  evidenceTypes: string[];
}

export interface LegalFolderWorkflowResult {
  caseName: string;
  folderPath: string;
  outputDir?: string;
  filesRead: ExtractedFile[];
  filesSkipped: SkippedFile[];
  signals: CaseSignals;
  searchPlan: {
    faxinQueries: string[];
    judgmentQueries: string[];
    statuteQueries: string[];
  };
  authorizationSteps: string[];
  draftFiles: Array<{ name: string; path?: string; preview: string }>;
  warnings: string[];
}

const SUPPORTED_EXTS = new Set([
  '.txt', '.md', '.csv', '.json', '.log', '.rtf',
  '.docx', '.xlsx', '.xls', '.pptx', '.pdf',
]);

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-server', '.codex-run']);

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function safeName(value: string, fallback = 'matter'): string {
  return path.basename(String(value || fallback)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || fallback;
}

function expandHome(value: string): string {
  return String(value || '').replace(/^~(?=$|[\\/])/, os.homedir());
}

function walkFiles(root: string, maxFiles: number): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    if (files.length >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

function decodeRtfUnicode(value: number): string {
  const code = value < 0 ? value + 65536 : value;
  return String.fromCharCode(code);
}

export function extractRtfText(rtf: string): string {
  const destinationWords = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object']);
  const stack: Array<{ ignorable: boolean; ucSkip: number }> = [{ ignorable: false, ucSkip: 1 }];
  let output = '';
  let index = 0;
  let pendingIgnorable = false;
  const current = () => stack[stack.length - 1];
  const append = (text: string) => { if (!current().ignorable) output += text; };

  while (index < rtf.length) {
    const char = rtf[index];
    if (char === '{') {
      stack.push({ ...current(), ignorable: pendingIgnorable || current().ignorable });
      pendingIgnorable = false;
      index++;
      continue;
    }
    if (char === '}') {
      if (stack.length > 1) stack.pop();
      pendingIgnorable = false;
      index++;
      continue;
    }
    if (char !== '\\') {
      append(char);
      index++;
      continue;
    }

    const next = rtf[index + 1];
    if (next === '\\' || next === '{' || next === '}') {
      append(next);
      index += 2;
      continue;
    }
    if (next === '~') {
      append(' ');
      index += 2;
      continue;
    }
    if (next === '*') {
      pendingIgnorable = true;
      index += 2;
      continue;
    }
    if (next === "'") {
      const byte = Number.parseInt(rtf.slice(index + 2, index + 4), 16);
      if (Number.isFinite(byte)) append(Buffer.from([byte]).toString('latin1'));
      index += 4;
      continue;
    }

    const match = rtf.slice(index + 1).match(/^([a-zA-Z]+)(-?\d+)? ?/);
    if (!match) {
      index += 2;
      continue;
    }
    const word = match[1];
    const parameter = match[2] !== undefined ? Number(match[2]) : undefined;
    index += 1 + match[0].length;

    if (destinationWords.has(word)) {
      current().ignorable = true;
      continue;
    }
    if (word === 'uc' && parameter !== undefined) current().ucSkip = Math.max(0, parameter);
    else if (word === 'u' && parameter !== undefined) {
      append(decodeRtfUnicode(parameter));
      index += current().ucSkip;
    } else if (word === 'par' || word === 'line') append('\n');
    else if (word === 'tab') append('\t');
  }
  return normalizeWhitespace(output);
}

async function extractPdfText(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const pdfModule: any = await import('pdf-parse');
  const legacyParser = typeof pdfModule.default === 'function'
    ? pdfModule.default
    : typeof pdfModule === 'function'
      ? pdfModule
      : null;
  if (legacyParser) return String((await legacyParser(buffer))?.text || '');
  const PDFParse = pdfModule.PDFParse || pdfModule.default?.PDFParse;
  if (typeof PDFParse !== 'function') throw new Error('Unsupported pdf-parse API');
  const parser = new PDFParse({ data: buffer });
  try {
    return String((await parser.getText())?.text || '');
  } finally {
    await parser.destroy?.();
  }
}

function extractOoxmlTextBlocks(xml: string): string[] {
  const decode = (value: string) => value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
  const runs = (chunk: string) => Array.from(chunk.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g))
    .map(match => decode(match[1] || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const paragraphs = Array.from(xml.matchAll(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g))
    .map(match => runs(match[0]).join(' ').trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs : runs(xml);
}

async function extractPptxText(filePath: string): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip: any = await JSZip.loadAsync(fs.readFileSync(filePath));
  const entries = Object.values(zip.files as Record<string, any>)
    .filter((entry: any) => !entry.dir && /^ppt\/(?:slides|notesSlides)\/(?:slide|notesSlide)\d+\.xml$/i.test(entry.name))
    .sort((a: any, b: any) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const sections: string[] = [];
  for (const entry of entries as any[]) {
    const xml = await entry.async('string');
    const blocks = extractOoxmlTextBlocks(xml);
    if (blocks.length) sections.push(`[${entry.name}]\n${blocks.join('\n')}`);
  }
  return sections.join('\n\n');
}

function cellValueToText(value: any): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value.richText)) return value.richText.map((part: any) => String(part?.text ?? '')).join('');
  if (Object.prototype.hasOwnProperty.call(value, 'result')) return cellValueToText(value.result);
  if (Object.prototype.hasOwnProperty.call(value, 'text')) return cellValueToText(value.text);
  return String(value);
}

function worksheetToCsv(worksheet: any): string {
  const lines: string[] = [];
  const columnCount = Math.max(worksheet.columnCount || 0, worksheet.actualColumnCount || 0);
  worksheet.eachRow({ includeEmpty: false }, (row: any) => {
    const fields: string[] = [];
    for (let col = 1; col <= columnCount; col++) {
      const text = cellValueToText(row.getCell(col).value);
      fields.push(/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
    if (fields.length > 0) lines.push(fields.join(','));
  });
  return lines.join('\n');
}

async function extractXlsxText(filePath: string): Promise<string> {
  const mod: any = await import('exceljs/dist/exceljs.min.js');
  const ExcelJS = mod.default || mod;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(filePath));
  return workbook.worksheets.map((sheet: any) => `[${sheet.name}]\n${worksheetToCsv(sheet)}`).join('\n\n');
}

async function extractFileText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (['.txt', '.md', '.csv', '.json', '.log'].includes(ext)) return fs.readFileSync(filePath, 'utf-8');
  if (ext === '.rtf') return extractRtfText(fs.readFileSync(filePath, 'utf-8'));
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    return String((await mammoth.extractRawText({ path: filePath })).value || '');
  }
  if (ext === '.xlsx') return extractXlsxText(filePath);
  if (ext === '.xls') throw new Error('Legacy .xls files are not supported. Convert the file to .xlsx or .csv first.');
  if (ext === '.pptx') return extractPptxText(filePath);
  if (ext === '.pdf') return extractPdfText(filePath);
  throw new Error(`Unsupported file type: ${ext || '(none)'}`);
}

function unique(values: string[], max = 12): string[] {
  return Array.from(new Set(values.map(v => v.trim()).filter(Boolean))).slice(0, max);
}

export function extractCaseSignals(text: string): CaseSignals {
  const caseNumbers = unique(Array.from(text.matchAll(/[（(]\d{4}[）)][\u4e00-\u9fa5A-Za-z0-9\-]+号/g)).map(m => m[0]), 8);
  const courts = unique(Array.from(text.matchAll(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院|仲裁委员会)/g)).map(m => m[0]), 8);
  const dates = unique(Array.from(text.matchAll(/(?:20\d{2}|19\d{2})[年./-]\d{1,2}[月./-]\d{1,2}日?/g)).map(m => m[0]), 12);
  const amounts = unique(Array.from(text.matchAll(/(?:人民币)?\s*\d+(?:\.\d+)?\s*(?:万元|元|万|亿元)/g)).map(m => m[0]), 12);
  const parties = unique(Array.from(text.matchAll(/(?:原告|被告|上诉人|被上诉人|申请人|被申请人|委托人|受托人|甲方|乙方)[:：\s]*([\u4e00-\u9fa5A-Za-z0-9（）()·._-]{2,40})/g)).map(m => m[1]), 12);
  const causes = unique(Array.from(text.matchAll(/(?:案由|纠纷类型|法律关系)[:：\s]*([\u4e00-\u9fa5A-Za-z0-9、，, ]{2,40})/g)).map(m => m[1]), 8);
  const evidenceTypes = unique([
    /合同|协议|订单|报价单|补充协议/.test(text) ? '合同/协议' : '',
    /微信|聊天记录|短信|邮件|录音/.test(text) ? '沟通记录' : '',
    /转账|银行流水|发票|收据|付款|汇款/.test(text) ? '付款凭证' : '',
    /送货|验收|签收|交付|物流/.test(text) ? '履行/交付材料' : '',
    /判决书|裁定书|调解书|仲裁/.test(text) ? '既有裁判/程序材料' : '',
    /身份证|营业执照|统一社会信用代码/.test(text) ? '主体身份材料' : '',
  ], 10);
  return { caseNumbers, courts, dates, amounts, parties, causes, evidenceTypes };
}

function inferMatterKeywords(args: LegalFolderWorkflowArgs, signals: CaseSignals, corpus: string): string[] {
  const seeds = [
    args.matterType || '',
    ...signals.causes,
    /买卖合同|货款|供货|订单/.test(corpus) ? '买卖合同纠纷' : '',
    /借款|借条|本金|利息/.test(corpus) ? '民间借贷纠纷' : '',
    /劳动|工资|加班|解除劳动/.test(corpus) ? '劳动争议' : '',
    /租赁|房屋|租金/.test(corpus) ? '租赁合同纠纷' : '',
    /建设工程|施工|工程款/.test(corpus) ? '建设工程施工合同纠纷' : '',
    /婚姻|离婚|抚养|共同财产/.test(corpus) ? '离婚纠纷' : '',
  ];
  return unique(seeds, 8);
}

function buildSearchPlan(args: LegalFolderWorkflowArgs, signals: CaseSignals, corpus: string) {
  const matterKeywords = inferMatterKeywords(args, signals, corpus);
  const parties = signals.parties.slice(0, 3);
  const amounts = signals.amounts.slice(0, 2);
  const objective = args.objective || '文书起草';
  const core = matterKeywords[0] || args.matterType || '民事纠纷';
  return {
    faxinQueries: unique([
      `${core} 代理词 模板`,
      `${core} 授权委托书 委托代理合同`,
      `${core} 争议焦点 裁判规则`,
      `${core} 证据目录 ${signals.evidenceTypes.slice(0, 2).join(' ')}`,
      `${core} ${objective}`,
    ], 8),
    judgmentQueries: unique([
      `${core} ${parties.join(' ')}`.trim(),
      `${core} ${amounts.join(' ')}`.trim(),
      `${core} 违约责任 举证责任`,
      `${core} 代理词 裁判观点`,
      ...signals.caseNumbers,
    ], 10),
    statuteQueries: unique([
      `${core} 民法典`,
      `${core} 诉讼时效`,
      `${core} 举证责任`,
      '民事诉讼法 授权委托 代理人',
    ], 8),
  };
}

function makeMarkdown(args: LegalFolderWorkflowArgs, files: ExtractedFile[], skipped: SkippedFile[], signals: CaseSignals, searchPlan: ReturnType<typeof buildSearchPlan>) {
  const caseName = args.caseName || safeName(path.basename(args.folderPath), '未命名案件');
  const corpusPreview = files.map(file => `## ${file.name}\n${file.excerpt}`).join('\n\n').slice(0, 12000);
  const materials = files.map(file => `- ${file.name} (${file.chars} chars)`).join('\n') || '- 暂无可读材料';
  const skippedList = skipped.map(file => `- ${file.path}: ${file.reason}`).join('\n') || '- 无';
  const evidenceList = signals.evidenceTypes.map(item => `- ${item}: 待核对原件、形成时间、来源和证明目的`).join('\n') || '- 待根据材料补充';

  const intake = `# ${caseName} 案件文件夹工作底稿

## 基本信息
- 案件类型：${args.matterType || '待确认'}
- 当前阶段：${args.stage || '待确认'}
- 我方身份：${args.clientRole || '待确认'}
- 办案目标：${args.objective || '整理材料、检索模板和类案、形成文书草稿'}

## 已读取材料
${materials}

## 暂未读取材料
${skippedList}

## 自动识别线索
- 案号：${signals.caseNumbers.join('；') || '未识别'}
- 法院/仲裁机构：${signals.courts.join('；') || '未识别'}
- 当事人：${signals.parties.join('；') || '未识别'}
- 日期：${signals.dates.join('；') || '未识别'}
- 金额：${signals.amounts.join('；') || '未识别'}
- 案由/法律关系：${signals.causes.join('；') || args.matterType || '待确认'}

## 证据初步分类
${evidenceList}

## 材料摘录
${corpusPreview}
`;

  const search = `# ${caseName} 检索计划

## 法信检索词
${searchPlan.faxinQueries.map(q => `- ${q}`).join('\n')}

## 中国裁判文书网检索词
${searchPlan.judgmentQueries.map(q => `- ${q}`).join('\n')}

## 法条检索词
${searchPlan.statuteQueries.map(q => `- ${q}`).join('\n')}

## 授权登录步骤
1. 在 Lumi 中创建或复用法信登录 profile：presetId = faxin。
2. 在可见浏览器中完成扫码、验证码或 SSO。
3. 创建或复用中国裁判文书网登录 profile：presetId = china-judgments-online。
4. 对每个候选模板/案例登记标题、链接、案号、法院、摘录和使用理由。
5. 不批量抓取，不绕过验证码，不把未授权内容写入最终文书。
`;

  const sourceTable = `# ${caseName} 来源登记表

| 序号 | 来源 | 标题/案号 | 链接 | 关键摘录 | 使用位置 | 复核状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 法信 | 待补 | 待补 | 待补 | 委托书/代理词 | 待复核 |
| 2 | 裁判文书网 | 待补 | 待补 | 待补 | 类案观点 | 待复核 |
`;

  const engagement = `# ${caseName} 委托书/委托代理合同要点草稿

委托人：${args.clientRole === '被告' ? '被告/被申请人信息待填' : '委托人信息待填'}

受托事项：就“${caseName}”相关争议提供法律服务，包括材料整理、法律检索、文书起草、沟通谈判、诉讼/仲裁代理等，具体以正式委托合同为准。

服务范围：
1. 审阅案件材料并形成案件摘要。
2. 检索法律法规、类案和可参考文书模板。
3. 起草或修改起诉状、答辩状、代理词、证据目录等。
4. 出庭、调解、执行等事项需另行确认授权范围。

待律师确认：
- 委托权限：一般授权 / 特别授权。
- 费用、发票、差旅、解除条款。
- 是否存在利益冲突。
`;

  const representation = `# ${caseName} 授权委托书草稿

委托人：［待填写］
受委托人：［律师/律所信息待填写］

现委托上述受委托人在“${caseName}”一案中作为委托人的诉讼/仲裁代理人。

代理权限：
- 一般授权：代为提交材料、参与庭审、发表代理意见、签收法律文书。
- 特别授权如需包含承认、放弃、变更诉讼请求，和解、调解、提起反诉或上诉等，应由委托人另行明确勾选。

委托人签字/盖章：
日期：

提示：正式版本需按法院/仲裁机构要求和律师执业信息复核。
`;

  const agency = `# ${caseName} 代理词框架

## 一、基本立场
我方身份：${args.clientRole || '待确认'}。
核心诉求/抗辩目标：${args.objective || '待确认'}。

## 二、案件事实概括
根据现有材料，案件事实需围绕时间线、合同关系、履行情况、违约/侵权事实、损失和证据对应关系展开。

## 三、争议焦点
1. 法律关系及案由是否成立。
2. 我方主张/抗辩事实是否有证据支持。
3. 责任承担、金额计算和利息/违约金标准。
4. 诉讼时效、管辖、主体资格等程序问题。

## 四、证据与证明目的
${evidenceList}

## 五、法律依据和类案观点
待从法信、中国裁判文书网和本地知识库中补充；所有引用必须登记来源并人工复核。

## 六、结论
请求法院/仲裁机构支持我方主张或驳回对方不成立请求。正式文字待律师结合证据和检索来源定稿。
`;

  const evidence = `# ${caseName} 证据目录草稿

| 编号 | 证据名称 | 来源 | 证明目的 | 原件/复印件 | 备注 |
| --- | --- | --- | --- | --- | --- |
${signals.evidenceTypes.map((item, index) => `| ${index + 1} | ${item} | 案件文件夹 | 证明相关事实 | 待核对 | 待补充具体文件 |`).join('\n') || '| 1 | 待补充 | 待补充 | 待补充 | 待核对 |  |'}

提示：提交前需逐项核对真实性、合法性、关联性和页码。
`;

  return {
    intake,
    search,
    sourceTable,
    engagement,
    representation,
    agency,
    evidence,
  };
}

export async function runLegalCaseFolderWorkflow(args: LegalFolderWorkflowArgs): Promise<LegalFolderWorkflowResult> {
  const folderPath = path.resolve(expandHome(args.folderPath || ''));
  if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error(`Folder not found: ${args.folderPath || '(empty)'}`);
  }

  const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 80, 1), 300);
  const maxChars = Math.min(Math.max(Number(args.maxChars) || 180000, 10000), 800000);
  const files = walkFiles(folderPath, maxFiles);
  const filesRead: ExtractedFile[] = [];
  const filesSkipped: SkippedFile[] = [];
  let corpus = '';

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) {
      filesSkipped.push({ path: filePath, reason: `unsupported extension ${ext || '(none)'}` });
      continue;
    }
    if (corpus.length >= maxChars) {
      filesSkipped.push({ path: filePath, reason: 'max corpus size reached' });
      continue;
    }
    try {
      const text = normalizeWhitespace(await extractFileText(filePath));
      if (!text) {
        filesSkipped.push({ path: filePath, reason: 'no extractable text' });
        continue;
      }
      const remaining = maxChars - corpus.length;
      const clipped = text.slice(0, remaining);
      corpus += `\n\n# ${path.basename(filePath)}\n${clipped}`;
      filesRead.push({
        path: filePath,
        name: path.basename(filePath),
        ext,
        chars: text.length,
        excerpt: text.slice(0, 1800),
      });
    } catch (err: any) {
      filesSkipped.push({ path: filePath, reason: err?.message || String(err) });
    }
  }

  const caseName = args.caseName || safeName(path.basename(folderPath), '未命名案件');
  const signals = extractCaseSignals(corpus);
  const searchPlan = buildSearchPlan({ ...args, folderPath, caseName }, signals, corpus);
  const markdown = makeMarkdown({ ...args, folderPath, caseName }, filesRead, filesSkipped, signals, searchPlan);
  const outputDir = args.outputDir
    ? path.resolve(expandHome(args.outputDir))
    : path.join(folderPath, 'Lumi法律工作底稿');

  const draftMap: Array<[string, string]> = [
    ['00_案件摘要.md', markdown.intake],
    ['01_检索计划.md', markdown.search],
    ['02_来源登记表.md', markdown.sourceTable],
    ['10_委托事项要点.md', markdown.engagement],
    ['11_授权委托书草稿.md', markdown.representation],
    ['12_代理词框架.md', markdown.agency],
    ['13_证据目录草稿.md', markdown.evidence],
  ];

  const draftFiles: LegalFolderWorkflowResult['draftFiles'] = [];
  if (args.writeFiles) {
    fs.mkdirSync(outputDir, { recursive: true });
    for (const [name, content] of draftMap) {
      const target = path.join(outputDir, name);
      fs.writeFileSync(target, content, 'utf-8');
      draftFiles.push({ name, path: target, preview: content.slice(0, 1200) });
    }
  } else {
    for (const [name, content] of draftMap) {
      draftFiles.push({ name, preview: content.slice(0, 1200) });
    }
  }

  return {
    caseName,
    folderPath,
    outputDir: args.writeFiles ? outputDir : undefined,
    filesRead,
    filesSkipped,
    signals,
    searchPlan,
    authorizationSteps: [
      'Use web_login_profile_save_from_preset with presetId "faxin" for 法信.',
      'Run web_login_run in visible mode so the user can complete captcha, QR, SSO, or 2FA.',
      'Use web_login_profile_save_from_preset with presetId "china-judgments-online" for 中国裁判文书网.',
      'Fetch or manually paste only authorized pages; record every source in 02_来源登记表.md.',
      'A lawyer/user must review every final legal document before filing or sending.',
    ],
    draftFiles,
    warnings: [
      'This workflow supports drafting and research organization only; it is not final legal advice.',
      'Do not bypass captcha, paywalls, rate limits, or account authorization on legal research sites.',
      filesSkipped.length ? `${filesSkipped.length} file(s) were skipped or only partially readable.` : '',
    ].filter(Boolean),
  };
}
