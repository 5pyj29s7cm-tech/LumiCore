import path from "path";
import { legalWrite } from "../../../../legal/execution";
import fs from "fs";
import { roleLabel, textArg, legalWorkspaceId, buildCaseContext, resolveWritableOutputDir, ensureLegalDeliveryRoot, LEGAL_REASONING_BASELINE, runLegalLLMWithin, sanitizeLegalWorkProductOutput, listArg } from "./context";
import { buildEvidenceReviewRows, formatEvidenceReviewRows, formatEvidenceGapList, appendLegalCaseMaterial } from "./case_workflow";
import { buildLitigationPacketDrafts, litigationDraftBoundary, type LitigationPacketDraft } from "./litigation_drafts";
import { writeDocxFromMarkdown } from "./documents";
import { appendLegalWorkProductArchiveSection, buildLegalWorkProductPreflightSection } from "./citations";

export async function generateLitigationPacketHandler(args: Record<string, any>, context?: any): Promise<string> {
  const role = roleLabel(textArg(args, 'role'));
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const orgId = legalWorkspaceId(args, context);
  const facts = textArg(args, 'facts');
  const evidence = textArg(args, 'evidence');
  const caseContext = buildCaseContext(args);
  if (!facts && !evidence) return '请至少提供案件事实 facts 或证据材料 evidence。';
  const evidenceReviewRows = buildEvidenceReviewRows({ ...args, facts, evidence });
  const evidenceReviewTable = formatEvidenceReviewRows(evidenceReviewRows);
  const evidenceGapList = formatEvidenceGapList(evidenceReviewRows);
  const writeFiles = args.writeFiles !== false && args.writeFile !== false;
  const includeDocx = args.includeDocx !== false;
  const packetDrafts = buildLitigationPacketDrafts(args, role, evidenceReviewTable, evidenceGapList);
  const finish = async (report: string) => {
    let packetPath = '';
    let filingChecklistPath = '';
    let authorizationChecklistPath = '';
    let evidenceMatrixPath = '';
    let manifestPath = '';
    let outputDir = '';
    const markdownPaths = new Map<string, string>();
    const docxPaths: string[] = [];
    const docxFailures: string[] = [];
    const boundary = litigationDraftBoundary(caseName);
    const normalizedReport = report.includes('legal_finalize_delivery_package')
      ? report
      : `${report.trim()}\n${boundary}`;

    if (writeFiles) {
      outputDir = resolveWritableOutputDir(
        textArg(args, 'outputDir'),
        ensureLegalDeliveryRoot(orgId),
        caseName,
        'litigation_packet',
      );
      const documents: LitigationPacketDraft[] = [
        {
          baseName: '00_litigation-packet',
          label: '诉讼文书包总稿',
          markdown: normalizedReport,
        },
        ...packetDrafts,
      ];

      for (const document of documents) {
        const markdownPath = path.join(outputDir, `${document.baseName}.md`);
        legalWrite(() => fs.writeFileSync(markdownPath, document.markdown, 'utf-8'));
        markdownPaths.set(document.baseName, markdownPath);

        if (includeDocx) {
          const docxPath = path.join(outputDir, `${document.baseName}.docx`);
          try {
            await writeDocxFromMarkdown(document.markdown, docxPath);
            docxPaths.push(docxPath);
          } catch (err: any) {
            docxFailures.push(`${document.label}: ${err?.message || String(err)}`);
          }
        }
      }

      const manifestMarkdown = [
        `# ${caseName} 诉讼文书包清单`,
        '',
        `- 我方身份：${role}`,
        `- 输出目录：${outputDir}`,
        `- 生成时间：${new Date().toISOString()}`,
        '- 交付状态：系统草稿，尚未通过正式交付核验。',
        '',
        '| 序号 | 文书 | Markdown | DOCX | 状态 |',
        '| --- | --- | --- | --- | --- |',
        ...documents.map((document, index) => {
          const markdownFile = `${document.baseName}.md`;
          const docxFile = `${document.baseName}.docx`;
          const hasDocx = docxPaths.some(filePath => path.basename(filePath) === docxFile);
          return `| ${index + 1} | ${document.label} | ${markdownFile} | ${includeDocx ? (hasDocx ? docxFile : '生成失败') : '未请求'} | 待律师复核 |`;
        }),
        '',
        '## 正式交付前必经步骤',
        '',
        '1. 补齐当事人、事实、请求、证据、金额、法院和授权信息。',
        '2. 完成法律检索、法条解释、类案来源登记、证据三性和证明目的复核。',
        '3. 对拟交付文书调用 `legal_finalize_delivery_package`；gate 未通过不得标记正式版或对外提交。',
        ...(docxFailures.length ? ['', '## DOCX 生成异常', '', ...docxFailures.map(item => `- ${item}`)] : []),
      ].join('\n');

      manifestPath = path.join(outputDir, '99_manifest.md');
      legalWrite(() => fs.writeFileSync(manifestPath, manifestMarkdown, 'utf-8'));
      if (includeDocx) {
        const manifestDocxPath = path.join(outputDir, '99_manifest.docx');
        try {
          await writeDocxFromMarkdown(manifestMarkdown, manifestDocxPath);
          docxPaths.push(manifestDocxPath);
        } catch (err: any) {
          docxFailures.push(`诉讼文书包清单: ${err?.message || String(err)}`);
        }
      }

      packetPath = markdownPaths.get('00_litigation-packet') || '';
      filingChecklistPath = markdownPaths.get('01_filing-material-checklist') || '';
      authorizationChecklistPath = markdownPaths.get('02_authorization-checklist') || '';
      evidenceMatrixPath = markdownPaths.get('03_evidence-review-matrix') || '';
    }
    const reportWithFiles = packetPath
      ? `${normalizedReport}

## 七、诉讼文书包文件输出
- 文书包总稿文件：${packetPath}
- 立案材料清单文件：${filingChecklistPath}
- 授权委托手续清单文件：${authorizationChecklistPath}
- 证据目录与三性矩阵文件：${evidenceMatrixPath}
- 独立文书清单文件：${manifestPath}
- 输出目录：${outputDir}
- Markdown 文件：${markdownPaths.size + 1} 份
- DOCX 文件：${docxPaths.length} 份
${!includeDocx ? '- DOCX 生成：未请求' : docxFailures.length ? `- DOCX 生成异常：${docxFailures.join('；')}` : '- DOCX 生成：全部成功'}`
      : normalizedReport;
    return appendLegalWorkProductArchiveSection(reportWithFiles, args, context, {
      caseName,
      title: `${caseName}半自动诉讼文书包`,
      type: 'pleading',
      cause: textArg(args, 'caseType') || '诉讼文书包',
      court: textArg(args, 'court'),
      localPath: packetPath || undefined,
    });
  };

  const prompt = `你是一名律所诉讼支持律师。请生成半自动诉讼文书包草稿，所有内容均用于律师复核，不得宣称可直接提交。

## 案件信息
${caseContext}

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 证据三性审查底稿
| 编号 | 证据名称 | 待证事实 | 证明目的 | 真实性核验 | 合法性核验 | 关联性核验 | 缺口/质证风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${evidenceReviewTable}

## 输出要求
1. 明确区分“系统草稿”“律师待确认”“当事人/法院系统填写项”。
2. 我方为${role}时，生成相应文书包：
   - 原告：起诉状、要素式诉状要点、委托手续、立案材料清单、证据目录、证明目的、法院立案系统填写项。
   - 被告：答辩状、质证意见、证据反驳表、管辖/时效/主体资格等程序抗辩检查项、代理词框架。
   - 通用：案件摘要、证据清单、争议焦点、待补材料、法律检索清单。
3. 证据目录必须逐项包含真实性、合法性、关联性、证明目的、补强缺口和质证风险。
4. 所有事实必须绑定证据或标注“待补证”。
5. 所有法律依据只写“待检索/待核验”或引用已确认法律名称，不得编造条文。
6. 保留提交、签字、盖章、立案、发送给对方等人工确认节点。
请用中文 Markdown 输出。`;

  try {
    const text = await runLegalLLMWithin(prompt, context, 1800, 8000);
    if (text) return finish(sanitizeLegalWorkProductOutput(text));
  } catch { /* fall through */ }

  const plaintiffDocs = [
    '起诉状草稿：当事人信息、诉讼请求、事实与理由、证据和来源、受诉法院。',
    '要素式诉状要点：主体、法律关系、请求权基础、争议事实、证据对应、金额计算。',
    '委托手续：委托代理合同要点、授权委托书、律所函、律师证复印件清单。',
    '立案材料组卷：主体材料、证据副本、送达地址确认书、缴费/保全材料。',
    '证据目录：证据名称、来源、页码、证明对象、证明目的、原件核验状态。',
  ];
  const defendantDocs = [
    '答辩状草稿：基本答辩立场、逐项回应诉请、事实反驳、程序抗辩、证据目录。',
    '质证意见：真实性、合法性、关联性、证明目的是否成立、反证或补证需求。',
    '程序抗辩清单：管辖、诉讼时效、主体资格、重复起诉/仲裁条款、送达瑕疵。',
    '代理词框架：争议焦点、事实认定、法律适用、证据评价、结论请求。',
  ];
  const docs = role === '原告' ? plaintiffDocs : role === '被告' ? defendantDocs : [...plaintiffDocs, ...defendantDocs.slice(0, 2)];

  return finish(`# ${caseName} 半自动诉讼文书包

## 一、人工边界
- 本文书包为系统草稿，只能作为律师工作底稿。
- 最终法律意见、签字盖章、立案提交、送达和对外发送必须由律师或当事人确认。
- 未能绑定证据的事实统一标注为“待补证”，不得直接写入最终文书。

## 二、案件信息
${caseContext}

## 三、文书包清单
${docs.map((item, index) => `${index + 1}. ${item}`).join('\n')}

## 四、证据目录与三性审查矩阵
| 编号 | 证据名称 | 待证事实 | 证明目的 | 真实性核验 | 合法性核验 | 关联性核验 | 缺口/质证风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${evidenceReviewTable}

## 五、证据缺口与补强清单
${evidenceGapList}

## 六、立案/提交前确认点
- 当事人身份信息、统一社会信用代码、送达地址和联系方式。
- 管辖法院、案由、诉讼请求、金额计算、诉讼费和保全需求。
- 法条引用、类案引用、证据三性、证明目的、证据页码、附件份数。
- 提交平台：如需网上立案，使用 web_login_run 打开“人民法院在线服务”，由律师人工核对并提交。
`);
}

