/** Domain hints feed the shared router; they never execute a separate model/task pipeline. */
export function businessInstructionText(text: string): string {
  // A path such as D:/Audit-Reports/orders.xlsx identifies data, not an audit operation.
  return text.replace(/(?:https?:\/\/|[A-Za-z]:[\\/]|\\\\|\/(?!\s))[^\r\n"'“”<>|，。；！？]*?\.(?:xlsx?|csv|docx?|pdf|pptx?|txt|md|json)(?=$|[\s"'“”，。；！？,;])/giu, ' ');
}

export function businessToolHints(text: string): string[] {
  text = businessInstructionText(text);
  const names: string[] = [];
  if (/发票|票税|进项|销项|invoice|vat/iu.test(text)) names.push('business_finance_vat_invoice_review', 'business_finance_tax_position_estimator');
  if (/对账|账务|账簿|账龄|核对.*流水|reconcil|ledger|receivable|payable/iu.test(text)) names.push('business_finance_ledger_reconciliation', 'business_finance_ar_ap_aging');
  if (/现金|资金.*风险|cash.?flow/iu.test(text)) names.push('business_finance_cashflow_forecast', 'business_finance_ar_ap_aging');
  if (/报表|财务|财税|经营看板|financial|finance|report-delivery|tax-filing/iu.test(text)) names.push('business_finance_finance_report_outline', 'business_finance_statement_consistency_review', 'business_finance_financial_ratio_analysis', 'business_finance_tax_period_checklist', 'business_finance_tax_position_estimator');
  if (/店铺|电商|销售额|ecommerce|store-data|today-operations/iu.test(text)
    || /订单/iu.test(text) && /经营|运营|利润|毛利|成本|对账|售后|核算/iu.test(text)) names.push('business_ecommerce_ecommerce_order_profit', 'business_ecommerce_platform_settlement_reconcile', 'industry_ecommerce_today_snapshot', 'industry_ecommerce_store_data_snapshot', 'business_finance_ecommerce_tax_workpaper');
  if (/库存|补货|inventory/iu.test(text)) names.push('business_ecommerce_inventory_restock_plan');
  if (/广告|投放|campaign|roas/iu.test(text)) names.push('business_ecommerce_campaign_roi_analyzer');
  if (/商品管理|listing-automation/iu.test(text)) names.push('industry_ecommerce_listing_action_queue', 'business_ecommerce_product_listing_optimizer');
  if (/客服|售后|ai-customer-service/iu.test(text)) names.push('industry_ecommerce_customer_service_drafts', 'business_ecommerce_after_sales_risk_report');
  if (/review.*insight/iu.test(text) || /评论|评价/iu.test(text) && /分析|汇总|整理|洞察|提炼|提取|差评|好评/iu.test(text)) names.push('business_ecommerce_review_source_normalizer', 'business_ecommerce_review_insight_analyzer');
  if (/爆款|趋势研究|trend-discovery/iu.test(text)) names.push('industry_ecommerce_trend_discovery');
  if (/旧版|历史.*(?:电商|财务|财税)|(?:电商|财务|财税).*历史/iu.test(text)) names.unshift('business_archive_get');
  return names.length ? [...new Set([...names, 'industry_workspace_status', 'industry_workspace_bind', 'industry_capability_profile_get', 'industry_workflow_start', 'industry_workflow_complete', 'work_takeover_task_get', 'create_xlsx', 'read_xlsx', 'read_file'])] : [];
}

/** Remove only scoped prohibitions; a general no-write instruction stays intact. */
export function localBusinessAnalysisBoundary(text: string): { instruction: string; tools: string[] } | null {
  if (!/(?:分析|计算|核对|复核|诊断|analysis|calculate|reconcile)/iu.test(text)) return null;
  const tools = businessToolHints(text).filter(name => /^(?:business_(?:finance|ecommerce)_|industry_ecommerce_(?:today_snapshot|store_data_snapshot|listing_action_queue|customer_service_drafts)$|industry_workflow_(?:start|complete)$)/u.test(name));
  if (!tools.some(name => name.startsWith('business_') || name.startsWith('industry_ecommerce_'))) return null;
  const instruction = text
    .replace(/(?:不要|不|别|禁止)\s*(?:写入|保存到|加入)\s*(?:日常|长期|个人)?记忆/gu, ' ')
    .replace(/(?:不要|不|别|禁止)\s*(?:连接|修改|操作|登录)\s*(?:任何|真实|实际|线上)?(?:店铺|平台|账户|账号)/gu, ' ');
  return instruction !== text ? { instruction, tools } : null;
}
