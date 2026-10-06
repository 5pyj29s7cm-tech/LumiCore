import type { UserLLMProvider } from "../../llm/user_preferences";
import type { WorkflowRecord } from "../worklog";

export interface SkillGenerateRequest {
  /** Natural language description of what the skill should do */
  description?: string;
  /** User-facing name retained in the reviewed tool description and manifest. */
  displayName?: string;
  /** Existing workflows to learn from */
  workflows?: WorkflowRecord[];
  /** LLM provider to use */
  provider?: UserLLMProvider;
  model?: string;
  userId?: string;
  /** Server-owned parent turn identity, retained for nested model diagnostics. */
  conversationId?: string;
  requestId?: string;
  domain?: string;
  orgId?: string;
  signal?: AbortSignal;
}

export interface SkillGenerateResult {
  success: boolean;
  skillName?: string;
  toolName?: string;
  directory?: string;
  status?: 'draft';
  review?: GeneratedSkillDraftReview;
  error?: string;
  generatedCode?: string;
}

export interface GeneratedSkillDraftReview {
  status: 'draft';
  generatedAt: string;
  contentHash: string;
  permissions: string[];
  sideEffects: string[];
  risk: 'low' | 'medium' | 'high';
  evidence: {
    kind: 'protocol_structure_validation';
    assurance: 'non_executing';
    limitations: string[];
  };
  staticCheck: {
    passed: boolean;
    findings: string[];
  };
  trialRun: {
    passed: boolean;
    note: string;
  };
  requiresUserApproval: true;
}