// ── legal_prepare_filing_handoff ────────────────────────────────────────

export async function prepareFilingHandoffHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = legalWorkspaceId(args, context);
  const userId = context?.userId || textArg(args, 'userId') || 'system';
  const caseId = textArg(args, 'caseId');
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const role = roleLabel(textArg(args, 'role'));
  const court = textArg(args, 'court') || '待确认法院';
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const claims = textArg(args, 'claims') || textArg(args, 'objective') || '待补充';
  const parties = textArg(args, 'parties') || '待补充当事人身份信息';
  const facts = textArg(args, 'facts') || '待补充案件事实';
  const evidence = textArg(args, 'evidence') || textArg(args, 'materials') || '待补充证据材料';
  const portalUrl = textArg(args, 'portalUrl') || 'https://zxfw.court.gov.cn/';
  const requestedMaterials = listArg(args, 'materials');
  const materialRows = requestedMaterials.length > 0
    ? requestedMaterials.map((item, index) => `| ${index + 1} | ${item} | 待匹配上传项 | 律师复核 |`).join('\n')
    : [
      '| 1 | 起诉状/申请书或答辩相关材料 | 诉状/申请书 | 律师复核 |',
      '| 2 | 当事人主体资格材料 | 身份证明/营业执照/法定代表人身份证明 | 律师复核 |',
      '| 3 | 授权委托手续 | 授权委托书、律所函、律师证 | 律师复核 |',
      '| 4 | 证据目录和证据副本 | 证据材料 | 原件核验/页码复核 |',
      '| 5 | 送达地址确认、收款账户、保全材料 | 其他材料 | 按法院要求补充 |',
    ].join('\n');

  const handoff = `# ${caseName} 半自动立案网交接单

## 一、边界
- 本单用于人民法院在线服务/地方在线诉讼服务平台的材料准备和人工提交交接。
- Lumi 可以整理字段、命名文件、生成核对清单、打开授权网页登录会话；不自动点击提交、签名、缴费、确认送达、撤回或代替身份认证。
- 所有诉请、金额、管辖、案由、法条、证据页码和附件份数必须由律师复核。

## 二、案件概要
- 我方身份：${role}
- 案由/类型：${caseType}
- 拟提交法院：${court}
- 当事人：${parties}
- 诉请/办理目标：${claims}
- 事实摘要：${facts}
- 证据摘要：${evidence}

## 三、立案系统字段映射
| 平台字段 | 建议填入 | 人工确认点 |
| --- | --- | --- |
| 案件类型/案由 | ${caseType} | 以法院平台可选案由为准 |
| 受诉法院 | ${court} | 管辖依据和级别管辖 |
| 当事人信息 | ${parties} | 身份证号/统一社会信用代码/地址/电话 |
| 诉讼请求 | ${claims} | 金额、利息、违约金、保全请求 |
| 事实与理由 | ${facts.slice(0, 500)} | 事实必须绑定证据 |
| 证据目录 | ${evidence.slice(0, 500)} | 证据名称、页码、证明目的、原件状态 |

## 四、上传材料清单
| 序号 | 材料 | 平台上传项 | 复核状态 |
| --- | --- | --- | --- |
${materialRows}

## 五、文件命名建议
1. 01_起诉状或申请书_${caseName}.pdf
2. 02_主体资格_${caseName}.pdf
3. 03_授权委托手续_${caseName}.pdf
4. 04_证据目录_${caseName}.pdf
5. 05_证据材料一_${caseName}.pdf
6. 06_送达地址确认及其他_${caseName}.pdf

## 六、网页登录动作
1. web_login_profile_save_from_preset {"presetId":"court-online-service"}
2. web_login_run {"profileId":"court-online-service","url":"${portalUrl}","headless":false}
3. 律师在可见浏览器内完成登录、身份核验、验证码、人脸或短信验证。
4. 按本交接单逐项填报、上传、核对；提交前截图或保存页面草稿编号。

## 七、提交前确认
- 管辖法院、案由、诉讼请求、金额计算、诉讼费、保全和送达地址。
- 起诉状/申请书是否签名盖章，授权手续是否完整。
- 证据是否按目录顺序合并，页码、份数、原件核验状态是否一致。
- 是否存在诉讼时效、仲裁条款、重复起诉、主体资格或管辖风险。

## 八、告知模板
材料已按半自动立案口径整理完毕，当前状态为“待律师登录法院平台人工核对并提交”。Lumi 未自动提交、未签名、未缴费、未确认送达；提交结果以法院平台回执为准。`;
  const preflightSection = buildLegalWorkProductPreflightSection(handoff, args, orgId);
  const archivedHandoff = `${handoff}\n\n${preflightSection}`;
  const archivedMaterial = appendLegalCaseMaterial({
    orgId,
    userId,
    caseId,
    type: 'note',
    title: `${caseName}半自动立案交接单`,
    content: archivedHandoff,
  });
  const archiveLine = caseId
    ? archivedMaterial ? `已归档到案件空间 materialId=${archivedMaterial.id}` : '未归档（caseId 不存在或无权限）'
    : '未归档（未提供 caseId）';
  return `${archivedHandoff}

## 九、案件空间归档
${archiveLine}`;
}
