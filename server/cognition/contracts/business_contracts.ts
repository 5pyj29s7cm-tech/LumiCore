import type { LumiActionContract } from './contracts';
import { withDefaults } from './contracts';

export function buildCustomerOperationsContract(): LumiActionContract {
  return withDefaults({
    kind: 'customer_operations',
    label: 'Customer operations',
    coreAction: 'Inspect the supplied customer context, perform the requested sales/service work, and record a verifiable customer-facing or operational result.',
    preparationIsNotCompletion: [
      'a canned quotation or contract template',
      'a local customer takeover packet',
      'opening WeChat, CRM, or a customer page',
      'a reply draft that was not sent',
      'a task record with no customer or business outcome',
    ],
    requiredEvidence: [
      'grounded customer analysis based on supplied records when analysis is requested',
      'sent=true or an equivalent channel receipt when contact/reply is requested',
      'a verified document artifact when a quotation, proposal, or agreement is requested',
      'a concrete task/result record that distinguishes completed work from drafts and blockers',
    ],
    preferredTools: [
      'mcp_sales-customer-ops_lead_score',
      'mcp_sales-customer-ops_sales_followup_draft',
      'mcp_sales-customer-ops_objection_response_builder',
      'mcp_sales-customer-ops_customer_health_review',
      'mcp_sales-customer-ops_support_ticket_triage',
      'work_takeover_task_create',
      'work_takeover_task_orchestrate',
      'work_takeover_task_run_suggested_tool',
      'wechat_send_message',
      'create_docx',
      'create_pdf',
      'work_product_verify',
    ],
    verificationTools: ['wechat_send_message', 'work_takeover_task_get', 'work_product_verify', 'desktop_path_info'],
    nextStep: 'Read the actual customer context, choose the relevant customer-operations tool, execute the requested outcome, then verify the channel receipt, artifact, or recorded business result.',
    caution: 'Do not report customer takeover as complete from a local packet, generic template, opened window, or unsent draft.',
  });
}

export function buildEcommerceOperationsContract(): LumiActionContract {
  return withDefaults({
    kind: 'ecommerce_operations',
    label: 'Ecommerce operations',
    coreAction: 'Use real supplied store, order, SKU, campaign, inventory, or platform state to perform the requested analysis, content production, or store operation.',
    preparationIsNotCompletion: [
      'a generic store audit checklist',
      'a local ecommerce growth packet',
      'image or video prompts without generated media',
      'opening a seller or creator platform',
      'a publish draft without a platform submission receipt',
    ],
    requiredEvidence: [
      'source-backed ecommerce analysis for analysis requests',
      'an actual image/video/file result for requested content production',
      'authenticated post-action platform state for store changes',
      'post-submit receipt or visible platform feedback for publishing',
    ],
    preferredTools: [
      'mcp_ecommerce-ops_product_listing_optimizer',
      'mcp_ecommerce-ops_ecommerce_order_profit',
      'mcp_ecommerce-ops_inventory_restock_plan',
      'mcp_ecommerce-ops_platform_settlement_reconcile',
      'mcp_ecommerce-ops_campaign_roi_analyzer',
      'mcp_ecommerce-ops_after_sales_risk_report',
      'mcp_content-ops_short_video_script',
      'generate_image',
      'generate_video',
      'web_login_run',
      'mcp_playwright_browser_snapshot',
      'work_product_verify',
    ],
    verificationTools: ['work_product_verify', 'desktop_path_info', 'mcp_playwright_browser_snapshot', 'desktop_capture_screen'],
    nextStep: 'Obtain the real source data or authenticated platform session, run the matching ecommerce operation, and verify the produced asset or post-action platform state.',
    caution: 'A local preparation packet or generated copy is not evidence that a store was operated, media was generated, or content was published.',
  });
}
