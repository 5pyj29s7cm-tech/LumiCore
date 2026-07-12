export type ToolPermission = 'public' | 'user' | 'admin' | 'system';

/** Security classification per tool — inspired by Claude Code's tier system */
export type SecurityLevel = 'safe' | 'confirm' | 'forbidden';

export interface ToolContext {
  userId?: string;
  /** Active data domain for scoped writes. */
  domain?: 'personal' | 'work' | string;
  /** Organization id when domain is work. */
  orgId?: string;
  socketId?: string;
  cwd?: string;
  /** Relay for desktop tools: sends execution request to Tauri frontend and returns result */
  desktopRelay?: (toolName: string, args: Record<string, any>) => Promise<string>;
  /** Explicit personal-device relay used only for approved cross-workspace handoff, such as sending an organization file to the member's own WeChat. */
  personalDesktopRelay?: (toolName: string, args: Record<string, any>) => Promise<string>;
  /** Called when a tool requires confirmation. Returns true to proceed, false to abort. */
  requestConfirmation?: (toolName: string, args: Record<string, any>) => Promise<boolean>;
  /** Original user/task intent used to classify semantic risk for low-level actions. */
  actionIntent?: string;
  /** True only after the registry's confirmation callback approved this tool call. */
  userConfirmed?: boolean;
  /**
   * True when the current user turn explicitly asked Lumi to create/export/save a
   * local deliverable. This only relaxes medium-risk local file generation tools;
   * high-risk actions and already-confirm-level tools keep their confirmation gate.
   */
  allowLocalFileWrites?: boolean;
  /** Human-readable reason recorded when allowLocalFileWrites is set. */
  localWriteIntentReason?: string;
  /**
   * True for foreground, user-present execution surfaces where Lumi can perform
   * ordinary social/content commits (messages, comments, non-commercial posts)
   * without a separate confirmation popup. High-consequence actions still gate.
   */
  supervisedExternalCommits?: boolean;
  /** Personality's tool policy for security level resolution */
  toolPolicy?: import('../personality/types').ToolPolicy;
  /** Returns true if the task has been cancelled — checked between tool iterations */
  isCancelled?: () => boolean;
  /** Progress callback for long-running tools (computer_use) — reports each step */
  onProgress?: (step: string) => void;
  /** Lifecycle callback fired immediately before an LLM-selected tool begins. */
  onToolStart?: (call: { id?: string; name: string; arguments: Record<string, any> }) => void;
  /** LLM provider getters for tools that need to call vision/text models internally */
  llmGetters?: {
    getDeepSeek: () => any;
    getGemini: () => any;
    getOpenAI?: () => any;
    getAnthropic?: () => any;
    getQwen?: () => any;
    getArk?: () => any;
    getOllama?: () => any;
    getLmStudio?: () => any;
    getXiaomi?: () => any;
    getKimi?: () => any;
    getGlm?: () => any;
    getRelay?: () => any;
  };
  /** True when the tool is being used by background autonomous work. */
  autonomous?: boolean;
  /** Surface that initiated the tool call, such as chat, voice, runtime-log, meeting, or mcp. */
  source?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  handler: (args: Record<string, any>, context?: ToolContext) => Promise<string>;
  permission: ToolPermission;
  /** Security level: safe = auto-execute, confirm = ask user, forbidden = never execute */
  securityLevel: SecurityLevel;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface NormalizedLLMResponse {
  text: string | null;
  toolCalls: ParsedToolCall[] | null;
  reasoningContent?: string | null;
  usage?: LLMUsage;
}

export interface ToolExecutionRecord {
  id?: string;
  name: string;
  arguments: Record<string, any>;
  result: string;
  error?: string;
}
