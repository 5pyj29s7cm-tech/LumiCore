export const LEGAL_ENTRY_PREFERRED_TOOLS = [
  'legal_search_external_authorities',
  'web_search',
  'url_fetch',
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
  /(?:\u5f8b\u5e08|\u6cd5\u5f8b|\u6848\u4ef6|\u7c7b\u6848|\u6cd5\u9662|\u8d77\u8bc9|\u8d77\u8bc9\u72b6|\u7b54\u8fa9|\u7b54\u8fa9\u72b6|\u4ee3\u7406\u8bcd|\u8bc1\u636e|\u8d28\u8bc1|\u7acb\u6848|\u88c1\u5224\u6587\u4e66|\u6cd5\u8749|\u5408\u540c|\u534f\u8bae|\u4e09\u6bb5\u8bba|\u5927\u524d\u63d0|\u5c0f\u524d\u63d0|\u6db5\u6444|\u6cd5\u6761|\u73b0\u884c\u6709\u6548|\u6cd5\u5f8b\u610f\u89c1|\u6807\u4e66|\u62db\u6807|\u6295\u6807|\u88ab\u6267\u884c\u4eba|\u5931\u4fe1|\u4f01\u67e5\u67e5|\u56fd\u5bb6\u4f01\u4e1a\u4fe1\u7528|legal|lawyer|pleading|contract|court|lawsuit|casework|filing|statute|tender|bid|alpha|fachan|qichacha)/i;

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
