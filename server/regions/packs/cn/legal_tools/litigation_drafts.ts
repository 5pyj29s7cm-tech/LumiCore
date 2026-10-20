import { textArg } from "./context";
import type { resolveSourceDraftEntries } from '../legal_reasoning_generation';

export type LitigationAnalysisEntry = ReturnType<typeof resolveSourceDraftEntries>[number];
export const LITIGATION_ANALYSIS_SECTIONS: Record<string, Array<{ id: string; title: string }>> = {
  '10_civil-complaint': [{ id: 'law', title: '条件法律分析' }],
  '20_statement-of-defense': [{ id: 'response', title: '逐项答辩分析' }, { id: 'law', title: '条件法律分析' }],
  '21_cross-examination-opinion': [{ id: 'evidence', title: '逐证质证分析' }],
  '23_argument-outline': [{ id: 'position', title: '条件立场分析' }, { id: 'issues', title: '争议焦点分析' }, { id: 'law', title: '条件法律适用' }, { id: 'conclusion', title: '条件结论分析' }],
};
import { formatEvidenceReviewRows, formatEvidenceCatalogRows, formatEvidenceGapList, type EvidenceReviewRow } from './case_workflow';

export interface LitigationPacketDraft {
  baseName: string;
  label: string;
  markdown: string;
}

export const litigationDraftCell = (value: string) => value.replace(/\|/g, '｜').replace(/[\r\n]+/g, '；');

export function litigationDraftValue(value: string, label: string): string {
  return value || `［${label}待补充］`;
}

export function litigationDraftBoundary(caseName: string): string {
  return [
    '',
    '## 状态与交付边界',
    '',
    `- 本文件属于“${caseName}”系统草稿，只能作为律师工作底稿。`,
    '- 当事人身份、事实、请求、金额、证据、授权范围、签字盖章和提交信息均须逐项人工确认。',
    '- 法律依据必须先检索并核验案件相应时间适用版本；未核验内容不得转为正式文书。',
    '- 正式交付前必须完成案件相应时间适用法律、引用来源和法律分析完整性核验，并由律师复核确认。',
  ].join('\n');
}

