import type { ProviderGetters as SharedProviderGetters } from "../../llm/provider_getters";
import type { ToolExecutionRecord } from "../../tools/types";

export type LLMGetters = SharedProviderGetters;

export interface AutonomousTaskOutcome {
  text: string;
  blocked: boolean;
  verified: boolean;
  reason: string;
  successfulToolRecords: ToolExecutionRecord[];
}
