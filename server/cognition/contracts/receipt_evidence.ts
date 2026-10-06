import type { ToolExecutionRecord } from "../../tools/types";
import { parseRecordJson } from "../action_contract_support";
import { hasMeaningfulArguments } from "../action_desktop_evidence";
import type { LumiActionContract } from './contracts';

export function hasVerifiedManifestCapabilityEvidence(
  contract: LumiActionContract,
  records: ToolExecutionRecord[],
): boolean {
  return records.some(record => {
    if (record.terminalVerification?.status !== 'verified' || !record.capability) return false;
    const searchText = [
      record.name,
      record.capability.capabilityId,
      record.evidence?.capability || '',
    ].join(' ').toLowerCase();
    return contract.verificationCapabilities.some(requirement => (
      requirement.lanes.includes(record.capability!.lane)
      && (!requirement.operations?.length || requirement.operations.includes(record.capability!.operation))
      && requirement.terms.some(term => searchText.includes(term.toLowerCase()))
    ));
  });
}

export function hasVerifiedGenericDesktopMutation(records: ToolExecutionRecord[]): boolean {
  const mutationPattern = /^(?:desktop_ui_(?:click|invoke|type)|desktop_(?:mouse_.+|keyboard_.+)|keyboard_press|mouse_(?:move|click|drag)|keyboard_type|computer_use|client_action)$/i;
  const observationPattern = /^(?:desktop_active_window|get_active_window_info|desktop_ui_snapshot|desktop_capture_screen|capture_screen|ocr_screen)$/i;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!mutationPattern.test(record.name) || !hasMeaningfulArguments(record)) continue;
    const payload = parseRecordJson(record);
    const embeddedVerification = record.evidence?.assurance === 'verified'
      || payload?.ok === true && /^(?:verified|completed|success|succeeded|ok)$/i.test(String(payload?.status || payload?.verification?.status || ''))
      || payload?.verification?.status === 'pass'
      || Boolean(payload?.selectedAfter);
    if (embeddedVerification) return true;
    if (records.slice(index + 1).some(candidate => observationPattern.test(candidate.name))) return true;
  }
  return false;
}

export function isPreparationOnlyTool(name: string): boolean {
  return /^(?:work_product_plan|work_takeover_task_(?:create|from_wechat|from_clipboard|list|get|update|continue|orchestrate|execute_step|advance|autorun|export_packet)|work_takeover_capability_reuse_probe|mcp_cad-drafting_cad_renovation_folder_workflow|desktop_(?:open|list_apps|list_files|active_window|capture_screen|ui_snapshot)|browser_open_task|write_clipboard)$/i.test(name);
}

export function hasActualMediaEvidence(records: ToolExecutionRecord[], kind: 'image' | 'video' | 'either'): boolean {
  const namePattern = kind === 'image'
    ? /^(?:generate_image(?:_dalle)?|edit_image|ai_edit_image|mcp_.+_(?:generate|edit)_image)$/i
    : kind === 'video'
      ? /^(?:generate_video|mcp_.+_(?:generate|create)_video)$/i
      : /^(?:generate_image(?:_dalle)?|edit_image|ai_edit_image|generate_video|mcp_.+_(?:generate|edit|create)_(?:image|video))$/i;
  return records.some(record => {
    if (!namePattern.test(record.name)) return false;
    const result = String(record.result || '');
    return /(?:image_url|video_url|output_url|download_url|savedPath|outputPath|"path"\s*:|https?:\/\/)/i.test(result)
      && !/(?:prompt\s*only|not\s+generated|failed|blocked)/i.test(result);
  });
}
