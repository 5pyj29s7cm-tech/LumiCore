import type { ToolExecutionRecord } from "../../tools/types";
import { parseRecordJson } from "../action_contract_support";
import { requiresVisibleAutoCadExecution, requiresAutoCadMcpPlayback, requiresSourceGrounding } from "../action_request";
import { hasMeaningfulArguments, hasVisibleAutoCadExecutionEvidence } from "../action_desktop_evidence";
import { hasCreatedArtifact, hasArtifactVerification, hasSourceInspectionEvidence } from './artifact_evidence';
import { hasActualMediaEvidence } from './receipt_evidence';
import { hasGroundedCadGeometryEvidence } from './cad_evidence';

export function hasCustomerOperationsEvidence(records: ToolExecutionRecord[], taskText: string): boolean {
  const wantsSend = /(?:\u53d1\u7ed9|\u53d1\u9001|\u76f4\u63a5\u56de\u590d|\u56de\u590d\u5ba2\u6237|\u8054\u7cfb\u5ba2\u6237|\u8ddf\u8fdb\u5ba2\u6237|\u56de\u8bbf\u5ba2\u6237|\u63a8\u8fdb\u8ddf\u8fdb|send|message|reply\s+to|contact\s+the\s+customer|follow\s+up\s+with|advance.{0,24}follow[-\s]?up)/iu.test(taskText)
    && !/(?:\u8349\u7a3f|\u8bdd\u672f|\u51c6\u5907|\u62df\u4e00\u4efd|draft|prepare|copy\s*only)/iu.test(taskText);
  const wantsDocument = /(?:\u62a5\u4ef7\u5355|\u62a5\u4ef7\u4e66|\u65b9\u6848\u4e66|\u5408\u540c|\u534f\u8bae|\u63d0\u6848|PPT|PDF|DOCX|quotation|proposal|agreement|contract)/iu.test(taskText);
  const wantsAnalysis = /(?:\u5206\u6790|\u8bc4\u5206|\u5206\u7c7b|\u5f02\u8bae|\u5065\u5eb7\u5ea6|\u5de5\u5355|analy|score|triage|objection|health\s+review)/iu.test(taskText);
  const takeoverOnly = /(?:\u63a5\u7ba1|\u5168\u6743\u5904\u7406|\u76f4\u63a5\u63a8\u8fdb|take\s*over|handle\s+everything)/iu.test(taskText)
    && !wantsSend && !wantsDocument && !wantsAnalysis;

  const sent = records.some(record => record.name === 'wechat_send_message' && /"sent"\s*:\s*true|sent:\s*true/i.test(record.result));
  const analyzed = records.some(record => /^mcp_sales-customer-ops_/i.test(record.name) && hasMeaningfulArguments(record) && String(record.result).trim().length > 20);
  const documentProduced = hasCreatedArtifact(records, /^(?:create_docx|create_pdf|create_ppt|write_file)$/i) && hasArtifactVerification(records);

  if (wantsSend && !sent) return false;
  if (wantsDocument && !documentProduced) return false;
  if (wantsAnalysis && !analyzed) return false;
  if (takeoverOnly) return sent || documentProduced;
  return sent || analyzed || documentProduced;
}

function hasAuthenticatedPlatformOutcome(records: ToolExecutionRecord[]): boolean {
  return records.some(record =>
    /(?:playwright_browser_snapshot|playwright_browser_evaluate|url_fetch_logged_in|computer_use)/i.test(record.name)
      && /(?:\u64cd\u4f5c\u6210\u529f|\u4fee\u6539\u6210\u529f|\u5df2\u66f4\u65b0|\u5df2\u4fdd\u5b58|\u751f\u6548|operation\s+(?:succeeded|completed)|updated|saved|applied)/iu.test(record.result)
      && !/(?:login|required|captcha|manual_required|blocked|failed)/i.test(record.result)
  );
}

