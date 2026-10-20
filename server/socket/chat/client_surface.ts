import { ToolExecutionRecord } from "../../tools/types";
import { type LumiClientMode, LUMI_CLIENT_MODE_IDS } from "../../../shared/operation_modes";
import { toolRecordSucceeded } from "../../cognition/task_execution_ledger";

export function getVerifiedClientModeChange(records: ToolExecutionRecord[]): LumiClientMode | null {
  const validModes = new Set<string>(LUMI_CLIENT_MODE_IDS);
  for (const record of [...records].reverse()) {
    if (
      record.name !== 'client_action'
      || record.arguments?.action !== 'set_client_mode'
      || !toolRecordSucceeded(record)
    ) continue;
    const mode = String(record.arguments?.mode || '').trim().toLowerCase();
    if (!validModes.has(mode)) continue;
    try {
      const parsed = JSON.parse(String(record.result || '{}'));
      const status = String(parsed?.verification?.status || parsed?.status || '').toLowerCase();
      if (/^(?:verified|not_applicable)$/.test(status) && parsed?.ok !== false) {
        return mode as LumiClientMode;
      }
    } catch {
      // A mode preference is never persisted from an unparseable receipt.
    }
  }
  return null;
}
