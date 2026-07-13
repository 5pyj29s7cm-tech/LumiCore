export const LEGAL_ENTRY_PREFERRED_TOOLS = [
  'legal_message_intake_to_case',
  'legal_case_workspace',
  'legal_case_workflow_status',
  'legal_meeting_minutes_to_case',
  'legal_case_reasoning_matrix',
  'legal_extract_dispute_focus',
  'legal_generate_litigation_packet',
  'legal_generate_argument_or_opinion',
  'legal_review_contract',
  'legal_draft_contract',
  'legal_generate_bid',
  'legal_import_materials_to_kb',
  'legal_process_notice_link',
  'legal_download_and_extract_document',
  'legal_external_research_plan',
  'legal_search_external_authorities',
  'legal_company_database_lookup',
  'legal_trace_assets',
  'legal_equity_penetration',
  'legal_case_strategy',
  'legal_analyze_folder_and_draft_argument',
  'legal_generate_citation_verification_report',
  'legal_finalize_delivery_package',
  'legal_authority_source_status',
  'legal_refresh_authoritative_sources',
  'legal_prepare_filing_handoff',
  'legal_prepare_external_browser_workspace',
  'legal_search_case',
  'legal_search_statute',
  'read_docx',
  'read_pdf',
  'create_docx',
  'write_file',
];

const LEGAL_ENTRY_RE =
  /(?:\u5f8b\u5e08|\u6cd5\u5f8b|\u6848\u4ef6|\u6cd5\u9662|\u8d77\u8bc9|\u8d77\u8bc9\u72b6|\u7b54\u8fa9|\u7b54\u8fa9\u72b6|\u4ee3\u7406\u8bcd|\u8bc1\u636e|\u8d28\u8bc1|\u7acb\u6848|\u88c1\u5224\u6587\u4e66|\u6cd5\u8749|\u5408\u540c|\u534f\u8bae|\u4e09\u6bb5\u8bba|\u5927\u524d\u63d0|\u5c0f\u524d\u63d0|\u6db5\u6444|\u6cd5\u6761|\u73b0\u884c\u6709\u6548|\u6cd5\u5f8b\u610f\u89c1|\u6807\u4e66|\u62db\u6807|\u6295\u6807|\u88ab\u6267\u884c\u4eba|\u5931\u4fe1|\u4f01\u67e5\u67e5|\u56fd\u5bb6\u4f01\u4e1a\u4fe1\u7528|legal|lawyer|pleading|contract|court|lawsuit|casework|filing|statute|tender|bid|alpha|fachan|qichacha)/i;

const REMOTE_LEGAL_INTAKE_RE =
  /(?:(?:\u98de\u4e66|\u5fae\u4fe1|\u4f01\u5fae|\u4f01\u4e1a\u5fae\u4fe1|Lumi\s*bot|\bbot\b|\u77ed\u4fe1|\u901a\u77e5\u94fe\u63a5|\u94fe\u63a5).*(?:\u5165\u6848|\u5f52\u6863|\u6848\u4ef6|\u6cd5\u9662|\u6cd5\u5f8b|\u6750\u6599|\u901a\u77e5)|(?:\u5165\u6848|\u5f52\u6863|\u81ea\u52a8\u5165\u6848).*(?:\u98de\u4e66|\u5fae\u4fe1|\u4f01\u5fae|\u4f01\u4e1a\u5fae\u4fe1|Lumi\s*bot|\bbot\b|\u77ed\u4fe1|\u901a\u77e5\u94fe\u63a5|\u94fe\u63a5))/i;

function compact(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function isRemoteLegalMessageTurn(text: string): boolean {
  const normalized = compact(text);
  if (!normalized) return false;
  return REMOTE_LEGAL_INTAKE_RE.test(normalized);
}

export function isLegalEntryTurn(text: string): boolean {
  const normalized = compact(text);
  if (!normalized) return false;
  return LEGAL_ENTRY_RE.test(normalized) || isRemoteLegalMessageTurn(normalized);
}

export function hasLegalRouteSignal(input: {
  text?: string;
  routeCategories?: string[];
  toolNames?: string[];
}): boolean {
  return Boolean(
    (input.routeCategories || []).includes('legal')
      || (input.toolNames || []).some(name => name.startsWith('legal_') || name.startsWith('mcp_legal-casework_'))
      || isLegalEntryTurn(input.text || ''),
  );
}

export function buildUnifiedLegalEntryPrompt(input: {
  text?: string;
  domain?: string;
  orgId?: string;
  channel?: string;
  source?: string;
  routeCategories?: string[];
  toolNames?: string[];
}): string {
  if (!hasLegalRouteSignal(input)) return '';

  const workScoped = input.domain === 'work' || Boolean(input.orgId);
  const remoteIntake = isRemoteLegalMessageTurn(input.text || '') || /(?:feishu|wechat|wecom|bot|message)/i.test(input.source || '');
  const scopeLine = workScoped
    ? 'Scope: this is work/company legal work. Prefer the organization case workspace, organization knowledge base, source registration, and case-state tools before drafting.'
    : 'Scope: this is legal work in the personal workspace unless the user selects an organization case. You may analyze and draft, but do not claim organization persistence before a work workspace is chosen.';

  return [
    '## Unified Legal Casework Entry',
    'Legal work is available from personal chat, company/work chat, voice, task center, and Feishu/WeCom/WeChat bot intake. Treat these as entrances into the same legal casework capability, not as separate scripts or ordinary messaging.',
    scopeLine,
    'Execution order: intake/case space -> identity/facts -> major premise -> minor premise -> conclusion/subsumption -> current-law gate -> filing handoff -> delivery/archive.',
    remoteIntake
      ? 'Remote legal messages and forwarded SMS/court links should use legal_message_intake_to_case or legal_process_notice_link, then bind the source, sender, link, extracted document, and next case step into the case workspace.'
      : '',
    remoteIntake
      ? 'Remote bot intake must resolve the organization/case binding first. If orgId is available, archive into the organization case workspace and organization knowledge base; if not, keep it as personal intake and do not claim organization persistence.'
      : '',
    'Core legal method: major premise = retrieve current law, explain the rule, and reinforce with ranked similar cases; minor premise = organize facts, materials, evidence, burden, and cross-examination; conclusion = subsume facts into the rule and produce the complaint, defense, argument, legal opinion, filing handoff, or delivery package.',
    'Current-law gate: every generated legal document must verify cited law through legal_generate_citation_verification_report, legal_search_statute, legal_search_external_authorities, or an equivalent authoritative source before being marked final. Check legal_authority_source_status first; if the snapshot is missing, expired, changed, or unavailable beyond its review deadline, run legal_refresh_authoritative_sources. If currency still cannot be verified, label it unverified instead of presenting it as current effective law.',
    'External legal platforms: court filing portals, Fachan, Alpha, China Judgments Online, Qichacha, and enterprise credit systems are authorized-collaboration surfaces. Do not claim full automation; archive sources/results and run the delivery gate before formal use.',
    'External-platform boundary: court filing, signatures, payment, public submission, settlement commitment, final legal position, or service confirmation require lawyer/party confirmation. Authorized browser/database work may prepare, search, verify, and stage the result.',
  ].filter(Boolean).join('\n');
}