export function hasEcommerceOperationsEvidence(records: ToolExecutionRecord[], taskText: string): boolean {
  const wantsAnalysis = /(?:\u5206\u6790|\u4f53\u68c0|\u5229\u6da6|\u6838\u7b97|\u5bf9\u8d26|\u8865\u8d27|\u5e93\u5b58|ROI|ROAS|\u98ce\u9669|\u6807\u9898\u4f18\u5316|analy|audit|profit|reconcile|restock|inventory|risk|listing\s+optim)/iu.test(taskText);
  const wantsImage = /(?:\u751f\u6210|\u5236\u4f5c|\u51fa).{0,16}(?:\u56fe\u7247|\u4e3b\u56fe|\u6d77\u62a5|\u56fe\u6587)|(?:generate|create).{0,16}(?:image|poster|creative)/iu.test(taskText);
  const wantsVideo = /(?:\u751f\u6210|\u5236\u4f5c|\u51fa).{0,16}(?:\u89c6\u9891|\u6210\u7247)|(?:generate|create|produce).{0,16}(?:video|clip)/iu.test(taskText);
  const wantsCopyOrScript = /(?:\u6587\u6848|\u811a\u672c|\u8be6\u60c5\u9875|\u6807\u9898|\u5356\u70b9|\u53d1\u5e03\u8349\u7a3f|copy|script|listing|caption|draft)/iu.test(taskText);
  const wantsPlatformChange = /(?:\u6539\u4ef7|\u6539\u5e93\u5b58|\u4e0a\u67b6|\u4e0b\u67b6|\u5f00\u59cb\u6295\u653e|\u8c03\u6574\u6295\u653e|\u4fee\u6539\u5e97\u94fa|change\s+price|update\s+inventory|list\s+the\s+product|start\s+campaign|change\s+the\s+store)/iu.test(taskText);
  const takeoverOnly = /(?:\u63a5\u7ba1|\u5168\u6258|take\s*over|fully\s+manage)/iu.test(taskText)
    && !wantsAnalysis && !wantsImage && !wantsVideo && !wantsCopyOrScript && !wantsPlatformChange;

  const analyzed = records.some(record => /^(?:mcp_ecommerce-ops_|business_ecommerce_|industry_ecommerce_(?:today_snapshot|store_data_snapshot|listing_action_queue|customer_service_drafts|trend_discovery)$)/i.test(record.name) && hasMeaningfulArguments(record) && String(record.result).trim().length > 20
    && (!record.name.startsWith('industry_') || (record.terminalVerification?.status === 'verified' && parseRecordJson(record)?.status === 'verified')));
  const copyProduced = records.some(record => /^(?:mcp_content-ops_|mcp_ecommerce-ops_product_listing_optimizer)/i.test(record.name) && hasMeaningfulArguments(record) && String(record.result).trim().length > 20)
    || hasCreatedArtifact(records, /^(?:create_docx|create_pdf|create_xlsx|write_file)$/i) && hasArtifactVerification(records);
  const platformChanged = hasAuthenticatedPlatformOutcome(records);

  if (wantsAnalysis && !analyzed) return false;
  if (wantsImage && !hasActualMediaEvidence(records, 'image')) return false;
  if (wantsVideo && !hasActualMediaEvidence(records, 'video')) return false;
  if (wantsCopyOrScript && !copyProduced) return false;
  if (wantsPlatformChange && !platformChanged) return false;
  if (takeoverOnly) return platformChanged;
  return analyzed || copyProduced || hasActualMediaEvidence(records, 'either') || platformChanged;
}

export function hasDesignDeliveryEvidence(records: ToolExecutionRecord[], taskText: string): boolean {
  const sourceRequired = requiresSourceGrounding(taskText);
  const wantsCompositePackage = /(?:\u5168\u5957\u8bbe\u8ba1|\u5168\u6848\u8bbe\u8ba1|\u5b8c\u6574\u4ea4\u4ed8\u5305|\u8bbe\u8ba1\u4ea4\u4ed8|\u88c5\u4fee\u4ea4\u4ed8|full\s+(?:design|renovation|interior)|design\s+(?:delivery|package|handoff))/iu.test(taskText);
  const wantsCad = /(?:\bCAD\b|\bDXF\b|\bDWG\b|AutoCAD|\u65bd\u5de5\u56fe|\u5e73\u9762\u56fe)/iu.test(taskText);
  const wantsBim = /(?:Revit|\bBIM\b|\bIFC\b|Dynamo)/iu.test(taskText);
  const wantsPresentation = /(?:PPT|\u6c47\u62a5|\u65b9\u6848\u4e66|presentation|proposal)/iu.test(taskText);
  const wantsVisual = /(?:\u6548\u679c\u56fe|\u6e32\u67d3|\u6d77\u62a5|logo|\u54c1\u724c\u89c6\u89c9|render|visual)/iu.test(taskText);
  const wantsSchedule = /(?:\u9884\u7b97|\u6e05\u5355|\u6750\u6599\u8868|BOQ|bill\s+of\s+quantit)/iu.test(taskText);

  if (sourceRequired && !hasSourceInspectionEvidence(records)) return false;
  if (sourceRequired && wantsCad && !hasGroundedCadGeometryEvidence(records)) return false;

  if (wantsCad) {
    if (requiresVisibleAutoCadExecution(taskText) || requiresAutoCadMcpPlayback(taskText)) {
      if (!hasVisibleAutoCadExecutionEvidence(records, taskText)) return false;
    } else {
      const cadCreated = hasCreatedArtifact(records, /^(?:cad_generate_dxf|mcp_cad-drafting_.+)$/i);
      if (!cadCreated || !hasArtifactVerification(records)) return false;
    }
  }

  if (wantsBim) {
    const realBim = records.some(record => {
      if (!/(?:revit|bim|ifc)/i.test(record.name) || /(?:prepare|package|handoff|dynamo)/i.test(record.name)) return false;
      return /"status"\s*:\s*"(?:completed|success)"|"(?:modelPath|ifcPath|outputPath|path)"\s*:/i.test(record.result);
    });
    if (!realBim) return false;
  }

  if (wantsPresentation) {
    if (!hasCreatedArtifact(records, /^(?:create_ppt|create_docx|create_pdf)$/i) || !hasArtifactVerification(records)) return false;
  }
  if (wantsVisual && !hasActualMediaEvidence(records, 'image')) return false;
  if (wantsSchedule) {
    if (!hasCreatedArtifact(records, /^(?:create_xlsx|create_docx|create_pdf|write_file)$/i) || !hasArtifactVerification(records)) return false;
  }

  const requestedSpecificOutput = wantsCad || wantsBim || wantsPresentation || wantsVisual || wantsSchedule;
  if (wantsCompositePackage && !requestedSpecificOutput) return false;
  if (!requestedSpecificOutput) return hasActualMediaEvidence(records, 'image') || hasCreatedArtifact(records, /^(?:create_ppt|create_pdf|create_docx)$/i) && hasArtifactVerification(records);
  return true;
}
