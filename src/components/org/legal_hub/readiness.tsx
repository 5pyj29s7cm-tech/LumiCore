import { CheckCircle, AlertTriangle } from "lucide-react";
import type { LegalCaseFile } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import type { LegalCaseReadinessItem } from './contracts';

const LEGAL_CASE_READINESS_TOOLS: Record<string, string> = {
  intake: 'legal_message_intake_to_case / legal_import_materials_to_kb',
  identity: 'legal_case_workspace / legal_import_materials_to_kb',
  facts: 'legal_meeting_minutes_to_case / legal_case_workspace',
  reasoning: 'legal_case_reasoning_matrix',
  evidence: 'legal_generate_litigation_packet',
  law: 'legal_search_statute / legal_generate_citation_verification_report',
  sources: 'legal_external_research_plan / legal_search_external_authorities',
  'work-product': 'legal_generate_litigation_packet / legal_generate_argument_or_opinion',
  filing: 'legal_prepare_filing_handoff',
  delivery: 'legal_finalize_delivery_package',
};

export function buildLegalCaseReadiness(caseFile: LegalCaseFile): LegalCaseReadinessItem[] {
  const text = [
    caseFile.notes,
    ...(caseFile.materials || []).map(material => [material.type, material.title, material.source || '', material.content || ''].join('\n')),
  ].join('\n').toLowerCase();
  const hasSignal = (patterns: RegExp[]) => patterns.some(pattern => pattern.test(text));
  const materials = caseFile.materials || [];
  const hasIntake = Boolean(caseFile.notes.trim() || materials.length > 0);
  const hasIdentity = Boolean(caseFile.party.trim())
    // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
    && hasSignal([/身份证|营业执照|统一社会信用代码|主体资格|授权委托|律所函|律师证/i]);
  const hasFacts = Boolean(caseFile.notes.trim().length >= 20)
    // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
    || hasSignal([/事实摘要|案件事实|时间线|履行|付款|交付|解除|侵权|庭审|会议纪要/i]);
  // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
  const hasReasoning = hasSignal([/三段论|大前提|小前提|涵摄|legal_case_reasoning_matrix|法律分析三段论/i]);
  const hasEvidence = materials.some(material => material.type === 'evidence')
    // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
    || hasSignal([/证据目录|证明目的|三性|真实性|合法性|关联性|质证/i]);
  // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
  const hasSources = hasSignal([/来源登记|外部检索|法源|类案|裁判文书|人民法院案例库|legal_external_research_plan|legal_search_external_authorities/i]);
  const hasWorkProduct = materials.some(material => material.type === 'pleading' || material.type === 'contract')
    // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
    || hasSignal([/起诉状|答辩状|质证意见|代理词|法律意见书|合同审查|合同起草|投标书|标书|诉讼策略/i]);
  // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
  const hasLawBlocked = hasSignal([/现行有效法律预检：未通过|硬门槛未通过|正式交付包未生成|不得标记为正式成果|已废止/i]);
  // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
  const hasLawPassed = !hasLawBlocked && hasSignal([/现行有效法律预检：通过|现行有效法律硬门槛：通过|引用核验|引用校验|citation-verification-report/i]);
  // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
  const hasFiling = hasSignal([/半自动立案交接单|立案网交接单|法院在线服务|legal_prepare_filing_handoff/i]);
  // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
  const hasDeliveryGate = hasSignal([/正式交付包|现行有效法律硬门槛|引用核验|引用校验|source-register|来源登记表|legal_finalize_delivery_package/i]);

  const items: Omit<LegalCaseReadinessItem, 'done'>[] = [
    {
      key: 'intake',
      label: uiMessage('legal-hub.intake.795643fe2e'),
      detail: hasIntake ? uiMessage('legal-hub.archived.1638832a14') : uiMessage('legal-hub.missing.3a25cf328c'),
      status: hasIntake ? 'done' : 'missing',
      nextStep: uiMessage('legal-hub.import-meeting-notes-pleadings-evidence.76c0fc3d9c'),
      view: 'import',
    },
    {
      key: 'identity',
      label: uiMessage('legal-hub.identity.1a371622a1'),
      detail: hasIdentity ? uiMessage('legal-hub.checked.9642f15399') : caseFile.party ? uiMessage('legal-hub.needs-check.bc00456c9a') : uiMessage('legal-hub.missing.2623bb38bf'),
      status: hasIdentity ? 'done' : caseFile.party ? 'ready' : 'missing',
      nextStep: uiMessage('legal-hub.add-identity-authority-and-service.8e402725fd'),
      view: 'workspace',
    },
    {
      key: 'facts',
      label: uiMessage('legal-hub.facts.5d7a5e1f8e'),
      detail: hasFacts ? uiMessage('legal-hub.prepared.9c28beac05') : hasIntake ? uiMessage('legal-hub.ready.2ade9ebc78') : uiMessage('legal-hub.missing.2623bb38bf'),
      status: hasFacts ? 'done' : hasIntake ? 'ready' : 'missing',
      nextStep: uiMessage('legal-hub.build-a-timeline-of-parties.17d8b862d0'),
      view: 'workspace',
    },
    {
      key: 'reasoning',
      label: uiMessage('legal-hub.reasoning-matrix.83dc0f2ce5'),
      detail: hasReasoning ? uiMessage('legal-hub.ready.3280ebf66e') : uiMessage('legal-hub.required.de4a95adb4'),
      status: hasReasoning ? 'done' : hasFacts || hasEvidence ? 'ready' : 'missing',
      nextStep: uiMessage('legal-hub.generate-the-authority-evidence-and.46ae098910'),
      view: 'strategy',
    },
    {
      key: 'evidence',
      label: uiMessage('legal-hub.evidence-review.904c0f7be0'),
      detail: hasEvidence ? uiMessage('legal-hub.prepared.9c28beac05') : uiMessage('legal-hub.missing.293c592854'),
      status: hasEvidence ? 'done' : hasIntake ? 'ready' : 'missing',
      nextStep: uiMessage('legal-hub.map-proof-purpose-original-status.0f3a872b6e'),
      view: 'packet',
    },
    {
      key: 'law',
      label: uiMessage('legal-hub.current-law.85754e3378'),
      detail: hasLawBlocked ? uiMessage('legal-hub.blocked.3044b5e296') : hasLawPassed ? uiMessage('legal-hub.passed.24c823b3b1') : uiMessage('legal-hub.missing.ba39d5a9c2'),
      status: hasLawBlocked ? 'blocked' : hasLawPassed ? 'done' : hasReasoning || hasWorkProduct ? 'ready' : 'missing',
      nextStep: hasLawBlocked
        ? uiMessage('legal-hub.replace-or-verify-blocking-authorities.d6248457ac')
        : uiMessage('legal-hub.verify-all-statutes-interpretations-and.4348622a41'),
      view: 'verify',
    },
    {
      key: 'sources',
      label: uiMessage('legal-hub.sources.fbb50fb2b2'),
      detail: hasSources ? uiMessage('legal-hub.logged.2bd1b41ec1') : uiMessage('legal-hub.missing.b1cd9e1420'),
      status: hasSources ? 'done' : hasFacts || hasReasoning ? 'ready' : 'missing',
      nextStep: uiMessage('legal-hub.log-authorities-from-supreme-high.adfac8a04d'),
      view: 'external-research',
    },
    {
      key: 'work-product',
      label: uiMessage('legal-hub.drafts.1b1bddcf17'),
      detail: hasWorkProduct ? uiMessage('legal-hub.drafted.ded8cf6f43') : uiMessage('legal-hub.missing.ee4d2a7e05'),
      status: hasWorkProduct ? 'done' : hasEvidence && hasReasoning ? 'ready' : 'missing',
      nextStep: uiMessage('legal-hub.generate-complaint-answer-cross-exam.f2aab3a8b7'),
      view: 'packet',
    },
    {
      key: 'filing',
      label: uiMessage('legal-hub.filing.b85688fcb5'),
      detail: hasFiling ? uiMessage('legal-hub.handoff-ready.bf79982539') : hasWorkProduct ? uiMessage('legal-hub.manual.24f17bdf15') : uiMessage('legal-hub.not-ready.b358df0cab'),
      status: hasFiling ? 'done' : hasWorkProduct ? 'manual' : 'missing',
      nextStep: uiMessage('legal-hub.prepare-court-platform-fields-and.29f878ee91'),
      view: 'packet',
    },
    {
      key: 'delivery',
      label: uiMessage('legal-hub.delivery-gate.94b193e100'),
      detail: hasLawBlocked ? uiMessage('legal-hub.blocked.e5862a2c38') : hasDeliveryGate ? uiMessage('legal-hub.recorded.5dd3865391') : uiMessage('legal-hub.missing.b4ee8a4d72'),
      status: hasLawBlocked ? 'blocked' : hasDeliveryGate ? 'done' : hasLawPassed && hasWorkProduct ? 'ready' : 'missing',
      nextStep: hasLawBlocked
        ? uiMessage('legal-hub.fix-authorities-before-formal-delivery.b2e1639fb7')
        : uiMessage('legal-hub.run-the-formal-delivery-gate.3a08dedc0f'),
      view: 'verify',
    },
  ];
  return items.map(item => ({ ...item, done: item.status === 'done', tool: LEGAL_CASE_READINESS_TOOLS[item.key] }));
}

export function legalReadinessTone(status: LegalCaseReadinessItem['status']): string {
  if (status === 'done') return 'border-emerald-400/18 bg-emerald-500/[0.07] text-emerald-100';
  if (status === 'blocked') return 'border-rose-400/24 bg-rose-500/[0.08] text-rose-100';
  if (status === 'ready') return 'border-amber-400/22 bg-amber-500/[0.07] text-amber-100 hover:border-amber-300/35';
  if (status === 'manual') return 'border-cyan-400/20 bg-cyan-500/[0.06] text-cyan-100 hover:border-cyan-300/35';
  return 'border-white/10 bg-black/18 text-white/58 hover:border-white/16 hover:bg-white/[0.05]';
}

export function legalReadinessIcon(item: LegalCaseReadinessItem) {
  if (item.status === 'done') return <CheckCircle size={12} />;
  return <AlertTriangle size={12} />;
}
