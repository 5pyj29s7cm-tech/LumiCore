/** Shared edition routing contract; cognition never selects a concrete regional pack. */
export { getCurrentIndustryCapabilityProfile, isCurrentIndustryWorkflowExecutionRequest,
  isCurrentIndustryMultiWorkspaceLedgerStatusRequest, isDesignProjectCreationRequest,
  matchCurrentIndustryWorkflow, formatIndustryWorkflowRoutingPrompt,
} from '../packs/cn/industry_capability_profile';
export type { IndustryCapabilityEntry } from '../packs/cn/industry_capability_profile';