export function buildLitigationPacketDrafts(
  args: Record<string, any>,
  role: '原告' | '被告' | '通用',
  evidenceRows: EvidenceReviewRow[],
  analyses = new Map<string, LitigationAnalysisEntry[]>(),
): LitigationPacketDraft[] {
  const evidenceReviewTable = formatEvidenceReviewRows(evidenceRows);
  const evidenceCatalogTable = formatEvidenceCatalogRows(evidenceRows);
  const evidenceGapList = formatEvidenceGapList(evidenceRows);
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const caseType = litigationDraftValue(textArg(args, 'caseType'), '案由/案件类型');
  const court = litigationDraftValue(textArg(args, 'court'), '受理/审理法院');
  const parties = litigationDraftValue(textArg(args, 'parties'), '当事人身份信息');
  const claims = litigationDraftValue(textArg(args, 'claims') || textArg(args, 'objective'), '诉讼请求或抗辩目标');
  const facts = evidenceRows.filter(row => row.sources.length).map(row => [
    '### ' + litigationDraftCell(row.name), row.sourceLabel,
    ...row.sources.flatMap(source => ['- ' + source.id + '；' + source.locator, '> ' + source.quote.replace(/\r\n?|\n/g, '\n> ')]),
  ].join('\n\n')).join('\n\n') || (textArg(args, 'facts') ? '> ' + textArg(args, 'facts').replace(/\r\n?|\n/g, '\n> ') : '［已登记的事实材料原文待补充；不根据任务要求补写事实］');
  const evidence = litigationDraftValue(textArg(args, 'evidence'), '证据材料');
  const registeredEvidence = analyses.has('10_civil-complaint') ? litigationDraftValue(textArg(args, 'evidence') || evidenceRows.map(row =>
    litigationDraftCell(row.name + '；' + row.sourceLabel + '；原件与证明力待核')).join('；'), '证据材料') : evidence;
  const opponentMaterials = textArg(args, 'opponentMaterials');
  const clientPartyName = textArg(args, 'clientPartyName');
  const client = clientPartyName ? litigationDraftCell(clientPartyName) + '（身份资料待核验）' : '［委托人名称及身份待确认］';
  const lawFirmName = litigationDraftValue(textArg(args, 'lawFirmName'), '律师事务所名称');
  const lawyerName = litigationDraftValue(textArg(args, 'lawyerName'), '承办律师姓名');
  const boundary = litigationDraftBoundary(caseName);
  // Model text stays inside analysis cells, not new identity or request sections.
  const cell = litigationDraftCell;
  const entry = (baseName: string, sectionId: string) => analyses.get(baseName)?.find(item => item.sectionId === sectionId);
  const analysis = (baseName: string, sectionId: string, fallback: string) => {
    const item = entry(baseName, sectionId);
    return item ? [
      '| 原始材料（未核验） | 拟议分析（待律师核对） | 待核前提 |',
      '| --- | --- | --- |',
      '| ' + cell(item.sources.map(source => source.id + '；' + source.title + '；' + source.locator + '：' + source.quote).join('；'))
        + ' | ' + cell(item.response) + ' | ' + cell(item.missing) + ' |',
    ].join('\n') : fallback;
  };
  const element = (sectionId: string, fallback: string) => {
    const item = entry('10_civil-complaint', sectionId);
    return item ? cell(item.response + '；来源：' + item.sources.map(source => source.id + '；' + source.locator).join('；') + (item.missing ? '；待核：' + item.missing : '')) : cell(fallback);
  };

  const common: LitigationPacketDraft[] = [
    {
      baseName: '01_filing-material-checklist',
      label: '立案/应诉材料清单',
      markdown: [
        `# ${caseName} Filing Material Checklist`,
        '',
        '| No. | Material | Use | Review point |',
        '| --- | --- | --- | --- |',
        '| 1 | Complaint / application / answer materials | Court filing or defense response | Lawyer review, signature, seal |',
        '| 2 | Party identity materials | Subject qualification | ID, business license, legal representative certificate |',
        '| 3 | Authorization materials | Attorney authority | Engagement, power of attorney, law firm letter, lawyer certificate |',
        '| 4 | Evidence catalog and copies | Proof package | Originals, page numbers, copy count, proof purpose |',
        '| 5 | Service address / fee / preservation materials | Court platform fields | Manual confirmation before submission |',
        '',
        `- 拟提交法院：${court}`,
        `- 案由：${caseType}`,
        boundary,
      ].join('\n'),
    },
    {
      baseName: '02_authorization-checklist',
      label: '授权委托手续清单',
      markdown: [
        `# ${caseName} Authorization Checklist`,
        '',
        '- 委托代理合同：代理阶段、工作范围、费用、解除条件和保密条款待确认。',
        '- 授权委托书：一般授权和特别授权事项逐项勾选，不得概括推定。',
        '- 律师事务所函：案号、法院、承办律师和有效期待确认。',
        '- 律师执业证复印件及年度考核状态。',
        '- 当事人身份证明、营业执照、法定代表人身份证明。',
        '- 全部签字、盖章、日期、份数和扫描件清晰度。',
        boundary,
      ].join('\n'),
    },
    {
      baseName: '03_evidence-review-matrix',
      label: '证据目录与三性审查矩阵',
      markdown: [
        `# ${caseName} Evidence Catalog And Three-Property Review`,
        '',
        '| 编号 | 证据名称 | 待证事实 | 证明目的 | 真实性核验 | 合法性核验 | 关联性核验 | 缺口/质证风险 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        evidenceReviewTable,
        '',
        '## Evidence Gaps',
        evidenceGapList,
        boundary,
      ].join('\n'),
    },
  ];

  const authorizationDrafts = (prefix: string): LitigationPacketDraft[] => [
    {
      baseName: `${prefix}_engagement-agreement`,
      label: '委托代理合同',
      markdown: [
        '# 委托代理合同（系统草稿）',
        '',
        `- 案件：${caseName}`,
        `- 甲方/委托人：${client}`,
        `- 乙方：${lawFirmName}`,
        `- 委托事项：就${caseName}（${caseType}）提供诉讼代理服务。`,
        '- 代理阶段：［一审/二审/执行/再审/其他，待勾选］',
        '- 工作范围：材料审查、法律检索、文书起草、立案/应诉协作、出庭代理及约定事项。',
        '- 律师费及支付：［金额、计费方式、税费、差旅费、支付节点待双方确认］',
        '- 双方义务：委托人如实完整提供材料；律师依法、勤勉、保密并及时报告进展。',
        '- 解除与终止：［解除条件、费用结算、材料返还待双方确认］',
        '- 争议解决：［协商/诉讼/仲裁条款待双方确认］',
        '',
        '甲方签字/盖章：［待签署］',
        '',
        '乙方盖章：［待签署］',
        '',
        '日期：［待填写］',
        boundary,
      ].join('\n'),
    },
    {
      baseName: `${prefix}_power-of-attorney`,
      label: '授权委托书',
      markdown: [
        '# 授权委托书（系统草稿）',
        '',
        `委托人：${client}`,
        '',
        `受托人：${lawyerName}，${lawFirmName}律师。`,
        '',
        `现委托上述受托人在${caseName}（${caseType}）中担任诉讼代理人。`,
        '',
        '## 授权范围',
        '',
        '- 一般代理：代为调查取证、查阅材料、参加庭审、陈述事实和法律意见、接收普通程序性材料。',
        '- 特别授权：［代为承认、放弃、变更诉讼请求，进行和解，提起反诉或上诉，申请执行，代收法律文书或款项等必须逐项勾选］',
        '- 授权期限：［起止日期或至本代理阶段终结，待确认］',
        '',
        '委托人签字/盖章：［待签署］',
        '',
        '日期：［待填写］',
        boundary,
      ].join('\n'),
    },
    {
      baseName: `${prefix}_law-firm-letter`,
      label: '律师事务所函',
      markdown: [
        '# 律师事务所函（系统草稿）',
        '',
        `${court}：`,
        '',
        `${lawFirmName}接受委托，指派${lawyerName}律师担任${caseName}（${caseType}）的诉讼代理人。`,
        '',
        '请依法办理相关诉讼手续。具体代理权限以经委托人签署的授权委托书为准。',
        '',
        `律师事务所：${lawFirmName}`,
        '',
        '（盖章处）',
        '',
        '日期：［待填写］',
        boundary,
      ].join('\n'),
    },
  ];

  const plaintiff: LitigationPacketDraft[] = [
    {
      baseName: '10_civil-complaint',
      label: '民事起诉状',
      markdown: [
        '# 民事起诉状（系统草稿）',
        '',
        `## 当事人\n${parties}`,
        '',
        `## 案由\n${caseType}`,
        '',
        `## 诉讼请求\n${claims}`,
        '',
        `## 事实与理由\n${facts}`,
        '',
        `## 证据和证据来源\n${registeredEvidence}`,
        '',
        '## 法律依据',
        analysis('10_civil-complaint', 'law', '- ［待结合请求权基础检索并核验案件相应时间适用法律、司法解释和类案，不得凭模型记忆补写］'),
        '',
        `此致\n${court}`,
        '',
        '具状人：［待签字/盖章］',
        '',
        '日期：［待填写］',
        boundary,
      ].join('\n'),
    },
    {
      baseName: '11_element-complaint',
      label: '要素式诉状',
      markdown: [
        '# 要素式诉状（系统草稿）',
        '',
        '| 要素 | 已有内容 | 证据绑定/待补项 |',
        '| --- | --- | --- |',
        `| 当事人主体 | ${parties.replace(/\|/g, '\\|')} | 身份证明、主体资格、送达信息待核验 |`,
        `| 案由与法律关系 | ${caseType.replace(/\|/g, '\\|')} | 请求权基础待检索、待核验 |`,
        `| 诉讼请求 | ${claims.replace(/\|/g, '\\|')} | 金额、计算方式、履行方式待核对 |`,
        `| 主要事实 | ${cell(facts)} | 与10起诉状共用材料原文及定位；不认定事实已成立 |`,
        `| 现有证据 | ${registeredEvidence.replace(/\|/g, '\\|')} | 原件、来源、页码、三性和证明目的待复核 |`,
        `| 管辖 | ${court.replace(/\|/g, '\\|')} | 级别、地域、专属/协议管辖待核验 |`,
        `| 法律分析 | ${element('law', '待检索/待核验')} | ${entry('10_civil-complaint', 'law') ? '与10起诉状共用已复核分析；正式交付前另行核验' : '待复核；正式交付前另行核验'} |`,
        boundary,
      ].join('\n'),
    },
    ...authorizationDrafts('12'),
    {
      baseName: '15_service-address-confirmation',
      label: '送达地址确认底稿',
      markdown: [
        '# 送达地址确认底稿（系统草稿）',
        '',
        `- 案件：${caseName}`,
        '- 当事人：［确认送达地址的当事人待确认］',
        '- 收件人：［待填写］',
        '- 送达地址及邮编：［待填写］',
        '- 手机号码：［待填写并核验］',
        '- 电子邮箱/电子送达账号：［待填写并单独确认电子送达意愿］',
        '- 地址变更告知义务和送达后果：［由律师向当事人说明并确认］',
        '',
        '确认人签字/盖章：［待签署］',
        '',
        '日期：［待填写］',
        boundary,
      ].join('\n'),
    },
    {
      baseName: '16_evidence-catalog',
      label: '原告证据目录',
      markdown: [
        '# 原告证据目录（系统草稿）',
        '',
        evidenceCatalogTable,
        boundary,
      ].join('\n'),
    },
  ];

  const defendant: LitigationPacketDraft[] = [
    {
      baseName: '20_statement-of-defense',
      label: '民事答辩状',
      markdown: [
        '# 民事答辩状（系统草稿）',
        '',
        `## 当事人\n${parties}`,
        '',
        ...(opponentMaterials ? [`## 对方诉请及材料\n${opponentMaterials}`, ''] : []),
        `## 答辩目标\n${claims}`,
        '',
        `## 答辩事实\n${facts}`,
        '',
        `## 我方证据\n${evidence}`,
        '',
        '## 逐项答辩意见',
        analysis('20_statement-of-defense', 'response', '- ［按对方每项诉讼请求、事实主张和证据编号逐项回应；未取得材料的部分标记待补充］'),
        '',
        '## 法律依据',
        analysis('20_statement-of-defense', 'law', '- ［待围绕抗辩要件检索并核验案件相应时间适用法律、司法解释和类案］'),
        '',
        `此致\n${court}`,
        '',
        '答辩人：［待签字/盖章］',
        '',
        '日期：［待填写］',
        boundary,
      ].join('\n'),
    },
    {
      baseName: '21_cross-examination-opinion',
      label: '质证意见',
      markdown: [
        '# 质证意见（系统草稿）',
        '',
        ...(opponentMaterials ? [`## 对方材料范围\n${opponentMaterials}`, ''] : []),
        analysis('21_cross-examination-opinion', 'evidence', [
          '| 对方证据编号 | 证据名称 | 真实性意见 | 合法性意见 | 关联性意见 | 对证明目的意见 | 反证/补证 | 待核验项 |',
          '| --- | --- | --- | --- | --- | --- | --- | --- |',
          '| ［待对应］ | ［待填写］ | ［认可/不认可及理由］ | ［取得方式、形式、程序］ | ［与待证事实关系］ | ［能否达到证明目的］ | ［我方对应材料］ | ［原件、完整性、形成时间等］ |',
        ].join('\n')),
        '',
        '## 我方材料参考',
        evidence,
        boundary,
      ].join('\n'),
    },
    {
      baseName: '22_procedural-defense-checklist',
      label: '程序抗辩检查表',
      markdown: [
        '# 程序抗辩检查表（系统草稿）',
        '',
        '| 检查项 | 初步状态 | 所需材料 | 处理动作 |',
        '| --- | --- | --- | --- |',
        '| 级别/地域/专属管辖 | 待核验 | 合同、履行地、住所地、管辖条款 | 在法定期限内决定是否提出异议 |',
        '| 仲裁协议 | 待核验 | 合同正本、补充协议 | 核验有效性和适用范围 |',
        '| 诉讼时效/除斥期间 | 待核验 | 履行期限、催告、确认债务、送达凭证 | 建立时间线并计算 |',
        '| 原告/被告主体资格 | 待核验 | 身份材料、工商档案、权利转让文件 | 核验适格性 |',
        '| 重复起诉/既判力 | 待核验 | 既往案件材料、裁判文书 | 核对当事人、标的、请求 |',
        '| 送达和举证期限 | 待核验 | 送达凭证、法院通知 | 记录期限并设置提醒 |',
        boundary,
      ].join('\n'),
    },
    {
      baseName: '23_argument-outline',
      label: '代理词工作稿',
      markdown: [
        '# 代理词工作稿（系统草稿）',
        '',
        `- 案件：${caseName}`,
        `- 审理法院：${court}`,
        `- 我方核心目标：${claims}`,
        '',
        '## 一、案件立场与结论请求',
        analysis('23_argument-outline', 'position', '［待在完成事实、证据和法律核验后填写］'),
        '',
        '## 二、争议焦点',
        analysis('23_argument-outline', 'issues', '［从起诉状、答辩状、证据和庭审笔录中提炼］'),
        '',
        '## 三、事实材料原文',
        facts,
        '',
        '## 四、法律适用与类案补强',
        analysis('23_argument-outline', 'law', '［按最高人民法院、高级人民法院、中级人民法院、基层人民法院顺序检索；逐条登记来源并核验］'),
        '',
        '## 五、结论',
        analysis('23_argument-outline', 'conclusion', '［待完成事实适用分析后形成，不得预设裁判结果］'),
        boundary,
      ].join('\n'),
    },
    ...authorizationDrafts('24'),
    {
      baseName: '27_evidence-catalog',
      label: '被告证据目录与反证矩阵',
      markdown: [
        '# 被告证据目录与反证矩阵（系统草稿）',
        '',
        evidenceCatalogTable,
        boundary,
      ].join('\n'),
    },
  ];

  if (role === '原告') return [...common, ...plaintiff];
  if (role === '被告') return [...common, ...defendant];
  return [...common, ...plaintiff, ...defendant];
}
